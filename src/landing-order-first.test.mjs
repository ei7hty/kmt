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
  const value = declaredValue(css, `\\.customer-shell\\s*>\\s*\\${child}`, 'order')
  return value === null ? null : Number(value)
}

/**
 * The value of `property` that actually applies, given every rule for
 * `selector` in `css`, at equal specificity.
 *
 * Cascade resolution is PER PROPERTY, not per rule, and the difference is not
 * academic here -- it is two separate bugs this file has already had:
 *
 *   - `.customer-shell > .site-nav` has two rules in the phone block. The
 *     first is about nav layout and declares no `order`; a reader that
 *     stopped at the first rule called the nav unordered.
 *   - `.hero-visual` has THREE rules across the phone blocks -- a size, a
 *     `display`, and a later one setting only `background`. A reader that
 *     took the last RULE saw `background: #080808` and concluded the element
 *     was not hidden, when the `display: none` two blocks earlier is still
 *     what applies.
 *
 * So: walk every matching rule in order, keep the last value seen for this
 * property, and ignore rules that say nothing about it.
 */
function declaredValue(css, selectorPattern, property) {
  const rules = new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, 'g')
  const declaration = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`)
  let last = null
  for (const rule of css.matchAll(rules)) {
    const found = declaration.exec(rule[1])
    if (found) last = found[1].trim()
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

test('the repeated logo block is gone from phones, and the strip is only moved', () => {
  // TWO DIFFERENT DECISIONS, and the test says which is which.
  //
  // Hiding the hero's logo block is Ken's, asked and answered on 2026-09-14
  // ("hide the logo too") after he was shown what shrinking it alone bought
  // (1.73 screens) against removing it (1.52). Removing something from the
  // page is his call and this records that it was made, not assumed.
  //
  // Resolved per property across all three phone rules for this selector --
  // see `declaredValue`. Reading the last RULE instead reports
  // `background: #080808` and concludes the block is still visible.
  assert.equal(declaredValue(phone, '\\.hero-visual', 'display'), 'none',
    '.hero-visual is not display:none on a phone; the 268px repeated logo block is back')

  // The strip is a different matter and was NOT part of that ruling. It is
  // moved below the order form, and it stays on the page. If a future edit
  // reaches for display:none here, that is another decision and Ken's to
  // make, not one this change licenses by precedent.
  const stripRules = [...phone.matchAll(/\.service-strip\s*\{([^}]*)\}/g)].map(match => match[1])
  assert.ok(stripRules.length > 0, '.service-strip has no phone rule at all')
  for (const rule of stripRules) {
    assert.doesNotMatch(rule, /display:\s*none/,
      'the service strip is hidden on phones; it was moved, not removed, and removing it was never ruled on')
  }
})
