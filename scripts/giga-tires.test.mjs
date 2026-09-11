import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { productUrl, refusalReason, visibleText } from './giga-tires.mjs'
import { GIGA_SITEMAP_SAMPLE } from './fixtures/giga-sitemap-sample.mjs'

/**
 * `productUrl()` is the guard between a scraped href and everything downstream
 * that trusts it. Table-driven per OWNER AGENT's brief: a security guard is
 * inspected here for what it accepts and refuses, not reasoned about, and each
 * disallow rule below is exercised by a case that names it -- a rule with no
 * case naming it is decoration nobody has checked.
 */

const REAL = 'https://www.giga-tires.com/205-65-15/waterfall-tires/quattro/tirecode/WT25'

const ACCEPT = [
  ['the real shape -- size, brand, model, tirecode', REAL],
  ['a /tires/-prefixed URL that also has /tirecode/ -- must not regress', 'https://www.giga-tires.com/tires/205-65-15/waterfall/tirecode/WT25'],
]

const REFUSE = [
  // Each disallow prefix, /tirecode/ appended so the disallow rule is what
  // fires and not the missing-tirecode check.
  ['/cart prefix', 'https://www.giga-tires.com/cart/tirecode/X'],
  ['/checkout prefix', 'https://www.giga-tires.com/checkout/tirecode/X'],
  ['/my-account prefix', 'https://www.giga-tires.com/my-account/tirecode/X'],
  ['/price/calculate prefix', 'https://www.giga-tires.com/price/calculate/tirecode/X'],
  // filtering query param, in any position.
  ['?filtering= as the only param', 'https://www.giga-tires.com/205-65-15/x/tirecode/X?filtering=summer'],
  ['&filtering= after another param', 'https://www.giga-tires.com/205-65-15/x/tirecode/X?a=1&filtering=summer'],
  ['?a=1&filtering=2 -- filtering not first', 'https://www.giga-tires.com/205-65-15/x/tirecode/X?a=1&filtering=2'],
  // The two /tires/o/ rules, each alone -- see the module comment on why both are needed.
  ['/tires/o/ -- the basic deals form', 'https://www.giga-tires.com/tires/o/deals/tirecode/X'],
  ['/tires/<size>/o/ -- the sized form', 'https://www.giga-tires.com/tires/205-65-15/o/x/tirecode/X'],
  // Everything else the original guard already covered, kept.
  ['another origin', 'https://evil.example.com/205-65-15/x/tirecode/X'],
  ['no /tirecode/ at all', 'https://www.giga-tires.com/205-65-15/waterfall-tires/quattro'],
  ['embedded credentials', 'https://user:pass@www.giga-tires.com/205-65-15/x/tirecode/X'],
]

test('productUrl() accepts a real product URL', () => {
  for (const [label, url] of ACCEPT) {
    assert.doesNotThrow(() => productUrl(url), label)
  }
})

for (const [label, url] of REFUSE) {
  test(`productUrl() refuses: ${label}`, () => {
    assert.throws(() => productUrl(url), /Not a giga-tires product URL/, label)
  })
}

test('productUrl() strips a fragment but keeps everything else', () => {
  assert.equal(productUrl(`${REAL}#reviews`), REAL)
})

test('productUrl() rejects a value that is not a URL at all', () => {
  // An empty string, or most other short strings, resolve FINE against the
  // ORIGIN base (that's what the base argument is for) and fall through to
  // the "not a giga-tires product URL" branch instead -- this has to be a
  // string `new URL(value, ORIGIN)` cannot parse even with a base to fall
  // back on.
  assert.throws(() => productUrl('http://[::1'), /Not a product URL/)
})

/**
 * The measurement, not a claim about it: every one of the 1,083 real product
 * URLs the scraper has actually collected must still pass, run against the
 * committed snapshot -- fixtures only, no live request. This is the test that
 * would have caught the original defect (`/tires/` prefix requirement refusing
 * every one of these, since none of them starts with `/tires/`) and the one
 * that catches its regression.
 */
test('productUrl() accepts every real URL in the committed scrape snapshot', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/scraped-tires.json', import.meta.url)))
  const urls = data.tires.map(tire => tire.source.url)
  assert.equal(urls.length, 1083, 'the snapshot itself moved -- re-derive this count before trusting the pass/fail below')

  const failures = []
  for (const url of urls) {
    try { productUrl(url) } catch (error) { failures.push({ url, message: error.message }) }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${urls.length} real URLs were refused`)
})

/**
 * Stronger corroboration than the scrape snapshot: these 30 URLs are a sample
 * of the supplier's OWN sitemap -- the addresses their robots.txt points a
 * crawler at, not merely something this scraper happened to collect. Measured
 * against the full 50,000-entry sitemap before this fixture was cut down: all
 * 50,000 passed `productUrl()`, none started with `/tires/`, none were
 * disallowed. See `scripts/fixtures/giga-sitemap-sample.mjs` for provenance.
 */
test('productUrl() accepts every URL in the sitemap sample', () => {
  const failures = []
  for (const url of GIGA_SITEMAP_SAMPLE) {
    try { productUrl(url) } catch (error) { failures.push({ url, message: error.message }) }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${GIGA_SITEMAP_SAMPLE.length} sitemap URLs were refused`)
})

/**
 * `refusalReason` reads what a page SAYS, not what its machinery is NAMED.
 *
 * The shapes below are taken verbatim from a real giga-tires product page
 * (2026-09-10) that `/\bcaptcha\b/i` matched sixteen times while being an
 * entirely normal, fully served page for the requested tire.
 */
const RECAPTCHA_ON_A_REAL_PRODUCT_PAGE = `
<html><head><title>Royal Black Racing Trac 225/50R17XL 98W BSW</title></head>
<body>
  <h1>Royal Black Racing Trac</h1>
  <input type="hidden" name="recaptchaToken" class="j-newsletter-recaptcha-token">
  <div id="recaptchaNewsletter" class="newsletter-recaptcha-container"></div>
  <script>
    ACC.config.googleReCaptchaSiteKey = '6LeTckAUAAAAAPxJ9w9A_n90FCYEhEzEIdl6-Dlj';
    ACC.messages.invalidGoogleReCaptcha = 'Captcha could not be validated';
    ACC.messages.contactFormErrorReCaptcha = ACC.messages.invalidGoogleReCaptcha;
  </script>
</body></html>`

test('refusalReason ignores a reCAPTCHA widget on a real product page', () => {
  assert.equal(refusalReason(RECAPTCHA_ON_A_REAL_PRODUCT_PAGE), null)
})

test('refusalReason still catches a challenge that says so in visible text', () => {
  // The discriminator is not the word, it is where the word lives. A real
  // challenge states its refusal to the reader; a widget never does.
  assert.equal(refusalReason('<html><body><h1>Please complete the CAPTCHA to continue</h1></body></html>'), 'captcha')
  assert.equal(refusalReason('<html><body><p>Verify you are human</p></body></html>'), 'verify you are human')
  assert.equal(refusalReason('<html><body><p>Access Denied</p></body></html>'), 'access denied')
  assert.equal(refusalReason('<html><body><p>Too Many Requests</p></body></html>'), 'too many requests')
})

test('visibleText drops scripts, styles and tag markup, keeps readable words', () => {
  const html = '<style>.captcha{}</style><script>var captcha = 1</script><div class="captcha">hello</div>'
  const text = visibleText(html)
  assert.ok(!/captcha/i.test(text), 'a word that only appears in script, style or attributes is not visible text')
  assert.match(text, /hello/)
})

test('a refusal inside a <script> string is NOT treated as a refusal, and one in the body IS', () => {
  // Mutation-proof for the pair: same word, two placements, opposite verdicts.
  assert.equal(refusalReason('<script>msg = "Access Denied"</script><body>Tire details</body>'), null)
  assert.equal(refusalReason('<script>ok()</script><body>Access Denied</body>'), 'access denied')
})
