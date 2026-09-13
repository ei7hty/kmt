/**
 * The chosen tire's detail panel: what it says, and what it must never say.
 *
 * Two halves, for two kinds of failure this repository has already paid for.
 *
 * THE MODULE half drives src/tire-detail.js directly. The sharpest test in it
 * is the rating one: ratings are built and deliberately unpopulated, and a
 * tire nobody has rated must never read as a tire rated zero. `0` is falsy,
 * `0 > 0` is false and `typeof 0 === 'number'` is true, so the three obvious
 * ways of writing that predicate do not agree, and the one that is wrong is
 * wrong only on the value that actually occurs.
 *
 * THE STYLESHEET half reads RequestFlow.css as text, the way
 * src/tire-card-layout.test.mjs does, because there is no DOM here to ask.
 * Both defects it pins were found by opening the page, not by reasoning:
 * a broad `.product-detail p` rule silently outranking two class rules, and
 * five contrast ratios written into a comment from memory that were all
 * wrong. The colour scan is deliberately not a list of colours -- it finds
 * every `color:` under a `.product-detail` selector, so a rule added later
 * with an unreadable grey fails here without anyone remembering to add it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SEASON_LABELS } from './tire-filters.js'
import { SEASON_NOTES, seasonNote, specPoints, tireRating, tireDetail } from './tire-detail.js'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const flowCss = read('./RequestFlow.css')
const rootCss = read('./index.css')
const route = read('./routes/CustomerRequest.jsx')

const tire = (over = {}) => ({ id: 't', name: 'A Tire', size: '225/50R17', price: 100, inStock: true, category: 'all-season', description: 'All Season · 94V BSW', ...over })

// --- what the panel says ---------------------------------------------------

test('the season note names the supplier category and explains it', () => {
  const note = seasonNote(tire({ category: 'winter' }))
  assert.equal(note.label, SEASON_LABELS.winter)
  assert.equal(note.body, SEASON_NOTES.winter)
})

test('every season note has a label, and never invents one', () => {
  for (const category of Object.keys(SEASON_NOTES)) {
    assert.equal(typeof SEASON_LABELS[category], 'string', `${category} has a note but no label in tire-filters.js`)
    assert.equal(seasonNote(tire({ category })).label, SEASON_LABELS[category])
  }
})

/**
 * The test that goes red when the supplier adds a category.
 *
 * Not a hard-coded list of five: it reads the tracked snapshot, so a refresh
 * that introduces a sixth category fails here rather than shipping a tire with
 * no note and nobody noticing. The snapshot is the same file that seeds a new
 * database and feeds the customer catalog.
 */
test('every category in the tracked snapshot has an honest sentence', () => {
  const rows = JSON.parse(read('./data/scraped-tires.json')).tires
  const categories = [...new Set(rows.map(row => row.category).filter(Boolean))].sort()
  assert.ok(categories.length >= 5, `expected the snapshot to carry categories, found ${categories.length}`)
  for (const category of categories) {
    assert.ok(SEASON_NOTES[category], `the supplier ships category "${category}" and tire-detail.js has no sentence for it`)
  }
})

test('a category nobody has written a sentence for draws no block at all', () => {
  assert.equal(seasonNote(tire({ category: 'hovercraft' })), null)
  assert.equal(seasonNote(tire({ category: undefined })), null)
  assert.equal(seasonNote(undefined), null)
})

// --- the decoded spec, which does not cross the boundary yet ----------------

test('no spec block until a decoded field actually crosses', () => {
  // Exactly the shape the catalog projects today: seven required fields plus
  // brand. Nothing here decodes `94V BSW`, and nothing should pretend to.
  assert.deepEqual(specPoints(tire()), [])
})

test('a decoded spec is rendered when it arrives, and junk in it is not', () => {
  assert.deepEqual(specPoints(tire({ specPoints: ['Carries 1,477 lb', 'Rated to 149 mph'] })), ['Carries 1,477 lb', 'Rated to 149 mph'])
  assert.deepEqual(specPoints(tire({ specPoints: ['Carries 1,477 lb', '', '   '] })), ['Carries 1,477 lb'])
  assert.deepEqual(specPoints(tire({ specPoints: 'Carries 1,477 lb' })), [], 'a string is not a list of points')
  assert.deepEqual(specPoints(tire({ specPoints: [null, 7] })), [])
})

// --- where the price sits --------------------------------------------------





// --- ratings: built, empty on purpose, and a zero is not a score -----------

/**
 * The one the brief demands, and the one a careless rewrite breaks.
 *
 * A tire nobody has rated is not a tire rated zero. Ken has no source for
 * ratings and inventing them was never on the table, so the panel must draw
 * nothing at all -- no stars, no empty stars, no "not yet rated" -- until a
 * tire really carries one.
 */
test('a zero does not switch the rating on', () => {
  assert.equal(tireRating(tire({ rating: 0 })), null)
  assert.equal(tireRating(tire()), null, 'no rating key at all')
  assert.equal(tireRating(tire({ rating: null })), null)
  assert.equal(tireRating(tire({ rating: '4.5' })), null, 'a string is not a score')
  assert.equal(tireRating(tire({ rating: 4.5 })), 4.5)
})

test('nothing in the live catalogue switches the rating on today', () => {
  const rows = JSON.parse(read('./data/scraped-tires.json')).tires
  const rated = rows.filter(row => tireRating(row) !== null)
  assert.equal(rated.length, 0, `${rated.length} snapshot rows would draw a rating; ratings have no source yet`)
})

test('tireDetail composes exactly the three blocks, each nullable', () => {
  // Three, not four: the price-standing sentence was removed at the owner's
  // request. If a fourth ever returns, this line is what says so out loud.
  const detail = tireDetail(tire({ price: 100 }))
  assert.deepEqual(Object.keys(detail).sort(), ['rating', 'season', 'spec'])
  assert.equal(detail.rating, null)
  assert.deepEqual(detail.spec, [])
  assert.ok(detail.season.body)
  const bare = tireDetail(tire({ category: 'hovercraft' }))
  assert.equal(bare.season, null)
})

// --- the stylesheet --------------------------------------------------------

/** Every declaration block whose selector mentions `.product-detail`. */
function productRules(css) {
  const rules = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].split('*/').at(-1).trim()
    if (selector.includes('.product-detail')) rules.push({ selector, body: match[2] })
  }
  return rules
}

/** `--name: #rrggbb` pairs declared on :root. */
function cssVariables(css) {
  return Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]))
}

const srgb = channel => { const v = channel / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const luminance = hex => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255)
}
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

test('every colour on the panel clears AA against the panel\'s own ground', () => {
  const rules = productRules(flowCss)
  const panel = rules.find(rule => rule.selector === '.product-detail')
  const ground = panel.body.match(/background:\s*(#[0-9a-f]{6})/i)[1]
  const vars = cssVariables(rootCss)
  // Found, not listed: a rule added later with an unreadable grey fails here
  // without anyone remembering to extend a list.
  const colours = rules.flatMap(rule =>
    [...rule.body.matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)].map(m => ({ selector: rule.selector, value: m[1].trim() })))
  assert.ok(colours.length >= 6, `expected the panel to declare several text colours, found ${colours.length}`)
  for (const { selector, value } of colours) {
    const hex = value.startsWith('#') ? value : vars[value.replace(/^var\(\s*|\s*\)$/g, '')]
    assert.ok(hex, `${selector} sets color: ${value}, which this check cannot resolve to a hex`)
    const ratio = contrast(hex, ground)
    assert.ok(ratio >= 4.5, `${selector} is ${hex} on ${ground}: ${ratio.toFixed(2)}:1, under AA's 4.5`)
  }
})

/**
 * The defect that actually shipped into this panel for twenty minutes.
 *
 * `.product-detail p` is (0,1,1) and beats `.product-detail-kicker` (0,1,0),
 * so the kicker rendered at body size in body grey and read as a second card
 * title. The same shape as `.min-h-screen label` outranking `.tire-facet-option`
 * on this page, which is why the rule is: no element-typed selector under
 * `.product-detail` except where it can only match one kind of element.
 */
test('no broad paragraph rule can outrank the panel\'s own classes', () => {
  const broad = productRules(flowCss)
    .map(rule => rule.selector)
    .filter(selector => /^\.product-detail\s+p$/.test(selector))
  assert.deepEqual(broad, [], 'a `.product-detail p` rule outranks every .product-detail-* class on a <p>')
})

test('the panel spans the whole tire grid, at every column count', () => {
  const panel = productRules(flowCss).find(rule => rule.selector === '.product-detail')
  assert.match(panel.body, /grid-column:\s*1\s*\/\s*-1/, 'a panel narrower than the row would sit beside a card as if it were one')
})

test('the text link is a real touch target', () => {
  const link = productRules(flowCss).find(rule => rule.selector === '.product-detail-text')
  const height = Number(link.body.match(/min-height:\s*(\d+)px/)[1])
  assert.ok(height >= 44, `the panel's only link is ${height}px tall`)
})

/**
 * The card is a single `<button>`, so the panel cannot live inside it: a link
 * nested in a button is invalid, and every word inside one is swallowed into
 * that button's accessible name, which already runs to "<name> <spec> In
 * stock $52.03 per tire".
 */
test('the panel is rendered outside the tire card button', () => {
  const open = route.indexOf("'tire-option selected'")
  assert.ok(open > 0, 'could not find the tire card in CustomerRequest.jsx')
  const close = route.indexOf('</button>', open)
  const inside = route.slice(open, close)
  assert.ok(!inside.includes('<TireDetails'), 'TireDetails is nested inside the tire card <button>')
  assert.ok(route.includes('<TireDetails'), 'TireDetails is not rendered at all')
})

test('the note is headed by the supplier\'s own words, not the coarse bucket', () => {
  // The complaint this answers, in the owner's words: the descriptions were
  // "the same generic new england text for everything". 230 of the 323 tires
  // in 225/50R17 are `all-season`, so seven rows in ten were headed with the
  // same word above the same paragraph.
  const touring = seasonNote({ category: 'all-season', specCategory: 'Touring' })
  const uhp = seasonNote({ category: 'all-season', specCategory: 'Ultra High Performance All Season' })

  assert.equal(touring.label, 'Touring')
  assert.equal(uhp.label, 'Ultra High Performance All Season')
  assert.notEqual(touring.label, uhp.label, 'two different tires were headed identically')
  // The paragraph is still the coarse one, and deliberately: a sentence about
  // driving here is only honest for the five buckets somebody wrote one for.
  assert.equal(touring.body, uhp.body)
})

test('a tire with no supplier label falls back to the bucket, and never to nothing', () => {
  assert.equal(seasonNote({ category: 'winter' }).label, 'Winter')
  assert.equal(seasonNote({ category: 'winter', specCategory: '   ' }).label, 'Winter')
  assert.equal(seasonNote({ category: 'winter', specCategory: null }).label, 'Winter')
})
