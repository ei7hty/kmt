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
import { SEASON_NOTES, seasonNote, specPoints, priceStanding, tireRating, tireDetail } from './tire-detail.js'

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

test('the cheapest and the dearest are named as such', () => {
  const cheap = tire({ id: 'a', price: 52.03 })
  const mid = tire({ id: 'b', price: 154.32 })
  const dear = tire({ id: 'c', price: 516.27 })
  const list = [cheap, mid, dear]
  assert.equal(priceStanding(cheap, list).text, 'Nothing else in this list costs less.')
  assert.equal(priceStanding(dear, list).text, 'Nothing else in this list costs more.')
  assert.equal(priceStanding(mid, list).text, 'In this list, 1 tire costs less and 1 costs more.')
})

test('the counts are real counts, and read as English at any size', () => {
  const subject = tire({ id: 'x', price: 100 })
  const list = [subject, tire({ id: 'a', price: 10 }), tire({ id: 'b', price: 20 }), tire({ id: 'c', price: 900 })]
  const standing = priceStanding(subject, list)
  assert.equal(standing.cheaper, 2)
  assert.equal(standing.dearer, 1)
  assert.equal(standing.text, 'In this list, 2 tires cost less and 1 costs more.')
})

test('tires at the same price count as neither cheaper nor dearer', () => {
  const subject = tire({ id: 'x', price: 100 })
  const list = [subject, tire({ id: 'a', price: 100 }), tire({ id: 'b', price: 100 }), tire({ id: 'c', price: 900 })]
  const standing = priceStanding(subject, list)
  assert.equal(standing.cheaper, 0)
  assert.equal(standing.dearer, 1)
  // Two ties are neither, so this is still true and the sentence stays honest.
  assert.equal(standing.text, 'Nothing else in this list costs less.')
})

test('a list of one has no standing to report', () => {
  const only = tire()
  assert.equal(priceStanding(only, [only]), null)
  assert.equal(priceStanding(only, []), null)
  assert.equal(priceStanding(tire({ price: undefined }), [tire(), tire()]), null)
})

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

test('tireDetail composes exactly the four blocks, each nullable', () => {
  const subject = tire({ price: 100 })
  const detail = tireDetail(subject, [subject, tire({ id: 'b', price: 200 })])
  assert.deepEqual(Object.keys(detail).sort(), ['rating', 'season', 'spec', 'standing'])
  assert.equal(detail.rating, null)
  assert.deepEqual(detail.spec, [])
  assert.ok(detail.season.body)
  assert.ok(detail.standing.text)
  const bare = tireDetail(tire({ category: 'hovercraft' }), [])
  assert.equal(bare.season, null)
  assert.equal(bare.standing, null)
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
