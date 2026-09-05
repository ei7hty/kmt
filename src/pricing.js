import { getTireById } from './data/catalog.js'

export const MOBILE_SERVICE_FEE = 49.99

const EXCEPTION_VEHICLE_PATTERN = /\b(truck|pickup|van|suv|f-\d+)\b/i

const roundCurrency = (amount) => Math.round(amount * 100) / 100

export function calculateDraftQuote(request, catalog = null) {
  const tires = catalog || [getTireById(request?.tireSelection)].filter(Boolean)
  const tire = tires.find(item => item.id === request?.tireSelection)
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
  const total = roundCurrency(tirePrice + MOBILE_SERVICE_FEE)

  return {
    requestId: request?.id || null,
    lineItems: [
      ...(tire ? [{ description: tire.name, quantity: 1, unitPrice: tire.price }] : []),
      { description: 'Mobile installation service', quantity: 1, unitPrice: MOBILE_SERVICE_FEE }
    ],
    total,
    exception: exceptionReasons.length > 0,
    exceptionReasons
  }
}