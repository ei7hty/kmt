/**
 * Storing and honouring the markup rule's margin bounds.
 *
 * A new file rather than more of `backend/owner.test.mjs` because that file is
 * shared by several lanes and 1,500 lines long; flat in `backend/` because
 * CI's glob (`backend/*.test.mjs`) is not recursive and a nested file would
 * never run at all.
 *
 * The arithmetic itself is `src/markup.test.mjs`'s. What is proved here is the
 * half that only exists once a database is involved: what a save writes, what
 * an omitted field does to a bound it never mentioned, and that the price a
 * customer is actually handed by `catalog()` is the bounded one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Inventory } from './inventory.mjs'
import { DEFAULT_MARKUP_SETTINGS, retailPrice } from '../src/markup.js'

const SIZE = '215/60R16'
const tire = (id = 'giga-a', overrides = {}) => ({
  id, name: 'Test Touring', size: SIZE, price: 50, inStock: true,
  category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/215-60-16/test-tires/model/tirecode/1' },
  ...overrides,
})
const fullRead = { limit: 0, pagesRead: 1, totalPages: 1, complete: true, scrapedAt: '2026-09-05T15:00:00Z' }
const snapshot = (tires) => ({
  source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE],
  coverage: { [SIZE]: fullRead }, tires,
})

function setup(t, tires = [tire()]) {
  const db = new Inventory(':memory:', [SIZE])
  t.after(() => db.close())
  db.importSnapshot(snapshot(tires))
  return db
}

test('a fresh database has no margin bounds, so it prices exactly as it did before they existed', t => {
  const db = setup(t)
  const markup = db.getMarkup()
  assert.equal(markup.minMarginPerTire, null)
  assert.equal(markup.maxMarginPerTire, null)
  // The keys are present and null rather than missing: the owner screen reads
  // this object over JSON, where a missing key and a null one are not the
  // same thing to a form deciding whether to render a field as empty.
  assert.ok('minMarginPerTire' in markup && 'maxMarginPerTire' in markup)
  // A tire nobody has touched is still for sale at the proposed price -- an
  // absent offer row is "not asked yet", not "no". So this IS the live price
  // a customer would be quoted, and it is the flat rule's, unmoved.
  assert.equal(db.catalog()[0].price, 67.5, '50 x 1.35, the same number as before margin bounds existed')
})

test('saving margin bounds stores them in cents and reads them back', t => {
  const db = setup(t)
  const saved = db.saveMarkup({ rate: 1.35, minMarginPerTire: 28, maxMarginPerTire: 75 })
  assert.equal(saved.minMarginPerTire, 28)
  assert.equal(saved.maxMarginPerTire, 75)
  assert.deepEqual(
    [db.getMarkup().minMarginPerTire, db.getMarkup().maxMarginPerTire], [28, 75], 'survive a reload')

  const rounded = db.saveMarkup({ rate: 1.35, minMarginPerTire: 28.006, maxMarginPerTire: 74.994 })
  assert.equal(rounded.minMarginPerTire, 28.01, 'stored to the cent')
  assert.equal(rounded.maxMarginPerTire, 74.99)
})

test("a rate-only save -- the owner form's actual body -- leaves the margin bounds alone", t => {
  const db = setup(t)
  db.saveMarkup({ rate: 1.35, minMarginPerTire: 28, maxMarginPerTire: 75 })

  // This is byte-for-byte what src/owner/OwnerInventory.jsx's markup form
  // sends today: rate and shipping, no mention of margins. If an omission
  // read as "clear it", Ken would wipe his own floor every time he nudged
  // the rate, and hundreds of prices would drop with no save that named them.
  const after = db.saveMarkup({ rate: 1.4, shippingPerTire: 25.75 })
  assert.equal(after.minMarginPerTire, 28, 'floor survived a save that never mentioned it')
  assert.equal(after.maxMarginPerTire, 75, 'ceiling too')
  assert.equal(after.rate, 1.4, 'and the save it WAS about still happened')
})

test('null is how a bound is turned off, and it is not the same as omitting it', t => {
  const db = setup(t)
  db.saveMarkup({ rate: 1.35, minMarginPerTire: 28, maxMarginPerTire: 75 })

  const cleared = db.saveMarkup({ rate: 1.35, minMarginPerTire: null })
  assert.equal(cleared.minMarginPerTire, null, 'an explicit null clears')
  assert.equal(cleared.maxMarginPerTire, 75, 'and touches nothing else')
})

test('margin bounds that would be a typo rather than a decision are refused, and write nothing', t => {
  const db = setup(t)
  db.saveMarkup({ rate: 1.35, minMarginPerTire: 28, maxMarginPerTire: 75 })

  for (const input of [{ minMarginPerTire: -1 }, { minMarginPerTire: 501 }, { minMarginPerTire: '28' }, { minMarginPerTire: Number.NaN }]) {
    assert.throws(() => db.saveMarkup({ rate: 1.35, ...input }), /minimum margin per tire/, JSON.stringify(input))
  }
  for (const input of [{ maxMarginPerTire: -1 }, { maxMarginPerTire: 501 }, { maxMarginPerTire: 'lots' }]) {
    assert.throws(() => db.saveMarkup({ rate: 1.35, ...input }), /maximum margin per tire/, JSON.stringify(input))
  }
  // Zero is a real answer for a floor (it is the same as off) and a typo for
  // a ceiling: a $0 maximum margin sells every unpriced tire at exactly what
  // Ken paid for it.
  assert.throws(() => db.saveMarkup({ rate: 1.35, maxMarginPerTire: 0 }), /maximum margin per tire/)
  assert.equal(db.saveMarkup({ rate: 1.35, minMarginPerTire: 0 }).minMarginPerTire, 0, 'but a $0 floor is allowed')

  assert.throws(() => db.saveMarkup({ rate: 1.35, minMarginPerTire: 80, maxMarginPerTire: 75 }),
    /cannot be more than the maximum/, 'a floor above the ceiling is a contradiction, not a rule')

  const stored = db.getMarkup()
  assert.equal(stored.maxMarginPerTire, 75, 'every rejected save left the stored rule as it was')
})

test('a markup record saved before margin bounds existed reads them as off, and reprices nothing', t => {
  const db = setup(t)
  // setMeta bypasses saveMarkup, standing in for the row already on the
  // production database: a rate and a shipping figure Ken chose, and no
  // margin keys because the field did not exist when he saved it.
  db.setMeta('markup', { rate: 1.8, shippingPerTire: 25.75, rateIsPlaceholder: false, shippingPerTireIsPlaceholder: false, isPlaceholder: false, updatedAt: '2026-09-07T00:00:00.000Z' })
  const legacy = db.getMarkup()
  assert.equal(legacy.minMarginPerTire, null)
  assert.equal(legacy.maxMarginPerTire, null)
  assert.equal(legacy.rate, 1.8, 'the rule he did decide is untouched')
  assert.equal(legacy.isPlaceholder, false, 'and still reads as decided -- a bound nobody set is not an undecided number')
  assert.equal(retailPrice(50, {}, legacy), 115.75, '(50 x 1.8) + 25.75, the price this row was already producing')
})

test('the price a customer is handed reflects the floor, and an owner price still overrides it', t => {
  const db = setup(t, [tire('giga-cheap', { price: 31.14 }), tire('giga-owned', { price: 31.14 })])
  db.saveMarkup({ rate: 1.35, minMarginPerTire: 28 })
  db.saveOffer('giga-cheap', { priceCents: null, enabled: true, notes: '', version: 0 })
  db.saveOffer('giga-owned', { priceCents: 4204, enabled: true, notes: '', version: 0 })

  const byId = Object.fromEntries(db.catalog().map(row => [row.id, row.price]))
  assert.equal(byId['giga-cheap'], 59.14, 'marked up, then held to the floor: cost + 28')
  assert.notEqual(byId['giga-cheap'], 42.04, 'not the bare 1.35, which is what it was before the floor')
  assert.equal(byId['giga-owned'], 42.04, "Ken's own price is his, and the floor does not raise it")
})

test('the flat rate and the floor cannot disagree about what an unconfigured catalogue costs', t => {
  const db = setup(t)
  db.saveOffer('giga-a', { priceCents: null, enabled: true, notes: '', version: 0 })
  // The defaults the backend falls back to are the frontend module's, not a
  // second copy -- so a change to either cannot leave the two disagreeing.
  assert.equal(db.getMarkup().minMarginPerTire, DEFAULT_MARKUP_SETTINGS.minMarginPerTire)
  assert.equal(db.getMarkup().maxMarginPerTire, DEFAULT_MARKUP_SETTINGS.maxMarginPerTire)
  assert.equal(db.catalog()[0].price, retailPrice(50, {}, DEFAULT_MARKUP_SETTINGS), 'and the catalogue agrees with the module')
})
