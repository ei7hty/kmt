/**
 * How the server presents itself to the internet: which name it answers on,
 * what it tells the browser about itself, and what it does with a URL that
 * does not parse.
 *
 * These are server.mjs's rules, kept here because server.mjs starts listening
 * the moment it is imported and nothing in the suite can reach a branch
 * written inline there. Each function is pure and takes what it needs.
 *
 *   KMT_CANONICAL_HOST   when set, every request on another name is answered
 *                        with a 301 to this one, same path and query, except
 *                        /api/health. Unset means every allowed name serves.
 */

/** Paths answered on any host, never redirected: the platform's health check. */
export const CANONICAL_EXEMPT = new Set(['/api/health'])

/**
 * The request URL, parsed, with a malformed path treated as a path.
 *
 * `new URL('//', base)` reads `//` as a protocol-relative URL, threw, and
 * landed in the catch-all as a 500 to a customer who typed one slash too many
 * (#132). Repeated slashes are collapsed first, wherever they are: `//owner`
 * is `/owner`, and `/api//catalog` is `/api/catalog` rather than a path no
 * handler knows, which used to fall through to the owner sign-in message. A
 * path that still does not parse is answered as not found rather than as a
 * server fault, because it is the link that is wrong, not the server.
 */
export function parseRequestUrl(raw) {
  const [pathPart, ...rest] = String(raw || '/').split('?')
  const collapsed = pathPart.replace(/\/{2,}/g, '/') + (rest.length ? '?' + rest.join('?') : '')
  try {
    return { url: new URL(collapsed, 'http://localhost'), malformed: false }
  } catch {
    return { url: new URL('/', 'http://localhost'), malformed: true }
  }
}

/** Whether the request arrived over TLS, at the edge or on this socket. */
export function isSecureRequest(request) {
  return (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(request.socket?.encrypted)
}

/**
 * Where a request on the wrong name should go, or null to serve it here.
 *
 * One switch moves everyone to the new domain and nothing else: set
 * KMT_CANONICAL_HOST and every other name the server accepts answers 301 to
 * it with the same path and query. The health check is exempt for the reason
 * it is exempt from the Host guard: the platform reads it on the internal
 * network under a name that is never the public one, and a 301 there would
 * make the checker report on a redirect rather than the app. Always https:
 * the only reason to have a canonical name is that it carries the certificate.
 */
export function canonicalRedirectTarget({ hostname, pathname, search = '', canonicalHost }) {
  if (!canonicalHost) return null
  if (CANONICAL_EXEMPT.has(pathname)) return null
  if ((hostname || '').toLowerCase() === canonicalHost.toLowerCase()) return null
  return `https://${canonicalHost}${pathname}${search}`
}

/**
 * Refuse to start when the canonical name is not one the server will serve.
 *
 * Set KMT_CANONICAL_HOST to a name KMT_ALLOWED_HOSTS does not contain and
 * the canonical name answers 403 while every other name 301s to it: a total
 * outage that reports itself healthy, because /api/health is exempt from
 * both guards and the checker keeps passing. The cutover sets both by
 * secret, in sequence, and a secret change restarts the machine outside a
 * deploy, so nothing downstream would notice either. The same posture
 * readAuthConfig takes for a bad password: a wrong secret is a visible
 * crash loop in the platform's status rather than a healthy-looking 403.
 * An empty allow-list stays legal; that is the state between t46 and the
 * cutover, and it serves every name.
 */
export function assertCanonicalIsAllowed({ canonicalHost, allowedHosts }) {
  if (!canonicalHost || !allowedHosts.length) return
  if (allowedHosts.some(host => host.toLowerCase() === canonicalHost.toLowerCase())) return
  throw new Error(
    `KMT_CANONICAL_HOST is ${canonicalHost} but KMT_ALLOWED_HOSTS (${allowedHosts.join(', ')}) does not include it. ` +
    'Every other name would redirect to a name this server refuses, and the health check would still pass. ' +
    'Add it to KMT_ALLOWED_HOSTS, or unset KMT_CANONICAL_HOST.',
  )
}

/**
 * The two routes GA4 is allowed to touch (.forge/analytics.md): the whole
 * marketing surface, and nothing that carries a customer's own request. It
 * is the boundary public/sitemap.xml already drew for a different reason --
 * these are the only two pages meant for a search index too. `/status`,
 * `/confirmation` and `/owner` stay off this list because their URL itself
 * is the credential: GA sends the full URL, query string included, with
 * every page view, so a tag there would hand Google a working key to a
 * customer's own record. index.html is one static shell for every route, so
 * this has to be decided per-request, from the path, not baked into the
 * page.
 *
 * Deliberately duplicated in `src/analytics.js`, not imported from there:
 * that one decides whether to load GA at all, this one decides whether the
 * CSP would let it through if that one failed. They are two independent
 * gates only as long as they are two separately written constants -- an
 * "obvious" cleanup that imports one from the other collapses them into one
 * gate that still produces the right outcome, which is exactly the shape
 * of failure that stays invisible to a test watching only the outcome.
 * `.forge/dead-end-audit.mjs`'s route-gate check also watches for a CSP
 * violation on its own, precisely because that collapse would otherwise
 * pass silently.
 */
export const ANALYTICS_PATHS = new Set(['/', '/privacy'])

/**
 * The browser-facing security headers, on every response (#67).
 *
 * The policy is written against what the built page actually does: one
 * module script and one stylesheet from this origin, images from this origin
 * (SVG icons included) and data: URLs, fetches to this origin only, no
 * frames, no plugins, no inline anything. The customer bundle has no inline
 * style or script, so nothing needs 'unsafe-inline'; if a change ever does,
 * the audits go red on the missing style rather than the policy quietly
 * widening. One known edge: the owner's import bookmarklet is a javascript:
 * link meant to be dragged to the bookmark bar and run on the supplier's
 * page, where this policy does not apply; clicking it on /owner instead is
 * refused by script-src, which is fine, since clicking it there never did
 * anything useful.
 *
 * HSTS only when the request is secure: sending it over plain http is
 * meaningless, and a local run should not teach a browser to insist on TLS
 * for localhost.
 *
 * The one exception is GA4, and only on `ANALYTICS_PATHS`: `script-src`
 * gains the tag loader, while `connect-src` and `img-src` gain only GA4's
 * collection hosts. `*.google-analytics.com` deliberately does not grant
 * `google-analytics.com` itself under CSP wildcard semantics; GA4 collects
 * through subdomains such as `www`. Widening the policy is a real security cost --
 * a compromise at Google's CDN could then run script on that page -- so it
 * is paid on the two pages that need it and never on the ones holding a
 * customer's own data.
 */
export function securityHeaders({ secure, release = '', serviceAreaOn, pathname = '' }) {
  const analytics = ANALYTICS_PATHS.has(pathname)
  const headers = {
    'Content-Security-Policy': [
      "default-src 'self'",
      analytics ? "script-src 'self' https://www.googletagmanager.com" : "script-src 'self'",
      "style-src 'self'",
      analytics ? "img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com" : "img-src 'self' data:",
      "font-src 'self'",
      analytics
        ? "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com"
        : "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  // Which commit is answering, on every response including the 301s and the
  // API, so each step of a cutover or a rollback is confirmed by one curl -sI.
  // A header rather than the health body keeps /api/health at exactly
  // {"ok":true}, which is what makes its Host exemption safe. Unset, the
  // header is omitted: a missing header is honest, and a placeholder is a
  // value that ends up in someone's comparison.
  if (release) headers['X-KMT-Release'] = release
  // On or off, never the radius, the base ZIP or the review distance -- the
  // same minimalism /api/health already holds ("not the place for a
  // version, a row count, or a path on disk") applied to a different
  // setting. `serviceAreaOn` is a boolean the caller derives once from the
  // same config object readServiceAreaConfig() already produced for the
  // boot line and for Quotes, not a value this function reads or composes
  // itself -- there is no second source of truth to drift from the first.
  // Omitted rather than false when the caller has no answer (a test that
  // does not pass it), the same way a missing release is omitted rather
  // than a placeholder.
  if (typeof serviceAreaOn === 'boolean') headers['X-KMT-Service-Area'] = serviceAreaOn ? 'on' : 'off'
  return headers
}

/**
 * The release the image was built from, as KMT_RELEASE says it: the short
 * SHA, seven characters, baked in by the Dockerfile from the workflow's
 * commit. Anything that is not a short hex SHA is treated as unset rather
 * than emitted, so a stray value cannot masquerade as a release.
 */
export function readRelease(env = process.env) {
  const value = (env.KMT_RELEASE || '').trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(value) ? value.slice(0, 7) : ''
}

/** Put the headers on a response before anything writes it; writeHead keeps them. */
export function applySecurityHeaders(request, response, { release = '', serviceAreaOn, pathname = '' } = {}) {
  for (const [name, value] of Object.entries(securityHeaders({ secure: isSecureRequest(request), release, serviceAreaOn, pathname }))) {
    response.setHeader(name, value)
  }
}
