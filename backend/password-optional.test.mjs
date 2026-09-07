import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuth, equals, memorySessionStore, readAuthConfig } from './auth.mjs'

/**
 * Booting without KMT_OWNER_PASSWORD, once Google is the way in.
 *
 * **Why this step exists at all, stated because it is easy to under-rate.**
 * `readAuthConfig` used to throw on a missing password, and `server.mjs` calls
 * it at startup. So unsetting that secret today does not lock the owner out of
 * `/owner` -- it stops the server booting, and takes the customer wizard,
 * `/status` and the quote flow down with it. A total outage produced by doing
 * the safe-looking half of the cutover first. This is the change that turns
 * unsetting the secret into a no-op, and it has to be deployed BEFORE the
 * secret is unset rather than with it.
 *
 * It does not remove the password and does not unset anything.
 */

const GOOGLE = {
  KMT_GOOGLE_CLIENT_ID: '1234567890-abcdefghijklmnop.apps.googleusercontent.com',
  KMT_GOOGLE_CLIENT_SECRET: 'not-a-real-secret',
}
const PASSWORD = { KMT_OWNER_PASSWORD: 'a-long-enough-password' }

const recorder = () => {
  const sent = { status: 0, headers: {}, body: '' }
  return { sent, writeHead(s, h) { sent.status = s; sent.headers = h || {} }, end(b = '') { sent.body = b } }
}
const post = (pathname) => ({
  request: { method: 'POST', headers: {}, socket: { encrypted: true } },
  url: new URL(`https://kensmobiletire.com${pathname}`),
})

// --- The hazard, asserted first, because everything else guards it ----------

test('equals("", "") is TRUE -- the premise this whole file exists to accommodate', () => {
  // THIS TEST DOES NOT TEST OUR CODE. It pins the assumption our code's shape
  // exists to work around, and it is here so that assumption cannot stop being
  // true silently. Do not delete it as a trivial assertion about a library
  // function -- that is exactly what it looks like, and removing it is the
  // failure it prevents.
  //
  // A constant-time compare of two empty buffers succeeds. So a server whose
  // configured password is '' would accept a request carrying no password and
  // issue a valid owner session. That is what the naive version of this change
  // ("just let the password be empty") does.
  //
  // If a future Node hardens timingSafeEqual to reject empty buffers, the guard
  // below becomes dead weight and every other test in this file still passes --
  // so the next reader deletes the guard as redundant, and it stops being
  // redundant the day someone changes the runtime back. This assertion is the
  // one thing that would go red and say why.
  assert.equal(equals('', ''), true)
  // And the near-misses, so the property is pinned at its edges rather than at
  // one point: only the empty/empty pair is vacuously equal.
  assert.equal(equals('', undefined), false, "String(undefined) is nine characters, not zero")
  assert.equal(equals('', 'x'), false)
})

test('with no password configured, an empty password does NOT sign anyone in', () => {
  // The test that would have caught the naive implementation. It posts exactly
  // what the hazard above describes.
  const auth = createAuth(readAuthConfig({ ...GOOGLE }), { sessions: memorySessionStore(), google: null })
  const out = recorder()
  const { request, url } = post('/api/owner/login')
  return auth.handle(request, out, url, async () => ({ password: '' })).then(() => {
    assert.equal(out.sent.status, 404, 'the password route does not exist on this server')
    assert.ok(!String(out.sent.headers['Set-Cookie'] || ''), 'and above all, no session cookie is issued')
  })
})

test('nor does any other password, when none is configured', async () => {
  const auth = createAuth(readAuthConfig({ ...GOOGLE }), { sessions: memorySessionStore(), google: null })
  for (const guess of ['a-long-enough-password', 'x', null, undefined, 'undefined']) {
    const out = recorder()
    const { request, url } = post('/api/owner/login')
    await auth.handle(request, out, url, async () => ({ password: guess }))
    assert.equal(out.sent.status, 404, `guess ${JSON.stringify(guess)} must not be accepted`)
    assert.ok(!String(out.sent.headers['Set-Cookie'] || ''), 'no cookie for any guess')
  }
})

test('a login request with NO password field at all is refused', async () => {
  // The PROJECT MANAGER's refinement, and it widens the hole rather than
  // narrowing it. The call site reads `input?.password ?? ''`, so a request
  // with no `password` key -- `{}`, or no body at all -- is coerced to '' before
  // the compare. Under a Google-only configuration that means the hole never
  // required anyone to deliberately probe with {"password": ""}:
  //
  //     a bare POST /api/owner/login, no body, is issued a valid owner session.
  //
  // Which is the first thing an unauthenticated scanner sends, before it thinks
  // to send anything. My earlier tests all passed `{ password: <something> }`,
  // so the key always existed and this shape rested on the same guard without
  // pinning it. Reading `equals` alone understates the blast radius; the
  // coercion at the call site is where it actually lives.
  const auth = createAuth(readAuthConfig({ ...GOOGLE }), { sessions: memorySessionStore(), google: null })
  for (const body of [{}, null, undefined, { other: 'field' }]) {
    const out = recorder()
    const { request, url } = post('/api/owner/login')
    await auth.handle(request, out, url, async () => body)
    assert.equal(out.sent.status, 404, `body ${JSON.stringify(body ?? null)} must not be accepted`)
    assert.ok(!String(out.sent.headers['Set-Cookie'] || ''), 'and no session cookie is issued')
  }
})

// --- Booting: the guard moves, it does not disappear -----------------------

test('no password but Google configured: boots, with password sign-in off', () => {
  const config = readAuthConfig({ ...GOOGLE })
  assert.equal(config.password, '', 'no password configured, and nothing invented in its place')
})

test('neither a password nor Google: refuses to boot, naming both variables', () => {
  // The inversion. Before this change, "no password" was the refuse-to-boot
  // condition. After it, the condition is "no way in at all" -- which is the
  // same property once Google is a way in, and is not a weakening.
  assert.throws(() => readAuthConfig({}), /KMT_GOOGLE_CLIENT_ID/)
  assert.throws(() => readAuthConfig({}), /KMT_OWNER_PASSWORD/)
})

test('a password alone still boots, exactly as before', () => {
  // Every environment today. This change must be invisible to all of them.
  const config = readAuthConfig({ ...PASSWORD })
  assert.equal(config.password, 'a-long-enough-password')
})

test('both configured: both work', () => {
  const config = readAuthConfig({ ...PASSWORD, ...GOOGLE })
  assert.equal(config.password, 'a-long-enough-password', 'Google being configured does not disable the password')
})

test('a short password is still refused, and is not quietly treated as absent', () => {
  // The dangerous near-miss: if a too-short password were tolerated as "no
  // password" now that absence is allowed, a typo in the secret would silently
  // switch password sign-in off rather than failing loudly.
  assert.throws(() => readAuthConfig({ KMT_OWNER_PASSWORD: 'short', ...GOOGLE }), /at least 12 characters/)
  assert.throws(() => readAuthConfig({ KMT_OWNER_PASSWORD: 'short' }), /at least 12 characters/)
})

// --- The password path, unchanged where it is configured -------------------

test('with a password configured, it still signs the owner in', async () => {
  const sessions = memorySessionStore()
  const config = readAuthConfig({ ...PASSWORD, KMT_SESSION_SECRET: 'test-secret' })
  const auth = createAuth(config, { sessions, google: null })
  const out = recorder()
  const { request, url } = post('/api/owner/login')
  await auth.handle(request, out, url, async () => ({ password: 'a-long-enough-password' }))
  assert.equal(out.sent.status, 200)
  assert.match(String(out.sent.headers['Set-Cookie']), /^kmt_owner=/)
})

test('and a wrong one is still refused with 401, not 404', async () => {
  // The two refusals mean different things and must stay distinguishable:
  // 401 is "that was wrong", 404 is "this way in does not exist here".
  const config = readAuthConfig({ ...PASSWORD, KMT_SESSION_SECRET: 'test-secret' })
  const auth = createAuth(config, { sessions: memorySessionStore(), google: null })
  const out = recorder()
  const { request, url } = post('/api/owner/login')
  await auth.handle(request, out, url, async () => ({ password: 'wrong-but-long-enough' }))
  assert.equal(out.sent.status, 401)
})

test('the session endpoint reports which ways in this server has', async () => {
  const config = readAuthConfig({ ...GOOGLE })
  const auth = createAuth(config, { sessions: memorySessionStore(), google: null })
  const out = recorder()
  const request = { method: 'GET', headers: {}, socket: { encrypted: true } }
  await auth.handle(request, out, new URL('https://kensmobiletire.com/api/owner/session'), async () => ({}))
  const body = JSON.parse(out.sent.body)
  // So the sign-in screen can stop offering a password field that cannot work.
  // The UI consumes this in a follow-up; the flag ships first so the screen is
  // never the thing holding up unsetting the secret.
  assert.equal(body.password, false)
  assert.equal(body.authenticated, false)
})
