import { useEffect } from 'react'

/**
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

const GA_MEASUREMENT_ID = 'G-6VS1BEJ3TS'

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
