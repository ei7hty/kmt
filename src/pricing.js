import { getTireById } from './data/catalog.js'

export const MOBILE_SERVICE_FEE = 49.99

/** How many tires a request may ask for. One job, one visit either way. */
export const ALLOWED_QUANTITIES = [1, 2, 4]

const EXCEPTION_VEHICLE_PATTERN = /\b(truck|pickup|van|suv|f-\d+)\b/i

const roundCurrency = (amount) => Math.round(amount * 100) / 100

/**
 * Requests built before quantity existed, and every call site that does not
 * care to pass one, mean one tire -- the fee for the visit either way.
 * `cleanRequest` in backend/quotes.mjs is the one place a customer's own
 * choice reaches this: it validates against ALLOWED_QUANTITIES and defaults
 * a missing one to 4, so a request that got this far already carries a
 * number from that list.
 */
const quantityFor = (request) => ALLOWED_QUANTITIES.includes(request?.quantity) ? request.quantity : 1

export function calculateDraftQuote(request, catalog = null) {
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
  }

  if (EXCEPTION_VEHICLE_PATTERN.test(request?.vehicleInfo || '')) {
    exceptionReasons.push('Truck, pickup, van, and SUV requests require owner review')
  }

  const tirePrice = tire?.price || 0
  // The visit costs the same whether it fits one tire or four: only the tire
  // line multiplies, the mobile-service fee stays one line at one price.
  const total = roundCurrency(tirePrice * quantity + MOBILE_SERVICE_FEE)

  return {
    requestId: request?.id || null,
    lineItems: [
      ...(tire ? [{ description: tire.name, quantity, unitPrice: tire.price }] : []),
      { description: 'Mobile installation service', quantity: 1, unitPrice: MOBILE_SERVICE_FEE }
    ],
    total,
    exception: exceptionReasons.length > 0,
    exceptionReasons
  }
}