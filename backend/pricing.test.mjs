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
  const tireLine = quote.lineItems.find(item => item.description === 'Test Touring')
  assert.equal(tireLine.quantity, 4, 'the exception does not stop the tire line from multiplying')
  assert.equal(quote.total, 200, '50 x 4, no catalogue line supplied')
  assert.ok(
    quote.exceptionReasons.includes('Not a supplier-listed tire; owner review required'),
    'multiplying the quantity does not excuse the tire from owner review',
  )
})

/* ---------------------------------------------- pricing settings (#289) --- */

test('with no catalogue lines supplied, calculateDraftQuote invents no fee of its own (#354 stage 2)', () => {
  // Before stage 2 this hardcoded the mobile-service fee; after it, every fee
  // beyond the tire itself is a catalogue entry the caller supplies --
  // Inventory.seedCatalogueLines() is what guarantees production never calls
  // this with an empty catalogue, not this function.
  const quote = calculateDraftQuote(request(), [tire()])
  assert.deepEqual(quote.lineItems, [{ description: 'Test Touring', quantity: 1, unitPrice: 50 }])
  assert.equal(quote.subtotal, 50)
  assert.equal(quote.total, 50)
  assert.equal('tax' in quote, false, 'tax ships absent, not as a disabled placeholder object')
})

// normalizePricingSettings itself is unchanged by stage 2 -- it still
// normalizes the settings object Inventory.seedCatalogueLines() reads from,
// even though calculateDraftQuote no longer consults mobileServiceFee/
// disposalFee directly.
test('an invalid mobile fee falls back to the default, marked a placeholder, rather than mispricing', () => {
  for (const bad of [0, -5, 'fifty', null, undefined]) {
    const settings = normalizePricingSettings({ mobileServiceFee: bad })
    assert.equal(settings.mobileServiceFee, DEFAULT_PRICING_SETTINGS.mobileServiceFee, `bad value ${String(bad)}`)
    assert.equal(settings.mobileServiceFeeIsPlaceholder, true)
  }
})

test('tax ships absent by default and stays absent until a valid rate and appliesTo are both set', () => {
  assert.equal(normalizePricingSettings({}).tax, null)
  assert.equal(normalizePricingSettings({ tax: { rate: 0.0625 } }).tax, null, 'no appliesTo')
  assert.equal(normalizePricingSettings({ tax: { appliesTo: 'all' } }).tax, null, 'no rate')
  assert.equal(normalizePricingSettings({ tax: { rate: 1, appliesTo: 'all' } }).tax, null, 'a rate of 100% is not a tax rate')
  assert.equal(normalizePricingSettings({ tax: { rate: 0.0625, appliesTo: 'nowhere' } }).tax, null, 'an unknown appliesTo')
})

// Stand-ins for what Inventory.seedCatalogueLines() actually produces --
// both classified 'services' at seed time, the tax treatment mobile-fee and
// disposal have always had. Post-stage-2 that classification is a static
// flag on the line, not something calculateDraftQuote recomputes from the
// live appliesTo setting the way it still does for the tire -- these fixture
// booleans are the seed's snapshot, not a live derivation.
const seededMobileFee = (taxable) => ({ id: 'mobile-service', label: 'Mobile installation service', amountCents: 4999, basis: 'perJob', mode: 'automatic', taxable, enabled: true })
const seededDisposal = (taxable) => ({ id: 'disposal', label: 'Old tire disposal', amountCents: 1000, basis: 'perTire', mode: 'optional', taxable, enabled: true })

test('tax applied to everything taxes the full subtotal, including catalogue lines seeded as taxable', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'all' } })
  const quote = calculateDraftQuote(request(), [tire()], settings, [seededMobileFee(true), seededDisposal(true)], ['disposal'])
  // 50 (tire) + 49.99 (fee) + 10 (disposal) = 109.99
  assert.equal(quote.subtotal, 109.99)
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'all', amount: 11 })
  assert.equal(quote.total, 120.99)
})

test('the tire is taxed under appliesTo: goods; catalogue lines seeded as services-taxable are not', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'goods' } })
  const quote = calculateDraftQuote(request(), [tire()], settings, [seededMobileFee(false), seededDisposal(false)], ['disposal'])
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'goods', amount: 5 }, '10% of the $50 tire line alone')
  assert.equal(quote.total, roundToCents(109.99 + 5))
})

test('appliesTo: services leaves the tire untaxed; catalogue lines seeded as services-taxable are taxed', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'services' } })
  const quote = calculateDraftQuote(request(), [tire()], settings, [seededMobileFee(true), seededDisposal(true)], ['disposal'])
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'services', amount: roundToCents((49.99 + 10) * 0.1) })
})

test('the screen-verified scenario, taxed: an edited fee plus a new owner line still balances', () => {
  // Same shape as the PR's own end-to-end walkthrough -- four tires, the
  // seeded fee edited to $65, a new "Tire installation" line added at $15
  // through the real screen -- but with tax on, against production's actual
  // rate and appliesTo (per the OWNER AGENT's live read: 0.0625 / 'goods').
  // The walkthrough itself ran with tax off, where subtotal equals total
  // trivially; this is the same numbers with tax on, so the invariant is
  // checked directly rather than inferred from a tax-off walkthrough and a
  // tax-on unit test that never combine.
  const settings = normalizePricingSettings({ tax: { rate: 0.0625, appliesTo: 'goods' } })
  const editedMobileFee = { id: 'mobile-service', label: 'Mobile installation service', amountCents: 6500, basis: 'perJob', mode: 'automatic', taxable: false, enabled: true }
  const installation = { id: 'install', label: 'Tire installation', amountCents: 1500, basis: 'perJob', mode: 'automatic', taxable: true, enabled: true }
  const quote = calculateDraftQuote(request({ quantity: 4 }), [tire({ price: 48.28 })], settings, [editedMobileFee, installation], [])
  assert.equal(quote.subtotal, 273.12) // 4 x 48.28 + 65 + 15, the PR body's own total
  assert.deepEqual(quote.tax, { rate: 0.0625, appliesTo: 'goods', amount: 13.01 }) // 6.25% of the taxable 193.12 + 15
  assert.equal(quote.total, 286.13)
  assert.equal(quote.total, roundToCents(quote.subtotal + quote.tax.amount), 'subtotal + tax = total')
})

test('a customer-facing quote never carries an internal taxable key on any line', () => {
  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'all' } })
  const quote = calculateDraftQuote(request(), [tire()], settings, [seededMobileFee(true), seededDisposal(true)], ['disposal'])
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

test('catalogue amounts resolve by SKU, then size, then site-wide without changing line order', () => {
  const scoped = line({
    amountCents: 1500,
    amountOverrides: {
      sizes: { '205/65R15': 2000, '225/50R17': 2100 },
      skus: { a: 2750 },
    },
  })
  const siteWide = calculateDraftQuote(request({ tireSelection: 'giga-ordinary' }), [tire({ id: 'giga-ordinary', size: '215/60R16' })], undefined, [scoped])
  const bySize = calculateDraftQuote(request({ tireSelection: 'giga-ordinary' }), [tire({ id: 'giga-ordinary' })], undefined, [scoped])
  const bySku = calculateDraftQuote(request(), [tire()], undefined, [scoped])

  assert.equal(siteWide.lineItems[1].unitPrice, 15)
  assert.equal(bySize.lineItems[1].unitPrice, 20)
  assert.equal(bySku.lineItems[1].unitPrice, 27.5, 'SKU wins even when the tire also matches the size override')
  assert.deepEqual(bySku.lineItems.map(item => item.description), ['Test Touring', 'Installation'])
})

test('subtotal + tax = total holds across every catalogue shape, not just the empty-catalogue no-op (#354, per review)', () => {
  // Stage 1 is inert until the catalogue has entries, which makes "nothing
  // changed" the easy half of testing it -- the fixture that never feeds a
  // real entry through would pass whether or not the arithmetic was right.
  // Each of these actually puts a line through calculateDraftQuote and
  // checks the invariant on the result, not on a hand-built object.
  const invariantHolds = quote => {
    const taxAmount = quote.tax?.amount ?? 0
    assert.equal(roundToCents(quote.subtotal + taxAmount), quote.total, `subtotal (${quote.subtotal}) + tax (${taxAmount}) should equal total (${quote.total})`)
  }

  const settings = normalizePricingSettings({ tax: { rate: 0.1, appliesTo: 'goods' } })
  const automaticPerTire = line({ id: 'install', basis: 'perTire', mode: 'automatic', taxable: true })
  const optionalPerJob = line({ id: 'nitrogen', label: 'Nitrogen fill', basis: 'perJob', mode: 'optional', taxable: false })

  invariantHolds(calculateDraftQuote(request({ quantity: 4 }), [tire()], settings, [automaticPerTire]))
  invariantHolds(calculateDraftQuote(request({ quantity: 4 }), [tire()], settings, [automaticPerTire, optionalPerJob], ['nitrogen']))
  invariantHolds(calculateDraftQuote(request({ quantity: 4 }), [tire()], settings, [automaticPerTire, optionalPerJob], []))
  invariantHolds(calculateDraftQuote(request({ quantity: 2, disposeOldTires: true }), [tire()], normalizePricingSettings({ disposalFee: 10, tax: { rate: 0.0625, appliesTo: 'all' } }), [automaticPerTire, optionalPerJob], ['nitrogen']))
  invariantHolds(calculateDraftQuote(request(), [tire()], DEFAULT_PRICING_SETTINGS, [automaticPerTire])) // tax off entirely
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
  assert.equal(quote.lineItems.length, 1) // tire only, nothing from the bad entry
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
