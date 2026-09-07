import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

// The frontend's markup module owns the default rate and the shape of the
// rule. Importing it rather than restating 1.35 here means the two cannot
// drift into disagreeing about what an unconfigured catalog costs.
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'
import { DEFAULT_PRICING_SETTINGS, normalizePricingSettings } from '../src/pricing.js'
import { deriveBrand } from '../src/data/brand.js'

const DEFAULT_MARKUP_RATE = DEFAULT_MARKUP_SETTINGS.rate
const DEFAULT_SHIPPING_PER_TIRE = DEFAULT_MARKUP_SETTINGS.shippingPerTire

const CATALOGUE_LINE_BASES = ['perTire', 'perJob']
const CATALOGUE_LINE_MODES = ['automatic', 'optional']
const CATALOGUE_LINE_LIMIT = 25

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

const now = () => new Date().toISOString()

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
        id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        CHECK(price_cents IS NULL OR price_cents > 0)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL,
        error TEXT, attempted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    this.seedCatalogueLines()
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
   * rather than one flag for the whole object: `retailPrice` folds shipping
   * into the rate's own multiplication, so a proposed price is only as
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
      rateIsPlaceholder: true, shippingPerTireIsPlaceholder: true, isPlaceholder: true, updatedAt: null,
    }
    const hasShippingKey = Object.prototype.hasOwnProperty.call(stored, 'shippingPerTire')
    const rateIsPlaceholder = stored.rateIsPlaceholder ?? stored.isPlaceholder
    const shippingPerTireIsPlaceholder = stored.shippingPerTireIsPlaceholder ?? (hasShippingKey ? stored.isPlaceholder : true)
    return {
      ...stored,
      shippingPerTire: stored.shippingPerTire ?? DEFAULT_SHIPPING_PER_TIRE,
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
    const markup = {
      rate: Math.round(input.rate * 10000) / 10000,
      shippingPerTire: Math.round(shippingPerTire * 100) / 100,
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

      // A new line (from the owner screen's "add line") arrives with no id;
      // an existing one keeps the id it was given here on its first save.
      const id = typeof line.id === 'string' && line.id.trim() ? line.id.trim() : randomBytes(8).toString('hex')
      if (seenIds.has(id)) throw new InputError(`Line ${index + 1} repeats an id already used by another line in this save.`)
      seenIds.add(id)

      const shaped = { id, label, amountCents: line.amountCents, basis: line.basis, mode: line.mode, taxable: line.taxable, enabled: line.enabled }

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
        id: 'mobile-service', label: 'Mobile installation service', amountCents: Math.round(pricing.mobileServiceFee * 100),
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
      validateTire(tire, tire?.size)
      if (!bySize.has(tire.size)) bySize.set(tire.size, [])
      bySize.get(tire.size).push(tire)
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
      const old = this.db.prepare('SELECT size FROM supplier WHERE id=?').get(tire.id)
      if (old && old.size !== size) throw new InputError('Supplier SKU changed size; refresh rejected')
      insert.run(tire.id, size, JSON.stringify(tire), timestamp)
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

  list({ search = '', size = '', filter = 'all', page = 1 } = {}) {
    const conditions = [], args = []
    if (size) { conditions.push('s.size=?'); args.push(size) }
    if (search) {
      conditions.push("(lower(json_extract(s.payload,'$.name')) LIKE ? OR lower(s.id) LIKE ?)")
      args.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`)
    }
    if (filter === 'offered') conditions.push('o.enabled=1')
    if (filter === 'unselected') conditions.push('COALESCE(o.enabled,0)=0')
    if (filter === 'available') conditions.push("s.active=1 AND json_extract(s.payload,'$.inStock')=1 AND json_extract(s.payload,'$.source.stock')>0")
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const from = `FROM supplier s LEFT JOIN offers o ON o.id=s.id ${where}`
    const total = this.db.prepare(`SELECT count(*) AS n ${from}`).get(...args).n
    const pageSize = 24
    const currentPage = Math.max(1, Math.min(Math.floor(Number(page)) || 1, Math.max(1, Math.ceil(total / pageSize))))
    const rows = this.db.prepare(`SELECT s.*, o.price_cents, o.enabled, o.notes, o.version ${from}
      ORDER BY s.size, json_extract(s.payload,'$.name'), s.id LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (currentPage - 1) * pageSize)
    return { items: rows.map(row => ({
      ...JSON.parse(row.payload), lastSeen: row.last_seen, supplierActive: !!row.active,
      offer: { priceCents: row.price_cents ?? null, enabled: !!row.enabled,
        notes: row.notes ?? '', version: row.version ?? 0 },
    })), total, page: currentPage, pageSize }
  }

  saveOffer(id, input) {
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.version) || input.version < 0 ||
        typeof input.notes !== 'string' || input.notes.length > 2000 ||
        (input.priceCents !== null && (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 10000000)) ||
        (input.enabled && input.priceCents === null)) {
      throw new InputError('Enter a positive KMT price before offering a tire; use at most two decimal places.')
    }
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM supplier WHERE id=?').get(id)) throw new InputError('Tire not found', 404)
      const current = this.db.prepare('SELECT version FROM offers WHERE id=?').get(id)
      if ((current?.version ?? 0) !== input.version) throw new InputError('This offer changed in another window. Reload inventory before saving.', 409)
      this.db.prepare(`INSERT INTO offers VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET price_cents=excluded.price_cents, enabled=excluded.enabled,
          notes=excluded.notes, version=excluded.version, updated_at=excluded.updated_at`)
        .run(id, input.priceCents, Number(input.enabled), input.notes, input.version + 1, now())
      return { ...input, version: input.version + 1 }
    })
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
  catalog({ size = '' } = {}) {
    const settings = this.getMarkup()
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
        s.active, o.id AS offer_id, o.price_cents, o.enabled
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
        supplierPrice: row.price, offer, tire: row, settings,
      })
      if (price === null || !offered) continue

      tires.push({
        id: row.id,
        name: row.name,
        size: row.size,
        price,
        // Delisted at the supplier is out of stock here, whatever the last
        // snapshot said about it, and whether or not the owner priced it.
        // json_extract answers a JSON boolean as 0/1, not true/false.
        inStock: !!row.active && !!row.inStock,
        category: row.category,
        description: row.description,
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
