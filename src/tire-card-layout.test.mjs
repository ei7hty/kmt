/**
 * The two things about a tire card that nothing else in this tree can see.
 *
 * `src/tire-filters.test.mjs` proves which tires survive a filter. Nothing
 * proved anything about the card they land in, and both defects below shipped
 * to the owner's screen and were found by looking at it:
 *
 *   - "Currently unavailable" was printed in the in-stock green, because the
 *     rule picked the line out by POSITION (`small:last-child`) rather than by
 *     state. The words and the colour said opposite things, and the colour is
 *     the half a scanning eye reads first.
 *   - Three columns were switched on at a 1040px VIEWPORT, but the viewport is
 *     not what constrains a card: the request flow caps at 1000px. Three
 *     columns of the real 872px grid left the tire name 81px, and wrapped it.
 *
 * One class, twice: a proxy standing in for the thing itself. These read the
 * stylesheets and the route as text -- the pattern backend/site-copy.test.mjs
 * already uses -- because this suite has no DOM to ask.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const appCss = read('./App.css')
const flowCss = read('./RequestFlow.css')
const route = read('./routes/CustomerRequest.jsx')

/** The width these measurements are about: an ordinary desktop window. */
const DESKTOP_VIEWPORT_PX = 1280

/** Does a `@media` condition hold at `width`? A comma-separated list is an or. */
function holdsAt(condition, width) {
  return condition.split(',').some(part => {
    const gates = [...part.matchAll(/\((min|max)-width:\s*(\d+(?:\.\d+)?)px\)/g)]
    return gates.every(([, kind, value]) => (kind === 'min' ? width >= Number(value) : width <= Number(value)))
  })
}

/**
 * The stylesheet as it applies at `width`: blocks whose condition cannot hold
 * are cut, and blocks whose condition does hold are inlined, so a declaration
 * inside one still counts.
 *
 * Both of this test's earlier readers were wrong, in opposite directions, and
 * both still reported a pass. The first skipped only the "@" and copied every
 * block through, so `.order-section` and `.tire-option` -- each declared twice,
 * once plainly and once under a max-width -- were read at their phone values
 * and the grid came out 888px wide instead of 872px. The second cut every
 * block, which threw away the min-width rules that do apply on a desktop, and
 * the measurement it could no longer see became "declares no
 * grid-template-columns". A reader nothing checks is not a reader; hence the
 * test directly below.
 */
function atWidth(css, width) {
  let out = ''
  for (let i = 0; i < css.length;) {
    if (!css.startsWith('@media', i)) { out += css[i++]; continue }
    const open = css.indexOf('{', i)
    if (open === -1) { out += css[i++]; continue }
    const condition = css.slice(i + '@media'.length, open)
    let depth = 0
    let j = open
    do {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    } while (j < css.length && depth > 0)
    if (holdsAt(condition, width)) out += atWidth(css.slice(open + 1, j - 1), width)
    i = j
  }
  return out
}

const desktop = css => atWidth(css, DESKTOP_VIEWPORT_PX)

test('the stylesheet reader keeps what applies at this width and drops what does not', () => {
  const sample = [
    '.a { padding: 40px; }',
    '@media (max-width: 760px) { .a { padding: 16px; } }',
    '@media (min-width: 560px) { .a { gap: 9px; } }',
    '.b { gap: 2px; }',
  ].join('\n')
  const kept = desktop(sample)
  assert.match(kept, /padding: 40px/, 'dropped an unconditional rule')
  assert.match(kept, /gap: 9px/, 'dropped a min-width rule that applies at this width')
  assert.match(kept, /gap: 2px/, 'dropped an unconditional rule after a media block')
  assert.doesNotMatch(kept, /padding: 16px/, `a narrow-only rule survived: ${JSON.stringify(kept)}`)
  assert.doesNotMatch(kept, /@media/, 'a media block was inlined without being evaluated')
  // Load-bearing here, not just in the sample: both stylesheets re-declare
  // inside a block, which is the condition that made the first bug invisible.
  assert.ok(desktop(appCss).length < appCss.length && desktop(flowCss).length < flowCss.length)
})

/**
 * Declarations of `prop` under `selector`, in source order.
 *
 * It throws when the selector or the property is missing rather than answering
 * undefined, because a lookup that quietly answers nothing turns every
 * assertion built on it into a pass that proves nothing.
 */
function lookup(css, selector, prop) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
  return blocks.flatMap(block =>
    [...block[1].matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'g'))].map(match => match[1].trim()))
}

function declarations(css, selector, prop, label) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.ok(new RegExp(`${escaped}\\s*\\{`).test(css),
    `${label}: no rule for \`${selector}\` -- this test cannot measure what it says it measures`)
  const found = lookup(css, selector, prop)
  assert.ok(found.length, `${label}: \`${selector}\` declares no ${prop}`)
  return found
}

/**
 * The winning declaration on a desktop: later rules of equal specificity beat
 * earlier ones, but a rule inside a `@media (max-width: …)` block wins nothing
 * at this width, so it is not a candidate at all.
 */
const declaration = (css, ...rest) => declarations(desktop(css), ...rest).at(-1)

function px(value) {
  const found = String(value).match(/(-?\d+(?:\.\d+)?)px/)
  assert.ok(found, `expected a px length, read ${JSON.stringify(value)}`)
  return Number(found[1])
}

// --- The stock line ----------------------------------------------------------

test('the stock line is coloured by its state, not by its position', () => {
  // The exact shape of the defect: any positional selector that gives a
  // .tire-info small a colour. Re-introduce it and this fails on any colour.
  for (const [name, css] of [['App.css', appCss], ['RequestFlow.css', flowCss]]) {
    const positional = [...css.matchAll(/\.tire-info\s+small:(?:last|first|nth)-[^{]*\{([^}]*)\}/g)]
      .filter(block => /(?:^|;)\s*color\s*:/.test(block[1]))
      .map(block => block[0])
    assert.deepEqual(positional, [],
      `${name} colours the stock line by where it sits in the card, so an out-of-stock tire reads in the in-stock colour`)
  }

  const inStock = declaration(appCss, '.tire-stock[data-stock="in"]', 'color', 'in stock')
  const outOfStock = declaration(appCss, '.tire-stock[data-stock="out"]', 'color', 'out of stock')
  assert.notEqual(inStock.toLowerCase(), outOfStock.toLowerCase(),
    'both stock states are painted the same colour, which is the defect this replaced wearing a different selector')
})

test('the element that says which state it is in, carries which state it is in', () => {
  // The rules above can only work if the markup hands them the state. Both
  // strings have to come off one element, and that element has to be tagged.
  const line = route.match(/<small[^>]*>\{tire\.inStock \? '[^']*' : '[^']*'\}<\/small>/)
  assert.ok(line, 'the in-stock / out-of-stock line is not where this test looks; if it moved, move this with it')
  assert.match(line[0], /className="tire-stock"/,
    'the stock line does not carry the class its colour rule selects, so neither colour applies')
  assert.match(line[0], /data-stock=\{tire\.inStock \? 'in' : 'out'\}/,
    'the stock line does not carry its own state, leaving position as the only thing a colour rule can key on')
})

// --- The width a card actually gets ------------------------------------------

/**
 * The grid's real width, derived rather than remembered: a number copied into
 * a test is only true on the day it was copied.
 *
 * RequestFlow.css is imported after App.css (src/App.jsx) and its
 * `.order-section` max-width is the one that applies.
 */
function tireGridWidth() {
  const shell = px(declaration(flowCss, '.order-section', 'max-width', 'request flow shell'))
  const shellPadding = px(declaration(appCss, '.order-section', 'padding', 'request flow shell').split(/\s+/)[1])
  // clamp(min, preferred, max): any desktop viewport lands on the max.
  const panelPadding = px(declaration(flowCss, '.order-section .step-panel', 'padding', 'step panel').split(',').at(-1))
  return shell - 2 * shellPadding - 2 * panelPadding
}

test('the tire grid fits its column count to the card, not to the viewport', () => {
  const grid = tireGridWidth()
  const template = declaration(appCss, '.tire-options', 'grid-template-columns', 'tire grid')
  // The rendered gap: RequestFlow.css raises App.css's, and it is the file
  // that wins, so measuring the other one would answer about a page nobody
  // is looking at.
  const gap = px(declaration(flowCss, '.order-section .tire-options', 'gap', 'tire grid'))

  const derived = template.match(/auto-fil[ln]\s*,\s*minmax\(\s*min\(\s*(\d+)px/)
  assert.ok(derived,
    `.tire-options hard-codes its column count (\`${template}\`). A fixed count is set against a viewport, ` +
    `and the viewport is not the constraint: this grid is ${grid}px wide however wide the screen is.`)

  const minimum = Number(derived[1])
  const columns = Math.max(1, Math.floor((grid + gap) / (minimum + gap)))
  const card = (grid - gap * (columns - 1)) / columns
  assert.ok(card >= minimum,
    `${columns} columns of a ${grid}px grid is ${card.toFixed(0)}px a card, under the ${minimum}px it asks for`)
})

test('neither card layout lets one long model name squeeze the rest of the card', () => {
  // minmax(0, 1fr), not 1fr: a bare 1fr floors at min-content, so a single
  // unbreakable model name widens its column at the photo's and price's cost.
  const wide = declaration(appCss, '.tire-option', 'grid-template-columns', 'tire card, wide')
  assert.match(wide, /minmax\(\s*0\s*,\s*1fr\s*\)/, `the wide card floors its text column at min-content: ${wide}`)
  // The narrow template lives inside a max-width block, so it is read from the
  // whole file rather than through the desktop reader above.
  for (const [name, css] of [['App.css', appCss], ['RequestFlow.css', flowCss]]) {
    const narrow = declarations(css, '.tire-option', 'grid-template-columns', `tire card, narrow (${name})`).at(-1)
    assert.match(narrow, /minmax\(\s*0\s*,\s*1fr\s*\)/, `${name}'s narrow card floors its text column at min-content: ${narrow}`)
  }
})

// --- The filter panel, against the page's legacy element rules ---------------

/** Selector specificity as (ids, classes/attributes/pseudo-classes, elements). */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  const elements = (selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) || []).length
  return [ids, classes, elements]
}

/** Does `a` win outright? A tie is not a win -- source order settles that. */
function beats(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

test('specificity is compared the way a browser compares it', () => {
  assert.deepEqual(specificity('.min-h-screen label'), [0, 1, 1])
  assert.deepEqual(specificity('.order-section .tire-facet-option'), [0, 2, 0])
  assert.ok(beats([0, 2, 0], [0, 1, 1]), 'two classes beat one class and an element')
  assert.ok(!beats([0, 1, 0], [0, 1, 1]), 'one class alone does not')
  assert.ok(!beats([0, 1, 1], [0, 1, 1]), 'a tie is not a win')
})

test('a filter option is laid out by its own rule, not by the page-wide label rule', () => {
  // This one shipped. `.min-h-screen label` gives every label on the customer
  // page display:block, a 7px bottom margin and UPPERCASE, and it outranks a
  // bare `.tire-facet-option`, so the panel's flex row, its gap and its
  // right-aligned count all silently did nothing: "BRIDGESTONE14", the
  // checkbox jammed against the text, 107 rows of it.
  // Comments first: a `/* ... */` mentioning "label" reads as a selector to a
  // regex, and the first version of this test failed on a comment about the
  // owner's cancel dialog.
  const bare = css => css.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = (css, wanted, valuePattern) =>
    [...bare(css).matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(rule => valuePattern.test(rule[2]))
      .flatMap(rule => rule[1].split(',').map(part => part.trim()))
      .filter(part => wanted.test(part))

  const legacy = [...new Set(selectors(appCss, /(?:^|[\s>+~])label\b/, /(?:^|;)\s*display\s*:/))]
  assert.ok(legacy.length, 'no page-wide label rule sets display any more -- re-read this test before deleting it')

  const own = [
    ...selectors(appCss, /\.tire-facet-option\b/, /(?:^|;)\s*display\s*:\s*flex/),
    ...selectors(flowCss, /\.tire-facet-option\b/, /(?:^|;)\s*display\s*:\s*flex/),
  ]
  assert.ok(own.length, '.tire-facet-option is never laid out as a flex row')

  for (const element of legacy) {
    assert.ok(own.some(mine => beats(specificity(mine), specificity(element))),
      `"${element}" outranks every rule that lays out a filter option, so the option renders as a block: ` +
      'checkbox against the text, count running into the label. Scope the rule; do not weaken this test.')
  }
})

const PHONE_VIEWPORT_PX = 375

test('the filter panel collapses on a phone and only on a phone', () => {
  const at = width => atWidth(appCss, width) + atWidth(flowCss, width)
  const phone = at(PHONE_VIEWPORT_PX)
  const wide = at(DESKTOP_VIEWPORT_PX)
  const collapsed = '.tire-filters-body[data-open="false"]'

  // On a phone: the panel can be shut, and there is a full-size control to
  // open it again.
  assert.deepEqual(lookup(phone, collapsed, 'display'), ['none'],
    'nothing collapses the panel at 375px, where it is ~950px of filters above the first tire')
  assert.equal(lookup(phone, '.order-section .tire-filters-toggle', 'display').at(-1), 'flex',
    'the panel collapses at 375px with no control shown to open it')
  assert.ok(px(lookup(phone, '.order-section .tire-filters-toggle', 'min-height').at(-1)) >= 44,
    'the only way back to the filters on a phone is under a 44px touch target')

  // On a desktop: neither half exists. This is the pairing that matters -- a
  // collapse rule that applied here would hide the panel at a width where the
  // toggle is display:none, leaving no way to reopen it.
  assert.deepEqual(lookup(wide, collapsed, 'display'), [],
    'the collapse rule reaches the desktop, where the control that undoes it is hidden')
  assert.equal(lookup(wide, '.tire-filters-toggle', 'display').at(-1), 'none',
    'the phone toggle is drawn on the desktop too, where it controls nothing')
})

test('the toggle names the thing it opens, and that thing is there', () => {
  const component = readFileSync(new URL('./components/TireFilters.jsx', import.meta.url), 'utf8')
  const id = component.match(/const BODY_ID = '([^']+)'/)
  assert.ok(id, 'BODY_ID is not declared where this test looks for it')
  assert.match(component, /aria-controls=\{BODY_ID\}/, 'the toggle does not say what it controls')
  assert.match(component, /id=\{BODY_ID\}/, 'nothing carries the id the toggle points at')
  assert.match(component, /aria-expanded=\{open\}/, 'the toggle does not report whether it is open')
  // The CSS hides the body by an attribute, so the attribute has to be written
  // as a string: data-open={open} renders nothing at all when open is false.
  assert.match(component, /data-open=\{open \? 'true' : 'false'\}/,
    "data-open must be a string; a boolean false renders no attribute and the selector never matches")
})

// --- Colours no audit on this repo can see -----------------------------------

/**
 * The state a customer meets least often is the one nothing measures.
 *
 * kmt-e2 found this shape on the owner's photo column and it transfers here
 * exactly: the a11y audit measures what the SEEDED database renders, and the
 * seed holds ZERO out-of-stock tires (measured today: 323 rows in 225/50R17,
 * 0 of them out of stock). So the whole disabled-card state is drawn zero
 * times in every run the gate has ever made, and its colours were whatever
 * they were. `.tire-option:disabled` faded the card with `opacity`, which
 * fades text and ground together over a near-black ground, so only the text
 * lost: "Currently unavailable" came out at 3.33:1 and the description 3.07:1.
 *
 * A disabled control is exempt from WCAG 1.4.3, so none of this was a
 * compliance failure. It is simpler than that -- "Currently unavailable" is
 * the only thing the card exists to say in that state.
 *
 * Every colour below is READ from the stylesheet and run through the gate's
 * own ratio(), so no hex is restated here and this cannot drift when someone
 * restyles the card.
 */
import { ratio } from '../.forge/contrast-measure.mjs'

const rgb = value => {
  // `!important` rides along on several of these declarations; it changes who
  // wins, not what colour it is.
  const found = String(value).replace(/!important/gi, '').trim().match(/^#([0-9a-f]{6})$/i)
  assert.ok(found, `expected a six-digit hex, read ${JSON.stringify(value)}`)
  const n = parseInt(found[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

const READABLE = 4.5

test('every state of a tire card is readable, including the one nothing renders', () => {
  const card = declaration(appCss, '.tire-option', 'background', 'tire card')
  const disabled = declaration(appCss, '.tire-option:disabled', 'background', 'unavailable card')

  const pairs = [
    ['in stock', '.tire-stock[data-stock="in"]', card],
    ['currently unavailable', '.tire-stock[data-stock="out"]', card],
    // On the unavailable card, which is the ground no audit here has drawn.
    ['currently unavailable, on the unavailable card', '.tire-stock[data-stock="out"]', disabled],
    ['the name of an unavailable tire', '.tire-option:disabled .tire-info strong, .tire-option:disabled > b', disabled],
    ['the description of an unavailable tire', '.tire-option:disabled .tire-info small:not(.tire-stock)', disabled],
    // And the filter panel's own unpickable row.
    ['a brand with nothing left in it', '.tire-facet-option.is-empty', declaration(appCss, '.tire-filters', 'background', 'filter panel')],
    ['the price range', '.tire-filters-range', declaration(appCss, '.tire-filters', 'background', 'filter panel')],
  ]

  for (const [label, selector, ground] of pairs) {
    const color = declaration(appCss, selector, 'color', label)
    const measured = ratio(rgb(color), rgb(ground))
    assert.ok(measured >= READABLE,
      `${label}: ${color.trim()} on ${ground.trim()} is ${measured.toFixed(2)}:1, under ${READABLE}:1`)
  }
})

test('the unavailable card is dimmed by its colours, not by fading it', () => {
  // The guard that matters more than any hex above. `opacity` fades the text
  // and the ground together; over a near-black ground only the text loses, so
  // re-introducing it would put every colour measured above back under 4:1
  // while each one still reads as passing on its own.
  const faded = lookup(desktop(appCss), '.tire-option:disabled', 'opacity')
    .filter(value => Number(value.trim()) < 1)
  assert.deepEqual(faded, [],
    'the unavailable card is faded with opacity again, which makes every colour above a number that is not what renders')
})
