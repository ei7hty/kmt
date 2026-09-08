import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ANALYTICS_PATHS, applySecurityHeaders, assertCanonicalIsAllowed, canonicalRedirectTarget, CANONICAL_EXEMPT, isSecureRequest, parseRequestUrl, readRelease, securityHeaders } from './site.mjs'

test('the release is answered as a header when the image says which commit it is, and omitted otherwise', async t => {
  // A header, not the health body: /api/health stays exactly {"ok":true}.
  // A header, not a meta tag: it is on API answers and on the 301s, so each
  // step of a cutover or a rollback is confirmed by one curl -sI.
  assert.equal(readRelease({ KMT_RELEASE: 'b4009ecba8abc46200b5a16e8ed72a4588ad64b8' }), 'b4009ec', 'a full SHA is answered short')
  assert.equal(readRelease({ KMT_RELEASE: 'B4009EC' }), 'b4009ec')
  assert.equal(readRelease({}), '', 'unset is unset')
  assert.equal(readRelease({ KMT_RELEASE: '' }), '')
  for (const bad of ['unknown', 'latest', 'v1.2', '$GIT_SHA', 'abc']) {
    assert.equal(readRelease({ KMT_RELEASE: bad }), '', `${JSON.stringify(bad)} is not a release, and a placeholder must not become a value in someone's comparison`)
  }
  assert.equal(securityHeaders({ secure: false, release: 'b4009ec' })['X-KMT-Release'], 'b4009ec')
  assert.equal('X-KMT-Release' in securityHeaders({ secure: false }), false, 'omitted rather than a placeholder')

  const server = createServer((request, response) => {
    applySecurityHeaders(request, response, { release: request.url === '/none' ? '' : 'b4009ec' })
    if (request.url === '/redirect') { response.writeHead(301, { Location: 'https://kensmobiletire.com/' }); return response.end() }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  for (const path of ['/', '/redirect']) {
    const response = await fetch(base + path, { redirect: 'manual' })
    assert.equal(response.headers.get('x-kmt-release'), 'b4009ec', `${path} names the release`)
  }
  assert.equal((await fetch(base + '/none')).headers.get('x-kmt-release'), null)
})

test('the service-area check answers on or off as a header, and never its parameters', async t => {
  // Minimal by the same rule as X-KMT-Release: a boolean, never the radius,
  // base ZIP or review distance readServiceAreaConfig() also produces.
  assert.equal(securityHeaders({ secure: false, serviceAreaOn: true })['X-KMT-Service-Area'], 'on')
  assert.equal(securityHeaders({ secure: false, serviceAreaOn: false })['X-KMT-Service-Area'], 'off')
  assert.equal('X-KMT-Service-Area' in securityHeaders({ secure: false }), false, 'omitted rather than a placeholder when the caller has no answer')

  const server = createServer((request, response) => {
    if (request.url === '/none') { applySecurityHeaders(request, response); response.writeHead(200); return response.end() }
    applySecurityHeaders(request, response, { serviceAreaOn: request.url !== '/off' })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base + '/')).headers.get('x-kmt-service-area'), 'on')
  assert.equal((await fetch(base + '/off')).headers.get('x-kmt-service-area'), 'off')
  assert.equal((await fetch(base + '/none')).headers.get('x-kmt-service-area'), null)
})

test('GA4 widens the CSP only on / and /privacy, never on a page carrying a customer\'s own request', async t => {
  // The boundary itself, named so a route added to one and not the other is
  // a visible mismatch rather than a typo two files apart.
  assert.ok(ANALYTICS_PATHS.has('/'))
  assert.ok(ANALYTICS_PATHS.has('/privacy'))
  const strictPaths = [
    '', '/status', '/confirmation', '/inquiry',
    '/owner', '/owner/quotes', '/owner/outbox', '/owner/inquiries', '/owner/site-copy', '/owner/social-proof',
    '/api/catalog', '/api/health', '/api/inquiries', '/api/site-copy', '/api/requests/audit-id',
    '/api/owner/inventory', '/api/owner/requests', '/api/owner/outbox', '/api/owner/inquiries',
  ]
  for (const path of strictPaths) {
    assert.equal(ANALYTICS_PATHS.has(path), false, `${JSON.stringify(path)} must never get the relaxed policy`)
  }

  const strict = securityHeaders({ secure: false })['Content-Security-Policy']
  const home = securityHeaders({ secure: false, pathname: '/' })['Content-Security-Policy']
  const privacy = securityHeaders({ secure: false, pathname: '/privacy' })['Content-Security-Policy']
  const status = securityHeaders({ secure: false, pathname: '/status' })['Content-Security-Policy']

  for (const csp of [home, privacy]) {
    assert.match(csp, /script-src 'self' https:\/\/www\.googletagmanager\.com/, 'GA\'s loader is allowed to run')
    assert.match(csp, /connect-src 'self' https:\/\/\*\.google-analytics\.com https:\/\/\*\.analytics\.google\.com https:\/\/www\.googletagmanager\.com/, 'only GA4 collection endpoints are allowed to phone home')
    assert.match(csp, /img-src 'self' data: https:\/\/\*\.google-analytics\.com https:\/\/www\.googletagmanager\.com/, 'GA4 pixel fallbacks are allowed on the marketing surface')
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|doubleclick|googleadservices|googlesyndication|https:\/\/google\.com|frame-src/, 'GA4 does not widen executable, advertising, generic Google, or frame sources')
  }
  // No pathname (every caller before this feature, and every path outside
  // the set) is the exact same string as before this feature existed.
  assert.equal(status, strict, '/status keeps the untouched policy string, not a version with GA carved back out')
  assert.doesNotMatch(strict, /googletagmanager|google-analytics|analytics\.google/)

  const server = createServer((request, response) => {
    const { url } = parseRequestUrl(request.url)
    applySecurityHeaders(request, response, { pathname: url.pathname })
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<p>hi</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  for (const path of ['/', '/privacy']) {
    const csp = (await fetch(base + path)).headers.get('content-security-policy')
    assert.match(csp, /script-src[^;]*www\.googletagmanager\.com/, `${path} carries the GA4 loader policy over the wire`)
    assert.match(csp, /connect-src[^;]*\*\.google-analytics\.com[^;]*\*\.analytics\.google\.com[^;]*www\.googletagmanager\.com/, `${path} carries every required GA4 connection source over the wire`)
    assert.match(csp, /img-src[^;]*\*\.google-analytics\.com[^;]*www\.googletagmanager\.com/, `${path} carries the GA4 pixel sources over the wire`)
  }
  for (const path of strictPaths.filter(Boolean)) {
    const csp = (await fetch(base + path)).headers.get('content-security-policy')
    assert.equal(csp, strict, `${path} must answer the exact strict policy over the wire, not a relaxed policy with GA carved back out`)
  }
})

test('a canonical name the allow-list refuses is a refusal to boot, not a healthy-looking outage', () => {
  // The canonical name would answer 403 while every other name 301s to it,
  // and /api/health, exempt from both, would keep the checker green.
  assert.throws(
    () => assertCanonicalIsAllowed({ canonicalHost: 'kensmobiletire.com', allowedHosts: ['kmt.fly.dev', 'www.kensmobiletire.com'] }),
    /KMT_CANONICAL_HOST is kensmobiletire\.com but KMT_ALLOWED_HOSTS \(kmt\.fly\.dev, www\.kensmobiletire\.com\) does not include it/,
  )
  // The states the cutover passes through are all legal.
  assert.doesNotThrow(() => assertCanonicalIsAllowed({ canonicalHost: '', allowedHosts: [] }), 'nothing set')
  assert.doesNotThrow(() => assertCanonicalIsAllowed({ canonicalHost: '', allowedHosts: ['kmt.fly.dev'] }), 'allow-list only, step 1')
  assert.doesNotThrow(() => assertCanonicalIsAllowed({ canonicalHost: 'kensmobiletire.com', allowedHosts: [] }), 'canonical only: every name serves, the t46-before-t52 state')
  assert.doesNotThrow(() => assertCanonicalIsAllowed({ canonicalHost: 'kensmobiletire.com', allowedHosts: ['kmt.fly.dev', 'kensmobiletire.com'] }), 'both, agreeing: step 2')
  assert.doesNotThrow(() => assertCanonicalIsAllowed({ canonicalHost: 'KensMobileTire.com', allowedHosts: ['kensmobiletire.com'] }), 'names are case-insensitive')
})

test('a double slash is a path, not a server fault', () => {
  // GET // answered 500 on production: new URL('//', base) reads it as a
  // protocol-relative URL and throws (#132).
  assert.equal(parseRequestUrl('//').url.pathname, '/')
  assert.equal(parseRequestUrl('//owner').url.pathname, '/owner')
  assert.equal(parseRequestUrl('///api/health').url.pathname, '/api/health')
  assert.equal(parseRequestUrl('/status?request=abc').url.search, '?request=abc')
  // A doubled slash inside the path is the same link with a slip in it, not a
  // path of its own: /api//catalog used to miss every handler and answer with
  // the owner sign-in message.
  assert.equal(parseRequestUrl('/api//catalog').url.pathname, '/api/catalog')
  assert.equal(parseRequestUrl('/api/requests//abc').url.pathname, '/api/requests/abc')
  assert.equal(parseRequestUrl('/status//?request=a//b').url.search, '?request=a//b', 'the query is not a path and is left alone')
  for (const raw of ['//', '//owner', '/']) assert.equal(parseRequestUrl(raw).malformed, false)
  // Something the parser still cannot read is not found, not a fault.
  const broken = parseRequestUrl('/%')
  assert.equal(broken.malformed, false, 'a stray percent is a legal path to the parser')
  const empty = parseRequestUrl('')
  assert.equal(empty.url.pathname, '/')
  assert.equal(empty.malformed, false)
})

test('the canonical redirect sends every other name to the one name, except the health check', () => {
  const canonicalHost = 'kensmobiletire.com'
  const to = (hostname, pathname, search = '') => canonicalRedirectTarget({ hostname, pathname, search, canonicalHost })

  assert.equal(to('kmt.fly.dev', '/'), 'https://kensmobiletire.com/')
  assert.equal(to('www.kensmobiletire.com', '/status', '?request=abc'), 'https://kensmobiletire.com/status?request=abc', 'path and query travel')
  assert.equal(to('order.kensmobiletire.com', '/owner/quotes'), 'https://kensmobiletire.com/owner/quotes')
  assert.equal(to('kensmobiletire.com', '/'), null, 'the canonical name serves')
  assert.equal(to('KensMobileTire.com', '/'), null, 'names are case-insensitive')

  // Fly reads /api/health on the internal network under a name that is never
  // the public one; a 301 there would have the checker report on a redirect.
  assert.equal(to('kmt.fly.dev', '/api/health'), null)
  assert.ok(CANONICAL_EXEMPT.has('/api/health'))

  // Unset means every allowed name serves: the switch is the setting itself.
  assert.equal(canonicalRedirectTarget({ hostname: 'kmt.fly.dev', pathname: '/', canonicalHost: '' }), null)
  assert.equal(canonicalRedirectTarget({ hostname: 'kmt.fly.dev', pathname: '/', canonicalHost: undefined }), null)
})

test('the security headers are present, and HSTS only over TLS', () => {
  const plain = securityHeaders({ secure: false })
  const secure = securityHeaders({ secure: true })
  for (const name of ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy']) {
    assert.ok(plain[name], `${name} on a plain response`)
    assert.equal(secure[name], plain[name], `${name} is the same over TLS`)
  }
  assert.equal(plain['Strict-Transport-Security'], undefined, 'no HSTS over plain http: a local run must not teach a browser to insist on TLS')
  assert.equal(secure['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains')

  const csp = plain['Content-Security-Policy']
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /object-src 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, 'the built page has no inline script or style, so the policy allows none')
  assert.equal(plain['X-Content-Type-Options'], 'nosniff')
  assert.equal(plain['X-Frame-Options'], 'DENY')
})

test('secure is read from the edge header or the socket', () => {
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }), true)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' }, socket: {} }), true, 'the first hop decides')
  assert.equal(isSecureRequest({ headers: {}, socket: { encrypted: true } }), true)
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' }, socket: {} }), false)
  assert.equal(isSecureRequest({ headers: {}, socket: {} }), false)
})

test('applied before a handler writes, the headers survive writeHead and reach every kind of response', async t => {
  const server = createServer((request, response) => {
    applySecurityHeaders(request, response)
    if (request.url === '/json') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      return response.end('{}')
    }
    if (request.url === '/redirect') {
      response.writeHead(301, { Location: 'https://kensmobiletire.com/' })
      return response.end()
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<p>hi</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  for (const path of ['/', '/json', '/redirect']) {
    const response = await fetch(base + path, { redirect: 'manual' })
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${path} carries the headers`)
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
    assert.equal(response.headers.get('strict-transport-security'), null, 'plain http, no HSTS')
  }
  const forwarded = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(forwarded.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains', 'behind a TLS edge, HSTS')
})
