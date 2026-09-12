import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchesFilters, facetCounts, applyFilters, sortTires, toggleFilter,
  activeFilterCount, hasRatings, availableSorts, NO_FILTERS, PRICE_BANDS,
} from './tire-filters.js'

/** A list shaped like the real one: the fields /api/catalog actually returns. */
const TIRES = [
  { id: 'a', name: 'Michelin X-Ice Snow', brand: 'Michelin', category: 'winter', price: 157.33, inStock: true },
  { id: 'b', name: 'Aplus Pro Racing', brand: 'Aplus', category: 'performance', price: 150.00, inStock: true },
  { id: 'c', name: 'Cooper Evolution Winter', brand: 'Cooper', category: 'winter', price: 220.00, inStock: true },
  { id: 'd', name: 'Atlas Force HP', brand: 'Atlas', category: 'all-season', price: 168.00, inStock: true },
  { id: 'e', name: 'Michelin Defender', brand: 'Michelin', category: 'all-season', price: 310.00, inStock: true },
  { id: 'f', name: 'Ferentino Eternopresa', brand: 'Ferentino', category: 'all-season', price: 145.62, inStock: false },
  { id: 'g', name: 'Nameless Tire', category: 'all-season', price: 99.00, inStock: true }, // no brand at all
]

test('an empty selection narrows nothing', () => {
  assert.equal(applyFilters(TIRES, NO_FILTERS).length, TIRES.length)
  assert.equal(activeFilterCount(NO_FILTERS), 0)
  for (const tire of TIRES) assert.equal(matchesFilters(tire, NO_FILTERS), true)
})

test('facets are OR within a kind and AND across kinds', () => {
  // winter OR all-season, AND Michelin -> the two Michelins, not every winter.
  const filters = { seasons: ['winter', 'all-season'], brands: ['Michelin'], bands: [] }
  assert.deepEqual(applyFilters(TIRES, filters).map(t => t.id), ['a', 'e'])

  // Same seasons, no brand -> everything in those seasons.
  const wider = { ...filters, brands: [] }
  assert.deepEqual(applyFilters(TIRES, wider).map(t => t.id).sort(), ['a', 'c', 'd', 'e', 'f', 'g'])
})

test('a count is computed with its OWN facet removed, so the panel does not collapse', () => {
  // This is the behaviour most hand-rolled filter panels get wrong: after
  // ticking Winter, every other season reads 0 and the list looks empty.
  const filters = { seasons: ['winter'], brands: [], bands: [] }
  const { seasons } = facetCounts(TIRES, filters)
  const byId = Object.fromEntries(seasons.map(s => [s.id, s.count]))
  assert.equal(byId.winter, 2, 'the selected facet still counts its own matches')
  assert.equal(byId['all-season'], 4, 'the OTHER seasons must still show what selecting them would give')
  assert.ok(byId['all-season'] > 0, 'a panel whose unselected options all read 0 is unusable')
})

test('a count in one kind DOES respect the other kinds', () => {
  // Brand counts must narrow to the chosen season -- that is the AND.
  const { brands } = facetCounts(TIRES, { seasons: ['winter'], brands: [], bands: [] })
  const byId = Object.fromEntries(brands.map(b => [b.id, b.count]))
  assert.equal(byId.Michelin, 1, 'Michelin has one winter tire, not two')
  assert.equal(byId.Cooper, 1)
  assert.equal(byId.Aplus, 0, 'Aplus has no winter tire')
})

test('zero-count options are returned, not dropped, so controls do not move under the cursor', () => {
  const { brands } = facetCounts(TIRES, { seasons: ['winter'], brands: [], bands: [] })
  assert.ok(brands.some(b => b.id === 'Aplus' && b.count === 0),
    'an option that would give nothing is shown disabled, not removed')
})

test('a tire with no brand is kept, and offers no brand facet', () => {
  assert.equal(matchesFilters(TIRES.find(t => t.id === 'g'), NO_FILTERS), true)
  const { brands } = facetCounts(TIRES, NO_FILTERS)
  assert.ok(!brands.some(b => b.id === undefined || b.label === 'undefined'),
    'a missing brand must not become a facet called undefined')
  // ...and it is excluded by any brand selection, because it matches none.
  assert.deepEqual(applyFilters(TIRES, { ...NO_FILTERS, brands: ['Michelin'] }).map(t => t.id), ['a', 'e'])
})

test('price bands cover the list without overlapping', () => {
  const counted = PRICE_BANDS.map(band => TIRES.filter(t => t.price >= band.min && t.price < band.max).length)
  assert.equal(counted.reduce((a, b) => a + b, 0), TIRES.length, 'every tire falls in exactly one band')
  assert.deepEqual(applyFilters(TIRES, { ...NO_FILTERS, bands: ['under-150'] }).map(t => t.id).sort(), ['f', 'g'])
})

test('out-of-stock trails in every order, and every order is total', () => {
  for (const sort of ['price', 'brand', 'rating']) {
    const ordered = sortTires(TIRES, sort)
    const lastInStock = ordered.map(t => t.inStock).lastIndexOf(true)
    const firstOut = ordered.map(t => t.inStock).indexOf(false)
    assert.ok(firstOut === -1 || firstOut > lastInStock, `${sort}: out-of-stock must trail`)
    // Total order: sorting the reversed input gives the identical sequence.
    assert.deepEqual(sortTires([...TIRES].reverse(), sort).map(t => t.id), ordered.map(t => t.id),
      `${sort}: a sort with ties reshuffles a list when nothing changed`)
  }
})

test('price ascending stays the default', () => {
  const ids = sortTires(TIRES).filter(t => t.inStock).map(t => t.id)
  assert.deepEqual(ids, ['g', 'b', 'a', 'd', 'c', 'e'])
})

test('brand sort puts unbranded tires last, not first', () => {
  const ordered = sortTires(TIRES, 'brand').filter(t => t.inStock)
  assert.equal(ordered[ordered.length - 1].id, 'g', 'a missing brand sorts after every real one')
})

/**
 * Ratings are built and deliberately unpopulated: the owner has no source and
 * inventing them was never on the table. The feature must be invisible until
 * something real carries one.
 */
test('with no ratings anywhere, rating is not offered as a sort', () => {
  assert.equal(hasRatings(TIRES), false)
  assert.deepEqual(availableSorts(TIRES).map(s => s.id), ['price', 'brand'])
})

test('one real rating is enough to offer the sort', () => {
  const rated = [...TIRES, { id: 'h', brand: 'Toyo', category: 'all-season', price: 200, inStock: true, rating: 4.4, ratingCount: 1280 }]
  assert.equal(hasRatings(rated), true)
  assert.deepEqual(availableSorts(rated).map(s => s.id), ['price', 'brand', 'rating'])
})

test('a zero rating is not a rating', () => {
  // A backend that fills in 0 for "unknown" must not switch the feature on.
  const zeroed = TIRES.map(t => ({ ...t, rating: 0, ratingCount: 0 }))
  assert.equal(hasRatings(zeroed), false)
  assert.deepEqual(availableSorts(zeroed).map(s => s.id), ['price', 'brand'])
})

test('rating sort is highest first, and unrated tires trail', () => {
  const rated = [
    { id: 'low', category: 'all-season', price: 100, inStock: true, rating: 3.1 },
    { id: 'high', category: 'all-season', price: 300, inStock: true, rating: 4.8 },
    { id: 'none', category: 'all-season', price: 200, inStock: true },
  ]
  assert.deepEqual(sortTires(rated, 'rating').map(t => t.id), ['high', 'low', 'none'])
})

test('toggleFilter adds then removes, and never mutates its input', () => {
  const start = { ...NO_FILTERS }
  const added = toggleFilter(start, 'brands', 'Michelin')
  assert.deepEqual(added.brands, ['Michelin'])
  assert.deepEqual(start.brands, [], 'the original selection is untouched')
  assert.deepEqual(toggleFilter(added, 'brands', 'Michelin').brands, [])
  assert.equal(activeFilterCount(added), 1)
  assert.equal(activeFilterCount(toggleFilter(added, 'seasons', 'winter')), 2)
})

test('the real shape: 323 tires narrowed by season and brand', () => {
  // Proportioned like the measured 225/50R17: mostly all-season, a thin band
  // of winter, a handful of name brands among many house brands.
  const many = Array.from({ length: 323 }, (_, i) => ({
    id: `t${i}`,
    brand: i % 40 === 0 ? 'Michelin' : `House ${i % 7}`,
    category: i % 8 === 0 ? 'winter' : 'all-season',
    price: 120 + (i % 200),
    inStock: true,
  }))
  assert.equal(applyFilters(many, NO_FILTERS).length, 323)
  const winter = applyFilters(many, { ...NO_FILTERS, seasons: ['winter'] })
  assert.equal(winter.length, 41)
  assert.ok(winter.every(t => t.category === 'winter'))
  const { brands } = facetCounts(many, { ...NO_FILTERS, seasons: ['winter'] })
  assert.ok(brands.every(b => b.count <= 41), 'no brand can outnumber the season it is counted within')
})
