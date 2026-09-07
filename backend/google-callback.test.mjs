import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, memorySessionStore } from './auth.mjs'
import { OWNER_DOMAIN } from './google-auth.mjs'

/**
 * The callback route around the verifier: `state`, the code exchange, and
 * whether a session is actually created.
 *
 * Separate from google-auth.test.mjs because that file tests a pure function
 * and this one drives `auth.handle`, and separate from owner.test.mjs because
 * that file is held by #374 -- two lanes in one test file is how a rebase
 * becomes a merge conflict over nothing.
 *
 * No browser and no network: Google is a stub. Driving a real sign-in could
 * not tell us whether this code refused someone or whether Google's Internal
 * consent screen refused them first.
 */

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com'
const google = { clientId: CLIENT_ID, clientSecret: 'not-a-real-secret', redirectUri: `https://${OWNER_DOMAIN}/api/owner/session/google/callback` }
const config = { password: 'a-long-enough-password', secret: 'test-secret', ttlMs: 3600_000 }

/** Enough of a ServerResponse to see what the handler decided. */
const recorder = () => {
  const sent = { status: 0, headers: {}, body: '' }
  return {
    sent,
    writeHead(status, headers) { sent.status = status; sent.headers = headers || {} },
    end(body = '') { sent.body = body },
  }
}

const get = (pathname, { search = '', cookie = '' } = {}) => ({
  request: { method: 'GET', headers: { cookie }, socket: { encrypted: true } },
  url: new URL(`https://${OWNER_DOMAIN}${pathname}${search}`),
})

/** A Google that hands back whatever claims the test names. */
const stubGoogle = (claims, { exchangeFails = false } = {}) => async (target) => {
  const href = typeof target === 'string' ? target : target.toString()
  // `/tokeninfo` is matched first and deliberately: it contains `/token`, so
  // the looser test order silently answered the claims request with the
  // exchange's response and turned a valid sign-in into a refusal. Caught
  // because the happy-path test exists; every refusal test stayed green.
  if (href.includes('/tokeninfo')) return { ok: true, status: 200, json: async () => claims }
  if (href.includes('/token')) {
    return exchangeFails
      ? { ok: false, status: 400, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ id_token: 'a.constructed.token' }) }
  }
  throw new Error(`the stub was asked for an unexpected URL: ${href}`)
}

const validClaims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  email: 'ken@kensmobiletire.com',
  email_verified: 'true',
  hd: OWNER_DOMAIN,
  ...over,
})

/** Drive one sign-in from /start to /callback, in one browser. */
const signIn = async (claims, { tamperState = null, options = {} } = {}) => {
  const sessions = memorySessionStore()
  const auth = createAuth(config, { sessions, google, googleFetch: stubGoogle(claims), ...options })

  const start = recorder()
  const first = get('/api/owner/session/google/start')
  await auth.handle(first.request, start, first.url, async () => ({}))

  const setCookie = start.sent.headers['Set-Cookie'] || ''
  const stateCookie = String(setCookie).split(';')[0]
  const nonce = new URL(start.sent.headers.Location).searchParams.get('state')

  const back = recorder()
  const second = get('/api/owner/session/google/callback', {
    search: `?code=an-auth-code&state=${encodeURIComponent(tamperState ?? nonce)}`,
    cookie: stateCookie,
  })
  await auth.handle(second.request, back, second.url, async () => ({}))
  return { start, back, sessions, nonce }
}

test('start sends the owner to Google with a state that matches its cookie', async () => {
  const auth = createAuth(config, { google, googleFetch: stubGoogle(validClaims()) })
  const out = recorder()
  const { request, url } = get('/api/owner/session/google/start')
  assert.equal(await auth.handle(request, out, url, async () => ({})), true)

  assert.equal(out.sent.status, 302)
  const target = new URL(out.sent.headers.Location)
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(target.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(target.searchParams.get('response_type'), 'code')
  assert.equal(target.searchParams.get('redirect_uri'), google.redirectUri)
  assert.ok(target.searchParams.get('state'), 'a state is always issued')

  const cookie = String(out.sent.headers['Set-Cookie'])
  assert.match(cookie, /^kmt_signin_state=/)
  assert.match(cookie, /HttpOnly/)
  // Lax, not Strict: the callback is a top-level cross-site GET navigation,
  // which is exactly what Strict withholds the cookie on. Strict here would
  // fail every sign-in while looking like a Google problem.
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Secure/)
})

test('an unconfigured server offers no Google route at all', async () => {
  const auth = createAuth(config, { google: null })
  for (const path of ['/api/owner/session/google/start', '/api/owner/session/google/callback']) {
    const out = recorder()
    const { request, url } = get(path)
    assert.equal(await auth.handle(request, out, url, async () => ({})), true)
    assert.equal(out.sent.status, 404, `${path} must not exist without an OAuth client`)
  }
})

test('the session endpoint says whether Google is available, without changing what authenticated means', async () => {
  for (const [client, expected] of [[google, true], [null, false]]) {
    const auth = createAuth(config, { google: client })
    const out = recorder()
    const { request, url } = get('/api/owner/session')
    await auth.handle(request, out, url, async () => ({}))
    const body = JSON.parse(out.sent.body)
    assert.equal(body.google, expected)
    assert.equal(body.authenticated, false, 'authenticated keeps its meaning')
  }
})

test('a verified owner on the domain is signed in and sent to the workspace', async () => {
  const { back, sessions } = await signIn(validClaims())
  assert.equal(back.sent.status, 302)
  assert.equal(back.sent.headers.Location, '/owner')

  const cookies = back.sent.headers['Set-Cookie']
  assert.ok(Array.isArray(cookies), 'the session is set and the state cookie cleared, together')
  assert.match(cookies[0], /^kmt_owner=/)
  assert.match(cookies[0], /SameSite=Lax/)
  assert.match(cookies[1], /^kmt_signin_state=; .*Max-Age=0/, 'the state cookie does not outlive the flow')

  const token = cookies[0].split(';')[0].slice('kmt_owner='.length)
  assert.equal(sessions.size ?? undefined, undefined) // memory store exposes no size; check by use
  assert.equal(createAuth(config, { sessions, google }).isAuthenticated({ headers: { cookie: `kmt_owner=${token}` } }), true,
    'the cookie it set is one the server will actually accept')
})

// --- Refusals. Each asserts that NO session was created, not merely that the
//     browser was redirected: a redirect with a live session would be the
//     worst possible pass.

const refused = async (label, run) => {
  const { back, sessions } = await run()
  assert.equal(back.sent.status, 302, `${label}: redirected`)
  assert.equal(back.sent.headers.Location, '/owner?signin=refused', `${label}: sent back to sign in`)
  const cookies = [back.sent.headers['Set-Cookie']].flat().filter(Boolean).join(' ')
  assert.ok(!/kmt_owner=[^;\s]/.test(cookies), `${label}: no session cookie was issued`)
  return sessions
}

test('a callback whose state does not match the cookie is refused', async () => {
  await refused('tampered state', () => signIn(validClaims(), { tamperState: 'a-state-we-never-issued' }))
})

test('a callback arriving with no state cookie at all is refused', async () => {
  // The replay shape: someone re-sends a callback URL in a browser that never
  // began a sign-in. Absent is a rejection, never a skip.
  const auth = createAuth(config, { google, googleFetch: stubGoogle(validClaims()) })
  const out = recorder()
  const { request, url } = get('/api/owner/session/google/callback', { search: '?code=c&state=s' })
  await auth.handle(request, out, url, async () => ({}))
  assert.equal(out.sent.headers.Location, '/owner?signin=refused')
})

test('a consumer Google account is refused by the callback, with no session', async () => {
  const consumer = validClaims({ email: 'someone@gmail.com' })
  delete consumer.hd
  await refused('no hd', () => signIn(consumer))
})

test('a token minted for another application is refused', async () => {
  await refused('wrong aud', () => signIn(validClaims({ aud: 'someone-else.apps.googleusercontent.com' })))
})

test('an unverified address is refused', async () => {
  await refused('email_verified false', () => signIn(validClaims({ email_verified: 'false' })))
})

test('Google refusing the code exchange is refused, not crashed', async () => {
  await refused('exchange failed', () => signIn(validClaims(), {
    options: { googleFetch: stubGoogle(validClaims(), { exchangeFails: true }) },
  }))
})

test('Google reporting its own error on the callback is refused', async () => {
  const auth = createAuth(config, { google, googleFetch: stubGoogle(validClaims()) })
  const start = recorder()
  const first = get('/api/owner/session/google/start')
  await auth.handle(first.request, start, first.url, async () => ({}))
  const stateCookie = String(start.sent.headers['Set-Cookie']).split(';')[0]
  const nonce = new URL(start.sent.headers.Location).searchParams.get('state')

  const out = recorder()
  const { request, url } = get('/api/owner/session/google/callback', {
    search: `?error=access_denied&state=${nonce}`, cookie: stateCookie,
  })
  await auth.handle(request, out, url, async () => ({}))
  assert.equal(out.sent.headers.Location, '/owner?signin=refused')
})

test('the password path still works while Google is configured', async () => {
  // Change one lands both. A Google client existing must not disturb the path
  // the owner is using today, and must not disturb the gate's audits, which
  // still sign in with a password.
  const sessions = memorySessionStore()
  const auth = createAuth(config, { sessions, google, googleFetch: stubGoogle(validClaims()) })
  const out = recorder()
  const url = new URL(`https://${OWNER_DOMAIN}/api/owner/login`)
  const request = { method: 'POST', headers: {}, socket: { encrypted: true } }
  await auth.handle(request, out, url, async () => ({ password: config.password }))
  assert.equal(out.sent.status, 200)
  assert.match(String(out.sent.headers['Set-Cookie']), /^kmt_owner=/)
})
