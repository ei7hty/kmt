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

import { sizeUrl } from './giga-tires.mjs'

const READY_SELECTOR = '.plp-list__item-container'

/**
 * Launch one browser and hand back a fetcher over it.
 *
 * One context for the whole run, reused across sizes: the WAF cookie it picks
 * up on the first page carries over, so later pages load without re-challenging.
 */
export async function createBrowserFetcher(options = {}) {
  const { headless = false, timeout = 60000 } = options

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  // Images and fonts are most of the bytes on a listing page and none of the
  // data. Skipping them is lighter on us and on them.
  await page.route('**/*', route => {
    const type = route.request().resourceType()
    return type === 'image' || type === 'font' || type === 'media'
      ? route.abort()
      : route.continue()
  })

  return {
    async fetchSizePage(size, pageNumber = 1) {
      const url = sizeUrl(size, pageNumber)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout })

      // The grid is server-rendered, so this is a check that the real page came
      // back rather than a wait for hydration. A size with no results never
      // renders it, which is a legitimate outcome -- hence the soft catch.
      await page.waitForSelector(READY_SELECTOR, { timeout: 20000 }).catch(() => {})

      const html = await page.content()
      if (!html.includes('window.productPrices') && !html.includes(READY_SELECTOR)) {
        const title = await page.title()
        throw new Error(`Blocked or unexpected page (title: ${title || 'none'})`)
      }
      return { html, url }
    },

    async close() {
      await browser.close()
    },
  }
}
