import test from 'node:test'
import assert from 'node:assert/strict'

import {
  matchesFilters, facetCounts, applyFilters, sortTires, toggleFilter,
  activeFilterCount, hasRatings, availableSorts, visibleFacet, priceRange,
  NO_FILTERS, PRICE_BANDS, BRAND_FACET_LIMIT, SORTS,
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
  for (const sort of ['price', 'price-desc', 'brand', 'rating']) {
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
  assert.deepEqual(availableSorts(TIRES).map(s => s.id), ['price', 'price-desc', 'brand'])
})

test('one real rating is enough to offer the sort', () => {
  const rated = [...TIRES, { id: 'h', brand: 'Toyo', category: 'all-season', price: 200, inStock: true, rating: 4.4, ratingCount: 1280 }]
  assert.equal(hasRatings(rated), true)
  assert.deepEqual(availableSorts(rated).map(s => s.id), ['price', 'price-desc', 'brand', 'rating'])
})

test('a zero rating is not a rating', () => {
  // A backend that fills in 0 for "unknown" must not switch the feature on.
  const zeroed = TIRES.map(t => ({ ...t, rating: 0, ratingCount: 0 }))
  assert.equal(hasRatings(zeroed), false)
  assert.deepEqual(availableSorts(zeroed).map(s => s.id), ['price', 'price-desc', 'brand'])
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

// --- How many brands to draw ---------------------------------------------------

/** Ranked the way facetCounts ranks: count first, then alphabetically. */
const ranked = (count, from = 30) => Array.from({ length: count }, (_, i) => ({
  id: `brand-${i}`, label: `Brand ${i}`, count: from - i,
}))

test('a short facet is drawn whole, with nothing behind a disclosure', () => {
  const options = ranked(BRAND_FACET_LIMIT)
  const { shown, hidden } = visibleFacet(options)
  assert.equal(shown.length, BRAND_FACET_LIMIT)
  assert.deepEqual(hidden, [], 'a list that already fits must not offer to expand')
})

test('a long facet keeps its ranking and cuts only the tail', () => {
  // 107 brands is the measured 225/50R17. Drawing all of them made the panel
  // 4,010px tall, which is what this cap exists to prevent.
  const options = ranked(107, 120)
  const { shown, hidden } = visibleFacet(options)
  assert.equal(shown.length, BRAND_FACET_LIMIT)
  assert.equal(shown.length + hidden.length, 107)
  assert.deepEqual(shown.map(o => o.id), options.slice(0, BRAND_FACET_LIMIT).map(o => o.id),
    'the shown brands are the highest-counted ones, in the order they arrived')
})

test('a brand you have already ticked is never hidden by the cap', () => {
  // Otherwise ticking a rare brand and collapsing the list would hide the only
  // control holding the list down, and Clear filters would be the way back.
  const options = ranked(107, 120)
  const rare = options.at(-1).id
  const { shown, hidden } = visibleFacet(options, { selected: [rare] })
  assert.ok(shown.some(o => o.id === rare), 'the ticked brand fell off the end of the panel')
  assert.ok(!hidden.some(o => o.id === rare))
  assert.equal(shown.length, BRAND_FACET_LIMIT + 1)
})

test('expanding shows every brand you can still pick, and no brand you cannot', () => {
  // With Winter ticked, 86 of the 107 brands have no winter tire. "Show all"
  // must not mean "show 86 things you cannot choose".
  const options = [...ranked(BRAND_FACET_LIMIT + 4, 40), ...ranked(50, 0).map(o => ({ ...o, count: 0 }))]
  const { shown, hidden } = visibleFacet(options, { expanded: true })
  assert.deepEqual(hidden, [])
  assert.equal(shown.length, BRAND_FACET_LIMIT + 4)
  assert.ok(shown.every(o => o.count > 0))
})

test('a zero-count brand already on screen stays on screen', () => {
  // The other half of the same rule: an option that is drawn must not vanish
  // as boxes are ticked, because a control that moves mid-press is worse than
  // a greyed one. Only the hidden tail is pruned.
  const options = [...ranked(6, 20), ...ranked(6, 0).map((o, i) => ({ ...o, id: `empty-${i}`, count: 0 }))]
  const { shown, hidden } = visibleFacet(options)
  assert.equal(options.length, BRAND_FACET_LIMIT)
  assert.equal(shown.length, BRAND_FACET_LIMIT, 'a collapsed list at the cap drops nothing')
  assert.deepEqual(hidden, [])
})

test('the count on the control is what expanding will really show', () => {
  const options = [...ranked(20, 40), ...ranked(30, 0).map((o, i) => ({ ...o, id: `empty-${i}`, count: 0 }))]
  const collapsed = visibleFacet(options)
  const expanded = visibleFacet(options, { expanded: true })
  assert.equal(collapsed.shown.length + collapsed.hidden.length, expanded.shown.length,
    '"Show all N brands" would name a number the expanded list does not contain')
  assert.notEqual(expanded.shown.length, options.length, 'this case has to include unpickable brands to mean anything')
})

// --- Which end of the price you are looking at ---------------------------------

test('high to low is the other end, and out-of-stock still trails', () => {
  const ids = sortTires(TIRES, 'price-desc').map(t => t.id)
  const inStock = TIRES.filter(t => t.inStock).length
  assert.deepEqual(ids.slice(0, inStock), ['e', 'c', 'd', 'a', 'b', 'g'],
    'dearest first among what can be bought')
  assert.deepEqual(ids.slice(inStock), ['f'], 'a tire nobody can buy does not lead any order')

  // Mirror images of each other among the tires you can actually buy. Out of
  // stock trails in BOTH directions, so it is not part of the mirror.
  const buyable = sort => sortTires(TIRES, sort).filter(t => t.inStock).map(t => t.id)
  assert.deepEqual(buyable('price-desc'), [...buyable('price')].reverse())
})

test('every sort a customer is offered is wired to a comparator of its own', () => {
  // `comparators[sort] ?? comparators.price` is right for a stale saved sort
  // and wrong for a new pill wired to nothing: it would look like it worked.
  // A list where price order and every other order genuinely differ.
  const list = [
    { id: '1', brand: 'Zenith', category: 'winter', price: 90, inStock: true, rating: 2 },
    { id: '2', brand: 'Apex', category: 'winter', price: 300, inStock: true, rating: 5 },
    { id: '3', brand: 'Mid', category: 'winter', price: 180, inStock: true, rating: 4 },
  ]
  const fallback = sortTires(list, 'no-such-sort').map(t => t.id)
  assert.deepEqual(fallback, sortTires(list, 'price').map(t => t.id),
    'an unknown sort should fall back to price -- if this changed, the guard below means something else')

  for (const id of Object.keys(SORTS)) {
    if (id === 'price') continue
    assert.notDeepEqual(sortTires(list, id).map(t => t.id), fallback,
      `the "${id}" pill orders this list exactly as price does, which is what a sort wired to nothing looks like`)
  }
})

test('every sort offered has a label that says which way it goes', () => {
  // "Price" did not, and there was only one direction, so a customer who
  // wanted the best tire in the size had no way to ask for it.
  for (const sort of availableSorts(TIRES)) {
    assert.ok(sort.label && sort.label.trim(), `${sort.id} has no label`)
    if (sort.id.startsWith('price')) {
      assert.match(sort.label, /low to high|high to low/,
        `"${sort.label}" does not say which end of the price it starts from`)
    }
  }
  const directions = availableSorts(TIRES).filter(s => s.id.startsWith('price')).map(s => s.label)
  assert.equal(new Set(directions).size, 2, 'both directions of price are offered, and they are not the same label')
})

// --- What the list on screen spans ---------------------------------------------

test('the range is of the tires actually shown, not of the size', () => {
  // "323 tires" over twelve tires between $52 and $64 reads as a shop that
  // tops out at $64. The line has to agree with the list under it.
  assert.deepEqual(priceRange(TIRES), { low: 99.00, high: 310.00 })
  const winter = applyFilters(TIRES, { ...NO_FILTERS, seasons: ['winter'] })
  assert.deepEqual(priceRange(winter), { low: 157.33, high: 220.00 },
    'filtered to winter, the range still claims the whole size')
})

test('a range needs something to be a range of', () => {
  assert.equal(priceRange([]), null, 'an empty list has no range, and must not report one')
  assert.deepEqual(priceRange([TIRES[0]]), { low: 157.33, high: 157.33 },
    'one tire is its own low and high; the panel says it once rather than as a span')
  // An out-of-stock tire is shown and carries a price, so it counts: leaving
  // it out would make the line disagree with the list.
  const soldOut = TIRES.find(t => !t.inStock)
  assert.ok(soldOut.price < priceRange(TIRES).high)
  assert.equal(priceRange([soldOut]).low, soldOut.price)
})
