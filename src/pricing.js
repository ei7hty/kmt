import { getTireById } from './data/catalog.js'

export const MOBILE_SERVICE_FEE = 49.99

/** How many tires a request may ask for. One job, one visit either way. */
export const ALLOWED_QUANTITIES = [1, 2, 4]

const EXCEPTION_VEHICLE_PATTERN = /\b(truck|pickup|van|suv|f-\d+)\b/i

const roundCurrency = (amount) => Math.round(amount * 100) / 100

const isUsableAmount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Every number on a quote that is Ken's to set, per .forge/pricing-settings.md
 * (#289). `mobileServiceFee` moves the fee already being charged (was the
 * `MOBILE_SERVICE_FEE` constant above) into a setting he can change; it is
 * always charged, so `isPlaceholder` marks the number, not whether the fee
 * applies. `disposalFee` and `tax` default to `null` -- off -- because
 * neither has ever been charged before: `disposalFee` is customer opt-in
 * (see `disposeOldTires` in backend/quotes.mjs) and only appears once Ken
 * sets an amount, and `tax` is deliberately absent rather than a placeholder
 * -- "there is no such thing as a provisional tax rate on a document someone
 * pays against" -- until Ken's accountant answers what rate and which lines.
 */
export const DEFAULT_PRICING_SETTINGS = {
  mobileServiceFee: MOBILE_SERVICE_FEE,
  mobileServiceFeeIsPlaceholder: true,
  /** Per tire, opt-in by the customer. `null` means Ken has not set one, so the opt-in is not offered. */
  disposalFee: null,
  disposalFeeIsPlaceholder: true,
  /** `{ rate, appliesTo }` or `null` -- absent, not a placeholder, until Ken's accountant answers. */
  tax: null,
  updatedAt: null,
}

const VALID_TAX_APPLIES_TO = ['all', 'goods', 'services']

/**
 * Fill in anything the caller left out, and refuse a shape that would produce
 * nonsense -- the same discipline as `normalizeMarkupSettings` in
 * src/markup.js. A malformed setting falls back to the safe default (the fee
 * already charged, everything else off) rather than silently mispricing.
 */
export function normalizePricingSettings(settings) {
  const merged = { ...DEFAULT_PRICING_SETTINGS, ...(settings || {}) }
  if (!isUsableAmount(merged.mobileServiceFee) || merged.mobileServiceFee <= 0) {
    merged.mobileServiceFee = DEFAULT_PRICING_SETTINGS.mobileServiceFee
    merged.mobileServiceFeeIsPlaceholder = true
  }
  if (merged.disposalFee !== null && !isUsableAmount(merged.disposalFee)) {
    merged.disposalFee = null
  }
  if (merged.tax !== null) {
    const rateOk = typeof merged.tax.rate === 'number' && Number.isFinite(merged.tax.rate) && merged.tax.rate > 0 && merged.tax.rate < 1
    const appliesOk = VALID_TAX_APPLIES_TO.includes(merged.tax.appliesTo)
    merged.tax = rateOk && appliesOk ? { rate: merged.tax.rate, appliesTo: merged.tax.appliesTo } : null
  }
  return merged
}

/**
 * Requests built before quantity existed, and every call site that does not
 * care to pass one, mean one tire -- the fee for the visit either way.
 * `cleanRequest` in backend/quotes.mjs is the one place a customer's own
 * choice reaches this: it validates against ALLOWED_QUANTITIES and defaults
 * a missing one to 4, so a request that got this far already carries a
 * number from that list.
 */
const quantityFor = (request) => ALLOWED_QUANTITIES.includes(request?.quantity) ? request.quantity : 1

/**
 * The tires a request asks for, as one list -- the only shape anything
 * below this line reads (`.forge/staggered-fitment.md`, stage A).
 *
 * A request carrying a `tires` array (a staggered fitment: different tires
 * front and rear, one car, one visit) is read as that array. A request with
 * none -- every row stored today, and every browser running the bundle that
 * exists today -- becomes a one-element list built from its legacy
 * `tireSize`/`tireSelection`/`quantity` fields, here and nowhere else.
 *
 * Deliberately not two paths. Keeping the legacy fields priced alongside a
 * new array would leave one branch to be forgotten, and the forgotten one
 * prices a staggered request as four of the FRONT tire: a wrong number on a
 * real invoice that looks exactly like a working order. One list cannot
 * have that bug.
 *
 * An EMPTY array is not the same as no array (the OWNER AGENT's ruling on
 * this stage). Absent means "this request predates the field"; empty means
 * "this request names no tire", and the engine must not quietly turn the
 * second into the first: if a later stage writes the legacy fields alongside
 * the array for older readers, a client bug producing `tires: []` would
 * arrive with populated legacy fields, and pricing those would auto-send a
 * quote for a tire the customer did not ask for. So an empty array is an
 * empty list here, and `calculateDraftQuote` makes zero tires an exception
 * rather than a quote of nothing but fees.
 */
function tireEntriesFor(request) {
  const listed = Array.isArray(request?.tires)
    ? request.tires
    : [{ position: null, size: request?.tireSize ?? null, tireSelection: request?.tireSelection, quantity: request?.quantity }]
  return listed.map(entry => ({
    position: entry?.position ?? null,
    size: entry?.size ?? null,
    tireSelection: entry?.tireSelection,
    quantity: quantityFor(entry),
  }))
}

const NOT_FOUND = 'Selected tire was not found in the catalog'

/**
 * How a multi-entry reason names its tire: the position the request gave
 * ("Front", "Rear"), with the size beside it when there is one; the size
 * alone when there is no position; the entry's place in the list when
 * there is neither.
 */
function entryLabel(entry, index) {
  const position = typeof entry.position === 'string' && entry.position.trim()
    ? entry.position.trim().charAt(0).toUpperCase() + entry.position.trim().slice(1)
    : null
  const size = typeof entry.size === 'string' && entry.size.trim() ? entry.size.trim() : null
  if (position && size) return `${position} (${size})`
  return position ?? size ?? `Tire ${index + 1}`
}

/**
 * The exception reasons one tire entry raises, in the order they always
 * came, with the same words. `null` is a tire the catalog did not have.
 */
function tireExceptionReasons(tire) {
  if (!tire) return [NOT_FOUND]
  const reasons = []
  if (!tire.inStock) reasons.push('Selected tire is out of stock')
  // Matched on category, not on a specific id. This was `tire.id === 'tire-5'`,
  // which was right when the catalog held six rows and silently wrong the
  // moment a second off-road tire existed.
  if (tire.category === 'off-road') reasons.push('Off-road tire requires owner review')
  // A supplier row's id always starts with giga-, set once at import and
  // never invented downstream (see src/data/scraped-tires.json and
  // backend/inventory.mjs). Everything else -- the six seeds, and every
  // generated row filling a size the supplier hasn't been asked about --
  // is a placeholder standing in for a tire that may not exist to buy. A
  // customer can still order one, but the owner has to look before it is
  // sent, the same gate a real out-of-stock or off-road tire goes through.
  if (!tire.id.startsWith('giga-')) reasons.push('Not a supplier-listed tire; owner review required')
  return reasons
}

/**
 * Whether a fee this function generates itself (never a catalogue entry --
 * see below) is taxed, given the owner's `appliesTo` setting. `'all'` taxes
 * everything; `'goods'`/`'services'` taxes only a line of that own category.
 * Resolved to a plain boolean here, at the one place that knows what kind of
 * line this is, rather than inside `computeQuoteTotals` -- which has no way
 * to classify a tire and must not guess (#354's ruling on the correction to
 * #335: a catalogue line's own `taxable` flag governs itself, but the tire
 * and the built-in fees are not catalogue entries and need this instead).
 */
const taxableAs = (category, settings) =>
  Boolean(settings.tax) && (settings.tax.appliesTo === 'all' || settings.tax.appliesTo === category)

/**
 * An owner-authored catalogue entry (#354), included in a draft:
 * `mode: 'automatic'` always; `mode: 'optional'` only when its id is in
 * `chosenLineIds` -- what the customer picked, the same shape
 * `disposeOldTires` will generalize into once the wizard control exists.
 * Skips anything that does not look like a real entry rather than throwing:
 * `saveCatalogueLines` is what validates a write, and a draft must never
 * fail a customer's checkout over a malformed row already sitting in the
 * database from before this stage existed.
 */
function scopedAmountCents(entry, tire) {
  const overrides = entry.amountOverrides
  // Supplier tire ids are minted as `giga-${sku.toLowerCase()}` at import.
  // Resolve from that already-public stable id so the pricing catalog never
  // has to widen the customer tire shape with a raw supplier field.
  const sku = tire?.id?.startsWith('giga-') ? tire.id.slice(5) : tire?.source?.sku?.toLowerCase()
  if (sku && Number.isInteger(overrides?.skus?.[sku])) return overrides.skus[sku]
  if (tire?.size && Number.isInteger(overrides?.sizes?.[tire.size])) return overrides.sizes[tire.size]
  return entry.amountCents
}

/**
 * `entries` is the resolved tire list (`tireEntriesFor`, each with its
 * `tire` looked up). The fee ruling in `.forge/staggered-fitment.md` is
 * the owner's, and this is where it is applied:
 *
 * - A `perTire` fee is one line per entry, each scoped to its own tire and
 *   carrying its own quantity. Disposing of a 275 costs what disposing of a
 *   275 costs; one merged line could not carry two unit prices.
 * - A `perJob` fee is one line. With one distinct tire it is scoped to that
 *   tire exactly as it always was. With more than one distinct tire it is
 *   charged once at the site-wide `amountCents`, dropping SKU and size
 *   overrides: a per-visit fee scoped to "the tire" has no answer when there
 *   are two, and scoping it to the first entry would make the price of the
 *   visit depend on which tire the customer happened to pick first.
 *
 * A request with one entry -- every request that exists today -- therefore
 * produces exactly the lines it always produced, in the same order; that is
 * asserted in the tests, not assumed here.
 */
function catalogueLineItems(catalogueLines, chosenLineIds, entries, settings) {
  const distinct = new Set(entries.map(entry => entry.tireSelection)).size
  const taxable = entry => Boolean(settings.tax) && entry.taxable === true
  return catalogueLines
    .filter(entry => entry && typeof entry === 'object' && entry.enabled &&
      (entry.mode === 'automatic' || (entry.mode === 'optional' && chosenLineIds.includes(entry.id))) &&
      typeof entry.label === 'string' && Number.isInteger(entry.amountCents))
    .flatMap(entry => {
      if (entry.basis === 'perTire') {
        return entries.map(({ tire, quantity }) => ({
          description: entry.label,
          quantity,
          // Price specificity is independent of catalogue order: a deliberate
          // SKU exception wins over its size, which wins over the site-wide
          // parent amount. Reordering invoice lines can therefore never change
          // what the customer is charged.
          unitPrice: scopedAmountCents(entry, tire) / 100,
          // The owner's own flag, never inferred -- see computeQuoteTotals.
          taxable: taxable(entry),
        }))
      }
      return [{
        description: entry.label,
        quantity: 1,
        unitPrice: (distinct > 1 ? entry.amountCents : scopedAmountCents(entry, entries[0]?.tire)) / 100,
        taxable: taxable(entry),
      }]
    })
}

export function calculateDraftQuote(request, catalog = null, pricingSettings = DEFAULT_PRICING_SETTINGS, catalogueLines = [], chosenLineIds = []) {
  // The list is built first and is the only thing read from here down.
  const wanted = tireEntriesFor(request)
  const tires = catalog || wanted.map(entry => getTireById(entry.tireSelection)).filter(Boolean)
  const entries = wanted.map(entry => ({ ...entry, tire: tires.find(item => item.id === entry.tireSelection) ?? null }))

  // Every tire rule runs per entry, and the request is an exception if any
  // entry raises one: an off-road rear with a road-going front is still an
  // off-road job.
  //
  // With ONE entry the words are exactly what they always were -- that is
  // the byte-identical property this stage promises. With more than one,
  // each reason says which tire it is about, because the reasons are stored
  // on the quote and a position dropped here cannot be recovered by the
  // owner's screen later: two out-of-stock entries are two things for Ken
  // to look at, and he should not have to work out which from the lines.
  // Zero entries (an empty `tires` array) is the not-found reason, in the
  // same words, so a request naming no tire lands in his review queue and
  // never sends itself as a quote of nothing but fees.
  //
  // The `new Set` is LOAD-BEARING, not tidiness: the owner's screen renders
  // each reason with the string itself as its React key
  // (src/routes/QuoteRequests.jsx:321, `<li key={reason}>`). Two entries
  // with the same size and no position share a label, so the same rule on
  // both yields two identical strings -- and a duplicate key makes React
  // reuse the wrong node and render the list wrong, with no test failing.
  // Do not remove it; `pricing.test.mjs` pins the uniqueness.
  const exceptionReasons = entries.length === 0
    ? [NOT_FOUND]
    : [...new Set(entries.flatMap((entry, index) =>
      tireExceptionReasons(entry.tire).map(reason => entries.length > 1 ? `${entryLabel(entry, index)}: ${reason}` : reason)))]

  // The vehicle is optional at intake (backend/quotes.mjs REQUIRED), and that
  // is why the empty case is handled first rather than falling through. This
  // test is a REVIEW GATE: a truck, pickup, van or SUV is not auto-sendable.
  // An empty string matches no pattern, so leaving this as a bare .test() would
  // have quietly made every vehicle-less request auto-sendable -- the gate
  // removed for the requests that tell Ken the least. Not knowing is its own
  // reason to look.
  const vehicle = String(request?.vehicleInfo ?? '').trim()
  if (!vehicle) {
    exceptionReasons.push('No vehicle given; owner review required')
  } else if (EXCEPTION_VEHICLE_PATTERN.test(vehicle)) {
    exceptionReasons.push('Truck, pickup, van, and SUV requests require owner review')
  }

  const settings = normalizePricingSettings(pricingSettings)

  // The tire resolves its own taxable status via taxableAs ('goods') rather
  // than carrying a category for computeQuoteTotals to match later -- see
  // the comment on taxableAs. Every other line on a quote -- mobile service,
  // disposal, and anything else Ken adds -- is a catalogue entry (#354 stage
  // 2): calculateDraftQuote no longer hardcodes either built-in fee.
  // Inventory.seedCatalogueLines() guarantees a mobile-service entry exists
  // from the moment the database exists, so this is never the reason a
  // quote is missing that line; disposal is a catalogue entry the customer
  // opts into like any optional one, chosen via chosenLineIds rather than a
  // request field calculateDraftQuote itself reads.
  const lineItems = [
    // One line per tire entry the catalog could resolve, in the order the
    // request listed them (front, then rear). The visit costs the same
    // whether it fits one tire or four: only the tire lines multiply.
    ...entries.filter(entry => entry.tire).map(({ tire, quantity }) =>
      ({ description: tire.name, quantity, unitPrice: tire.price, taxable: taxableAs('goods', settings) })),
    ...catalogueLineItems(catalogueLines, chosenLineIds, entries, settings),
  ]

  const totals = computeQuoteTotals(lineItems, settings)

  return {
    requestId: request?.id || null,
    // taxClass is this function's own bookkeeping, not part of the quote's
    // stored or displayed shape -- every existing reader of lineItems (the
    // owner editor, the invoice renderer, the audits) expects exactly
    // description/quantity/unitPrice and nothing else.
    lineItems: lineItems.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice })),
    ...totals,
    exception: exceptionReasons.length > 0,
    exceptionReasons
  }
}

/**
 * `subtotal`/`tax`/`total` from a set of line items, and nothing else --
 * the one computation both the initial draft and a later owner adjustment
 * use, so a quote can never carry a total that disagrees with its own lines.
 *
 * Before this, `backend/quotes.mjs`'s `adjust()` re-added the lines by hand
 * to get `total` and left whatever `subtotal`/`tax` the draft had computed
 * sitting on the row unchanged -- correct only because tax has never been
 * turned on in production. The moment it is, an adjusted quote would store a
 * `total` that included tax while `subtotal` and `tax.amount` still named
 * the pre-adjustment numbers: a receipt that contradicts itself.
 *
 * `settings` is expected already normalized (`normalizePricingSettings`) --
 * `calculateDraftQuote` does this once and passes the result on, rather than
 * every caller normalizing again.
 *
 * Each line is expected to carry its own resolved `taxable: boolean` --
 * this function only sums, it never classifies. Classification is the
 * caller's job because it is the caller who knows what kind of line it has:
 * `calculateDraftQuote` resolves `taxable` for the tire and its own fees
 * against `appliesTo` via `taxableAs`, and for a catalogue line (#354) from
 * that line's own authored `taxable` flag -- an owner-authored line belongs
 * to none of `appliesTo`'s categories, so it must never be matched against
 * them. An owner adjustment's hand-typed lines (`backend/quotes.mjs`'s
 * `adjust()`) have no classification to give either, and that caller
 * resolves them to `taxable: appliesTo === 'all'` -- taxed only when tax
 * applies to everything, excluded otherwise rather than guessed at, per
 * pricing-settings.md's "an absent number is correctable, a wrong one is
 * not". The quote still carries a `tax` object naming the configured rate
 * and `appliesTo` (an amount of $0 if nothing on it was taxable), never a
 * total that silently omits tax nobody can tell is missing.
 */
export function computeQuoteTotals(lineItems, settings) {
  const lineTotal = (line) => roundCurrency(line.quantity * line.unitPrice)
  const subtotal = roundCurrency(lineItems.reduce((sum, line) => sum + lineTotal(line), 0))

  if (!settings.tax) return { subtotal, total: subtotal }

  const taxable = roundCurrency(lineItems.filter(line => line.taxable).reduce((sum, line) => sum + lineTotal(line), 0))
  const amount = roundCurrency(taxable * settings.tax.rate)
  const total = roundCurrency(subtotal + amount)
  return { subtotal, tax: { rate: settings.tax.rate, appliesTo: settings.tax.appliesTo, amount }, total }
}
