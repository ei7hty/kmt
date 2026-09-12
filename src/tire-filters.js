/**
 * Narrowing a size down to a list a person can actually read.
 *
 * WHY THIS EXISTS. Measured on the live site, 2026-09-12: size 225/50R17 holds
 * 323 tires. The shop showed twelve, sorted by price ascending, with no filter
 * and no sort control anywhere -- reaching the last tire meant pressing "show
 * 24 more" thirteen times. A winter tire sat fourth, between two summer tires,
 * because $157 falls between $155 and $159. In a Massachusetts market that is
 * the single distinction a buyer most needs and the page did not draw it.
 *
 * Pure functions over a plain array, deliberately: no fetch, no DOM, no React.
 * The list is already in memory -- filtering it in the browser is instant and
 * costs the supplier nothing, and it keeps this file testable without either.
 *
 * The markup lives in src/components/TireFilters.jsx. This is the part that
 * decides things, and the part the tests drive.
 */

/**
 * Season is the facet a buyer needs first, and the supplier does not provide
 * it. What it provides is `category` -- 'all-season', 'winter', 'performance',
 * 'off-road', 'eco' -- which mixes season with use case.
 *
 * These map the supplier's categories onto the question an owner is actually
 * asking ("will these get me through February?"). A category absent from this
 * map is kept and shown under its own name rather than dropped: a facet that
 * silently hides tires is worse than one with an unfamiliar label.
 */
export const SEASON_LABELS = Object.freeze({
  'all-season': 'All-season',
  winter: 'Winter',
  performance: 'Summer / performance',
  'off-road': 'Off-road / all-terrain',
  eco: 'Eco',
})

/**
 * Price bands, in dollars per tire.
 *
 * Derived from the live catalogue rather than picked round: measured
 * 2026-09-12 over 6,038 offered tires, the range is $55.64 to $4,611.96 with a
 * median of $249.27. Two bands under the median and two above put roughly half
 * the catalogue in each direction, which is what makes a band worth pressing.
 * RE-MEASURE if pricing moves; a band nobody's tires fall into is dead weight.
 */
export const PRICE_BANDS = Object.freeze([
  { id: 'under-150', label: 'Under $150', min: 0, max: 150 },
  { id: '150-250', label: '$150 – $250', min: 150, max: 250 },
  { id: '250-400', label: '$250 – $400', min: 250, max: 400 },
  { id: 'over-400', label: 'Over $400', min: 400, max: Infinity },
])

/**
 * The orders a customer can ask for, each labelled with what it does.
 *
 * "Price" said nothing about which end it started from, and there was only one
 * direction, so a customer who wanted the best tire in the size could not ask
 * for it. In 225/50R17 that hid a lot: the size runs $52.03 to $516.27, and
 * the twelve tires everyone saw first spanned $52.03 to $63.92 -- a $12 window
 * of a $464 range, with the other 311 thirteen presses of "show 24 more" away.
 */
export const SORTS = Object.freeze({
  price: { id: 'price', label: 'Price: low to high' },
  'price-desc': { id: 'price-desc', label: 'Price: high to low' },
  brand: { id: 'brand', label: 'Brand A-Z' },
  rating: { id: 'rating', label: 'Rating' },
})

/** The empty selection: everything shown, nothing narrowed. */
export const NO_FILTERS = Object.freeze({ seasons: [], brands: [], bands: [] })

const bandOf = price => PRICE_BANDS.find(band => price >= band.min && price < band.max) ?? null
const seasonLabel = category => SEASON_LABELS[category] ?? category ?? 'Other'

/**
 * Does one tire pass a selection?
 *
 * Facets are AND across kinds and OR within a kind -- "winter OR all-season,
 * AND Michelin, AND under $250" -- which is how every shop a customer has used
 * before behaves. An empty kind means that kind is not narrowing anything, not
 * that nothing matches.
 */
export function matchesFilters(tire, filters = NO_FILTERS) {
  const { seasons = [], brands = [], bands = [] } = filters ?? {}
  if (seasons.length && !seasons.includes(tire.category)) return false
  if (brands.length && !brands.includes(tire.brand)) return false
  if (bands.length) {
    const band = bandOf(tire.price)
    if (!band || !bands.includes(band.id)) return false
  }
  return true
}

/**
 * Facet options with a COUNT FOR EACH, computed against the other facets.
 *
 * The count beside a checkbox answers "how many will I have left" before the
 * press, and it is computed with that facet's own selection removed -- so
 * ticking "Winter" does not drop every other season's count to zero and make
 * the rest of the list look empty. That is the behaviour a person expects from
 * a shop and the thing that is wrong in most hand-rolled filter panels.
 *
 * Options with a zero count are RETURNED, not dropped, so the panel does not
 * reflow as boxes are ticked; the caller renders them disabled. A control that
 * moves under the cursor is worse than one that is greyed.
 */
export function facetCounts(tires, filters = NO_FILTERS) {
  const without = kind => tires.filter(tire => matchesFilters(tire, { ...filters, [kind]: [] }))

  const seasonPool = without('seasons')
  const seasonIds = [...new Set(tires.map(tire => tire.category).filter(Boolean))]
  const seasons = seasonIds
    .map(id => ({ id, label: seasonLabel(id), count: seasonPool.filter(tire => tire.category === id).length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const brandPool = without('brands')
  const brandIds = [...new Set(tires.map(tire => tire.brand).filter(Boolean))]
  const brands = brandIds
    .map(id => ({ id, label: id, count: brandPool.filter(tire => tire.brand === id).length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const bandPool = without('bands')
  const bands = PRICE_BANDS
    .map(band => ({ id: band.id, label: band.label, count: bandPool.filter(tire => bandOf(tire.price)?.id === band.id).length }))
    .filter(band => band.count > 0 || (filters?.bands ?? []).includes(band.id))

  return { seasons, brands, bands }
}

/**
 * Is there anything to sort by rating WITH?
 *
 * Ratings are built but unpopulated on purpose: the owner has no source for
 * them yet and inventing them was never on the table. So the control appears
 * only once real ratings exist, rather than sitting there sorting nothing and
 * teaching customers it does not work.
 */
export function hasRatings(tires) {
  return tires.some(tire => typeof tire.rating === 'number' && tire.rating > 0)
}

/** The sorts worth offering for THIS list: rating only when something carries one. */
export function availableSorts(tires) {
  return [SORTS.price, SORTS['price-desc'], SORTS.brand, ...(hasRatings(tires) ? [SORTS.rating] : [])]
}

/**
 * The cheapest and dearest of a list, for the line above it.
 *
 * The first screen used to say "323 tires" over twelve tires between $52 and
 * $64, which reads as a shop that tops out at $64. It says what the list on
 * screen really spans instead -- so "low to high" is understood as a place in
 * a range rather than as the whole of it.
 *
 * Out-of-stock tires count: they are shown, they carry a price, and leaving
 * them out would make the line disagree with the list under it.
 */
export function priceRange(tires) {
  const prices = tires.map(tire => tire.price).filter(price => typeof price === 'number')
  if (prices.length === 0) return null
  return { low: Math.min(...prices), high: Math.max(...prices) }
}

/**
 * Order a list.
 *
 * Out-of-stock tires trail in every order, as they always have: they are shown
 * so a buyer knows they exist, and cannot be chosen.
 *
 * LOW TO HIGH STAYS THE DEFAULT. The complaint it answers is real -- the shop
 * opened on its twelve cheapest tires -- but the fix is not a different
 * default. It is saying which end you are at, offering the other one, and
 * printing the range above the list, because a customer at a roadside asking
 * for the cheapest workable tire is the common case here and reordering
 * against them to make the shop look dearer would be merchandising, not help.
 *
 * Every comparator ends in a total tiebreak, so the order is total: a sort
 * with ties is a list that reshuffles when nothing changed.
 *
 * An id with no comparator here falls back to price, which is the right thing
 * for a stale saved sort and the wrong thing for a pill someone just added and
 * wired to nothing -- it would look like it worked. tire-filters.test.mjs
 * holds SORTS and this table to each other so that cannot happen quietly.
 */
export function sortTires(tires, sort = 'price') {
  const byStock = (a, b) => (a.inStock === b.inStock ? 0 : a.inStock ? -1 : 1)
  const tail = (a, b) => a.price - b.price || String(a.id).localeCompare(String(b.id))
  const comparators = {
    price: tail,
    // Not -tail: the tiebreak has to stay a total order, and negating one that
    // ends in a localeCompare would reverse the id order too, which is fine,
    // but writing it out says what it does.
    'price-desc': (a, b) => b.price - a.price || String(a.id).localeCompare(String(b.id)),
    brand: (a, b) => String(a.brand ?? '￿').localeCompare(String(b.brand ?? '￿')) || tail(a, b),
    // Highest first: a rating sort that put one-star tires on top would be a
    // literal reading of "sort by rating" and no use to anyone.
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || tail(a, b),
  }
  const compare = comparators[sort] ?? comparators.price
  return [...tires].sort((a, b) => byStock(a, b) || compare(a, b))
}

/** Filter then sort, in that order, because the sort is over what survived. */
export function applyFilters(tires, filters = NO_FILTERS, sort = 'price') {
  return sortTires(tires.filter(tire => matchesFilters(tire, filters)), sort)
}

/** Tick or untick one option, returning a new selection. */
export function toggleFilter(filters, kind, id) {
  const current = filters?.[kind] ?? []
  const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id]
  return { ...NO_FILTERS, ...filters, [kind]: next }
}

/** How many kinds are narrowing anything -- for the "clear all" control. */
export function activeFilterCount(filters = NO_FILTERS) {
  return (filters?.seasons?.length ?? 0) + (filters?.brands?.length ?? 0) + (filters?.bands?.length ?? 0)
}

/**
 * How many brands to show before the rest go behind a disclosure.
 *
 * Measured, not chosen by feel: 225/50R17 holds 323 tires from 107 brands, and
 * the first version of this panel drew every one of them. It came to 4,010px
 * -- four and a half screens of checkboxes above the first tire -- and the
 * tail of it was 40-odd brands with a single tire each. A filter that is
 * taller than the list it filters is not narrowing anything.
 *
 * Twelve is where the shape of this catalogue changes: sorted by count, the
 * twelfth brand in that size has 8 tires and the thirteenth has 7, and the
 * twelve are Bridgestone, Hankook, Pirelli, Continental, Nexen, Goodyear,
 * Michelin, Nokian, Cooper, Falken, General and Yokohama -- the names a
 * customer came in saying. They are ranked, never listed by name here: a
 * hard-coded roster would quietly hide a brand the moment stock changed.
 */
export const BRAND_FACET_LIMIT = 12

/**
 * Split a facet's options into the ones shown and the ones behind "show all".
 *
 * `options` arrives already ranked (count first, then alphabetically), so this
 * only cuts; it never reorders, because a list that re-sorts itself as boxes
 * are ticked moves a control out from under the cursor mid-press -- the same
 * reason a zero-count option is disabled rather than dropped.
 *
 * A SELECTED option is always shown, wherever it ranks. Otherwise ticking a
 * rare brand and then collapsing the list would hide the very control holding
 * the list down, and the only way back would be Clear filters.
 *
 * A zero-count option that is already on screen STAYS on screen, disabled --
 * removing it reflows the panel under the cursor. One still hidden is dropped
 * instead of revealed: with Winter ticked, 86 of the 107 brands have no winter
 * tire, and "show all" should not mean "show 86 things you cannot pick".
 * `shown.length + hidden.length` is therefore what the control should count,
 * not `options.length`.
 */
export function visibleFacet(options, { limit = BRAND_FACET_LIMIT, selected = [], expanded = false } = {}) {
  const pickable = option => option.count > 0 || selected.includes(option.id)
  if (expanded) return { shown: options.filter(pickable), hidden: [] }
  if (options.length <= limit) return { shown: options, hidden: [] }
  const keep = new Set(options.slice(0, limit).map(option => option.id))
  for (const id of selected) keep.add(id)
  return {
    shown: options.filter(option => keep.has(option.id)),
    hidden: options.filter(option => !keep.has(option.id) && pickable(option)),
  }
}
