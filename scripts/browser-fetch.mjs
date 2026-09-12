/* global document */ // used inside waitForFunction, which runs in the browser

/**
 * Page fetcher backed by a real browser window.
 *
 * Why this exists: giga-tires.com sits behind AWS WAF and CloudFront. A plain
 * HTTP fetch gets a challenge page, and a *headless* browser gets refused
 * outright ("The request could not be satisfied"). A normal, visible browser
 * loads the same pages without complaint.
 *
 * So that is what this does -- it opens a real browser window and reads pages
 * the way a person would. There is deliberately no stealth plugin, no spoofed
 * user agent, no fingerprint patching and no token replay: if the site decides
 * to turn this away, it should be able to. What keeps it acceptable is that it
 * stays small and honest -- one window, one page at a time, a pause between
 * requests, and only the /tires/ paths robots.txt allows.
 *
 * The window is visible on purpose. This is a tool someone runs by hand and
 * watches; a scraper you cannot see is a scraper you cannot tell has gone wrong.
 */

import { assertExpectedPage, assertProviderResponse, productUrl, ProviderRefusalError, sizeUrl, USER_AGENT } from './giga-tires.mjs'

const READY_SELECTOR = '.plp-list__item-container'

// Metadata pilot: ONE exact main-document navigation, no redirects, no popups,
// no second document. That part is unchanged and is what this policy is for.
//
// Subresources are NOT refused any more. They were, and it made the pilot
// incapable of ever succeeding against this supplier -- see the note on
// `javaScriptEnabled` in createBrowserFetcher. Images, fonts and media are
// still dropped, matching the size scrape. The pilot still never retries, never
// substitutes, and never follows a redirect to obtain a result.
export function productDocumentPolicy(expectedUrl) {
  let used = false
  return request => {
    if (used || !request.isNavigationRequest() || request.resourceType() !== 'document' ||
        request.frame() !== request.frame().page().mainFrame() || request.url() !== expectedUrl) return false
    used = true
    return true
  }
}

export async function routeProductDocument(route, allow) {
  if (!allow(route.request())) { await route.abort(); return }
  // route.continue() can follow an HTTP redirect without another route hook.
  // Fetch exactly one response and refuse redirects before browser fulfillment.
  const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 })
  if (response.status() >= 300 && response.status() < 400 ||
      Number(response.headers()['content-length']) > 4 * 1024 * 1024) {
    await route.abort(); throw new Error('Product metadata response refused')
  }
  const body = await response.body()
  if (body.length > 4 * 1024 * 1024) { await route.abort(); throw new Error('Product metadata response too large') }
  await route.fulfill({ response, body })
}

/**
 * The supplier's own words for a size it does not carry, e.g. "Unfortunately,
 * the size is not available at this time." Confirmed by reading a real empty
 * page rather than inferred from the absence of results.
 */
const EMPTY_TEXT = 'is not available at this time'

/**
 * The supplier telling us the rate is too high, as an actual HTTP status
 * rather than inferred from a page's title -- title text is guessable, a
 * status code is not. Carries Retry-After when the response sends one, so
 * the caller can log it. Distinguished from every other error because it
 * means one thing: stop the whole run, do not retry, do not continue past
 * it. See docs/supplier-refresh.md.
 */
export class RateLimitedError extends ProviderRefusalError {
  constructor(message, retryAfter = null) {
    super(message, { status: 429, reason: 'rate-limit', retryAfter })
    this.name = 'RateLimitedError'
  }
}

/**
 * Launch one browser and hand back a fetcher over it.
 *
 * One context for the whole run, reused across sizes: the WAF cookie it picks
 * up on the first page carries over, so later pages load without re-challenging.
 */
export async function createBrowserFetcher(options = {}) {
  const { headless = false, timeout = 60000, userAgent = USER_AGENT, productMetadataOnly = false } = options

  const { chromium } = await import('playwright')

  // In a container there is no bundled browser and no user to drop privileges
  // to, so both come from the environment. Unset -- which is every local run --
  // this changes nothing: Playwright's own Chromium, sandbox intact.
  //
  // The browser is still headful there. Xvfb supplies the display, because the
  // supplier's WAF refuses headless browsers outright and that does not stop
  // being true on a server.
  const executablePath = process.env.KMT_CHROMIUM_PATH || undefined
  const args = process.env.KMT_CHROMIUM_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-dev-shm-usage']
    : []

  const browser = await chromium.launch({ headless, executablePath, args })
  // JavaScript stays ON for the pilot, as it already is for the size scrape.
  //
  // It used to be off (`javaScriptEnabled: false` when productMetadataOnly),
  // for minimum footprint. Measured 2026-09-11: with scripts disabled, a
  // product URL answers HTTP 202 and a 1,997-byte shell that never fills --
  // held for 20 seconds it stays at 1,997 bytes, no JSON-LD, not one
  // occurrence of `tirecode`. The shell's only request is to
  // `token.awswaf.com`: this host's AWS WAF wants a browser to behave like a
  // browser before it serves the page, exactly as the header above describes
  // for the listing scrape.
  //
  // So the pilot could never have worked. Turning scripts on is not stealth
  // and not a bypass -- it is the same honest posture `fetchSizePage` has
  // used all along: a visible window, the real user agent, no fingerprint
  // patching, no token replay, and a pause between pages. What it gives up is
  // only the pilot's original "absolute minimum footprint" goal, which cost
  // the feature its entire reason to exist.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent,
    serviceWorkers: 'block' })
  const page = await context.newPage()

  // Images and fonts are most of the bytes on a listing page and none of the
  // data. Skipping them is lighter on us and on them.
  await context.route('**/*', route => {
    if (productMetadataOnly) return route.abort()
    const type = route.request().resourceType()
    return type === 'image' || type === 'font' || type === 'media'
      ? route.abort()
      : route.continue()
  })

  return {
    async fetchSizePage(size, pageNumber = 1) {
      const url = sizeUrl(size, pageNumber)
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout })

      if (response?.status() === 429) {
        const retryAfter = response.headers()['retry-after'] ?? null
        throw new RateLimitedError(`429 from ${url}`, retryAfter)
      }

      // Check the response before waiting on any success selector: a refusal
      // page must stop immediately, not spend the selector timeout on it.
      assertProviderResponse(url, response, await page.content())

      // Neither the grid nor the "not available" message is present at
      // domcontentloaded -- both render client-side, at about the same
      // speed (measured: ~1.7s for either). Racing them means a genuinely
      // empty size returns as fast as a hit, instead of waiting out the
      // full 20s below to conclude the grid was never coming. Each side
      // catches its own timeout so the loser of the race never becomes an
      // unhandled rejection.
      await Promise.race([
        page.waitForSelector(READY_SELECTOR, { timeout: 20000 }).catch(() => {}),
        page.getByText(EMPTY_TEXT).waitFor({ timeout: 20000 }).catch(() => {}),
      ])

      const html = await page.content()
      assertProviderResponse(url, response, html)
      if (html.includes(EMPTY_TEXT)) return { html, url }
      assertExpectedPage(url, html, 'listing')
      return { html, url }
    },

    async fetchProductPage(input) {
      const url = productUrl(input)
      // A separate page per product makes explicitly bounded concurrency safe;
      // the listing page above stays dedicated to its sequential pagination.
      const productPage = await context.newPage()
      let documentError
      try {
        if (productMetadataOnly) {
          const allow = productDocumentPolicy(url)
          await productPage.route('**/*', async route => {
            // The MAIN DOCUMENT keeps every guard it ever had: exactly one
            // navigation, fetched with maxRedirects 0 so a redirect is refused
            // rather than followed, and capped at 4MB. `allow` only consumes
            // itself on a match, so calling it per request is safe.
            if (allow(route.request())) {
              return routeProductDocument(route, () => true).catch(async error => {
                documentError = error
                await route.abort().catch(() => {})
              })
            }
            // Everything else follows `fetchSizePage`'s rule, which has been
            // in production against this supplier all along: drop the bytes
            // that are not data, let the page be a page. Aborting subresources
            // here is what left the pilot staring at a 1,997-byte WAF shell.
            const type = route.request().resourceType()
            if (type === 'image' || type === 'font' || type === 'media') return route.abort().catch(() => {})
            return route.continue().catch(async () => { await route.abort().catch(() => {}) })
          })
        }
        const response = await productPage.goto(url, { waitUntil: 'domcontentloaded', timeout })
        if (documentError) throw documentError
        if (response?.status() === 429) {
          throw new RateLimitedError(`429 from ${url}`, response.headers()['retry-after'] ?? null)
        }
        if (!response) throw new Error(`GET ${url} -> no response`)
        // A refusal page should not wait for product JSON-LD to appear -- so
        // the refusal check runs FIRST, against whatever is on screen at
        // domcontentloaded, and a genuine refusal still fails immediately.
        assertProviderResponse(url, response, await productPage.content())
        // Then wait, for every caller. Measured on a real product page,
        // 2026-09-10: at domcontentloaded it is a 1,997-byte shell with an
        // empty <title> and neither `application/ld+json` nor `tirecode`
        // anywhere in it; a moment later it is 538,513 bytes of the right
        // tire. `productMetadataOnly` used to skip this wait, so the pilot --
        // the ONLY caller that sets it -- judged the shell and concluded the
        // supplier had served something that was not a product page. It had
        // not. Skipping the wait was an optimisation for the refusal case that
        // silently broke the success case, and the refusal case is already
        // covered by the check above.
        // Wait for the JSON-LD block, and ONLY that.
        //
        // This wait briefly tested `ld+json OR the string "tirecode"`, on the
        // reasoning that `assertExpectedPage` accepts either. That was a wait
        // THAT COULD NOT FAIL: every one of these URLs contains the word
        // `tirecode`, and the unrendered shell echoes its own URL (canonical
        // link, og:url), so the condition was already true at
        // domcontentloaded. It returned instantly on a shell and the run then
        // judged a page that had not rendered -- symptom: a product page
        // parsing to `sku: undefined` because there was no structured data
        // yet, on some pages but not others, depending on how fast they came
        // back.
        //
        // `parseProductPage` reads everything it needs out of the JSON-LD
        // product block, so that block is the real precondition. If a page
        // genuinely never produces one, the 20s elapses and the caller refuses
        // it by name -- loudly and for the right reason, rather than silently
        // parsing a shell.
        // Wait for a JSON-LD block that actually contains a PRODUCT.
        //
        // Third correction to this one wait tonight, and the same mistake each
        // time: waiting for something CORRELATED with what the parser needs
        // instead of the thing itself.
        //   1. `ld+json OR "tirecode"` -- every URL contains "tirecode", so it
        //      was true before anything rendered.
        //   2. any `ld+json` element -- these pages ship a BreadcrumbList or
        //      Organization block in the shell and the Product block later, so
        //      it returned on the wrong block. Measured: 19 of 37 pages parsed
        //      to `sku: undefined` with that wait in place.
        // `productJsonLd` (giga-tires.mjs) scans every ld+json block for a node
        // whose @type includes "Product" and ignores the rest. So that is the
        // precondition, and nothing weaker will do.
        await productPage.waitForFunction(
          () => [...document.querySelectorAll('script[type="application/ld+json"]')]
            .some(node => (node.textContent || '').includes('"Product"')),
          undefined,
          { timeout: 20000 },
        ).catch(() => {})
        const html = await productPage.content()
        assertProviderResponse(url, response, html)
        if (response.status() >= 400) throw new Error(`GET ${url} -> ${response.status()}`)
        assertExpectedPage(url, html, 'product')
        const finalUrl = productUrl(productPage.url())
        if (productMetadataOnly && finalUrl !== url) throw new Error('Product pilot final URL changed')
        return { html, url: finalUrl }
      } finally {
        await productPage.close()
      }
    },

    async close() {
      await browser.close()
    },
  }
}
