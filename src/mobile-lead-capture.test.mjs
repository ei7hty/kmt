/**
 * The two things a phone customer needs that nothing else here could see.
 *
 * Both were measured on production (`x-kmt-release: 9ee19c9`) at 375x812
 * before a line was changed, because both are the kind of defect that reads
 * as fine in source and only exists at a size:
 *
 *   - The three sort pills rendered 22.0px tall at 11px type -- exactly half
 *     the 44px minimum, and the ONLY controls anywhere in the customer flow
 *     under it. The `.tire-facet-option` rows directly beside them already
 *     measured 44px, which is what made this an isolated defect rather than a
 *     site-wide one.
 *   - `.site-nav` is `position: relative`, so the `sms:` deep link -- one tap,
 *     messages app, draft already written, the lowest-friction way to become a
 *     lead on this site -- scrolled out of reach by 2000px and never came
 *     back, on a page 5.7 screens tall at step 1 and 8.5 at step 2.
 *
 * WHY THIS READS CSS AS TEXT. Same reason `src/tire-card-layout.test.mjs`
 * does, and it says so at its own head: this suite has no DOM to ask. A text
 * reader cannot compute a rendered height, so it does not pretend to -- it
 * asserts the DECLARED floor that produces it, which is the thing a future
 * edit would actually remove. Every reader below is checked against a value
 * it should reject before it is trusted with a value it should accept.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TEXT_HREF } from './contact.js'

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8')
const appCss = read('./App.css')
const flowCss = read('./RequestFlow.css')
const route = read('./routes/CustomerRequest.jsx')

/** Apple's floor and Google's, the smaller of the two. */
const MIN_TAP_PX = 44

/**
 * The two breakpoints this file reads, and why they are not the same number.
 *
 * They are not a mistake and they should not be unified here. The order
 * section's touch sizing has lived at 600px since the #85 a11y pass
 * (`RequestFlow.css`), and the marketing nav's mobile layout at 760px
 * (`App.css`). The sort pill belongs to the first neighbourhood and the
 * contact bar to the second, so each is fixed beside the rules it was
 * measured against rather than at a third width invented here.
 */
const ORDER_TOUCH = '(max-width: 600px)'
const NAV_MOBILE = '(max-width: 760px)'

/**
 * Every `@media <condition> { ... }` block's inner text, brace-matched rather
 * than regexed to the next `}` -- these blocks contain whole rules, so the
 * first `}` is a rule's, not the block's. Returns all of them joined: there
 * is more than one `(max-width: 760px)` block in App.css and a rule may sit
 * in either, so which one is an accident of ordering, not a fact worth
 * asserting.
 */
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
      else if (css[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) break
    blocks.push(css.slice(open + 1, end))
    from = end
  }
  return blocks.join('\n')
}

/**
 * The declaration body of the rule whose selector is exactly `selector`.
 * `\s*\{` after the literal is what keeps `.tire-sort` off `.tire-sort.selected`
 * and off `.tire-sorts` -- the next non-space character has to be the brace.
 */
function ruleBody(css, selector) {
  const found = new RegExp(`(?:^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  return found ? found[1] : null
}

/** A pixel-valued property from a declaration body, as a number. */
function pixels(body, property) {
  if (body === null) return null
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body)
  return found ? Number(found[1]) : null
}

test('the readers reject what they should, before anything below trusts them', () => {
  // A rule that is not there reads as absent, not as an empty pass.
  assert.equal(ruleBody(appCss, '.no-such-class-anywhere'), null)
  assert.equal(pixels(ruleBody(appCss, '.no-such-class-anywhere'), 'min-height'), null)

  // The selector matcher is exact: these three are distinct rules, and a
  // reader that confused them would answer questions about the wrong one.
  assert.ok(ruleBody(appCss, '.tire-sort'), '.tire-sort itself is gone')
  assert.notEqual(ruleBody(appCss, '.tire-sort'), ruleBody(appCss, '.tire-sorts'))
  assert.notEqual(ruleBody(appCss, '.tire-sort'), ruleBody(appCss, '.tire-sort.selected'))

  // `pixels` reads a real number off a real declaration rather than always
  // returning something truthy: this one is deliberately NOT 44.
  assert.equal(pixels('min-height: 12px; color: red', 'min-height'), 12)
  assert.equal(pixels('min-height: 12px', 'max-height'), null)

  // And the media extractor finds a block that exists and not one that doesn't.
  assert.ok(mediaText(appCss, NAV_MOBILE).length > 0)
  assert.ok(mediaText(flowCss, ORDER_TOUCH).length > 0)
  assert.equal(mediaText(appCss, '(max-width: 99999px)'), '')
})

test('every sort pill is at least a 44px tap target on a phone', () => {
  const touch = mediaText(flowCss, ORDER_TOUCH)
  const height = pixels(ruleBody(touch, '.order-section .tire-sort'), 'min-height')
  assert.ok(height !== null,
    'the sort pills have no min-height inside the touch breakpoint, so their height is padding and 11px type again -- that is exactly how they were 22px')
  assert.ok(height >= MIN_TAP_PX, `the sort pills are ${height}px on a phone; ${MIN_TAP_PX}px is the floor`)

  // The neighbours they were measured against, fixed by the same block in the
  // #85 pass. If these ever regress the pills stop being an isolated defect
  // and the note at the head of this file stops being true.
  const facet = pixels(ruleBody(touch, '.order-section .tire-facet-option'), 'min-height')
  assert.ok(facet !== null && facet >= MIN_TAP_PX,
    `the facet rows are ${facet}px -- the pills were fixed to match these, so these cannot regress quietly`)

  // The control that keeps this test honest about WHERE the fix has to live:
  // the desktop rule is deliberately still dense, so a reader that was
  // accidentally pointed at App.css would fail rather than quietly agree.
  assert.equal(pixels(ruleBody(appCss, '.tire-sort'), 'min-height'), null,
    'the desktop pill now declares a min-height too; if that is intended, this control needs rewriting rather than deleting')
})

test('a phone can reach Ken from anywhere on the page, not just the top', () => {
  const mobile = mediaText(appCss, NAV_MOBILE)

  assert.ok(route.includes('mobile-contact-bar'), 'the sticky contact bar is gone from the customer route')
  assert.equal(pixels(ruleBody(appCss, '.mobile-contact-bar'), 'min-height'), null,
    'the base rule should only hide the bar; its size belongs to the mobile block')
  assert.match(ruleBody(appCss, '.mobile-contact-bar'), /display:\s*none/,
    'the bar must be hidden by default, or it appears on desktop too')

  const bar = ruleBody(mobile, '.mobile-contact-bar')
  assert.ok(bar, 'the bar has no rule inside the phone breakpoint, so it stays display:none everywhere')
  assert.match(bar, /position:\s*fixed/, 'a bar that is not fixed scrolls away, which is the whole defect')
  assert.match(bar, /bottom:\s*0/, 'anchored to the bottom of the viewport')
  assert.match(bar, /env\(safe-area-inset-bottom/,
    'without the inset the action sits under the iPhone home indicator')

  const action = pixels(ruleBody(mobile, '.mobile-contact-action'), 'min-height')
  assert.ok(action !== null && action >= MIN_TAP_PX, `the bar's own action is ${action}px`)

  // The bar is fixed, so it covers whatever is at the bottom of the page --
  // at the end of the order form, the submit button.
  const reserved = pixels(ruleBody(mobile, '.customer-shell'), 'padding-bottom')
  assert.ok(reserved !== null && reserved >= action,
    `the shell reserves ${reserved}px for a bar whose action alone is ${action}px, so the bar covers the end of the page`)
})

test('the bar offers texting and nothing else, which is Ken\'s rule not a layout choice', () => {
  // t63, verbatim: "dont create smaller call option promote texting". A bar
  // like this normally grows a call button; this asserts that it has not.
  const bar = /<div className="mobile-contact-bar">([\s\S]*?)<\/div>/.exec(route)
  assert.ok(bar, 'the contact bar markup is gone or no longer a single element')

  const hrefs = [...bar[1].matchAll(/href=\{?([^}\s>]+)\}?/g)].map(match => match[1])
  assert.deepEqual(hrefs, ['TEXT_HREF'],
    'the bar links to something other than the one shared sms: constant -- a tel: here would break t63, and a literal number would fork the opener')
  assert.ok(!/tel:/.test(bar[1]), 'a call control in the contact bar contradicts t63')

  // And the constant it shares really is the sms: deep link with a draft, so
  // the assertion above is about the right thing.
  assert.match(TEXT_HREF, /^sms:\+\d+\?body=\S+/)
})
