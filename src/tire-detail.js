/**
 * What a customer needs to know about ONE tire, once they have picked it.
 *
 * WHY THIS EXISTS. Walked at 375px on 2026-09-12 against the live catalogue:
 * size 225/50R17 holds 323 tires from 107 brands between $52.03 and $516.27,
 * and a card carries four things -- a name, the supplier's spec string, a stock
 * line and a price. For 103 of those 107 brands the name says nothing to
 * anybody (Ferentino, Rockblade, Accelera, Americus), the spec string is half
 * English and half code ("High Performance All Season · 94V BSW"), and 4 rows
 * in this size carry NO English at all: their whole description is "98W BSW".
 * So the question a person actually has standing next to a flat -- why is this
 * one $52 and that one $516, and will it get me through February -- has no
 * answer anywhere on the screen.
 *
 * This module answers the part that can be answered HONESTLY from the fields a
 * customer's browser is already allowed to see. It invents nothing:
 *
 *   - the season note explains what the supplier's own category MEANS, and
 *     says that the supplier is the one saying it (see SEASON_NOTES);
 *   - the price standing is arithmetic over the list already on screen;
 *   - the decoded spec is rendered only if a `specPoints` field ever crosses
 *     the catalog boundary, which is the owner's decision and not ours;
 *   - the rating is `null` until a tire really carries one.
 *
 * Pure functions over plain objects, deliberately -- no fetch, no DOM, no
 * React. The markup is src/components/TireDetails.jsx; every decision is here,
 * which is where the tests drive it. Same split as tire-filters.js /
 * TireFilters.jsx, and inventory-grid.js / OwnerInventoryGrid.jsx.
 */
import { SEASON_LABELS, hasRatings } from './tire-filters.js'

/**
 * What each supplier category means, in plain English, for driving here.
 *
 * These describe the CATEGORY, not the tire. That distinction is load-bearing
 * and not pedantry: measured over all 1,083 rows of the tracked snapshot, 4
 * are filed under the wrong season -- the General/Grabber Altimax Arctic X, a
 * studdable winter tire, is categorised `all-season` in three sizes and
 * `performance` in a fourth. A sentence of advice about THAT tire would be
 * wrong. A sentence about what "all-season" means, attributed to the supplier
 * who assigned it, stays true whether the filing is right or not, and Ken --
 * who confirms every job personally -- is the one who catches the rest.
 *
 * The keys are the supplier's categories as they reach the browser. Measured
 * over the same 1,083 rows there are exactly five: all-season (724),
 * off-road (146), winter (131), performance (80), eco (2). A category absent
 * from this map yields no note at all rather than a guess; `seasonNote`
 * returns null and the panel simply does not draw that block.
 *
 * The LABEL is not repeated here. It is read from SEASON_LABELS, which the
 * filter panel above the list already prints, so a tire cannot be filed under
 * "Summer / performance" in the filter and called something else forty pixels
 * below it. Two constants encoding one fact is the defect this repository has
 * already paid for in CATALOG_FIELDS and EXPECTED_CHECKS; there is one here.
 */
export const SEASON_NOTES = Object.freeze({
  'all-season': 'Built to cope with most of a New England year: wet roads, cold mornings, an inch or two of snow. It is the usual choice around here if you are not swapping to winters in November.',
  winter: 'The rubber stays soft in the cold, so it holds on snow and ice in a way nothing else does. It wears fast in summer heat, so this is a tire you swap off again in the spring.',
  performance: 'A warm-weather tire, built for grip when it is dry and mild. The rubber goes hard as the temperature drops, so it is the wrong tire to be on in a Massachusetts January.',
  'off-road': 'Built for dirt, gravel and mud. Louder on the highway than a road tire, and it will not last as long on pavement.',
  eco: 'Built to roll easily and save fuel on the highway. In every other way an ordinary road tire.',
})

/**
 * The season block: the supplier's label, and what that label means.
 *
 * Returns null for a category this map has no honest sentence for, including
 * a missing one. The panel draws nothing rather than an empty heading -- the
 * card above it already prints whatever the supplier said.
 */
export function seasonNote(tire) {
  const category = tire?.category
  const body = SEASON_NOTES[category]
  if (!body) return null
  // THE LABEL IS THE SUPPLIER'S OWN WORDS WHERE THEY EXIST, and the coarse
  // category only as a fallback. `category` has five values; 230 of the 323
  // tires in 225/50R17 are `all-season`, so seven rows in ten were headed with
  // the same word above the same paragraph and the panel read as though it had
  // failed to load. `specCategory` carries what the supplier actually called
  // it -- Touring, Racing, All Weather, Ultra High Performance All Season --
  // and has fourteen values in that same size.
  //
  // The BODY still comes from the coarse category, because a sentence about
  // driving here is only honest for the five buckets somebody wrote one for.
  // So the label says what this tire is and the paragraph says what that kind
  // of tire does, which is the split a customer needs.
  const supplier = typeof tire?.specCategory === 'string' ? tire.specCategory.trim() : ''
  return { label: supplier || SEASON_LABELS[category] || category, body }
}

/**
 * The supplier's spec codes, already turned into plain English.
 *
 * NOT PARSED HERE, AND NOT PARSED YET. `backend/tire-spec.mjs` (PR #513) is
 * the parser -- `describeTireSpec()` resolves 99.0% of the 1,083 rows with no
 * unresolved token -- and it returns `points` as an ARRAY while `description`
 * is a string, so wiring it to the customer ADDS a field to what crosses to a
 * browser rather than replacing one. That boundary is a positive allow-list
 * (`CATALOG_FIELDS` / `CATALOG_OPTIONAL_FIELDS` in .forge/audit-ui.mjs,
 * asserted per row by backend/catalog-boundary.test.mjs) and it exists because
 * `sku`, `stock`, `listPrice` and the supplier's product URL once reached
 * every customer's browser. Adding to it is the owner's decision.
 *
 * So this reads a field that does not cross today and returns an empty array,
 * and the panel draws no spec block at all. The day `specPoints` is approved
 * and projected, this lights up with no further change here. ONE field is the
 * whole ask; `unresolved` is deliberately not requested, because the card
 * already prints the raw description including any token nobody could resolve.
 *
 * Defensive about the shape rather than trusting it: a string, a number, a
 * null or an array of empty strings all yield nothing, because a panel that
 * renders an empty bullet is worse than one that renders no list.
 */
export function specPoints(tire) {
  const points = tire?.specPoints
  if (!Array.isArray(points)) return []
  return points.filter(point => typeof point === 'string' && point.trim() !== '')
}

/**
 * This tire's rating, or null.
 *
 * Ratings are built and DELIBERATELY EMPTY: there is no source for them and
 * inventing them was never on the table. Nothing in the catalogue carries one
 * today -- measured 2026-09-12 against the live API, 0 of 323 rows in
 * 225/50R17 even have the key. So this returns null and the panel draws no
 * stars, no empty stars, and no "not yet rated" placeholder, which would all
 * teach a customer the feature is broken.
 *
 * The predicate is `hasRatings` from tire-filters.js, applied to a list of
 * one. Not a reimplementation of `typeof x === 'number' && x > 0`: that rule
 * is what decides whether the rating SORT appears, and a second copy of it
 * here would be two literals encoding one fact -- they would agree today and
 * one of them would be changed alone later. A zero is the case that matters:
 * a tire nobody has rated must not read as a tire rated zero.
 */
export function tireRating(tire) {
  return hasRatings([tire]) ? tire.rating : null
}

/**
 * Everything the panel draws, as data.
 *
 * One call so the component is a renderer with no decisions in it, and so a
 * test can assert the whole panel's content without a DOM -- there is no
 * react-dom in this suite and a JSX file cannot be imported by `node --test`.
 * Every field is null or empty when there is nothing honest to say, and the
 * component draws exactly the blocks that are not.
 *
 * IT NO LONGER TAKES THE LIST. A fourth block compared this tire's price with
 * the others on screen -- "In this list, 8 tires cost less and 165 cost more."
 * The owner read it on his own site and did not want it, which is the whole
 * reason it is gone: a sentence that invites a customer to go price-hunting
 * through 323 rows was answering a question he had not asked to have answered.
 * The list was that block's only reader.
 */
export function tireDetail(tire) {
  return {
    season: seasonNote(tire),
    spec: specPoints(tire),
    rating: tireRating(tire),
  }
}
