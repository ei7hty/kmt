import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDraftQuote } from '../src/pricing.js'

const tire = (overrides = {}) => ({
  id: 'giga-a', name: 'Test Touring', size: '205/65R15', price: 50,
  inStock: true, category: 'all-season', description: '95H BSW',
  ...overrides,
})

const request = (overrides = {}) => ({
  id: 'req-1', tireSelection: 'giga-a', vehicleInfo: '2021 Honda Civic',
  ...overrides,
})

test('a real supplier tire, in stock, ordinary vehicle: no exception', () => {
  const quote = calculateDraftQuote(request(), [tire()])
  assert.equal(quote.exception, false)
  assert.deepEqual(quote.exceptionReasons, [])
})

test('a tire whose id does not start with giga- is an exception, even in stock and not off-road', () => {
  const quote = calculateDraftQuote(request({ tireSelection: 'tire-1' }), [tire({ id: 'tire-1' })])
  assert.equal(quote.exception, true)
  assert.ok(
    quote.exceptionReasons.includes('Not a supplier-listed tire; owner review required'),
    `expected the supplier-listing reason, got: ${quote.exceptionReasons}`,
  )
})

test('a generated placeholder id (tire-<size>-<model>) is the same exception as a seed id', () => {
  const quote = calculateDraftQuote(
    request({ tireSelection: 'tire-205-65r15-touring-comfort' }),
    [tire({ id: 'tire-205-65r15-touring-comfort' })],
  )
  assert.ok(quote.exceptionReasons.includes('Not a supplier-listed tire; owner review required'))
})

test('a non-supplier tire stacks with the other exception rules rather than replacing them', () => {
  const quote = calculateDraftQuote(
    request({ tireSelection: 'tire-5', vehicleInfo: '2019 Ford F-150 Pickup' }),
    [tire({ id: 'tire-5', category: 'off-road', inStock: false })],
  )
  assert.equal(quote.exceptionReasons.length, 4)
  assert.ok(quote.exceptionReasons.includes('Selected tire is out of stock'))
  assert.ok(quote.exceptionReasons.includes('Off-road tire requires owner review'))
  assert.ok(quote.exceptionReasons.includes('Truck, pickup, van, and SUV requests require owner review'))
  assert.ok(quote.exceptionReasons.includes('Not a supplier-listed tire; owner review required'))
})
