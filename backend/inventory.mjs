import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// The frontend's markup module owns the default rate and the shape of the
// rule. Importing it rather than restating 1.35 here means the two cannot
// drift into disagreeing about what an unconfigured catalog costs.
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'
import { DEFAULT_PRICING_SETTINGS, normalizePricingSettings } from '../src/pricing.js'
import { deriveBrand } from '../src/data/brand.js'
// The customer's own season facet owns the list of categories. Importing it
// for the same reason the markup rate is imported above: an owner override
// that named a sixth category would file a tire under a facet no filter draws,
// and the tire would vanish from the shop rather than move within it.
import { SEASON_LABELS } from '../src/tire-filters.js'
import { ensureImagePublicationSchema, approvedImageUrls, PHOTO_JOIN, PHOTO_COLUMNS, photoState } from './image-publication.mjs'
import { cleanCatalogDescription } from './catalog-description.mjs'
import { describeTireSpec } from './tire-spec.mjs'

const DEFAULT_MARKUP_RATE = DEFAULT_MARKUP_SETTINGS.rate
const DEFAULT_SHIPPING_PER_TIRE = DEFAULT_MARKUP_SETTINGS.shippingPerTire
const DEFAULT_MIN_MARGIN_PER_TIRE = DEFAULT_MARKUP_SETTINGS.minMarginPerTire
const DEFAULT_MAX_MARGIN_PER_TIRE = DEFAULT_MARKUP_SETTINGS.maxMarginPerTire
/** A typo guard, not a pricing opinion -- the same job `rate`'s 1-to-10 does. */
const MARGIN_BOUND_LIMIT = 500

const CATALOGUE_LINE_BASES = ['perTire', 'perJob']
const CATALOGUE_LINE_MODES = ['automatic', 'optional']
const CATALOGUE_LINE_LIMIT = 25

/**
 * The supplier's cost arrives in DOLLARS and the owner's price in CENTS.
 *
 * `payload.$.price` is what the supplier's page quoted -- a float, in dollars.
 * `offers.price_cents` is an integer this app stores. Subtracting them as they
 * come is wrong by 100x, and a margin wrong by 100x still sorts into an order
 * that looks entirely plausible, off a screen the owner prices tires from.
 * Nothing in either column name says the units differ, which is why this says
 * it here. The conversion lives in SQL, once: the value the list SELECTs and
 * the value it ORDERs BY are the same expression and cannot drift apart.
 */
const MARGIN_CENTS = "o.price_cents - CAST(ROUND(json_extract(s.payload,'$.price') * 100) AS INTEGER)"

/**
 * Sort keys the owner screen may ask for, each mapped to a FIXED SQL fragment.
 *
 * The key is looked up, never interpolated -- an unknown key cannot reach the
 * query -- and an unknown key falls back to the default order rather than
 * raising, because a mistyped sort must not blank the owner's screen.
 */
const SORT_COLUMNS = Object.freeze({
  size: 's.size',
  name: "json_extract(s.payload,'$.name')",
  supplierPrice: "json_extract(s.payload,'$.price')",
  price: 'o.price_cents',
  margin: MARGIN_CENTS,
  enabled: 'COALESCE(o.enabled,0)',
  updated: 'o.updated_at',
})

const DEFAULT_ORDER = "s.size, json_extract(s.payload,'$.name'), s.id"

/** Page sizes the listing will serve. 24 stays the default so no existing caller moves. */
const PAGE_SIZES = Object.freeze([24, 50, 100, 200])
const DEFAULT_PAGE_SIZE = 24

/** Rows one bulk offer write may carry, matching the largest page. */
const BULK_OFFER_LIMIT = 200

/** Per-row failure codes. The screen branches on these; the message is for the owner. */
const BULK_REASONS = Object.freeze({ 404: 'not-found', 409: 'version-conflict', 400: 'invalid' })

/**
 * The categories an owner may re-file a tire under.
 *
 * DERIVED FROM `SEASON_LABELS`, never listed here. That map is what the
 * customer's season facet draws its buckets from, so a category valid here and
 * absent there would put a tire under a filter nobody can press -- and a second
 * hand-written list of five strings is the paired-literal defect this
 * repository has already paid for in CATALOG_FIELDS and EXPECTED_CHECKS. If a
 * sixth season is ever added to the shop, this follows it with no edit.
 */
export const OVERRIDE_CATEGORIES = Object.freeze(Object.keys(SEASON_LABELS))

/**
 * The longest description an owner override may carry.
 *
 * MEASURED over all 1,083 rows of the tracked snapshot rather than picked
 * round: the longest supplier description that is a real description is 47
 * characters ("Ultra High Performance All Season · XL 116H BSW") and the
 * median is 23. The only rows above 120 are the seven whose description is the
 * supplier's own advertising -- "Compare tires at a glance using our easy test
 * score® system", 202 characters of it -- which is the defect this override
 * exists to let the owner delete. So 120 sits above every honest description
 * in the catalogue and below every dishonest one, and it is low enough that a
 * pasted paragraph cannot break the card it renders on.
 */
export const DESCRIPTION_OVERRIDE_LIMIT = 120

/**
 * The ORDER BY for a listing, built from an allow-listed key.
 *
 * Two pieces here are load-bearing rather than tidy:
 *
 * `, s.id` last. LIMIT/OFFSET paging over a non-unique sort key is
 * nondeterministic -- "sort by offered, page 2" can repeat rows page 1 already
 * showed and skip others entirely. It is silent, it looks right, and it ends
 * with the owner editing a row he never saw while another goes untouched.
 *
 * `<expr> IS NULL` first. Most supplier rows have no offer, so price, margin,
 * enabled and updated are NULL for them, and SQLite sorts NULLs first when
 * ascending. "Margin, ascending" -- the gesture this whole feature exists for
 * -- would then open on thousands of tires that carry no price at all rather
 * than the thin margins being hunted. Unpriced rows already have their own
 * control in `filter=unselected`; a sort must not quietly become a worse copy
 * of a filter that already exists.
 */
function orderBy(sort, dir) {
  const column = Object.hasOwn(SORT_COLUMNS, sort) ? SORT_COLUMNS[sort] : null
  if (!column) return { order: DEFAULT_ORDER, sort: null, dir: null }
  const direction = dir === 'desc' ? 'DESC' : 'ASC'
  return { order: `${column} IS NULL, ${column} ${direction}, s.id`, sort, dir: direction.toLowerCase() }
}

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

const now = () => new Date().toISOString()

/**
 * How a model is identified across its sizes, and it is the display name.
 *
 * The same tire in 205/55R16 and 225/50R17 carries that name and a different
 * id, so the name is the only thing grouping them. Trimmed and lowercased: a
 * stray space or a capital is not a different tire.
 */
export const modelKey = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '')

/**
 * The decoded spec a customer sees, as the fields that may cross the boundary.
 *
 * Runs the SAME cleaner the description itself goes through, so the parser is
 * fed exactly what the customer is shown rather than the raw payload.
 *
 * CORRECTING WHAT THIS COMMENT USED TO SAY: it claimed `cleanCatalogDescription`
 * removes the supplier's advertising from the seven rows that carry it. It does
 * not, and cannot -- it is an HTML sanitiser, and "Compare tires at a glance
 * using our easy test score® system" contains no markup to strip. Measured
 * against the live row: that description reaches a customer's card in full, all
 * 202 characters of it. Nothing removes it automatically and nothing should
 * try; a heuristic that deleted supplier prose would eventually delete a real
 * description. It is `description_override` on that tire's offer, set by a
 * person who read both, that fixes it.
 *
 * Each key is omitted rather than emitted empty, because `CATALOG_FIELDS` is a
 * positive allow-list and `backend/catalog-boundary.test.mjs` asserts the
 * field is present only when it says something.
 */
export function specFields(description) {
  const cleaned = cleanCatalogDescription(description)
  if (!cleaned) return {}
  const described = describeTireSpec(cleaned)
  return {
    ...(described.category ? { specCategory: described.category } : {}),
    ...(described.points?.length ? { specPoints: described.points } : {}),
  }
}

/**
 * One approved photo per MODEL, for rows of that model that have none of their own.
 *
 * IT MUST NOT BE BUILT FROM THE ROWS `catalog()` IS RETURNING. `catalog(size)`
 * filters to one size, and the photo of that model very likely lives on a
 * different size -- which is the entire point. Reading the model map out of the
 * filtered result set would find nothing and quietly change nothing, and the
 * feature would look implemented. So this asks the supplier table directly,
 * across every size, whatever the caller filtered to.
 *
 * The id, not the url, breaks ties: two sizes of one model can both be
 * approved, and picking by url would reorder whenever a hash changed. Lowest id
 * wins, so two requests over one database answer identically.
 */
export function modelImageUrls(db, imageUrls) {
  const byModel = new Map()
  if (!imageUrls || imageUrls.size === 0) return byModel
  // Two small columns for every supplier row. Cheap next to the catalogue query
  // itself, and free of the placeholder limit that `WHERE id IN (...)` would
  // hit once approvals pass 999.
  const rows = db.prepare("SELECT id, json_extract(payload,'$.name') AS name FROM supplier").all()
  for (const row of rows) {
    const url = imageUrls.get(row.id)
    if (!url) continue
    const key = modelKey(row.name)
    if (!key) continue
    const held = byModel.get(key)
    if (!held || String(row.id) < String(held.id)) byModel.set(key, { id: row.id, url })
  }
  return new Map([...byModel].map(([key, held]) => [key, held.url]))
}

export function validateTire(tire, size) {
  if (!tire || typeof tire.id !== 'string' || !tire.id.startsWith('giga-') ||
      typeof tire.name !== 'string' || !tire.name.trim() || tire.size !== size ||
      !Number.isFinite(tire.price) || tire.price <= 0 || tire.price > 100000 ||
      typeof tire.inStock !== 'boolean' || typeof tire.category !== 'string' ||
      typeof tire.source?.sku !== 'string') {
    throw new InputError(`Invalid supplier row for ${size}; previous inventory kept.`)
  }
  if (tire.source.stock !== null && tire.source.stock !== undefined &&
      (!Number.isInteger(tire.source.stock) || tire.source.stock < 0)) {
    throw new InputError(`Invalid stock count for ${tire.id}`)
  }
  const optionalStrings = ['brand', 'model', 'season', 'loadIndex', 'speedRating', 'sidewall', 'treadwear', 'utqg', 'warranty']
  if (optionalStrings.some(key => tire[key] !== undefined && (typeof tire[key] !== 'string' || !tire[key].trim())) ||
      (tire.runFlat !== undefined && typeof tire.runFlat !== 'boolean') ||
      (tire.imageUrls !== undefined && (!Array.isArray(tire.imageUrls) || tire.imageUrls.some(value => typeof value !== 'string' || !/^https?:\/\//.test(value)))) ||
      (tire.source.fetchedAt !== undefined && !Number.isFinite(Date.parse(tire.source.fetchedAt))) ||
      (tire.source.productId !== undefined && (typeof tire.source.productId !== 'string' || !tire.source.productId.trim())) ||
      (tire.source.raw !== undefined && (!tire.source.raw || typeof tire.source.raw !== 'object' || Array.isArray(tire.source.raw)))) {
    throw new InputError(`Invalid product enrichment for ${tire.id}`)
  }
  return tire
}

export class Inventory {
  constructor(filename, supportedSizes) {
    this.sizes = [...new Set(supportedSizes)].sort()
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS supplier (
        id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL,
        last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS supplier_size ON supplier(size);
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER, shipping_cents INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        category_override TEXT, description_override TEXT,
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        CHECK(price_cents IS NULL OR price_cents > 0),
        CHECK(shipping_cents IS NULL OR shipping_cents >= 0)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL,
        error TEXT, attempted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    // Every column added after the table first shipped needs BOTH the CREATE
    // above (for a fresh database) and an ALTER here (for production's, which
    // already exists and will never run the CREATE). Neither alone is enough,
    // and the half that is missing only fails on one of the two.
    //
    // NO CHECK CONSTRAINT ON `category_override`, deliberately. SQLite cannot
    // alter one, so a CHECK listing today's five seasons would have to be
    // migrated by rebuilding the table the day a sixth is added -- the exact
    // trap `quotes.status` is already stuck in here. The valid set is asserted
    // in `saveOffer`, against `OVERRIDE_CATEGORIES`, where it can change.
    const offerColumns = this.db.prepare('PRAGMA table_info(offers)').all().map(column => column.name)
    if (!offerColumns.includes('shipping_cents')) this.db.exec('ALTER TABLE offers ADD COLUMN shipping_cents INTEGER')
    if (!offerColumns.includes('category_override')) this.db.exec('ALTER TABLE offers ADD COLUMN category_override TEXT')
    if (!offerColumns.includes('description_override')) this.db.exec('ALTER TABLE offers ADD COLUMN description_override TEXT')
    this.seedCatalogueLines()
    ensureImagePublicationSchema(this.db)
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)
    return row ? JSON.parse(row.value) : null
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  /**
   * The markup rule, which proposes a price for tires the owner has not priced.
   *
   * It never overrides one. An offer's price_cents still wins wherever it is
   * set; this only fills the gap so a tire nobody has reached still has a
   * number, because there are hundreds of supported sizes (910 as of the
   * fitment-range change) and pricing every tire by hand is not something
   * anyone finishes.
   *
   * `isPlaceholder` stays true until every part of the rule has actually been
   * decided, so the customer catalog can mark those prices provisional
   * instead of presenting a default as a decision that was made. It is the OR
   * of two per-field flags (`rateIsPlaceholder`, `shippingPerTireIsPlaceholder`)
   * rather than one flag for the whole object: `retailPrice` combines shipping
   * with the marked-up supplier price, so a proposed price is only as
   * decided as its least-decided input (#finding-3, the scrutiny agent's
   * third pass -- a save of one field used to silently ratify the other,
   * whichever it happened to be sitting at).
   *
   * A record saved before these two fields existed reads its old combined
   * flag two different ways, and the difference is not academic -- it is the
   * shape of a real row on the production database. `rateIsPlaceholder`
   * falls back to the old flag: rate has always been required, so an old
   * record's `isPlaceholder: false` really did mean the rate was chosen.
   * `shippingPerTireIsPlaceholder` only does that when the record actually
   * has a `shippingPerTire` key -- an old record with the key entirely
   * absent (saved before shipping was a field at all, not merely before it
   * was asked about) is read as still a placeholder regardless of what the
   * combined flag said, because that flag was never asked the question. A
   * fallback that ignored this distinction would read a pre-shipping row's
   * `isPlaceholder: false` as "shipping decided too" -- the exact defect
   * this method exists to close, reappearing at read time for any row this
   * old.
   */
  getMarkup() {
    const stored = this.getMeta('markup')
    if (!stored) return {
      rate: DEFAULT_MARKUP_RATE, shippingPerTire: DEFAULT_SHIPPING_PER_TIRE,
      minMarginPerTire: DEFAULT_MIN_MARGIN_PER_TIRE, maxMarginPerTire: DEFAULT_MAX_MARGIN_PER_TIRE,
      rateIsPlaceholder: true, shippingPerTireIsPlaceholder: true, isPlaceholder: true, updatedAt: null,
    }
    const hasShippingKey = Object.prototype.hasOwnProperty.call(stored, 'shippingPerTire')
    const rateIsPlaceholder = stored.rateIsPlaceholder ?? stored.isPlaceholder
    const shippingPerTireIsPlaceholder = stored.shippingPerTireIsPlaceholder ?? (hasShippingKey ? stored.isPlaceholder : true)
    return {
      ...stored,
      shippingPerTire: stored.shippingPerTire ?? DEFAULT_SHIPPING_PER_TIRE,
      // A record saved before the margin bounds existed needs none of the
      // careful legacy reading `shippingPerTire` above needs, and the reason
      // is worth stating so nobody adds it later out of symmetry: shipping
      // arrived with a guessed value (0) and a flag claiming whose it was, so
      // an absent key and a decided zero had to be told apart. A margin bound
      // has no guessed value and no flag. Absent is off, off is what every
      // row saved before today meant, and `?? null` is the whole migration.
      minMarginPerTire: stored.minMarginPerTire ?? DEFAULT_MIN_MARGIN_PER_TIRE,
      maxMarginPerTire: stored.maxMarginPerTire ?? DEFAULT_MAX_MARGIN_PER_TIRE,
      rateIsPlaceholder,
      shippingPerTireIsPlaceholder,
      isPlaceholder: rateIsPlaceholder || shippingPerTireIsPlaceholder,
    }
  }

  saveMarkup(input) {
    // Below 1 would quote under what we pay the supplier. The upper bound is
    // not a pricing opinion, just a guard against a typo repricing everything.
    if (!input || !Number.isFinite(input.rate) || input.rate < 1 || input.rate > 10) {
      throw new InputError('Enter a markup between 1 and 10 times the supplier price.')
    }
    // Omitted means "not changing this" (every caller before shipping existed
    // still only sends `rate`), not zero -- so a missing field keeps whatever
    // is already stored, or the default, rather than refusing the whole save.
    // Zero is still a real, explicit answer (Ken absorbs shipping); a negative
    // number or anything past the guard rail is refused either way.
    const shippingProvided = input.shippingPerTire !== undefined
    const previous = this.getMarkup()
    const shippingPerTire = shippingProvided ? input.shippingPerTire : previous.shippingPerTire
    if (!Number.isFinite(shippingPerTire) || shippingPerTire < 0 || shippingPerTire > 200) {
      throw new InputError('Enter a per-tire shipping cost between $0 and $200.')
    }

    // The margin bounds, under the same "omitted means not changing" rule.
    // That rule is load-bearing here rather than merely tidy: the owner
    // screen's markup form sends `{ rate, shippingPerTire }` and nothing else
    // (src/owner/OwnerInventory.jsx), so under any other reading Ken would
    // clear his own margin floor every time he adjusted his rate, and the
    // hundreds of prices it was holding up would drop with no save that
    // mentioned them.
    //
    // `null` is a real, explicit answer here -- "no bound" -- and it is the
    // only way back off, so it has to be distinguishable from an omission.
    // Zero is NOT that way back for the ceiling: a $0 maximum margin sells
    // every unpriced tire at exactly what Ken paid for it, which is a typo,
    // not an instruction, and it is refused below.
    const minProvided = input.minMarginPerTire !== undefined
    const maxProvided = input.maxMarginPerTire !== undefined
    const minMarginPerTire = minProvided ? input.minMarginPerTire : previous.minMarginPerTire
    const maxMarginPerTire = maxProvided ? input.maxMarginPerTire : previous.maxMarginPerTire
    if (minMarginPerTire !== null &&
        (!Number.isFinite(minMarginPerTire) || minMarginPerTire < 0 || minMarginPerTire > MARGIN_BOUND_LIMIT)) {
      throw new InputError(`Enter a minimum margin per tire between $0 and $${MARGIN_BOUND_LIMIT}, or leave it off.`)
    }
    if (maxMarginPerTire !== null &&
        (!Number.isFinite(maxMarginPerTire) || maxMarginPerTire <= 0 || maxMarginPerTire > MARGIN_BOUND_LIMIT)) {
      throw new InputError(`Enter a maximum margin per tire above $0 and up to $${MARGIN_BOUND_LIMIT}, or leave it off.`)
    }
    if (minMarginPerTire !== null && maxMarginPerTire !== null && minMarginPerTire > maxMarginPerTire) {
      throw new InputError('The minimum margin per tire cannot be more than the maximum.')
    }

    const markup = {
      rate: Math.round(input.rate * 10000) / 10000,
      shippingPerTire: Math.round(shippingPerTire * 100) / 100,
      // Cents, like shipping beside it -- a bound stored to a fraction of a
      // cent would move a price by an amount no invoice could show.
      minMarginPerTire: minMarginPerTire === null ? null : Math.round(minMarginPerTire * 100) / 100,
      maxMarginPerTire: maxMarginPerTire === null ? null : Math.round(maxMarginPerTire * 100) / 100,
      // rate is required and freshly validated on every call, so a
      // successful save always decides it. shippingPerTire only stops being
      // a placeholder on a call that actually named it -- an untouched
      // fallback to the stored (or default) value is not Ken confirming it,
      // it is this save simply not being about shipping.
      rateIsPlaceholder: false,
      shippingPerTireIsPlaceholder: shippingProvided ? false : previous.shippingPerTireIsPlaceholder,
      updatedAt: now(),
    }
    markup.isPlaceholder = markup.rateIsPlaceholder || markup.shippingPerTireIsPlaceholder
    this.setMeta('markup', markup)
    return markup
  }

  /**
   * The quote-side settings: the mobile fee, disposal, tax (.forge/pricing-
   * settings.md, #289). Stored as integer cents, the way `offers.price_cents`
   * already is -- a tax rate multiplied across several lines is where float
   * drift starts to matter, and cents is the cheap fix while this is being
   * built anyway. `src/pricing.js` works in dollars, the way tire prices
   * already do, so the conversion happens here, at the one boundary, and
   * `calculateDraftQuote` never has to know the database's units.
   */
  getPricingSettings() {
    const stored = this.getMeta('pricing')
    if (!stored) return { ...DEFAULT_PRICING_SETTINGS, updatedAt: null }
    return normalizePricingSettings({
      mobileServiceFee: stored.mobileServiceFeeCents / 100,
      mobileServiceFeeIsPlaceholder: stored.mobileServiceFeeIsPlaceholder,
      disposalFee: stored.disposalFeeCents === null ? null : stored.disposalFeeCents / 100,
      disposalFeeIsPlaceholder: stored.disposalFeeIsPlaceholder,
      tax: stored.tax,
      updatedAt: stored.updatedAt,
    })
  }

  savePricingSettings(input) {
    if (!input) throw new InputError('Send the pricing settings to save.')
    const previous = this.getMeta('pricing')

    // Both fees are optional now that catalogue entries are the fee's actual
    // source of truth (#354 stage 2 -- calculateDraftQuote no longer reads
    // either one directly). Omitted means "not changing this", the same
    // shape saveMarkup already uses for shippingPerTire: the owner screen's
    // pricing form now asks only about tax, and must not be forced to
    // re-supply fees it no longer shows a field for.
    const feeProvided = input.mobileServiceFee !== undefined
    const mobileServiceFee = feeProvided ? input.mobileServiceFee : (previous ? previous.mobileServiceFeeCents / 100 : DEFAULT_PRICING_SETTINGS.mobileServiceFee)
    if (!Number.isFinite(mobileServiceFee) || mobileServiceFee <= 0 || mobileServiceFee > 1000) {
      throw new InputError('Enter a mobile service fee between $0 and $1000.')
    }
    const disposalProvided = input.disposalFee !== undefined
    // null is "not offered"; anything else has to be a real amount, not a guess.
    const disposalFee = disposalProvided ? input.disposalFee : (previous && previous.disposalFeeCents !== null ? previous.disposalFeeCents / 100 : null)
    if (disposalFee !== null && (!Number.isFinite(disposalFee) || disposalFee < 0 || disposalFee > 200)) {
      throw new InputError('Enter a disposal fee between $0 and $200, or leave it off.')
    }
    // A stored fee's own placeholder flag, read before this save overwrites
    // it -- see the note on disposalFeeIsPlaceholder below.
    const previousDisposalIsPlaceholder = previous?.disposalFeeIsPlaceholder ?? true
    let tax = null
    if (input.tax !== null && input.tax !== undefined) {
      // A rate is a fraction of the price, not a percentage typed as one: 6.25% is 0.0625.
      // The upper bound is a typo guard (a rate above 25% is not a tax rate anyone charges here).
      if (!Number.isFinite(input.tax.rate) || input.tax.rate <= 0 || input.tax.rate >= 0.25) {
        throw new InputError('Enter a tax rate between 0 and 25%, as a fraction (6.25% is 0.0625).')
      }
      if (!['all', 'goods', 'services'].includes(input.tax.appliesTo)) {
        throw new InputError('Choose which lines the tax applies to.')
      }
      tax = { rate: input.tax.rate, appliesTo: input.tax.appliesTo }
    }
    const pricing = {
      mobileServiceFeeCents: Math.round(mobileServiceFee * 100),
      // A save that actually names the fee always decides it; a save that
      // omits it (the tax-only form, post-stage-2) leaves whatever
      // placeholder status it already had -- same "omitted is not a guess"
      // rule stage 2 gives disposal below, now shared by both fees.
      mobileServiceFeeIsPlaceholder: feeProvided ? false : (previous?.mobileServiceFeeIsPlaceholder ?? true),
      disposalFeeCents: disposalFee === null ? null : Math.round(disposalFee * 100),
      // null is the disposal toggle's own default (off), not evidence Ken
      // looked at it: the very first pricing save he ever makes, to set only
      // the mobile fee, sends disposalFee: null because that is what the
      // untouched form still holds, and that used to permanently record "no
      // disposal" as a decision he never made (#finding-3). The flag only
      // clears on a save that actually names a real fee; null (typed or
      // omitted) keeps whatever the field's placeholder status already was.
      disposalFeeIsPlaceholder: disposalProvided && disposalFee !== null ? false : previousDisposalIsPlaceholder,
      tax,
      updatedAt: now(),
    }
    this.setMeta('pricing', pricing)
    return this.getPricingSettings()
  }

  /**
   * The owner's own quote lines (#354): installation, and anything else Ken
   * adds beyond the four built-in fees above. One ordered array under a
   * metadata key, the same storage as `markup`/`pricing` -- array order
   * *is* the invoice's order, Ken's to arrange, not an incidental artifact
   * of how the list happens to be stored.
   *
   * Empty by default. This stage adds the capability; `calculateDraftQuote`
   * folds these in alongside the four hard-coded fees, so a database that
   * has never called `saveCatalogueLines` prices exactly as it does today.
   */
  getCatalogueLines() {
    return this.getMeta('pricingLines') ?? []
  }

  /**
   * Replace the whole ordered list -- the owner's screen (#354, stage 2)
   * sends the list as it wants it to read, add/edit/reorder/disable all at
   * once, the same shape `saveMarkup`/`savePricingSettings` already use for
   * a single settings object. `id` is stable across a rename: a request
   * that already chose an optional line references it by id, so keeping
   * the id and only changing the label must not turn that reference into a
   * new, different line.
   *
   * `isPlaceholder` does not exist on a line Ken authors himself (#354): the
   * flag exists to mark a number this codebase invented, and his own entry
   * has nothing to disclaim. It does exist, carried across from the setting
   * it came from, on a line `seedCatalogueLines` wrote on his behalf --
   * that number is ours wearing his name until he actually edits it
   * (pricing-catalogue.md's amendment to #354, stage 2). This method computes
   * the flag itself from whether the amount actually changed; it is never
   * trusted from the caller, the same rule `savePricingSettings` already
   * applies to `disposalFeeIsPlaceholder` -- otherwise saving the whole list
   * (this replaces it wholesale) without touching a seeded line's amount
   * would silently clear its flag just by echoing it back unchanged.
   */
  saveCatalogueLines(input) {
    if (!Array.isArray(input)) throw new InputError('Send the catalogue as a list of lines.')
    if (input.length > CATALOGUE_LINE_LIMIT) throw new InputError(`A catalogue may hold at most ${CATALOGUE_LINE_LIMIT} lines.`)

    const previous = new Map(this.getCatalogueLines().map(line => [line.id, line]))
    const seenIds = new Set()
    const lines = input.map((line, index) => {
      if (!line || typeof line !== 'object') throw new InputError(`Line ${index + 1} is not valid.`)
      const label = typeof line.label === 'string' ? line.label.trim() : ''
      if (!label || label.length > 200) throw new InputError(`Line ${index + 1} needs a label under 200 characters.`)
      if (!Number.isInteger(line.amountCents) || line.amountCents < 0 || line.amountCents > 10_000_000) {
        throw new InputError(`Line ${index + 1} needs a whole-cent amount between $0 and $100,000.`)
      }
      if (!CATALOGUE_LINE_BASES.includes(line.basis)) {
        throw new InputError(`Line ${index + 1} needs a basis of ${CATALOGUE_LINE_BASES.join(' or ')}.`)
      }
      if (!CATALOGUE_LINE_MODES.includes(line.mode)) {
        throw new InputError(`Line ${index + 1} needs a mode of ${CATALOGUE_LINE_MODES.join(' or ')}.`)
      }
      if (typeof line.taxable !== 'boolean') throw new InputError(`Line ${index + 1} needs taxable to be true or false.`)
      if (typeof line.enabled !== 'boolean') throw new InputError(`Line ${index + 1} needs enabled to be true or false.`)

      const amountOverrides = { sizes: {}, skus: {} }
      for (const scope of ['sizes', 'skus']) {
        const values = line.amountOverrides?.[scope] ?? {}
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          throw new InputError(`Line ${index + 1} ${scope} overrides must be an object.`)
        }
        for (const [target, amountCents] of Object.entries(values)) {
          if (!target.trim() || !Number.isInteger(amountCents) || amountCents < 0 || amountCents > 10_000_000) {
            throw new InputError(`Line ${index + 1} has an invalid ${scope} override.`)
          }
          amountOverrides[scope][scope === 'skus' ? target.trim().toLowerCase() : target.trim()] = amountCents
        }
      }

      // A new line (from the owner screen's "add line") arrives with no id;
      // an existing one keeps the id it was given here on its first save.
      const id = typeof line.id === 'string' && line.id.trim() ? line.id.trim() : randomBytes(8).toString('hex')
      if (seenIds.has(id)) throw new InputError(`Line ${index + 1} repeats an id already used by another line in this save.`)
      seenIds.add(id)

      const shaped = { id, label, amountCents: line.amountCents, basis: line.basis, mode: line.mode, taxable: line.taxable, enabled: line.enabled }
      if (Object.keys(amountOverrides.sizes).length || Object.keys(amountOverrides.skus).length) shaped.amountOverrides = amountOverrides

      const existing = previous.get(id)
      if (existing && 'isPlaceholder' in existing) {
        // Untouched amount: the flag survives. Changed amount: Ken just set
        // it, so the flag is gone for good -- omitted, not set to false, the
        // same "absent, not a placeholder" shape the rest of pricing uses.
        if (existing.amountCents === line.amountCents) shaped.isPlaceholder = existing.isPlaceholder
      } else if (!existing && line.isPlaceholder === true) {
        // No previous line to compare against: this is seedCatalogueLines's
        // own first write, the one caller allowed to assert the flag
        // directly rather than have it computed.
        shaped.isPlaceholder = true
      }

      return shaped
    })

    this.setMeta('pricingLines', lines)
    return lines
  }

  /**
   * One-time, at construction: fold the two settings-based fees into
   * catalogue entries so `calculateDraftQuote` can drop its own hardcoded
   * versions of them without a customer ever seeing a quote missing a line
   * (#354 stage 2). Runs only while the catalogue is empty -- idempotent by
   * construction, asking the database what it actually has rather than
   * counting on a version flag, the same idiom `Quotes.migrate()` uses.
   *
   * Mobile service seeds unconditionally. `calculateDraftQuote`'s own line
   * for it was unconditional too -- `isPlaceholder` marks the number, never
   * whether the fee applies -- so a fresh database with no pricing ever
   * saved still needs a mobile-service line, or a draft comes out light by
   * exactly that fee the moment the hardcoded line is gone. Disposal seeds
   * only when a fee is actually set: an unset disposal fee is not a
   * placeholder number, it is an absent optional line, exactly as it reads
   * today.
   *
   * Both carry the tax classification those two lines have always had
   * (`'services'`, from the original hardcoded `taxClass`) rather than a
   * guess, and both carry whichever setting's own `isPlaceholder` state --
   * a seeded line is our number wearing Ken's name until he edits it.
   */
  seedCatalogueLines() {
    if (this.getCatalogueLines().length > 0) return
    const pricing = this.getPricingSettings()
    const taxableAsServices = Boolean(pricing.tax) && (pricing.tax.appliesTo === 'all' || pricing.tax.appliesTo === 'services')
    const seeds = [
      {
        id: 'mobile-service', label: 'Mobile service fee', amountCents: Math.round(pricing.mobileServiceFee * 100),
        basis: 'perJob', mode: 'automatic', taxable: taxableAsServices, enabled: true,
        isPlaceholder: pricing.mobileServiceFeeIsPlaceholder,
      },
      ...(pricing.disposalFee !== null ? [{
        id: 'disposal', label: 'Old tire disposal', amountCents: Math.round(pricing.disposalFee * 100),
        basis: 'perTire', mode: 'optional', taxable: taxableAsServices, enabled: true,
        isPlaceholder: pricing.disposalFeeIsPlaceholder,
      }] : []),
    ]
    this.saveCatalogueLines(seeds)
  }

  /**
   * Check a snapshot in the shape scripts/scrape-tires.mjs writes, and group
   * its rows by size. Throws before anything is written, so a bad row cannot
   * leave half a snapshot in the database.
   */
  validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== 'giga-tires.com' ||
        !Array.isArray(snapshot.tires) || !Number.isFinite(Date.parse(snapshot.scrapedAt))) {
      throw new InputError('Invalid supplier snapshot')
    }
    // Per-size coverage is what the scraper writes since it started recording
    // what it read; older files have none and are treated as partial.
    if (snapshot.coverage !== undefined &&
        (typeof snapshot.coverage !== 'object' || snapshot.coverage === null || Array.isArray(snapshot.coverage))) {
      throw new InputError('Invalid supplier snapshot')
    }
    const bySize = new Map()
    for (const tire of snapshot.tires) {
      const normalized = { ...tire, description: cleanCatalogDescription(tire?.description) }
      validateTire(normalized, normalized.size)
      if (!bySize.has(normalized.size)) bySize.set(normalized.size, [])
      bySize.get(normalized.size).push(normalized)
    }
    for (const size of bySize.keys()) {
      if (!this.sizes.includes(size)) throw new InputError('Snapshot contains unsupported sizes')
    }
    if (new Set(snapshot.tires.map(t => t.id)).size !== snapshot.tires.length) throw new InputError('Duplicate supplier IDs')
    return bySize
  }

  importSnapshot(snapshot) {
    if (this.getMeta('seeded')) return
    const bySize = this.validateSnapshot(snapshot)
    this.transaction(() => {
      for (const [size, tires] of bySize) this.writeSize(size, tires, snapshot.scrapedAt, false)
      this.setMeta('seeded', { at: now(), snapshotAt: snapshot.scrapedAt })
    })
  }

  /**
   * Apply a snapshot to a database that already has one.
   *
   * importSnapshot seeds an empty database once and then steps aside, which
   * is right for the tracked file but leaves no way to get a scrape run on
   * someone's own machine into a server that is already up. This is that
   * way. It writes through the same writeSize a refresh uses, so owner
   * offers and prices are untouched and a row is never deleted.
   *
   * By default a size is treated as a *partial* view -- the scraper keeps the
   * cheapest few per size -- so rows the snapshot does not mention stay
   * active. `complete` says the snapshot is the supplier's whole listing for
   * each size it covers, and retires the rest as a refresh would. A dry run
   * reports what would change and writes nothing.
   */
  applySnapshot(snapshot, { complete = false, dryRun = false } = {}) {
    const bySize = this.validateSnapshot(snapshot)
    if (!bySize.size) throw new InputError('The snapshot holds no tires; nothing to import')
    // Retiring what a size does not list is only right when the scraper read
    // the whole size: no limit, every page. The file says whether it did. The
    // CLI refuses this first with a fuller message; this is the door itself.
    if (complete) {
      for (const size of bySize.keys()) {
        if (snapshot.coverage?.[size]?.complete !== true) {
          throw new InputError(`${size} was not scraped completely (every page, no limit), so its missing tires cannot be retired. Import it without complete, or scrape it again with --limit 0.`)
        }
      }
    }

    const report = []
    for (const [size, tires] of bySize) {
      const existing = new Map(this.db.prepare('SELECT id, payload, active FROM supplier WHERE size=?').all(size)
        .map(row => [row.id, row]))
      const counts = { size, tires: tires.length, added: 0, changed: 0, unchanged: 0, retired: 0 }
      for (const tire of tires) {
        const old = existing.get(tire.id)
        if (!old) counts.added++
        else if (!old.active || old.payload !== JSON.stringify(tire)) counts.changed++
        else counts.unchanged++
      }
      if (complete) {
        const incoming = new Set(tires.map(t => t.id))
        counts.retired = [...existing.values()].filter(row => row.active && !incoming.has(row.id)).length
      }
      report.push(counts)
    }

    if (!dryRun) {
      // One transaction for the whole file: a snapshot either lands or it does
      // not. Validation has already run, so the only failure left is a SKU
      // that changed size, and half a file is not a useful answer to that.
      this.transaction(() => {
        for (const [size, tires] of bySize) this.writeSize(size, tires, snapshot.scrapedAt, complete)
      })
      const at = now()
      this.setMeta('job', {
        id: `snapshot-${at}`, status: 'completed', sizes: [...bySize.keys()], completed: bySize.size, failed: [],
        tiresRead: snapshot.tires.length, pagesRead: 0, currentSize: null, startedAt: at, finishedAt: at,
        message: `Imported ${snapshot.tires.length} tires across ${bySize.size} size${bySize.size === 1 ? '' : 's'} from a snapshot scraped ${snapshot.scrapedAt}.`,
      })
    }

    return { dryRun, complete, scrapedAt: snapshot.scrapedAt, tires: snapshot.tires.length, sizes: report }
  }

  // Only a complete, validated size refresh may retire missing supplier rows.
  writeSize(size, tires, timestamp, complete) {
    if (complete) this.db.prepare('UPDATE supplier SET active=0 WHERE size=?').run(size)
    const insert = this.db.prepare(`INSERT INTO supplier VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, last_seen=excluded.last_seen, active=1`)
    for (const tire of tires) {
      const normalized = { ...tire, description: cleanCatalogDescription(tire.description) }
      const old = this.db.prepare('SELECT size FROM supplier WHERE id=?').get(tire.id)
      if (old && old.size !== size) throw new InputError('Supplier SKU changed size; refresh rejected')
      insert.run(normalized.id, size, JSON.stringify(normalized), timestamp)
    }
    this.db.prepare(`INSERT INTO coverage VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(size) DO UPDATE SET last_success=excluded.last_success,
        completeness=excluded.completeness, error=NULL, attempted_at=excluded.attempted_at`)
      .run(size, timestamp, complete ? 'full' : 'snapshot', timestamp)
  }

  refreshSize(size, tires) {
    if (!this.sizes.includes(size)) throw new InputError('Unsupported tire size')
    if (!tires.length) throw new InputError('No priced tires returned; previous inventory kept')
    tires.forEach(tire => validateTire(tire, size))
    if (new Set(tires.map(t => t.id)).size !== tires.length) throw new InputError('Duplicate supplier IDs')
    this.transaction(() => this.writeSize(size, tires, now(), true))
  }

  recordFailure(size, error) {
    this.db.prepare(`INSERT INTO coverage VALUES (?, NULL, 'none', ?, ?)
      ON CONFLICT(size) DO UPDATE SET error=excluded.error, attempted_at=excluded.attempted_at`)
      .run(size, error, now())
  }

  list({ search = '', size = '', filter = 'all', page = 1, sort = '', dir = '', pageSize: askedPageSize } = {}) {
    const conditions = [], args = []
    if (size) { conditions.push('s.size=?'); args.push(size) }
    if (search) {
      conditions.push("(lower(json_extract(s.payload,'$.name')) LIKE ? OR lower(s.id) LIKE ?)")
      args.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`)
    }
    if (filter === 'offered') conditions.push('o.enabled=1')
    if (filter === 'unselected') conditions.push('COALESCE(o.enabled,0)=0')
    // Priced, and not for sale. NOT a subset of `unselected` in meaning even
    // though it is in SQL: `unselected` is "nobody has chosen this", which is
    // the normal state of a tire, while this is "you named a price for a tire
    // a customer cannot buy", which is never something anyone intends. It is
    // the state the old grid could not show and the one a deliberate repair
    // has to work from.
    if (filter === 'priced-not-offered') conditions.push('COALESCE(o.enabled,0)=0 AND o.price_cents IS NOT NULL')
    if (filter === 'available') conditions.push("s.active=1 AND json_extract(s.payload,'$.inStock')=1 AND json_extract(s.payload,'$.source.stock')>0")
    // Photo filters. `photo` means a publication row exists at all, not that a
    // customer can see it -- hidden, stale and pending rows still answer yes,
    // because the owner filtering for "tires with photos" is looking for the
    // ones there is something to manage on. `no-photo` is its exact complement,
    // so the two partition the catalogue with nothing falling between them.
    if (filter === 'photo') conditions.push('ip.supplier_id IS NOT NULL')
    if (filter === 'no-photo') conditions.push('ip.supplier_id IS NULL')
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const from = `FROM supplier s LEFT JOIN offers o ON o.id=s.id ${PHOTO_JOIN} ${where}`
    const total = this.db.prepare(`SELECT count(*) AS n ${from}`).get(...args).n
    const asked = Math.floor(Number(askedPageSize))
    const pageSize = PAGE_SIZES.includes(asked) ? asked : DEFAULT_PAGE_SIZE
    // The sort the query actually ran, not the one that was asked for. An
    // unknown key silently falls back, so the caller has to be told which one
    // it got: a header rendering an arrow on a column the server ignored is a
    // screen lying about what it did.
    const applied = orderBy(sort, dir)
    const currentPage = Math.max(1, Math.min(Math.floor(Number(page)) || 1, Math.max(1, Math.ceil(total / pageSize))))
    // `o.id` is the only honest test for "does an offers row exist at all".
    // Every other offer column is nullable in its own right, so a NULL there
    // cannot tell a row Ken has never touched from one he has. `catalog()`
    // makes the same test the same way, and the whole distinction below turns
    // on it.
    const rows = this.db.prepare(`SELECT s.*, o.id AS offer_id, o.price_cents, o.shipping_cents, o.enabled, o.notes, o.version,
        o.category_override, o.description_override,
        o.updated_at AS offer_updated_at, ${MARGIN_CENTS} AS margin_cents, ${PHOTO_COLUMNS} ${from}
      ORDER BY ${applied.order} LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (currentPage - 1) * pageSize)
    // Read once for the whole page, not once per row: `getMarkup()` hits the
    // meta table, and a 200-row page would otherwise make 200 reads of a value
    // that cannot change mid-query.
    const settings = this.getMarkup()
    return { items: rows.map(row => {
      const payload = JSON.parse(row.payload)
      // What a CUSTOMER is being sold right now -- answered by `quotedPrice`,
      // called here exactly as `catalog()` calls it, rather than by a second
      // expression of the markup rule that could drift from the first.
      //
      // This field exists because the two beside it are both wrong about an
      // untouched row, and wrong in the same direction. A tire with no
      // `offers` row has `o.enabled` NULL, so `offer.enabled` below is `false`
      // and the screen draws an empty "Offered" box; it has no `o.price_cents`
      // either, so "Your price" draws an em-dash. Together they read as "not
      // for sale, no price". `catalog()` disagrees, deliberately and
      // correctly: a missing offers row is nobody's decision, not a
      // deselection, so the tire IS for sale at the price the markup rule
      // proposes. Measured against a freshly seeded database: the customer
      // catalogue was selling 1,083 of 1,083 rows while this screen showed
      // every one of them unoffered and unpriced.
      //
      // `offer` is left exactly as it was -- it means what Ken has decided,
      // which is a real and separate question. This says what is happening.
      const offer = row.offer_id === null || row.offer_id === undefined
        ? undefined
        : { priceCents: row.price_cents ?? null, enabled: !!row.enabled }
      const quoted = quotedPrice({
        supplierPrice: payload.price, offer,
        tire: { ...payload, shippingPerTire: row.shipping_cents === null || row.shipping_cents === undefined ? undefined : row.shipping_cents / 100 },
        settings,
      })
      return {
      ...payload, lastSeen: row.last_seen, supplierActive: !!row.active,
      // `source` is 'owner' when Ken priced it and 'markup' when the rule did,
      // which is the difference between a decision and a suggestion nobody has
      // looked at -- markup.js exposes it for exactly that reason. No margin
      // figure is derived here: markup.js is explicit that shipping is a
      // freight pass-through and not goods margin, so subtracting cost from a
      // marked-up price would report freight as profit. Deriving it properly
      // means knowing the rule's shape, and the rule's shape is the pricing
      // lane's to change, not this one's.
      selling: {
        priceCents: quoted.price === null ? null : Math.round(quoted.price * 100),
        source: quoted.source,
        offered: quoted.offered,
      },
      // Derived, never stored, and deliberately OUTSIDE `offer`: that object is
      // the shape the owner screen submits back, asserted field-for-field in
      // four existing tests, and widening it would make a read-only column look
      // like something to send. The margin the grid renders is the identical
      // SQL expression the sort orders by, so the column and the order cannot
      // disagree. NULL for a tire with no price.
      marginCents: row.margin_cents ?? null, offerUpdatedAt: row.offer_updated_at ?? null,
      // Read-only, and outside `offer` for the same reason marginCents is: the
      // screen submits `offer` back field-for-field, and a photo is changed
      // through its own route, not by saving a price.
      photo: photoState(row, payload),
      // INSIDE `offer`, unlike marginCents and photo above, because these two
      // really are submitted back: they are corrections the owner makes and
      // saves on the same round trip as a price. NULL means "no correction",
      // which is a different thing from an empty string -- the screen renders
      // the supplier's own value in that case, and sends null to return to it.
      offer: { priceCents: row.price_cents ?? null, shippingCents: row.shipping_cents ?? null, enabled: !!row.enabled,
        notes: row.notes ?? '', categoryOverride: row.category_override ?? null,
        descriptionOverride: row.description_override ?? null, version: row.version ?? 0 },
      }
    }), total, page: currentPage, pageSize, sort: applied.sort, dir: applied.dir }
  }

  saveOffer(id, input) {
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.version) || input.version < 0 ||
        typeof input.notes !== 'string' || input.notes.length > 2000 ||
        (input.priceCents !== null && (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 10000000)) ||
        (input.shippingCents !== undefined && input.shippingCents !== null &&
          (!Number.isInteger(input.shippingCents) || input.shippingCents < 0 || input.shippingCents > 20000))) {
      throw new InputError('Enter a positive KMT price and a shipping override from $0 to $200; use at most two decimal places.')
    }
    // The two corrections get their OWN refusals rather than joining the
    // condition above. That message names a price and a shipping figure; a
    // caller who mistyped a category and was told to check their decimal
    // places would have no way to find what was actually wrong.
    if (input.categoryOverride !== undefined && input.categoryOverride !== null &&
        !OVERRIDE_CATEGORIES.includes(input.categoryOverride)) {
      throw new InputError(`Choose a season from: ${OVERRIDE_CATEGORIES.join(', ')} -- or clear it to use the supplier's.`)
    }
    if (input.descriptionOverride !== undefined && input.descriptionOverride !== null &&
        (typeof input.descriptionOverride !== 'string' || !input.descriptionOverride.trim() ||
          input.descriptionOverride.length > DESCRIPTION_OVERRIDE_LIMIT)) {
      // A blank string is refused, not quietly stored: it would render as a
      // tire with no description at all, which is not something anybody means
      // to publish. Clearing the box means "use the supplier's", and the way
      // to say that is null.
      throw new InputError(`Write a description of up to ${DESCRIPTION_OVERRIDE_LIMIT} characters, or clear it to use the supplier's.`)
    }
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM supplier WHERE id=?').get(id)) throw new InputError('Tire not found', 404)
      const current = this.db.prepare('SELECT version, shipping_cents, category_override, description_override FROM offers WHERE id=?').get(id)
      if ((current?.version ?? 0) !== input.version) throw new InputError('This offer changed in another window. Reload inventory before saving.', 409)
      // `undefined` means the caller did not mention this field and what is
      // already stored stands; `null` means the caller cleared it. The
      // distinction is not decoration -- the bulk price path and every older
      // client send a body with no override keys at all, and reading those as
      // "set both to null" would wipe every correction Ken has made across up
      // to 200 rows per request. This is the same idiom `shippingCents` above
      // has used since it was added, for the same reason.
      const keep = (given, held) => (given === undefined ? (held ?? null) : given)
      const shippingCents = input.shippingCents === undefined ? (current?.shipping_cents ?? null) : input.shippingCents
      const categoryOverride = keep(input.categoryOverride, current?.category_override)
      const descriptionOverride = keep(input.descriptionOverride, current?.description_override)
      this.db.prepare(`INSERT INTO offers (id, price_cents, shipping_cents, enabled, notes, category_override, description_override, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET price_cents=excluded.price_cents, enabled=excluded.enabled,
          shipping_cents=excluded.shipping_cents, notes=excluded.notes,
          category_override=excluded.category_override, description_override=excluded.description_override,
          version=excluded.version, updated_at=excluded.updated_at`)
        .run(id, input.priceCents, shippingCents, Number(input.enabled), input.notes,
          categoryOverride, descriptionOverride, input.version + 1, now())
      return { ...input, shippingCents, categoryOverride, descriptionOverride, version: input.version + 1 }
    })
  }

  /**
   * Save many offers in one call, each row on its own terms.
   *
   * PARTIAL SUCCESS IS THE NORMAL CASE here, and it is why this is a loop of
   * transactions rather than one transaction around a loop. The obvious
   * implementation wraps the whole batch, which quietly turns one stale row
   * out of forty into forty rows that did not save -- so if you are tempted to
   * "tidy" this into a single transaction later, that is the behaviour you
   * would be changing. If 38 of 40 save, those 38 stay saved and the owner is
   * told which 2 did not.
   *
   * Every row keeps the version check `saveOffer` makes. A bulk write that
   * skipped it would be faster and would also be a safety regression across
   * thousands of rows of the owner's pricing; the unconditional brand toggle
   * below is a wart, not a precedent.
   *
   * Failures answer with a machine `reason` AND a human `message`. The code is
   * the contract the screen marks rows from -- matching on message text means
   * a copy edit to an error string silently stops failed rows rendering as
   * failed.
   *
   * Three refusals reject the whole request instead of answering per row,
   * because none of them is an outcome for a tire. Over the cap and a missing
   * id are client bugs. A duplicate id is subtler: the second write to one
   * tire is guaranteed to fail the version check the first just bumped, so it
   * would report a mystery conflict on a row that saved perfectly.
   */
  saveOffers(input) {
    const offers = input?.offers
    if (!Array.isArray(offers) || !offers.length) throw new InputError('Send at least one offer to save.')
    if (offers.length > BULK_OFFER_LIMIT) throw new InputError(`Save at most ${BULK_OFFER_LIMIT} tires at once.`)
    const ids = offers.map(offer => offer?.id)
    if (ids.some(id => typeof id !== 'string' || !id)) throw new InputError('Every offer needs a tire id.')
    if (new Set(ids).size !== ids.length) throw new InputError('Send each tire once per request.')
    return { results: offers.map(({ id, ...offer }) => {
      try {
        return { id, ok: true, version: this.saveOffer(id, offer).version }
      } catch (error) {
        // `failed` covers what is neither the owner's input nor a stale
        // version -- a disk error, say. Reporting it per row rather than
        // throwing keeps the answer honest about the rows that DID commit:
        // abandoning the response mid-batch would leave the screen unable to
        // tell which of them saved.
        const reason = error instanceof InputError
          ? BULK_REASONS[error.status] ?? 'invalid'
          : 'failed'
        return { id, ok: false, reason, message: error instanceof InputError ? error.message : 'This tire could not be saved.' }
      }
    }) }
  }

  /**
   * Every brand with at least one supplier row, most tires first -- the
   * ones a bulk action saves the most taps on come first. Brand is not a
   * column: it is derived from `source.url` at read time (see
   * `src/data/brand.js`), which at 1,083 rows is sub-millisecond and needs
   * no migration. This is the data a brand picker and its confirmation
   * numbers are built from; it changes nothing.
   */
  brandSummary() {
    const rows = this.db.prepare(`
      SELECT s.id, json_extract(s.payload,'$.source.url') AS url, s.size, o.enabled, o.price_cents
      FROM supplier s LEFT JOIN offers o ON o.id=s.id
    `).all()
    const byBrand = new Map()
    for (const row of rows) {
      const brand = deriveBrand(row.url)
      if (!brand) continue
      if (!byBrand.has(brand.slug)) {
        byBrand.set(brand.slug, { brand: brand.slug, label: brand.label, count: 0, sizes: new Set(), enabledCount: 0, missingPriceCount: 0 })
      }
      const entry = byBrand.get(brand.slug)
      entry.count++
      entry.sizes.add(row.size)
      if (row.enabled) entry.enabledCount++
      if (row.price_cents == null) entry.missingPriceCount++
    }
    return [...byBrand.values()]
      .map(({ sizes, ...entry }) => ({ ...entry, sizeCount: sizes.size }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }

  /**
   * Enable or disable every supplier row for one brand, in one transaction.
   *
   * Touches only `enabled`, `version` and `updated_at` on each row -- never
   * `price_cents` or `notes` -- so a price Ken already set survives a bulk
   * toggle untouched (proven below: an upsert that lists those two columns
   * in its `ON CONFLICT` `SET` clause is the one bug this method cannot
   * afford, so they are not there.)
   *
   * Deliberately does NOT reuse `saveOffer`'s "enabled requires a price"
   * rule. That rule exists so a single-row save cannot silently leave a
   * tire enabled with nothing to sell it at; here the equivalent question --
   * how many of these have no price and will be priced by markup -- is
   * answered by `brandSummary()` and shown to the owner *before* this runs,
   * not enforced by refusing the write. A bulk-enable of an unpriced brand
   * is exactly what the confirmation screen exists to make an informed
   * choice about, not a case this method blocks.
   */
  setBrandEnabled(brandSlug, enabled) {
    if (typeof enabled !== 'boolean') throw new InputError('enabled must be true or false')
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT s.id, json_extract(s.payload,'$.source.url') AS url, o.price_cents
        FROM supplier s LEFT JOIN offers o ON o.id=s.id
      `).all()
      const matched = rows.filter(row => deriveBrand(row.url)?.slug === brandSlug)
      if (!matched.length) throw new InputError(`No supplier tires found for brand "${brandSlug}"`, 404)
      const at = now()
      const upsert = this.db.prepare(`
        INSERT INTO offers (id, price_cents, enabled, notes, version, updated_at) VALUES (?, NULL, ?, '', 1, ?)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, version=offers.version+1, updated_at=excluded.updated_at
      `)
      let missingPriceCount = 0
      for (const row of matched) {
        upsert.run(row.id, Number(enabled), at)
        if (row.price_cents == null) missingPriceCount++
      }
      return { brand: brandSlug, enabled, updated: matched.length, missingPriceCount }
    })
  }

  /**
   * What a customer may be shown: every tire that is offered and has a price,
   * optionally narrowed to one size.
   *
   * The same rows the owner curates, reduced to what a quote needs. Unpaginated
   * on purpose -- list() pages because a person scrolls a screen, and this
   * answers a program that needs the whole catalog (or one size's worth of it)
   * to price a request.
   *
   * The mapping deliberately mirrors scrapedTiresFor() in src/data/catalog.js,
   * field for field, because the customer flow already runs on rows of that
   * shape and a second, subtly different shape is the kind of thing that only
   * shows up as a wrong price. Anything the supplier told us -- SKU, list
   * price, stock count, the URL we scraped -- stops here: the customer sees
   * KMT's price and nothing behind it. That is now also true of what SQLite
   * hands back: the query projects exactly these seven fields with
   * `json_extract` rather than the whole `payload` column, so a supplier's
   * extra bytes never cross into Node just to be parsed and discarded.
   *
   * A tire the supplier has stopped listing is kept and marked out of stock
   * rather than dropped. Dropping it would quietly shrink the catalog under a
   * customer mid-request; leaving it in stock would sell something nobody can
   * source. Out of stock is the honest answer, and the pricing rules already
   * route an out-of-stock choice to the owner instead of quoting it outright.
   */
  hasImagePackets() { return !!this.db.prepare('SELECT 1 FROM image_packets LIMIT 1').get() }

  catalog({ size = '' } = {}) {
    const settings = this.getMarkup()
    const imageUrls = approvedImageUrls(this.db)
    const modelImages = modelImageUrls(this.db, imageUrls)
    const where = size ? 'WHERE s.size=?' : ''
    const args = size ? [size] : []
    const rows = this.db.prepare(`SELECT
        json_extract(s.payload,'$.id') AS id,
        json_extract(s.payload,'$.name') AS name,
        s.size AS size,
        json_extract(s.payload,'$.price') AS price,
        json_extract(s.payload,'$.inStock') AS inStock,
        json_extract(s.payload,'$.category') AS category,
        json_extract(s.payload,'$.description') AS description,
        json_extract(s.payload,'$.source.url') AS source_url,
        s.active, o.id AS offer_id, o.price_cents, o.shipping_cents, o.enabled,
        o.category_override, o.description_override
      FROM supplier s LEFT JOIN offers o ON o.id=s.id
      ${where}
      ORDER BY s.size, name, s.id`).all(...args)

    const tires = []
    for (const row of rows) {
      // A missing offers row is not the same as a disabled one: a tire the
      // owner has never touched is still for sale at the marked-up price,
      // while one he switched off is a deliberate no.
      const offer = row.offer_id === null || row.offer_id === undefined
        ? undefined
        : { priceCents: row.price_cents ?? null, enabled: !!row.enabled }

      const { price, offered } = quotedPrice({
        supplierPrice: row.price, offer,
        tire: { ...row, shippingPerTire: row.shipping_cents === null || row.shipping_cents === undefined ? undefined : row.shipping_cents / 100 },
        settings,
      })
      if (price === null || !offered) continue

      // THE OWNER'S CORRECTION WINS, and it is read once here so that every
      // field derived from either one moves together. The supplier gets a tire
      // wrong in two ways a customer can see, and neither is fixable by
      // re-scraping because the supplier's own record is what is wrong:
      //
      //   - the CATEGORY. All three rows filed `off-road` in 225/50R17 are
      //     road tires (Bridgestone Turanza EverDrive, Pegasus HPX SPORT AS,
      //     Radar Dimax AS-9), so the shop was telling customers a touring
      //     tire is "built for dirt, gravel and mud". Filed wrong, it is also
      //     under the wrong season facet and the wrong sort.
      //   - the DESCRIPTION. Seven rows carry the supplier's own advertising
      //     instead of a description -- "Compare tires at a glance using our
      //     easy test score® system", which on this site reads as a scoring
      //     system Ken does not have.
      //
      // `??`, NOT `||`: an override is either set or it is NULL, and a future
      // empty-string override must not fall through to the supplier's text
      // silently. `saveOffer` refuses a blank one outright rather than storing
      // one, so the two agree, but only one of them says so at read time.
      const category = row.category_override ?? row.category
      const description = row.description_override ?? row.description

      tires.push({
        id: row.id,
        name: row.name,
        size: row.size,
        price,
        // Delisted at the supplier is out of stock here, whatever the last
        // snapshot said about it, and whether or not the owner priced it.
        // json_extract answers a JSON boolean as 0/1, not true/false.
        inStock: !!row.active && !!row.inStock,
        category,
        // Normalize at the customer boundary as well as ingress: historical
        // payloads are corrected immediately without rewriting production data.
        description: cleanCatalogDescription(description),
        // The customer's shop filters by brand, and a brand has to come from
        // somewhere the customer boundary can see. It is READ, not inferred:
        // `deriveBrand` takes the `<brand>-tires` segment out of the supplier's
        // own listing URL. Splitting the display name on its first space would
        // turn "Royal Black Racing Trac" into "Royal", which is not a brand,
        // and gets multi-word brands wrong silently.
        //
        // The URL itself never crosses this boundary -- only the label. A
        // supplier URL is private provenance and the catalogue is public.
        //
        // Omitted, not null, when the URL has no recognisable brand segment: a
        // filter should offer the brands that exist, and "null" is not one.
        ...(deriveBrand(row.source_url) ? { brand: deriveBrand(row.source_url).label } : {}),
        // The supplier's spec codes, decoded once here rather than parsed again
        // in a browser. `94V BSW` means nothing to somebody standing next to a
        // flat tyre; "Carries up to 1,653 lb per tire" does.
        //
        // BOTH FIELDS EXIST BECAUSE ONE OF THEM IS NOT ENOUGH. `specPoints` is
        // per-tire fact, and `specCategory` is the supplier's OWN label for the
        // tire -- "Touring", "Ultra High Performance All Season", "Racing".
        // The coarse `category` beside it has five values and 230 of the 323
        // tires in 225/50R17 are `all-season`, so a panel keyed on it showed
        // seven tires in ten the identical paragraph. The supplier's own label
        // has FOURTEEN values in that same size. The owner read the result on
        // his own site and said the descriptions were "the same generic New
        // England text for everything", which they were.
        //
        // Derived from the raw description that already crosses, so nothing
        // new about the tire is exposed -- only the same sentence, readable.
        // Omitted rather than empty when there is nothing to say.
        //
        // FROM THE OVERRIDDEN DESCRIPTION, which is what makes the owner's
        // edit reach the heading and the bullets rather than only the card's
        // small print. Deleting "Compare tires at a glance using our easy test
        // score® system · XL 98Y BSW" down to "XL 98Y BSW" is one edit that
        // fixes all three. There is no second control for the heading and
        // there should not be: two fields that both decide what the panel
        // calls a tire is how they come to disagree.
        ...specFields(description),
        // This row's own approved photo if it has one, otherwise a photo of the
        // SAME MODEL approved on one of its other sizes. A tire's product shot
        // is of the tread and sidewall pattern, which belongs to the model and
        // not to the size, so one photo is honest for every listing of it.
        //
        // The row's own photo always wins; the fallback only ever fills a gap.
        // Measured on production 2026-09-13, which is why this exists: 189
        // approved photos, every one of them attached to exactly one row, while
        // the 189 models they belong to span 2,528 listings. 2,339 rows were
        // showing a grey placeholder next to a photo of the same tire.
        ...(imageUrls.has(row.id)
          ? { imageUrl: imageUrls.get(row.id) }
          : modelImages.has(modelKey(row.name)) ? { imageUrl: modelImages.get(modelKey(row.name)) } : {}),
      })
    }
    return tires
  }

  /**
   * The sizes a bulk refresh may cover: those the supplier has already been
   * asked about, meaning they hold supplier rows or a coverage row (full,
   * snapshot, or a recorded failure). Everything else in `sizes` is a size the
   * customer selector can build, and there are 910 of those. Walking all of
   * them from the hosted machine is 910 page loads at a 1.5-second pause from
   * a datacenter address the supplier's firewall already dislikes, so the full
   * walk is a deliberate local action -- `npm run scrape-tires -- --from-catalog`
   * on a home connection, then `npm run import-tires` -- and the owner screen's
   * "Refresh all" stays inside this subset. Any single size can still be
   * refreshed on its own from the size filter; see Refresher.start.
   */
  refreshableSizes() {
    const known = new Set(this.db.prepare('SELECT size FROM supplier UNION SELECT size FROM coverage').all().map(row => row.size))
    return this.sizes.filter(size => known.has(size))
  }

  summary() {
    const coverage = this.db.prepare('SELECT * FROM coverage ORDER BY size').all()
    return {
      sizes: this.sizes, coverage,
      refreshableSizes: this.refreshableSizes(),
      supplierCount: this.db.prepare('SELECT count(*) AS n FROM supplier').get().n,
      offeredCount: this.db.prepare('SELECT count(*) AS n FROM offers WHERE enabled=1').get().n,
      // Tires that have a price and are NOT for sale. Reads nothing and
      // writes nothing; it is a count, deliberately not a repair.
      //
      // Before the fix above, this was the shape the defect left behind: the
      // grid sent `enabled: false` alongside every price the owner typed, so
      // a tire he priced ended up priced and off sale. `saveOffer` requires a
      // price to enable a row, so a priced row sitting at `enabled=0` is
      // either that bug or a tire he deliberately switched off after pricing
      // it -- and until the grid could show the difference, nobody could tell
      // which. This number is how big that pile is. Acting on it is Ken's
      // call, on rows he has looked at, with the controls this change makes
      // honest; it is explicitly NOT a sweep, because a blanket re-enable
      // would also turn on whatever he meant to switch off.
      pricedNotOfferedCount: this.db.prepare('SELECT count(*) AS n FROM offers WHERE enabled=0 AND price_cents IS NOT NULL').get().n,
      fullSizeCount: coverage.filter(c => c.completeness === 'full').length,
      importedSizeCount: coverage.filter(c => c.completeness === 'snapshot').length,
      job: this.getMeta('job'),
      // Carried on the inventory response so the screen can show the rule and
      // each tire's suggested price without a second round trip.
      markup: this.getMarkup(),
      // Same reasoning: the mobile fee, disposal and tax settings ride along
      // rather than needing their own request.
      pricing: this.getPricingSettings(),
      // Same reasoning: the owner's own quote lines (#354, stage 2) ride
      // along too, seeded by construction so this is never empty on a real
      // deploy.
      pricingLines: this.getCatalogueLines(),
      // Same reasoning: the brand picker's counts ride along rather than
      // needing their own request.
      brands: this.brandSummary(),
    }
  }

  close() { this.db.close() }
}
