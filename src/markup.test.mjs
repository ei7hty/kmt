/**
 * The markup engine, and the one question a pricing change has to answer:
 * what does it do to the prices customers are being quoted right now?
 *
 * `src/markup.js` had no test file of its own before this. Its only coverage
 * was incidental -- a handful of `quotedPrice` calls inside
 * `backend/owner.test.mjs`, none of which would notice a repricing.
 *
 * Two of the tests below are instruments rather than examples, and both were
 * mutation-checked by hand (change the thing, watch that test and only that
 * test go red):
 *
 *   - "the shipped defaults move none of the 1,083 live supplier prices"
 *     runs the real catalogue through the real function. Set a default margin
 *     bound and it reports the exact count that moved.
 *   - "no margin bound can ever price a dearer tire below a cheaper one"
 *     is the property that ruled out banded rates. Replace the clamp with a
 *     cost-banded rate and it fails.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_MARKUP_SETTINGS, normalizeMarkupSettings, quotedPrice, retailPrice } from './markup.js'

/** Every real supplier cost the owner's database is seeded from. */
const SUPPLIER_COSTS = JSON.parse(readFileSync(new URL('./data/scraped-tires.json', import.meta.url), 'utf8'))
  .tires.map(tire => tire.price)

const cents = (amount) => Math.round(amount * 100) / 100

/**
 * What `retailPrice` computed before margin bounds existed, written out rather
 * than imported, so this is a second opinion and not the same arithmetic
 * agreeing with itself. It reads `rate` off the settings rather than restating
 * 1.35, so it cannot become a stale literal that has to be kept in step.
 */
const priceBeforeMarginBounds = (cost, settings = DEFAULT_MARKUP_SETTINGS) =>
  cents((cost * settings.rate) + settings.shippingPerTire)

test('the shipped defaults move none of the 1,083 live supplier prices', () => {
  assert.equal(SUPPLIER_COSTS.length, 1083, 'the seeded catalogue is the population this is measuring')
  assert.equal(DEFAULT_MARKUP_SETTINGS.minMarginPerTire, null, 'no floor ships')
  assert.equal(DEFAULT_MARKUP_SETTINGS.maxMarginPerTire, null, 'no ceiling ships')

  const moved = SUPPLIER_COSTS.filter(cost => retailPrice(cost) !== priceBeforeMarginBounds(cost))
  assert.equal(moved.length, 0,
    `margin bounds must ship inert: ${moved.length} of ${SUPPLIER_COSTS.length} prices moved, ` +
    `first at supplier cost $${moved[0]}`)
})

test('no margin bound can ever price a dearer tire below a cheaper one', () => {
  // The property that rejected cost-banded rates. A band boundary is a step
  // DOWN in rate, so a banded price function steps down with it: at a $80
  // boundary with 1.60 below and 1.42 above, $80.00 of cost is quoted $128.00
  // and $80.01 is quoted $113.61. Against these same supplier costs that band
  // set produces 3,710 inverted pairs. `cost x rate`, `cost + floor` and
  // `cost + ceiling` are each increasing in cost, so no combination of them
  // can invert -- this asserts that over the real catalogue rather than
  // trusting the argument.
  const settingSets = [
    { minMarginPerTire: 28, maxMarginPerTire: null },
    { minMarginPerTire: null, maxMarginPerTire: 75 },
    { minMarginPerTire: 28, maxMarginPerTire: 75 },
    { minMarginPerTire: 0, maxMarginPerTire: 500 },
  ]
  const ascending = [...SUPPLIER_COSTS].sort((a, b) => a - b)
  for (const bounds of settingSets) {
    const settings = { ...DEFAULT_MARKUP_SETTINGS, ...bounds, shippingPerTire: 25.75 }
    const priced = ascending.map(cost => retailPrice(cost, {}, settings))
    const inverted = priced.filter((price, i) => i > 0 && price < priced[i - 1])
    assert.equal(inverted.length, 0, `${JSON.stringify(bounds)} inverted ${inverted.length} adjacent pairs`)
  }
})

test('a margin floor lifts a tire the flat rate leaves nothing on', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28 }
  // The cheapest tire in the catalogue. 1.35 earns $10.90 on it; the floor
  // is the difference between a job worth doing and one that is not.
  assert.equal(retailPrice(31.14), 42.04, 'without a floor')
  assert.equal(retailPrice(31.14, {}, settings), 59.14, 'with a $28 floor: cost + 28')
  assert.equal(cents(retailPrice(31.14, {}, settings) - 31.14), 28, 'and the margin is exactly the floor')
})

test('a margin floor leaves a tire that already clears it untouched', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28 }
  // $100 of cost earns $35 at 1.35, which is above the floor, so the floor
  // has nothing to do. A floor that reached this row would be repricing
  // tires it was never asked about.
  assert.equal(retailPrice(100, {}, settings), 135)
  assert.equal(retailPrice(382.42, {}, settings), 516.27, 'and the dearest tire is untouched too')
})

test('at the exact break-even cost the floor and the flat rate agree', () => {
  // $80 x 0.35 is exactly $28, so both answers are $108.00. This fixture is
  // DELIBERATELY the equal case and is here to pin the boundary, not to
  // prove the floor works -- on its own it would pass against code that
  // ignored the floor entirely, which is why the cent either side is
  // asserted with it.
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28 }
  assert.equal(retailPrice(80, {}, settings), 108, 'at the boundary, both rules say the same thing')
  assert.equal(retailPrice(79.99, {}, settings), 107.99, 'a cent below, the floor is what answers')
  assert.equal(priceBeforeMarginBounds(79.99), 107.99, '...which happens to round to the same cent here')
  assert.equal(retailPrice(79, {}, settings), 107, 'a dollar below, the two answers differ')
  assert.notEqual(priceBeforeMarginBounds(79), 107, 'the flat rate would have said $106.65')
  assert.equal(retailPrice(80.01, {}, settings), 108.01, 'a cent above, the rate is what answers')
})

test('a margin ceiling caps what the flat rate takes on an expensive tire', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, maxMarginPerTire: 75 }
  // The dearest tire in the catalogue: 1.35 takes $133.85 on it, for the
  // same driveway and the same forty-five minutes as the $31 one.
  assert.equal(retailPrice(382.42), 516.27, 'without a ceiling')
  assert.equal(retailPrice(382.42, {}, settings), 457.42, 'with a $75 ceiling: cost + 75')
  assert.equal(retailPrice(100, {}, settings), 135, 'a tire under the ceiling is untouched')
})

test('a floor and a ceiling together bound the margin at both ends', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28, maxMarginPerTire: 75 }
  assert.equal(retailPrice(31.14, {}, settings), 59.14, 'lifted to cost + 28')
  assert.equal(retailPrice(150, {}, settings), 202.5, 'inside both bounds, the rate answers')
  assert.equal(retailPrice(382.42, {}, settings), 457.42, 'capped at cost + 75')
})

test('shipping is added outside the margin bounds, because freight is not margin', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28, shippingPerTire: 25.75 }
  // $59.14 of goods, then freight on top. If shipping counted toward the
  // floor, this row would come back $56.89 -- the flat-rate price plus
  // freight -- and the floor would quietly stop protecting anything the
  // moment Ken set a shipping figure, which is the case it exists for.
  assert.equal(retailPrice(31.14, {}, settings), 84.89, '(cost + 28) + 25.75')
  assert.notEqual(retailPrice(31.14, {}, settings), 67.79, 'not (cost x 1.35) + 25.75')

  // The same holds for a per-tire shipping override on the row.
  assert.equal(retailPrice(31.14, { shippingPerTire: 0 }, settings), 59.14,
    'a free-shipping tire still gets the full goods floor')
})

test("a price the owner set is his, and no margin bound touches it", () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28, maxMarginPerTire: 75 }
  const owned = quotedPrice({ supplierPrice: 31.14, offer: { priceCents: 4204, enabled: true }, settings })
  assert.equal(owned.price, 42.04, 'markup proposes, the owner disposes -- unchanged')
  assert.equal(owned.source, 'owner')

  const proposed = quotedPrice({ supplierPrice: 31.14, offer: null, settings })
  assert.equal(proposed.price, 59.14, 'only an unpriced tire is bounded')
  assert.equal(proposed.source, 'markup')
})

test('a nonsensical margin bound falls back to the default rule, flagged, rather than repricing quietly', () => {
  // Dropping a malformed floor would put every tire under it back to the bare
  // rate -- a real repricing of hundreds of rows with nothing saying so.
  // Falling back also reprices, but sets isPlaceholder, which the owner screen
  // already renders as "this is not Ken's number".
  for (const bad of [
    { minMarginPerTire: -5 },
    { minMarginPerTire: Number.NaN },
    { minMarginPerTire: Infinity },
    { minMarginPerTire: '28' },
    { maxMarginPerTire: -1 },
    { maxMarginPerTire: 'lots' },
    { minMarginPerTire: 75, maxMarginPerTire: 28 },
  ]) {
    const settings = normalizeMarkupSettings({ ...DEFAULT_MARKUP_SETTINGS, rate: 1.8, shippingPerTire: 25.75, ...bad })
    assert.equal(settings.rate, DEFAULT_MARKUP_SETTINGS.rate, `${JSON.stringify(bad)} refused the whole rule`)
    assert.equal(settings.minMarginPerTire, null)
    assert.equal(settings.maxMarginPerTire, null)
    assert.equal(settings.isPlaceholder, true, 'and says the prices are not decided')
  }
})

test('a settings object from before margin bounds existed is honoured, not refused', () => {
  // Every stored markup record on the production database predates this
  // field. An absent bound is off, and off is what those rows already meant,
  // so a rule Ken really did decide must not be thrown away as malformed.
  const legacy = normalizeMarkupSettings({ rate: 1.8, shippingPerTire: 25.75, isPlaceholder: false })
  assert.equal(legacy.rate, 1.8, 'his rate survives')
  assert.equal(legacy.minMarginPerTire, null)
  assert.equal(legacy.maxMarginPerTire, null)
  assert.equal(legacy.isPlaceholder, false, 'and is still read as decided')
  assert.equal(retailPrice(31.14, {}, legacy), 81.80, '(31.14 x 1.8) + 25.75, exactly as before')

  // An explicit undefined -- what a form field nobody filled in serialises to
  // -- is absence, not garbage.
  const blank = normalizeMarkupSettings({ rate: 1.8, minMarginPerTire: undefined, maxMarginPerTire: undefined })
  assert.equal(blank.rate, 1.8)
  assert.equal(blank.minMarginPerTire, null)
})

test('a margin bound cannot rescue a tire with no usable supplier cost', () => {
  const settings = { ...DEFAULT_MARKUP_SETTINGS, minMarginPerTire: 28 }
  // A floor is a bound on a price, not a substitute for one: without a cost
  // there is no margin to be short of. Returning cost + 28 from a missing
  // cost would invent $28 tires out of bad data.
  for (const cost of [null, undefined, 0, -1, Number.NaN, '50']) {
    assert.equal(retailPrice(cost, {}, settings), null, `refused ${String(cost)}`)
  }
})
