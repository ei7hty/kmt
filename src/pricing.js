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
function catalogueLineItems(catalogueLines, chosenLineIds, quantity, settings) {
  return catalogueLines
    .filter(entry => entry && typeof entry === 'object' && entry.enabled &&
      (entry.mode === 'automatic' || (entry.mode === 'optional' && chosenLineIds.includes(entry.id))) &&
      typeof entry.label === 'string' && Number.isInteger(entry.amountCents))
    .map(entry => ({
      description: entry.label,
      quantity: entry.basis === 'perTire' ? quantity : 1,
      unitPrice: entry.amountCents / 100,
      // The owner's own flag, never inferred -- see computeQuoteTotals.
      taxable: Boolean(settings.tax) && entry.taxable === true,
    }))
}

export function calculateDraftQuote(request, catalog = null, pricingSettings = DEFAULT_PRICING_SETTINGS, catalogueLines = [], chosenLineIds = []) {
  const tires = catalog || [getTireById(request?.tireSelection)].filter(Boolean)
  const tire = tires.find(item => item.id === request?.tireSelection)
  const quantity = quantityFor(request)
  const exceptionReasons = []

  if (!tire) {
    exceptionReasons.push('Selected tire was not found in the catalog')
  } else {
    if (!tire.inStock) {
      exceptionReasons.push('Selected tire is out of stock')
    }
    // Matched on category, not on a specific id. This was `tire.id === 'tire-5'`,
    // which was right when the catalog held six rows and silently wrong the
    // moment a second off-road tire existed.
    if (tire.category === 'off-road') {
      exceptionReasons.push('Off-road tire requires owner review')
    }
    // A supplier row's id always starts with giga-, set once at import and
    // never invented downstream (see src/data/scraped-tires.json and
    // backend/inventory.mjs). Everything else -- the six seeds, and every
    // generated row filling a size the supplier hasn't been asked about --
    // is a placeholder standing in for a tire that may not exist to buy. A
    // customer can still order one, but the owner has to look before it is
    // sent, the same gate a real out-of-stock or off-road tire goes through.
    if (!tire.id.startsWith('giga-')) {
      exceptionReasons.push('Not a supplier-listed tire; owner review required')
    }
  }

  if (EXCEPTION_VEHICLE_PATTERN.test(request?.vehicleInfo || '')) {
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
    // The visit costs the same whether it fits one tire or four: only the
    // tire line multiplies.
    ...(tire ? [{ description: tire.name, quantity, unitPrice: tire.price, taxable: taxableAs('goods', settings) }] : []),
    ...catalogueLineItems(catalogueLines, chosenLineIds, quantity, settings),
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