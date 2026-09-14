/**
 * What a phone customer reaches first, asserted as an ordering rather than a
 * distance.
 *
 * MEASURED ON PRODUCTION at 375x812 (release 4bfc736) before this existed:
 * the first control a customer can actually touch -- a width option in the
 * size selector -- sat 1931px down, 2.38 screens into a 5.8-screen page.
 * Between the hero's own "Order Tires" button and that control were the three
 * service-strip rows (382px) and a second copy of the logo (268px), under a
 * nav that already carries the logo. Reordering and shrinking took it to
 * 1401px, 1.73 screens, tested live in the page before a line was written.
 *
 * WHY THIS ASSERTS ORDER AND NOT PIXELS. A pixel target would be the more
 * satisfying test and it would be a lie: this suite has no DOM, no layout
 * engine and no fonts, so any number it computed would be a number it made
 * up. What it can read is the decision -- that on a phone the order form is
 * placed before the trust strip -- which is the thing a future edit would
 * actually undo. `src/tire-card-layout.test.mjs` takes the same line and says
 * so at its own head.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

/** The breakpoint the marketing page's mobile layout has always lived at. */
const PHONE = '(max-width: 760px)'

/** Every `@media <condition>` block's inner text, brace-matched. */
function mediaText(css, condition) {
  const blocks = []
  let from = 0
  for (;;) {
    const start = css.indexOf(`@media ${condition}`, from)
    if (start === -1) break
    const open = css.indexOf('{', start)
    if (open === -1) break
    let depth = 0
    let end = -1
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) break
    blocks.push(css.slice(open + 1, end))
    from = end
  }
  return blocks.join('\n')
}

/**
 * The `order` declared for `.customer-shell > <child>`, as a number.
 *
 * Scans EVERY rule with that selector and takes the last one that declares
 * `order`, because that is what the cascade does at equal specificity. The
 * first version of this read only the first matching rule and reported
 * `.site-nav` as unordered -- there are two rules for it in the phone block,
 * one about nav layout and one about position, and the reader was looking at
 * the wrong one. A reader that stops at the first match answers a question
 * nobody asked whenever a selector appears twice, which in CSS is normal.
 */
function orderOf(css, child) {
  const rules = new RegExp(`\\.customer-shell\\s*>\\s*\\${child}\\s*\\{([^}]*)\\}`, 'g')
  let last = null
  for (const rule of css.matchAll(rules)) {
    const value = /(?:^|;|\s)order\s*:\s*(-?\d+)/.exec(rule[1])
    if (value) last = Number(value[1])
  }
  return last
}

const phone = mediaText(appCss, PHONE)

test('the readers find what is there and reject what is not', () => {
  assert.ok(phone.length > 0, `no ${PHONE} block in App.css; every assertion below would be vacuous`)
  assert.equal(mediaText(appCss, '(max-width: 99999px)'), '')
  assert.equal(orderOf(phone, '.no-such-child'), null)
  assert.equal(orderOf('.customer-shell > .thing { color: red }', '.thing'), null,
    'a rule with no order must read as null, not as 0')
})

test('on a phone the order form comes before the trust strip', () => {
  // The whole point. The strip is three rows of reassurance; it is worth
  // having and it was sitting between the hero's CTA and the first thing a
  // customer can touch.
  const order = orderOf(phone, '.order-section')
  const strip = orderOf(phone, '.service-strip')
  assert.ok(order !== null, '.order-section has no order on a phone; the reorder is gone')
  assert.ok(strip !== null, '.service-strip has no order on a phone; the reorder is gone')
  assert.ok(order < strip, `the order form (${order}) must come before the service strip (${strip})`)
})

test('every child is ordered, because one unset child sorts around the rest', () => {
  // `order` defaults to 0, so a child left out does not stay where it was --
  // it joins the 0 group and lands wherever document position puts it
  // relative to anything else at 0. Half-ordering a flex container is the
  // bug that looks like it worked on the one screen you checked.
  const children = ['.site-nav', '.hero-section', '.order-section', '.service-strip', '.social-proof', '.site-footer']
  const values = children.map(child => [child, orderOf(phone, child)])
  for (const [child, value] of values) {
    assert.ok(value !== null, `${child} has no explicit order inside ${PHONE}`)
  }
  const numbers = values.map(([, value]) => value)
  assert.equal(new Set(numbers).size, numbers.length, `two children share an order: ${numbers.join(', ')}`)

  // And the container is actually a flex column, or `order` is inert and
  // every assertion above is about a property nothing reads.
  assert.match(phone, /\.customer-shell\s*\{[^}]*display:\s*flex/,
    '.customer-shell is not display:flex on a phone, so `order` does nothing at all')
  assert.match(phone, /\.customer-shell\s*\{[^}]*flex-direction:\s*column/,
    '.customer-shell is not a column, so the children would lay out in a row')
})

test('the strip and the logo are moved and resized, never removed', () => {
  // Ken has not been asked to drop anything from the page, and this change
  // deliberately does not need him to. If a future edit reaches for
  // `display: none` on either, that is a different decision and his to make.
  const hidden = /\.(service-strip|hero-visual|hero-logo)\s*\{[^}]*display:\s*none/.exec(phone)
  assert.equal(hidden, null,
    `${hidden?.[1]} is hidden on phones; moving and resizing needs no ruling, removing does`)

  // The repeated logo block is smaller than it was, which is the space this
  // reclaims.
  //
  // LAST declaration, not the first, and this is not pedantry: App.css has
  // TWO `(max-width: 760px)` blocks that both size `.hero-visual`, and the
  // second one wins and says so in its own comment. The first version of this
  // change edited the first block, the built page did not move, and only
  // looking at it in a browser found the second. A test that read the first
  // declaration would have agreed with the edit that did nothing.
  const declared = [...phone.matchAll(/\.hero-visual\s*\{[^}]*min-height:\s*(\d+)px/g)].map(m => Number(m[1]))
  assert.ok(declared.length > 0, '.hero-visual has no min-height on a phone')
  const winning = declared[declared.length - 1]
  assert.ok(winning <= 160,
    `.hero-visual resolves to ${winning}px on a phone (declared: ${declared.join(', ')}); it was 268px of a logo the nav already carries`)
})
