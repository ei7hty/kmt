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
 */
export function securityHeaders({ secure, release = '' }) {
  const headers = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
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
export function applySecurityHeaders(request, response, { release = '' } = {}) {
  for (const [name, value] of Object.entries(securityHeaders({ secure: isSecureRequest(request), release }))) {
    response.setHeader(name, value)
  }
}
