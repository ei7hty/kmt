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

export function calculateDraftQuote(request, catalog = null, pricingSettings = DEFAULT_PRICING_SETTINGS) {
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

  // Each line remembers which of Ken's accountant's two buckets it falls
  // into ('goods' for the tire, 'services' for labour and disposal) so tax,
  // when it is ever turned on, can apply to the right subset without this
  // function's caller having to know the taxonomy. Stripped before the line
  // reaches storage or a screen -- see below -- so it changes nothing about
  // what a quote looks like today.
  const lineItems = [
    // The visit costs the same whether it fits one tire or four: only the
    // tire line multiplies, the mobile-service fee stays one line at one price.
    ...(tire ? [{ description: tire.name, quantity, unitPrice: tire.price, taxClass: 'goods' }] : []),
    { description: 'Mobile installation service', quantity: 1, unitPrice: settings.mobileServiceFee, taxClass: 'services' },
    // Opt-in only (pricing-settings.md, "Disposal is opt-in"): the customer
    // chose this at the service step, and it only ever appears once Ken has
    // set a fee -- disposalFee is null until he does, and that is what "not
    // configured" looks like, not zero.
    ...(request?.disposeOldTires && settings.disposalFee !== null
      ? [{ description: 'Old tire disposal', quantity, unitPrice: settings.disposalFee, taxClass: 'services' }]
      : []),
  ]

  const lineTotal = (line) => roundCurrency(line.quantity * line.unitPrice)
  const subtotal = roundCurrency(lineItems.reduce((sum, line) => sum + lineTotal(line), 0))

  let tax
  let total = subtotal
  if (settings.tax) {
    const taxable = settings.tax.appliesTo === 'all'
      ? subtotal
      : roundCurrency(lineItems.filter(line => line.taxClass === settings.tax.appliesTo).reduce((sum, line) => sum + lineTotal(line), 0))
    const amount = roundCurrency(taxable * settings.tax.rate)
    tax = { rate: settings.tax.rate, appliesTo: settings.tax.appliesTo, amount }
    total = roundCurrency(subtotal + amount)
  }

  return {
    requestId: request?.id || null,
    // taxClass is this function's own bookkeeping, not part of the quote's
    // stored or displayed shape -- every existing reader of lineItems (the
    // owner editor, the invoice renderer, the audits) expects exactly
    // description/quantity/unitPrice and nothing else.
    lineItems: lineItems.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice })),
    subtotal,
    ...(tax ? { tax } : {}),
    total,
    exception: exceptionReasons.length > 0,
    exceptionReasons
  }
}