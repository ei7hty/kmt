import { useEffect } from 'react'

/**
 * This is not the standard Google snippet pasted into `<head>`, on purpose.
 * `index.html` is one static shell for every route -- `App.jsx`'s pathname
 * switch decides what renders -- so a tag in `<head>` would load on every
 * route including `/status`, and no GA `config` call undoes a script that
 * has already loaded and set its cookies by the time it runs. Loaded here
 * instead, keyed to the route, so it never starts on a page it should not
 * be on. `backend/site.mjs`'s CSP is the second, independent gate: it
 * widens to allow GA's two domains only on the routes below, and stays
 * `script-src 'self'` everywhere else, so a bug in this file's own gating
 * would still be caught at the network layer rather than reaching Google.
 *
 * GA4 on the marketing surface only (.forge/analytics.md). `/status` and
 * `/confirmation` carry a customer's own request behind an id that is the
 * only thing standing between a stranger and that record; GA sends the full
 * URL, query string included, with every page view, so loading it there
 * would hand Google a permanent, working key to a customer's data. `/owner`
 * is Ken's workspace. None of the three are excluded for an analytics
 * preference -- they are excluded because the URL itself is sensitive.
 *
 * In scope: `/` and `/privacy`, the same two pages public/sitemap.xml
 * already lists as the whole indexable surface -- a boundary drawn for a
 * different reason and correct for this one too. Kept separate from
 * App.jsx's own `CANONICAL_PATHS` even though the two sets are equal today:
 * one answers "what should a crawler index", the other "what may send a
 * customer's URL to a third party", and nothing requires the two questions
 * to keep the same answer forever.
 */
const ANALYTICS_PATHS = new Set(['/', '/privacy'])

/**
 * The one value here with no way to be verified from inside this codebase:
 * it must match a property that exists only in Ken's own GA4 account, and a
 * wrong-but-validly-shaped id fails exactly as silently as no id at all --
 * GA accepts the hits, nothing errors, and the data lands somewhere nobody
 * is watching. The shape check below only catches "absent" or "malformed",
 * which is still worth catching loudly rather than as an empty dashboard
 * three weeks from now. `.forge/deployed-site-check.mjs` imports this exact
 * constant and asserts it reaches the deployed bundle, which catches drift
 * between what this file says and what actually shipped -- not whether the
 * value itself is the one Ken's account expects, which nothing in this
 * repository can check.
 */
export const GA_MEASUREMENT_ID = 'G-M9PW70T8V3'

if (!/^G-[A-Z0-9]{6,}$/.test(GA_MEASUREMENT_ID)) {
  console.error(`analytics.js: GA_MEASUREMENT_ID ${JSON.stringify(GA_MEASUREMENT_ID)} is not shaped like a GA4 measurement id (expected "G-" then letters/digits) -- analytics will silently do nothing`)
}

/**
 * Loaded only when this is genuinely the canonical production site.
 *
 * Every browser audit drives the real UI, and `npm run dev` would too --
 * none of that traffic is a visit, it is this project's own robots. Gating
 * on the hostname rather than a build flag means localhost, previews and
 * any scratch server are excluded by construction, and nobody has to
 * remember to flip a flag back off before deploying.
 */
const ANALYTICS_HOSTNAME = 'kensmobiletire.com'

let scriptRequested = false

/** Inject GA4's loader once, the first time it is actually needed. */
function loadGaScript() {
  if (scriptRequested) return
  scriptRequested = true
  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() { window.dataLayer.push(arguments) }
  window.gtag('js', new Date())
  // The config call sends the first page view itself, for whichever of the
  // two marketing routes triggered this load -- no separate event needed.
  window.gtag('config', GA_MEASUREMENT_ID)
  const script = document.createElement('script')
  script.async = true
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`
  document.head.appendChild(script)
}

/**
 * Count a visit to the current route -- on the two pages this is allowed to
 * run on, on the one host it is allowed to run on. Every other route, and
 * every other host, is a silent no-op: no script tag requested, no request
 * to Google, nothing that later has to be proven not to have happened,
 * because it never started.
 */
export function useAnalytics(route) {
  useEffect(() => {
    if (window.location.hostname !== ANALYTICS_HOSTNAME) return
    if (!ANALYTICS_PATHS.has(route)) return
    if (scriptRequested) {
      // A second (or later) marketing page in the same visit: the loader
      // already sent the first page view via 'config', so this one is an
      // explicit event, the documented way GA4 hears about an SPA route
      // change that never reloads the page.
      window.gtag('event', 'page_view', { page_path: route, page_location: window.location.href })
    } else {
      loadGaScript()
    }
  }, [route])
}
