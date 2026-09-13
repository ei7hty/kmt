/**
 * The inventory matrix, with no React in it.
 *
 * Everything the grid *decides* lives here: which way a header arrow points,
 * whether the empty state may be shown, what a bulk response did to which
 * rows, and whether an action needs confirming before a request is sent. The
 * component in `OwnerInventoryGrid.jsx` renders this and nothing more.
 *
 * It is split out because none of those decisions can be tested through the
 * component: there is no JSX runner, no jsdom and no testing-library in this
 * repository, and adding three dependencies to assert an arrow direction is a
 * worse trade than keeping the decisions in a file `node --test` can import.
 * `inventory-grid.test.mjs` drives `createInventoryGrid` against a stub of
 * `api()` that implements the stage-1 contract strictly, so the tests exercise
 * request shape and response handling, not just pure helpers.
 *
 * THE CONTRACT THIS IS BUILT AGAINST (stage 1, `backend/inventory.mjs`):
 *
 *   GET  /api/owner/inventory?search=&size=&filter=&page=&sort=&dir=&pageSize=
 *        -> { items[], total, page, pageSize, summary, sort, dir }
 *   PUT  /api/owner/offers   { offers: [{id, priceCents, shippingCents,
 *                                        enabled, notes, version}] }, max 200
 *        -> { results: [{id, ok:true, version} |
 *                       {id, ok:false, reason, message}] } in request order
 *   PUT  /api/owner/offers/:id  (unchanged, single row)
 *
 * The server ECHOES the sort and dir it actually applied, because an unknown
 * sort key falls back to the default order without erroring. Every arrow in
 * this file is derived from the echo, never from what was requested: a header
 * that claims a sort the server ignored is a UI that lies.
 */
// The customer's own season facet. Imported rather than restated so the
// owner's select, the customer's filter and the server's validator are three
// readings of one list -- see seasonChoices below.
import { SEASON_LABELS } from '../tire-filters.js'

/** What the server's pageSize allow-list accepts. Anything else is refused. */
export const PAGE_SIZES = [24, 50, 100, 200]

/** The bulk endpoint's cap. Selection is per page, so a full page fits. */
export const BULK_LIMIT = 200

/**
 * The columns, left to right, and which of them the server can order by.
 *
 * `updated` is in the contract's sort allow-list but was not in the column
 * list, and a sort key with no header is a sort the owner cannot reach — so
 * it gets a column of its own at the right-hand end.
 */
export const GRID_COLUMNS = [
  { key: 'select', label: '', sort: null },
  // Not sortable, deliberately. `photo` is derived per row -- part SQL, part a
  // revision hash computed in JS -- so there is no single column the server
  // could ORDER BY. A header that sorts nothing while looking sortable is the
  // screen lying about what it did; the two photo FILTERS do this job honestly.
  { key: 'photo', label: 'Photo', sort: null },
  { key: 'size', label: 'Size', sort: 'size' },
  { key: 'name', label: 'Tire', sort: 'name' },
  { key: 'supplierCost', label: 'Supplier cost', sort: 'supplierPrice', numeric: true },
  { key: 'price', label: 'Your price', sort: 'price', numeric: true },
  { key: 'margin', label: 'Margin', sort: 'margin', numeric: true },
  { key: 'shipping', label: 'Shipping', sort: null, numeric: true },
  { key: 'enabled', label: 'Offered', sort: 'enabled' },
  { key: 'notes', label: 'Notes', sort: null },
  { key: 'sku', label: 'SKU', sort: null },
  { key: 'updated', label: 'Updated', sort: 'updated' },
]

export const dollars = cents => cents == null || Number.isNaN(cents)
  ? '—'
  : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** A money field as typed, in cents. '' is "not set"; anything malformed is NaN. */
export function parseMoney(text) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return NaN
  return Math.round(Number(value) * 100)
}

export const moneyField = cents => cents == null ? '' : (cents / 100).toFixed(2)

/**
 * Is a customer able to buy this tire right now?
 *
 * The server answers this in `selling.offered`, computed by the same
 * `quotedPrice` the customer catalogue runs on. This wrapper exists only for
 * the fallback, and the fallback's DIRECTION is the point: an older response
 * with no `selling` field must not quietly resolve to `offer.enabled`, because
 * that is the exact value whose falseness took priced tires off sale. So it
 * falls back to the rule `quotedPrice` applies -- a tire with no offers row is
 * offered, whatever `enabled` says -- reconstructed from `version`, which is 0
 * for a row that has never been written and >= 1 for every row that has.
 */
export const sellingEnabled = item =>
  typeof item?.selling?.offered === 'boolean'
    ? item.selling.offered
    : neverDecided(item) || Boolean(item?.offer?.enabled)

/**
 * Has Ken ever saved anything about this tire?
 *
 * `version` is 0 for a row with no `offers` record and at least 1 for every
 * row that has one -- the first write stores `version + 1`. That makes it the
 * one field on `offer` that distinguishes "he said no" from "nobody asked",
 * which the `enabled` boolean on its own cannot.
 */
export const neverDecided = item => (item?.offer?.version ?? 0) === 0

/**
 * What one row is selling for, and whether that is Ken's number or the rule's.
 *
 * `source` is markup.js's own word for the difference, carried through the
 * server untouched: 'owner' is a decision, 'markup' is a suggestion nobody has
 * looked at, and null is a tire with no usable supplier cost to price from.
 */
export const sellingPriceCents = item => item?.selling?.priceCents ?? null
export const sellingSource = item => item?.selling?.source ?? null

/**
 * The rule's price for this row, or null if the rule is not what is in force.
 *
 * TWO conditions, and the second is the load-bearing one. `selling` is the
 * server's answer and the save responses do not carry a new one, so a row that
 * has just been saved still holds the `selling` from before the save: source
 * 'markup', and the old rule price. Reading `source` alone therefore printed
 * "$135.00 by rule" under the $150.00 the owner had just set — announcing a
 * price that was no longer in force, which is the same class of defect this
 * whole change exists to remove.
 *
 * `offer.priceCents` is the half that survives a stale `selling`, because both
 * save paths keep it accurate on the row. An owner price always wins over the
 * rule (markup.js: "The owner's price for that specific tire, if he has set
 * one. It wins outright"), so its presence is enough to know the rule is not
 * pricing this tire — without this module having to know what the rule is.
 */
export const ruledPriceCents = item =>
  item?.offer?.priceCents == null && sellingSource(item) === 'markup'
    ? sellingPriceCents(item)
    : null

/* -------------------------------------------------------------------------- *
 * Low stock, and the rule Ken has been keeping in his head.
 *
 * In his own words he switches tires off when stock is low -- "below 100, or
 * whatever the number is". Two things follow from that, and neither is visible
 * on this screen today.
 *
 * **The grid cannot show him what his own rule covers.** The stock line reads
 * `N in stock` in the in-stock green for every row above zero, so a tire with 4
 * left and a tire with 35,681 look identical. Measured on the 1,083 supplier
 * rows in `src/data/scraped-tires.json`: stock runs 4 to 35,681, median 459,
 * and 274 of them -- 25.3% -- are under 100.
 *
 * **And switching one off is a one-way door.** When the supplier restocks,
 * nothing turns it back on; the off-list only grows and goes quietly stale.
 * That half is not fixed by hiding low stock automatically, because an
 * automatic rule knows nothing about the tires he already switched off by hand
 * -- `offers` records that a row was disabled and never why. So the pile stays
 * off forever unless something puts it in front of him. `stockRecovered` is
 * that something, and it is the reason this is display work rather than a
 * deriving rule: the deriving belongs in the backend, this is the half that
 * makes it safe to turn on and the half that clears what is already stuck.
 * -------------------------------------------------------------------------- */

/** Ken's own number, until he changes it. `.forge/CLAIMS.md`'s brief quotes him. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 100

/**
 * The range the threshold box accepts. Whole tires, so a whole number.
 *
 * The floor is 1 rather than 0 on purpose: at 0 nothing could ever be under it,
 * so a `0` here would be a silent "off" switch wearing the clothes of a
 * threshold -- the same blank-against-zero confusion the markup form's margin
 * bounds are careful about, and not worth reintroducing in a second place. The
 * ceiling is above the largest stock figure in the catalogue (35,681), so
 * "mark everything" stays reachable if Ken wants to see the whole spread.
 */
export const LOW_STOCK_MIN = 1
export const LOW_STOCK_MAX = 99999

/** A typed threshold, or `null` if it is not one. Whole numbers only. */
export function parseLowStockThreshold(text) {
  const value = String(text ?? '').trim()
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  return number >= LOW_STOCK_MIN && number <= LOW_STOCK_MAX ? number : null
}

/**
 * What the supplier's stock says about one row.
 *
 * Five states, and `low` is the new one -- everything else is the expression
 * already rendered inline in `OwnerInventoryGrid.jsx`, moved here so it can be
 * tested. That move matters more than it looks: **three of these five states
 * are states the seeded database never produces.** There are zero out-of-stock
 * rows, zero delisted rows and zero rows with no stock figure in all 1,083, so
 * no browser audit this repository runs has ever drawn `out`, `delisted` or
 * `unknown` -- which is exactly how the customer flow's unavailable-tire card
 * went months with colours nobody could read. A unit test can reach them.
 *
 * Order is load-bearing. Delisted outranks everything, because a tire the
 * supplier has stopped listing is not "low", it is gone. `inStock === false`
 * outranks the count for the same reason `catalog()` trusts it: the supplier
 * can say out of stock while still reporting a number.
 */
export function stockState(item, threshold = DEFAULT_LOW_STOCK_THRESHOLD) {
  if (!item?.supplierActive) return 'delisted'
  const stock = item?.source?.stock
  if (typeof stock !== 'number') return 'unknown'
  if (item?.inStock === false || stock <= 0) return 'out'
  return stock < threshold ? 'low' : 'ok'
}

/** The stock line as the owner reads it. `low` says how few, not how many. */
export function stockLabel(item, threshold = DEFAULT_LOW_STOCK_THRESHOLD) {
  const stock = item?.source?.stock
  switch (stockState(item, threshold)) {
    case 'delisted': return 'No longer listed'
    case 'unknown': return 'Stock unconfirmed'
    case 'out': return 'Out of stock'
    // "left", not "in stock": the number is the same and the sentence is the
    // point -- this is the row his own rule is about.
    case 'low': return `${stock.toLocaleString()} left`
    default: return `${stock.toLocaleString()} in stock`
  }
}

/**
 * The classes the stock line wears, decided here rather than in the component.
 *
 * The COLOUR comes from this screen's two settled tokens -- `.oi-stock` green
 * and `.oi-attention` amber -- and `ok` is the only state that gets the green
 * one. That is the behaviour change: `low` used to be green along with
 * everything above zero.
 *
 * `oi-g-stock-<state>` carries no colour. It is a hook, so a reader and a test
 * can tell which of the five a row is in without re-deriving it. Giving each
 * state its own colour rule would put a second copy of one of those two hexes
 * in the stylesheet, and two literals encoding one fact is the defect this
 * repository has already paid for three times.
 */
export const stockClass = (item, threshold = DEFAULT_LOW_STOCK_THRESHOLD) => {
  const state = stockState(item, threshold)
  return `oi-g-stock oi-g-stock-${state} ${state === 'ok' ? 'oi-stock' : 'oi-attention'}`
}

/**
 * Did Ken take this tire off sale himself?
 *
 * `sellingEnabled`, and NOT `offer.enabled`. That field is false for every row
 * nobody has ever touched -- 1,083 of 1,083 on a freshly seeded database --
 * because a tire with no `offers` record is still for sale at the rule's
 * price, so reading it here would report the entire catalogue as deliberately
 * switched off and put a "you switched this off" marker on every line.
 *
 * IT IS ONE TEST, NOT TWO, and that is worth stating because the obvious
 * defensive version is `!neverDecided(item) && !sellingEnabled(item)` -- which
 * is what this was, until a mutation survived: dropping the `neverDecided`
 * half changed no answer anywhere. It cannot, and the reason is a property of
 * `sellingEnabled` rather than a coincidence of the fixtures. Both of its
 * paths already answer TRUE for an untouched row: the server's `selling.offered`
 * comes from `quotedPrice`, which treats a missing offer as offered, and the
 * fallback is `neverDecided || enabled`, whose first term is that same
 * distinction. So `!sellingEnabled` is already exactly "he said no", and the
 * extra conjunct was a guard that could not fire -- which reads as protection
 * while providing none.
 */
export const switchedOffByHand = item => !sellingEnabled(item)

/**
 * The one-way door, on one row: he switched it off, and the supplier has since
 * restocked it past the threshold.
 *
 * `=== 'ok'` rather than "not low" is deliberate. A row that is delisted, out
 * of stock, or carrying no stock figure at all has not recovered from
 * anything, and saying so would send him to turn a tire back on that nobody
 * can source -- the opposite mistake, and the more expensive one.
 */
export const stockRecovered = (item, threshold = DEFAULT_LOW_STOCK_THRESHOLD) =>
  switchedOffByHand(item) && stockState(item, threshold) === 'ok'

/**
 * What this page of rows looks like at the current threshold.
 *
 * PAGE, not catalogue, and the wording that renders it says so. The server
 * pages at 24 rows and has no low-stock filter or count today, so a
 * catalogue-wide figure would be a number this screen cannot actually know.
 * Claiming one is worse than showing a smaller true one.
 */
export const lowStockSummary = (items, threshold = DEFAULT_LOW_STOCK_THRESHOLD) => {
  const rows = items ?? []
  return {
    total: rows.length,
    low: rows.filter(item => stockState(item, threshold) === 'low').length,
    recovered: rows.filter(item => stockRecovered(item, threshold)).length,
  }
}

/**
 * Which way this column's arrow points, read from what the SERVER said it did.
 *
 * `echoed` is the `{sort, dir}` off the last successful response. A column the
 * server is not ordering by gets no arrow at all, including the column that was
 * just clicked — if the server ignored the request, the header must not claim it.
 */
export function headerSortState(echoed, columnSortKey) {
  if (!columnSortKey || !echoed || echoed.sort !== columnSortKey) return null
  return echoed.dir === 'desc' ? 'desc' : 'asc'
}

export const sortArrow = state => state === 'asc' ? '↑' : state === 'desc' ? '↓' : ''

/**
 * What clicking this header should ask the server for next.
 *
 * Also computed from the echo: clicking a header the server is already sorting
 * ascending asks for descending, and everything else asks for ascending. Were
 * this read from the requested sort instead, a click on a column the server
 * rejected would toggle a direction that was never applied.
 */
export function nextSortRequest(echoed, columnSortKey) {
  const current = headerSortState(echoed, columnSortKey)
  return { sort: columnSortKey, dir: current === 'asc' ? 'desc' : 'asc' }
}

/**
 * May the "nothing here" panel be shown?
 *
 * `!error` is the load-bearing clause. Claiming an empty list when the request
 * failed is a defect that already shipped on the images screen: the owner is
 * told he has no inventory when in fact the server did not answer.
 */
export function showEmptyState({ loading, error, data }) {
  if (error) return false
  if (loading || !data) return false
  return data.items.length === 0
}

/** What a per-row failure reason means, in the owner's words. Distinct per code. */
export function reasonLabel(reason, message) {
  if (reason === 'version-conflict') return 'Changed in another window since this page loaded. Reload before saving this row.'
  if (reason === 'not-found') return 'No longer in the supplier list, so nothing was saved.'
  if (reason === 'invalid') return message ? `Rejected: ${message}` : 'Rejected as invalid, so nothing was saved.'
  // Stage 1 shipped a fourth code the agreed contract did not name: 'failed',
  // for anything that is neither bad input nor a stale version -- a disk
  // error, say. It is not the owner's mistake and there is nothing for him to
  // correct, so it says to try again rather than blaming the row.
  if (reason === 'failed') return message ? `Not saved: ${message} Try again.` : 'Not saved because of a server problem. Try again.'
  return message || 'Not saved.'
}

/**
 * What a version-conflict row says once the grid has re-read it for him.
 *
 * `reasonLabel`'s version-conflict text ends "Reload before saving this row",
 * which is right on the single-row path, where nothing reloads for him. A bulk
 * save now reloads itself, so leaving that text up would be instructing the
 * owner to do the thing that just happened -- and he would go looking for a
 * control to do it with. The mark stays; only the words change.
 */
export const RELOADED_AFTER_CONFLICT =
  'Changed in another window, so this row was re-read and your change was not applied. Check it and save again.'

/**
 * Fold a bulk response back into the rows it came from.
 *
 * Partial success is the normal case, so this never speaks about the batch as a
 * whole: each result lands on its own row. A saved row's `version` is taken from
 * the response, because the next save on that row will be rejected without it.
 */
export function applyBulkResults(items, results, patchOf) {
  const byId = new Map(results.map(result => [result.id, result]))
  const saved = [], failed = []
  const nextItems = items.map(item => {
    const result = byId.get(item.id)
    if (!result) return item
    if (!result.ok) {
      failed.push({ id: item.id, reason: result.reason, message: result.message })
      return item
    }
    saved.push(item.id)
    const patch = patchOf ? patchOf(item) : {}
    return { ...item, offer: { ...item.offer, ...patch, version: result.version } }
  })
  return { items: nextItems, saved, failed }
}

/**
 * The one line above the grid after a bulk write.
 *
 * A batch with any failure is never announced as a success, however many rows
 * did save — the count of what did save is said inside the failure notice
 * instead, so the owner learns both facts from one sentence.
 */
export function bulkNotice({ saved, failed }) {
  if (failed.length) {
    return {
      tone: 'error',
      text: `${failed.length} of ${saved.length + failed.length} row${saved.length + failed.length === 1 ? '' : 's'} did not save. ` +
        `${saved.length} saved. The rows that failed are marked below with why.`,
    }
  }
  return { tone: 'success', text: `${saved.length} row${saved.length === 1 ? '' : 's'} saved.` }
}

/** What one row's supplier cost is, in cents. `price` is the supplier's, in dollars. */
export const supplierCostCents = item => item?.price == null ? null : Math.round(item.price * 100)

/**
 * Supplier cost × multiplier, optionally plus that row's shipping.
 *
 * The shipping added is the row's own override where it has one and the default
 * markup shipping otherwise, which is the same precedence the customer price
 * already uses.
 */
export function priceFromFormula(item, { multiplier, addShipping, defaultShippingCents = 0 }) {
  const cost = supplierCostCents(item)
  if (cost == null || !Number.isFinite(multiplier) || multiplier <= 0) return null
  const shipping = item.offer?.shippingCents ?? defaultShippingCents
  return Math.round(cost * multiplier) + (addShipping ? shipping : 0)
}

/**
 * The before/after the owner is shown before a price write runs.
 *
 * It is a sample plus a count, not the whole list: 200 rows do not fit in a
 * confirmation, and the point is that he sees real numbers from his own data
 * rather than a row count on its own.
 */
export function previewPriceChange(items, formula, sampleSize = 3) {
  const rows = items.map(item => ({
    id: item.id,
    name: item.name,
    size: item.size,
    before: item.offer?.priceCents ?? null,
    after: priceFromFormula(item, formula),
  }))
  return { count: rows.length, sample: rows.slice(0, sampleSize), rows }
}

/** Reduce a selection to ids that are actually on screen. */
export const intersectSelection = (selected, items) => {
  const present = new Set(items.map(item => item.id))
  return selected.filter(id => present.has(id))
}

/* -------------------------------------------------------------------------- *
 * The markup rule's form.
 *
 * Not the grid, but here for the reason the file header gives: there is no JSX
 * runner in this repository, so a decision left inside a component is a
 * decision nothing tests. `MarkupRule` in `OwnerInventory.jsx` is markup around
 * `buildMarkupSave` the same way `OwnerInventoryGrid.jsx` is markup around the
 * store above.
 * -------------------------------------------------------------------------- */

/**
 * The backend's typo guard on either margin bound, mirrored.
 *
 * `backend/inventory.mjs` owns this number and refuses anything past it. The
 * copy here exists so Ken is told before a round trip, not instead of one: the
 * server is still the thing that decides, and a mismatch surfaces as its error
 * message rather than as a field that silently accepts and then fails.
 */
export const MARGIN_BOUND_LIMIT = 500

/**
 * Does the backend that answered know what a margin bound is?
 *
 * `minMarginPerTire` and `maxMarginPerTire` arrived with the markup rule's
 * floor and ceiling. A server without them does not merely return null -- it
 * returns no key at all, and `saveMarkup` there builds its stored record field
 * by field, so a bound sent to it is accepted with a 200 and dropped on the
 * floor. That is the one outcome this screen must never produce: a control Ken
 * can set, that reports success, and that changes nothing.
 *
 * So the fields render only where the keys are actually present. The backend
 * side pins them present-and-null deliberately -- "a missing key and a null one
 * are not the same thing to a form deciding whether to render a field as empty"
 * -- which is exactly the distinction being read here.
 */
export const supportsMarginBounds = markup =>
  !!markup && Object.prototype.hasOwnProperty.call(markup, 'minMarginPerTire')

/**
 * A margin bound as typed, in DOLLARS -- which is the unit the markup rule is
 * stored and sent in, unlike every other money field on this screen.
 *
 * `parseMoney` does the actual reading, so the three answers a money field can
 * give are the same three they are everywhere else on this screen: `null` for
 * blank, `NaN` for anything malformed, and a number otherwise. Reusing it
 * rather than writing a second parser is the point -- the per-tire shipping
 * override already carries exactly this "blank is not zero" distinction, and
 * two idioms for one rule is how the two drift apart.
 */
export const parseMarginBound = text => {
  const cents = parseMoney(text)
  return cents === null ? null : cents / 100
}

/** A stored bound as a form value. `null` -- no bound -- is an empty field. */
export const marginField = value => (value === null || value === undefined ? '' : Number(value).toFixed(2))

/**
 * What to SEND for a field the owner may correct: the text, or `null`.
 *
 * The season and description boxes are seeded with what a customer is being
 * shown right now, so "unedited" and "corrected back to the supplier's own
 * words" look identical in the form and must not be stored differently. Both
 * send `null`, which is the server's "use the supplier's" -- so an override
 * that merely restates the supplier cannot accumulate, and the day the
 * supplier changes its mind the tire follows it instead of being pinned to a
 * correction nobody remembers making.
 *
 * An emptied box is also `null`, which makes clearing the box the way to undo
 * a correction. The server refuses a blank override outright rather than
 * publishing a tire with no description, so the two agree.
 *
 * NO LENGTH CHECK HERE, deliberately. The limit is a catalogue rule and it
 * lives once, in `DESCRIPTION_OVERRIDE_LIMIT` on the server; a copy of the
 * number in the browser is the paired-literal defect this repository has
 * already paid for three times. A refusal comes back as a 400 whose message
 * names the limit, and `reasonLabel` renders it on the row verbatim.
 */
export function correctionOf(typed, supplied) {
  const text = typeof typed === 'string' ? typed.trim() : ''
  if (!text) return null
  return text === (typeof supplied === 'string' ? supplied.trim() : '') ? null : text
}

/**
 * The seasons to offer for one tire, as [key, label] pairs.
 *
 * The five come from `SEASON_LABELS` -- the same map the customer's own facet
 * draws its buckets from and the same one the server validates against, so a
 * season cannot be offerable here and unfilterable there.
 *
 * A SUPPLIER CATEGORY THAT IS NOT ONE OF THE FIVE IS ADDED, at the end, under
 * its own raw name. Measured over the 1,083-row snapshot there are exactly
 * five and this never fires -- but a select whose value matches no option
 * renders blank, which would read as "this tire has no season" on precisely
 * the rows whose season is the unusual thing about them. Choosing it is a
 * no-op: it equals the supplier's value, so `correctionOf` sends null.
 */
export function seasonChoices(supplierCategory) {
  const choices = Object.entries(SEASON_LABELS)
  if (supplierCategory && !Object.prototype.hasOwnProperty.call(SEASON_LABELS, supplierCategory)) {
    choices.push([supplierCategory, supplierCategory])
  }
  return choices
}

/**
 * What a margin bound field, as it currently reads, will actually do.
 *
 * Rendered live under each field, because the distinction this form exists to
 * protect cannot be carried by a placeholder alone: **blank means no bound, and
 * `0` is a different answer entirely.** Those two states look nearly identical
 * in a text input and mean opposite things, so the screen says which one is in
 * the box rather than leaving Ken to infer it from an empty rectangle.
 *
 * The `0` cases are separated on purpose, because the two ends do not agree
 * about zero and no single sentence covers both:
 *
 *   - a `$0` FLOOR is legal and inert. The rate is guarded at 1 or more, so a
 *     marked-up price is never below cost, so a floor of zero can never bind.
 *     It stores a number that does nothing -- worth saying, not worth refusing.
 *   - a `$0` CEILING is refused, here and by the server. It would sell every
 *     unpriced tire at exactly what Ken paid for it. Nobody types that on
 *     purpose, which is precisely why it must not be the accidental way to
 *     turn the ceiling off.
 */
export function marginBoundSummary(text, kind) {
  const value = parseMarginBound(text)
  if (Number.isNaN(value)) return 'Not a dollar amount.'
  if (value === null) {
    return kind === 'min'
      ? 'No least — the markup rate alone decides the price.'
      : 'No most — the markup rate alone decides the price.'
  }
  if (value === 0) {
    return kind === 'min'
      ? 'Zero, which changes nothing the rate was not already doing. Leave the box empty to turn the least off.'
      : 'Zero would sell the tire at what you paid for it. Leave the box empty to turn the most off.'
  }
  const amount = dollars(Math.round(value * 100))
  return kind === 'min'
    ? `Every tire you have not priced earns you at least ${amount} over what you paid, before shipping.`
    : `No tire you have not priced earns you more than ${amount} over what you paid, before shipping.`
}

/**
 * The body of a markup save, or the reason there is not going to be one.
 *
 * Two things here are load-bearing and neither is obvious from the shape:
 *
 * **The bounds are sent EXPLICITLY, always, including as `null`.** `saveMarkup`
 * reads an omitted field as "this save is not about that", which is what keeps
 * a rate-only save from wiping a floor Ken set last week -- and it is why this
 * form cannot simply leave a blank field out. Omitting it would make a bound
 * something Ken could switch on and never switch off again.
 *
 * **The bounds are sent only when the server has them.** See
 * `supportsMarginBounds`. Where it does not, the body is byte-identical to the
 * one this form has always sent, which is also what every existing test of that
 * body asserts.
 */
export function buildMarkupSave({ rate, shippingPerTire, minMarginPerTire, maxMarginPerTire, marginBounds = false }) {
  const parsedRate = Number(rate)
  if (!Number.isFinite(parsedRate) || parsedRate < 1 || parsedRate > 10) {
    return { error: 'Enter a markup between 1 and 10 times the supplier price.' }
  }
  const parsedShipping = Number(shippingPerTire)
  if (!Number.isFinite(parsedShipping) || parsedShipping < 0 || parsedShipping > 200) {
    return { error: 'Enter a per-tire shipping cost between $0 and $200.' }
  }
  const body = { rate: parsedRate, shippingPerTire: parsedShipping }
  if (!marginBounds) return { body }

  const min = parseMarginBound(minMarginPerTire)
  if (Number.isNaN(min) || (min !== null && min > MARGIN_BOUND_LIMIT)) {
    return { error: `Enter the least you make between $0 and $${MARGIN_BOUND_LIMIT}, or leave the box empty for no least.` }
  }
  const max = parseMarginBound(maxMarginPerTire)
  if (Number.isNaN(max) || (max !== null && max > MARGIN_BOUND_LIMIT)) {
    return { error: `Enter the most you make between $0 and $${MARGIN_BOUND_LIMIT}, or leave the box empty for no most.` }
  }
  // Zero is the one value the two ends disagree about, so it gets its own
  // message rather than falling into the range error above -- "between $0 and
  // $500" would be a lie about a field that refuses $0, and the refusal is the
  // whole reason the empty box has to be the way off.
  if (max === 0) {
    return { error: 'The most you make cannot be $0 — that sells the tire at what you paid. Leave the box empty for no most.' }
  }
  if (min !== null && max !== null && min > max) {
    return { error: 'The least you make cannot be more than the most.' }
  }
  return { body: { ...body, minMarginPerTire: min, maxMarginPerTire: max } }
}

/**
 * What the screen says after a markup save, read back off what was STORED.
 *
 * Built from the server's response rather than from the form, so it reports
 * what happened rather than what was asked for. That matters most in exactly
 * the case this form is careful about: Ken clearing a bound sees the sentence
 * change to "no least", which is the confirmation that an emptied box was read
 * as "off" and not as something else.
 */
export function markupSavedNotice(markup) {
  const base = `Default markup saved. Tires you have not priced are now offered at supplier price × ${markup.rate}, plus $${markup.shippingPerTire} shipping.`
  if (!supportsMarginBounds(markup)) return base
  const { minMarginPerTire: min, maxMarginPerTire: max } = markup
  if (min === null && max === null) return `${base} No least or most set, so the rate alone decides.`
  const parts = []
  if (min !== null) parts.push(`at least ${dollars(Math.round(min * 100))}`)
  if (max !== null) parts.push(`at most ${dollars(Math.round(max * 100))}`)
  return `${base} Those prices earn you ${parts.join(' and ')} over what you paid.`
}

const EMPTY = Object.freeze({})

/**
 * The grid's whole state and every action on it.
 *
 * A plain store rather than React state so the decisions above are reachable
 * from a test with a stubbed `api`. The component subscribes and renders; it
 * holds no grid state of its own.
 */
export function createInventoryGrid({ api }) {
  let state = {
    query: { search: '', size: '', filter: 'all' },
    sort: 'size', dir: 'asc',
    page: 1, pageSize: 24,
    data: null,
    loading: true,
    error: '',
    needsSignIn: false,
    selected: [],
    drafts: EMPTY,
    rowStatus: EMPTY,
    notice: null,
    pending: null,
    busy: false,
    // Ids whose photo toggle is in flight. Per row rather than one global flag:
    // the owner works down a page turning photos off, and a single `busy` would
    // freeze every other row while one request was out.
    photoBusy: EMPTY,
  }
  const listeners = new Set()
  let sequence = 0

  const getState = () => state
  const set = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }

  /** The sort and dir the SERVER last said it applied. Null until a load lands. */
  const echoed = () => state.data ? { sort: state.data.sort, dir: state.data.dir } : null

  const items = () => state.data?.items ?? []
  const selectedItems = () => items().filter(item => state.selected.includes(item.id))

  function rowValues(item) {
    const draft = state.drafts[item.id]
    if (draft) return draft
    return {
      price: moneyField(item.offer.priceCents),
      shipping: moneyField(item.offer.shippingCents),
      // `sellingEnabled`, NOT `item.offer.enabled` -- this is the whole fix.
      //
      // Every field here is sent straight back by `commitRow`, so this object
      // is not "what to display", it is "what saving this row will assert".
      // `offer.enabled` is false for a tire with no offers row, which is not a
      // decision to stop selling it: the customer catalogue sells exactly
      // those rows, at the markup price. Seeding the draft from it therefore
      // attached a deselection Ken never made to the next thing he saved, so
      // typing a price into an untouched row took the tire off sale --
      // reproduced live: a tire selling at $48.28 was gone from
      // /api/catalog after one price save, and a ten-row bulk price write
      // removed all ten.
      //
      // `selling.offered` is the same boolean `catalog()` acts on, so a save
      // that carries it forward asserts what was already true instead of
      // reversing it. Ticking the box on an untouched row is then a no-op for
      // the customer, and clearing it is a real deselection, which is what an
      // unchecked box has always looked like it meant.
      enabled: sellingEnabled(item),
      notes: item.offer.notes ?? '',
      // The owner's corrections to the supplier's own record, as EDITABLE text
      // seeded with the correction where one exists and the supplier's own
      // words where it does not.
      //
      // The supplier's half is the RAW payload -- `list()` spreads the payload,
      // while a customer's copy goes through `cleanCatalogDescription` first --
      // so for a description carrying markup the two differ. Deliberate, and
      // harmless: `correctionOf` compares raw to raw, so an untouched box still
      // reads as no correction, and what Ken edits is what the supplier
      // actually sent rather than a sanitised rendering of it.
      //
      // That seeding is the whole affordance: the defect this fixes is
      // 202 characters of the supplier's advertising on a card, and deleting
      // the first sentence of a box that already holds it is one gesture,
      // where retyping "XL 98Y BSW" from memory into an empty box is not.
      //
      // `category` is the supplier's key, not its label, because the value
      // goes straight back to the server and the server files by key. The
      // select renders SEASON_LABELS over these.
      category: item.offer.categoryOverride ?? item.category ?? '',
      description: item.offer.descriptionOverride ?? item.description ?? '',
      baseVersion: item.offer.version,
    }
  }

  const withDraft = (id, patch) => {
    const item = items().find(row => row.id === id)
    if (!item) return
    set({ drafts: { ...state.drafts, [id]: { ...rowValues(item), ...patch } } })
  }

  const clearDraft = id => {
    const drafts = { ...state.drafts }
    delete drafts[id]
    return drafts
  }

  const setRowStatus = (id, status) => {
    const rowStatus = { ...state.rowStatus }
    if (status) rowStatus[id] = status
    else delete rowStatus[id]
    return rowStatus
  }

  /**
   * Load a page.
   *
   * Every load carries an explicit sort, dir and pageSize; the echo comes back
   * on `data` and the headers read it from there. A draft whose row came back
   * at a different version is dropped and the row flagged, because keeping it
   * would let the owner save over a change he never saw.
   */
  async function load() {
    const request = ++sequence
    set({ loading: true })
    try {
      const params = new URLSearchParams({
        search: state.query.search, size: state.query.size, filter: state.query.filter,
        page: String(state.page), sort: state.sort, dir: state.dir, pageSize: String(state.pageSize),
      })
      const result = await api(`inventory?${params}`)
      if (request !== sequence) return
      const drafts = {}
      const rowStatus = { ...state.rowStatus }
      for (const item of result.items) {
        const draft = state.drafts[item.id]
        if (!draft) continue
        if (draft.baseVersion === item.offer.version) drafts[item.id] = draft
        else rowStatus[item.id] = { kind: 'error', text: 'This row changed elsewhere; your unsaved edit was dropped.' }
      }
      set({
        data: result, error: '', needsSignIn: false, loading: false,
        drafts, rowStatus, selected: intersectSelection(state.selected, result.items),
      })
    } catch (err) {
      if (request !== sequence) return
      // A 401 is not an error to report, it is a door to open.
      if (err.status === 401) set({ needsSignIn: true, error: '', loading: false })
      else set({ error: err.message, loading: false })
    }
  }

  /** Anything that changes which rows are on screen drops the selection with it. */
  function reset(patch) {
    set({ ...patch, page: patch.page ?? 1, selected: [], notice: null, pending: null })
    return load()
  }

  return {
    getState, subscribe,
    echoed, rowValues,
    items,
    selectedItems,

    load,
    /** A fresh load that keeps the page and the selection: the reload button, and the job poll. */
    reload: load,

    setQuery(query) {
      const next = { ...state.query, ...query }
      if (next.search === state.query.search && next.size === state.query.size && next.filter === state.query.filter) return
      return reset({ query: next })
    },

    /**
     * Sort at the server, over all rows, not the ones on screen.
     *
     * Selection is dropped, the same as a page change: a server sort replaces
     * every row in the grid, so a selection carried across it would be a
     * selection of rows the owner is no longer looking at.
     */
    sortBy(columnSortKey) {
      if (!columnSortKey) return
      return reset(nextSortRequest(echoed(), columnSortKey))
    },

    goToPage(page) {
      if (page === state.page) return
      return reset({ page })
    },

    setPageSize(pageSize) {
      if (!PAGE_SIZES.includes(pageSize)) return
      return reset({ pageSize })
    },

    /**
     * A summary field saved by one of the tools above the grid (markup, tax,
     * pricing lines). The sequence bump is what the old `invalidate` did: an
     * inventory load already in flight carries the pre-save summary, and must
     * not be allowed to land on top of what was just saved. `loading` is
     * cleared with it, because the discarded load will never clear it itself.
     */
    patchSummary(patch) {
      sequence++
      if (!state.data) { set({ loading: false }); return }
      set({ loading: false, data: { ...state.data, summary: { ...state.data.summary, ...patch } } })
    },

    /** Signing out on a hosted deployment: the gate comes straight back. */
    signedOut() { set({ data: null, needsSignIn: true, drafts: EMPTY, rowStatus: EMPTY, selected: [], notice: null, pending: null }) },

    editRow: withDraft,

    isPhotoBusy: id => Boolean(state.photoBusy[id]),

    /**
     * Turn one product's photo off or on.
     *
     * NOT OPTIMISTIC, deliberately, and this is the one place in the grid where
     * that is the right call. Price edits are optimistic because the owner is
     * typing and needs the field to keep up. A photo toggle changes what a
     * CUSTOMER sees; showing "Off" before the server has agreed would mean the
     * screen and the shop disagree about a live page, and the owner would move
     * on believing something that had not happened.
     *
     * The row is patched from the SERVER's answer, not from what was asked for
     * -- the same rule the rest of this file follows for sort and for saves.
     */
    async setPhotoHidden(id, hidden) {
      if (state.photoBusy[id]) return
      set({ photoBusy: { ...state.photoBusy, [id]: true }, notice: null })
      try {
        const result = await api(`images/product/${encodeURIComponent(id)}`, {
          method: 'POST', body: JSON.stringify({ hidden }),
        })
        const items = state.data?.items?.map(item => item.id === id
          ? { ...item, photo: { ...item.photo, state: result.hidden ? 'hidden' : 'live' } }
          : item)
        const rest = { ...state.photoBusy }; delete rest[id]
        set({ photoBusy: rest, ...(items ? { data: { ...state.data, items } } : {}) })
      } catch (error) {
        const rest = { ...state.photoBusy }; delete rest[id]
        // Named, and the row is left exactly as the server still has it. A
        // toggle that silently does nothing is worse than one that says so.
        set({ photoBusy: rest, notice: { tone: 'error',
          text: error?.status === 404
            ? 'That tire has no photo to switch off. Reload to see its current state.'
            : 'That photo could not be changed. Nothing was altered; try again.' } })
      }
    },

    toggleSelected(id) {
      const selected = state.selected.includes(id)
        ? state.selected.filter(value => value !== id)
        : [...state.selected, id]
      set({ selected })
    },

    selectAllOnPage(on) { set({ selected: on ? items().map(item => item.id) : [] }) },

    clearNotice() { set({ notice: null }) },

    /**
     * Commit one row: Enter, or blur, or the offered checkbox changing.
     *
     * Uses the unchanged single-row endpoint, which returns the new version.
     * The margin is a server-derived figure and the response does not carry a
     * new one, so the cell is marked stale rather than showing a number this
     * screen guessed.
     */
    async commitRow(id) {
      const item = items().find(row => row.id === id)
      if (!item) return
      const draft = state.drafts[id]
      if (!draft) return
      const priceCents = parseMoney(draft.price)
      const shippingCents = parseMoney(draft.shipping)
      if (Number.isNaN(priceCents) || (priceCents !== null && priceCents <= 0)) {
        set({ rowStatus: setRowStatus(id, { kind: 'error', text: 'Enter a price above $0 with up to two decimals, or leave it blank.' }) })
        return
      }
      if (Number.isNaN(shippingCents) || (shippingCents !== null && shippingCents > 20000)) {
        set({ rowStatus: setRowStatus(id, { kind: 'error', text: 'Enter shipping from $0 to $200, or leave it blank for the default.' }) })
        return
      }
      const body = { priceCents, shippingCents, enabled: draft.enabled, notes: draft.notes,
        // Against the SUPPLIER's own values, never against what is stored: the
        // box is seeded with the correction where one exists, so comparing it
        // to the stored correction would find them equal and send null, which
        // would delete the correction every time Ken saved a price on a row he
        // had already fixed.
        categoryOverride: correctionOf(draft.category, item.category),
        descriptionOverride: correctionOf(draft.description, item.description),
        version: draft.baseVersion }
      try {
        const offer = await api(`offers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
        const enabledDelta = Number(offer.enabled) - Number(item.offer.enabled)
        set({
          drafts: clearDraft(id),
          rowStatus: setRowStatus(id, { kind: 'saved', text: 'Saved. Margin refreshes on the next load.' }),
          data: {
            ...state.data,
            items: state.data.items.map(row => row.id === id ? { ...row, offer: { ...row.offer, ...offer } } : row),
            summary: { ...state.data.summary, offeredCount: (state.data.summary?.offeredCount ?? 0) + enabledDelta },
          },
        })
      } catch (err) {
        // Only a 400 is the owner's input being refused. A 500, or a fetch that
        // never landed (no `status` at all -- `api()` throws the "backend is not
        // connected" error before it reads one), is not: telling him his entry
        // was "Rejected" attributes a server outage to something he typed, and
        // there is nothing on the row for him to correct. That is the exact
        // collapse the fourth reason code exists to prevent, and this is the
        // single-row path where it was not being used.
        const reason = err.status === 409 ? 'version-conflict'
          : err.status === 404 ? 'not-found'
            : err.status === 400 ? 'invalid' : 'failed'
        set({ rowStatus: setRowStatus(id, { kind: 'error', reason, text: reasonLabel(reason, err.message) }) })
      }
    },

    /**
     * Stage a bulk action. NOTHING is sent from here.
     *
     * A price change over up to 200 rows is a destructive write over the
     * owner's livelihood, so it is shown back to him with a count and real
     * before/after numbers off his own rows, and waits. Offered and shipping
     * confirm too, matching the brand-wide toggle above the grid, which has
     * always asked first.
     */
    requestBulk(kind, params = {}) {
      const rows = selectedItems()
      if (!rows.length) return
      if (rows.length > BULK_LIMIT) {
        set({ notice: { tone: 'error', text: `The bulk endpoint takes at most ${BULK_LIMIT} rows at a time.` } })
        return
      }
      if (kind === 'price') {
        const multiplier = Number(params.multiplier)
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
          set({ notice: { tone: 'error', text: 'Enter a multiplier above 0 to price from supplier cost.' } })
          return
        }
        const formula = { multiplier, addShipping: !!params.addShipping, defaultShippingCents: params.defaultShippingCents ?? 0 }
        set({ pending: { kind, formula, preview: previewPriceChange(rows, formula) } })
        return
      }
      if (kind === 'shipping') {
        const shippingCents = parseMoney(params.shipping)
        if (Number.isNaN(shippingCents)) {
          set({ notice: { tone: 'error', text: 'Enter shipping from $0 to $200, or leave it blank to clear the override.' } })
          return
        }
        set({ pending: { kind, shippingCents, count: rows.length } })
        return
      }
      if (kind === 'offered') set({ pending: { kind, enabled: !!params.enabled, count: rows.length } })
    },

    cancelBulk() { set({ pending: null }) },

    /** Run the staged action. The only path that reaches the bulk endpoint. */
    async confirmBulk() {
      const pending = state.pending
      if (!pending) return
      const rows = selectedItems()
      // `patchOf` is the ONE definition of what this write changes on a row:
      // it builds the request body below and is replayed onto the row on
      // screen afterwards, so anything it omits is a field where the grid and
      // the database can disagree. `enabled` is in it for every kind, not just
      // the 'offered' action -- see `sellingEnabled` for why a price or
      // shipping write must not carry `item.offer.enabled` forward.
      const patchOf = item => {
        if (pending.kind === 'offered') return { enabled: pending.enabled }
        const enabled = sellingEnabled(item)
        if (pending.kind === 'price') return { priceCents: priceFromFormula(item, pending.formula), enabled }
        return { shippingCents: pending.shippingCents, enabled }
      }
      // `enabled` is deliberately absent from the carried-forward fields and
      // supplied only by `patchOf`, so there is exactly one expression of it.
      // Before this, it was read off `item.offer` here and the falseness of an
      // untouched row's `enabled` rode along with every price write: measured
      // at ten untouched rows in 215/60R16, all ten in the customer
      // catalogue, one bulk price write, none of the ten left in it.
      const offers = rows.map(item => ({
        id: item.id,
        priceCents: item.offer.priceCents,
        shippingCents: item.offer.shippingCents,
        notes: item.offer.notes ?? '',
        version: item.offer.version,
        ...patchOf(item),
      }))
      set({ busy: true, pending: null })
      try {
        const response = await api('offers', { method: 'PUT', body: JSON.stringify({ offers }) })
        const { items: nextItems, saved, failed } = applyBulkResults(state.data.items, response.results, patchOf)
        const rowStatus = { ...state.rowStatus }
        for (const id of saved) rowStatus[id] = { kind: 'saved', text: 'Saved. Margin refreshes on the next load.' }
        for (const failure of failed) rowStatus[failure.id] = { kind: 'error', reason: failure.reason, text: reasonLabel(failure.reason, failure.message) }
        const offeredDelta = nextItems.reduce((sum, row, index) =>
          sum + Number(row.offer.enabled) - Number(state.data.items[index].offer.enabled), 0)
        set({
          busy: false,
          data: {
            ...state.data, items: nextItems,
            summary: { ...state.data.summary, offeredCount: (state.data.summary?.offeredCount ?? 0) + offeredDelta },
          },
          rowStatus,
          // The rows that failed stay selected so a retry needs no re-picking.
          selected: failed.map(failure => failure.id),
          notice: bulkNotice({ saved, failed }),
        })
        // ...but a version-conflict row is stale BY DEFINITION, and the line
        // above leaves it selected while `applyBulkResults` leaves its version
        // at the value the server just rejected. Together those made the retry
        // this selection invites rebuild a byte-identical body and fail
        // identically, forever: an affordance saying "press me again" over data
        // guaranteeing the press fails, which presents as a broken Save button
        // rather than as data that moved. So reload. `load()` preserves
        // `rowStatus` and leaves `notice` alone, and `intersectSelection`
        // preserves the selection -- the marks and the picks survive, and only
        // the versions change, to the true ones a retry needs.
        const conflicts = failed.filter(failure => failure.reason === 'version-conflict')
        if (conflicts.length) {
          await load()
          const reloaded = { ...state.rowStatus }
          for (const conflict of conflicts) {
            // Not any row the load has since said something newer about -- a
            // dropped draft is a fresher fact about that row than this is.
            if (reloaded[conflict.id]?.reason !== 'version-conflict') continue
            reloaded[conflict.id] = { kind: 'error', reason: 'version-conflict', text: RELOADED_AFTER_CONFLICT }
          }
          set({ rowStatus: reloaded })
        }
      } catch (err) {
        set({ busy: false, notice: { tone: 'error', text: err.message } })
      }
    },

    /**
     * After the brand-wide toggle above the grid.
     *
     * `PUT /api/owner/offers/by-brand/:brand` takes no expected version and
     * bumps every matched row's, so every `version` on screen for that brand is
     * stale the moment it returns — and at 200 rows the next save would be a
     * guaranteed conflict storm. Drafts go, the selection goes, and the page is
     * re-read, so nothing on screen is saving against a version that no longer
     * exists. (Invisible today only because 24 rows fit on screen.)
     */
    afterBrandToggle() {
      set({
        drafts: EMPTY, rowStatus: EMPTY, selected: [], pending: null,
        notice: { tone: 'success', text: 'Brand offers updated. The grid was reloaded, because that change bumps every affected row.' },
      })
      return load()
    },
  }
}
