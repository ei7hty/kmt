import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PRICING_SETTINGS, calculateDraftQuote, computeQuoteTotals, normalizePricingSettings } from '../src/pricing.js'

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

test('quantity and the supplier-id guard are independent: four of a non-supplier tire still multiplies', () => {
  // Neither #62 nor #93 exercised this combination alone: the guard's fixtures
  // were always quantity 1, and quantity's fixtures were always a giga- tire.
  const quote = calculateDraftQuote(
    request({ tireSelection: 'tire-1', quantity: 4 }),
    [tire({ id: 'tire-1' })],
  )
  const tireLine = quote.lineItems.find(item => item.description !== 'Mobile installation service')
  assert.equal(tireLine.quantity, 4, 'the exception does not stop the tire line from multiplying')
  assert.equal(quote.total, Math.round((50 * 4 + 49.99) * 100) / 100)
  assert.ok(
    quote.exceptionReasons.includes('Not a supplier-listed tire; owner review required'),
    'multiplying the quantity does not excuse the tire from owner review',
  )
})

/* ---------------------------------------------- pricing settings (#289) --- */

test('with no settings passed, the quote is unchanged from before pricing settings existed', () => {
  const quote = calculateDraftQuote(request(), [tire()])
  assert.deepEqual(quote.lineItems, [
    { description: 'Test Touring', quantity: 1, unitPrice: 50 },
    { description: 'Mobile installation service', quantity: 1, unitPrice: 49.99 },
  ])
  assert.equal(quote.subtotal, 99.99)
  assert.equal(quote.total, 99.99, 'subtotal and total agree when tax is off, same as before subtotal existed')
  assert.equal('tax' in quote, false, 'tax ships absent, not as a disabled placeholder object')
})

test('a configured mobile fee replaces the constant, and marks itself no longer a placeholder', () => {
  const settings = normalizePricingSettings({ mobileServiceFee: 65, mobileServiceFeeIsPlaceholder: false })
  const quote = calculateDraftQuote(request(), [tire()], settings)
  const feeLine = quote.lineItems.find(line => line.description === 'Mobile installation service')
  assert.equal(feeLine.unitPrice, 65)
  assert.equal(quote.subtotal, 115)
})

test('an invalid mobile fee falls back to the default, marked a placeholder, rather than mispricing', () => {
  for (const bad of [0, -5, 'fifty', null, undefined]) {
    const settings = normalizePricingSettings({ mobileServiceFee: bad })
    assert.equal(settings.mobileServiceFee, DEFAULT_PRICING_SETTINGS.mobileServiceFee, `bad value ${String(bad)}`)
    assert.equal(settings.mobileServiceFeeIsPlaceholder, true)
  }
})

test('disposal is opt-in: off by default, absent unless the customer chose it and Ken has set a fee', () => {
  const settings = normalizePricingSettings({ disposalFee: 5 })
  const notOptedIn = calculateDraftQuote(request({ disposeOldTires: false }), [tire()], settings)
  assert.equal(notOptedIn.lineItems.some(line => line.description === 'Old tire disposal'), false)

  const optedIn = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], settings)
  const disposalLine = optedIn.lineItems.find(line => line.description === 'Old tire disposal')
  assert.equal(disposalLine.unitPrice, 5)
  assert.equal(disposalLine.quantity, 1, 'matches the tire quantity')

  // Ken has not configured a fee: opting in has nothing to charge for, so no line appears.
  const noFeeSet = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], DEFAULT_PRICING_SETTINGS)
  assert.equal(noFeeSet.lineItems.some(line => line.description === 'Old tire disposal'), false)
})

test('disposal quantity matches the tire quantity, not a flat one', () => {
  const settings = normalizePricingSettings({ disposalFee: 5 })
  const quote = calculateDraftQuote(request({ disposeOldTires: true, quantity: 4 }), [tire()], settings)
  const disposalLine = quote.lineItems.find(line => line.description === 'Old tire disposal')
  assert.equal(disposalLine.quantity, 4)
  assert.equal(quote.subtotal, roundToCents(50 * 4 + 49.99 + 5 * 4))
})

test('tax ships absent by default and stays absent until a valid rate and appliesTo are both set', () => {
  assert.equal(normalizePricingSettings({}).tax, null)
  assert.equal(normalizePricingSettings({ tax: { rate: 0.0625 } }).tax, null, 'no appliesTo')
  assert.equal(normalizePricingSettings({ tax: { appliesTo: 'all' } }).tax, null, 'no rate')
  assert.equal(normalizePricingSettings({ tax: { rate: 1, appliesTo: 'all' } }).tax, null, 'a rate of 100% is not a tax rate')
  assert.equal(normalizePricingSettings({ tax: { rate: 0.0625, appliesTo: 'nowhere' } }).tax, null, 'an unknown appliesTo')
})

test('tax applied to everything taxes the full subtotal, including disposal', () => {
  const settings = normalizePricingSettings({ disposalFee: 10, tax: { rate: 0.1, appliesTo: 'all' } })
  const quote = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], settings)
  // 50 (tire) + 49.99 (fee) + 10 (disposal) = 109.99
  assert.equal(quote.subtotal, 109.99)
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'all', amount: 11 })
  assert.equal(quote.total, 120.99)
})

test('tax applied to goods only taxes the tire line, not labour or disposal', () => {
  const settings = normalizePricingSettings({ disposalFee: 10, tax: { rate: 0.1, appliesTo: 'goods' } })
  const quote = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], settings)
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'goods', amount: 5 }, '10% of the $50 tire line alone')
  assert.equal(quote.total, roundToCents(109.99 + 5))
})

test('tax applied to services only taxes labour and disposal, not the tire', () => {
  const settings = normalizePricingSettings({ disposalFee: 10, tax: { rate: 0.1, appliesTo: 'services' } })
  const quote = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], settings)
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'services', amount: roundToCents((49.99 + 10) * 0.1) })
})

test('a customer-facing quote never carries an internal taxable key on any line', () => {
  const settings = normalizePricingSettings({ disposalFee: 10, tax: { rate: 0.1, appliesTo: 'all' } })
  const quote = calculateDraftQuote(request({ disposeOldTires: true }), [tire()], settings)
  for (const line of quote.lineItems) {
    assert.deepEqual(Object.keys(line).sort(), ['description', 'quantity', 'unitPrice'])
  }
})

function roundToCents(amount) { return Math.round(amount * 100) / 100 }

// #354: the owner's own catalogue lines, alongside the four built-in fees.

const line = (overrides = {}) => ({
  id: 'install', label: 'Installation', amountCents: 1500,
  basis: 'perTire', mode: 'automatic', taxable: false, enabled: true,
  ...overrides,
})

test('an enabled automatic catalogue line is on every draft, with no chosen ids needed', () => {
  const quote = calculateDraftQuote(request(), [tire()], undefined, [line()])
  assert.ok(quote.lineItems.some(item => item.description === 'Installation' && item.unitPrice === 15))
})

test('a disabled catalogue line never appears, automatic or not', () => {
  const quote = calculateDraftQuote(request(), [tire()], undefined, [line({ enabled: false })])
  assert.ok(!quote.lineItems.some(item => item.description === 'Installation'))
})

test('an optional catalogue line appears only when its id is chosen', () => {
  const optional = line({ id: 'nitrogen', label: 'Nitrogen fill', mode: 'optional' })
  const withoutChoice = calculateDraftQuote(request(), [tire()], undefined, [optional], [])
  const withChoice = calculateDraftQuote(request(), [tire()], undefined, [optional], ['nitrogen'])
  assert.ok(!withoutChoice.lineItems.some(item => item.description === 'Nitrogen fill'))
  assert.ok(withChoice.lineItems.some(item => item.description === 'Nitrogen fill'))
})

test('a perTire catalogue line multiplies by quantity; a perJob line does not', () => {
  const perTire = calculateDraftQuote(request({ quantity: 4 }), [tire()], undefined, [line({ basis: 'perTire' })])
  const perJob = calculateDraftQuote(request({ quantity: 4 }), [tire()], undefined, [line({ basis: 'perJob' })])
  const perTireLine = perTire.lineItems.find(item => item.description === 'Installation')
  const perJobLine = perJob.lineItems.find(item => item.description === 'Installation')
  assert.equal(perTireLine.quantity, 4)
  assert.equal(perJobLine.quantity, 1)
})

test('a catalogue line\'s own taxable flag governs it, regardless of appliesTo -- #354\'s correction to #335', () => {
  // taxable:true still taxes the line even though appliesTo is 'goods' and
  // installation is neither a tire nor a service classification -- the
  // catalogue line is not matched against appliesTo at all.
  const taxedUnderGoods = calculateDraftQuote(
    request(), [tire()], normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'goods' } }),
    [line({ taxable: true })],
  )
  const installTaxed = taxedUnderGoods.lineItems.find(i => i.description === 'Installation')
  assert.ok(taxedUnderGoods.tax.amount > roundToCents(50 * 0.1), 'the tire and the taxable install line are both taxed')

  // taxable:false is never taxed even though appliesTo is 'all' -- the
  // catalogue line's own flag overrides, it is not simply another 'all' line.
  const untaxedUnderAll = calculateDraftQuote(
    request(), [tire()], normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'all' } }),
    [line({ taxable: false })],
  )
  const installUntaxed = untaxedUnderAll.lineItems.find(i => i.description === 'Installation')
  const taxableSubtotal = untaxedUnderAll.subtotal - installUntaxed.unitPrice
  assert.equal(untaxedUnderAll.tax.amount, roundToCents(taxableSubtotal * 0.1))
  assert.ok(installTaxed) // line is present in both cases; only its tax treatment differs
})

test('a catalogue line is never taxed while tax is off entirely, whatever its own flag says', () => {
  const quote = calculateDraftQuote(request(), [tire()], undefined, [line({ taxable: true })])
  assert.equal('tax' in quote, false)
})

test('a malformed catalogue entry is skipped rather than crashing a customer\'s draft', () => {
  const malformed = [{ id: 'bad', enabled: true, mode: 'automatic' }] // no label, no amountCents
  const quote = calculateDraftQuote(request(), [tire()], undefined, malformed)
  assert.equal(quote.exception, false)
  assert.equal(quote.lineItems.length, 2) // tire + mobile service, nothing from the bad entry
})

test('computeQuoteTotals sums by the taxable flag the caller already resolved, and never guesses', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'goods' } })
  const lines = [
    { quantity: 1, unitPrice: 100, taxable: true },
    { quantity: 1, unitPrice: 50, taxable: false },
  ]
  const totals = computeQuoteTotals(lines, settings)
  assert.equal(totals.subtotal, 150)
  assert.deepEqual(totals.tax, { rate: 0.1, appliesTo: 'goods', amount: 10 })
  assert.equal(totals.total, 160)
})

test('computeQuoteTotals still returns a tax object at $0 when every line is untaxed, not an absent tax key', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'goods' } })
  const totals = computeQuoteTotals([{ quantity: 1, unitPrice: 100, taxable: false }], settings)
  assert.deepEqual(totals.tax, { rate: 0.1, appliesTo: 'goods', amount: 0 })
  assert.equal(totals.total, 100)
})
