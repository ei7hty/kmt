import test from 'node:test'
import assert from 'node:assert/strict'
import { GOOGLE_ISSUERS, OWNER_DOMAIN, actorFromEmail, readGoogleConfig, verifyGoogleClaims } from './google-auth.mjs'

/**
 * These tests feed constructed claims straight to the verifier. No browser, no
 * Google, no consent screen -- and that is a requirement, not a convenience.
 *
 * Google's Internal consent screen and this file's `hd` check are two
 * independent domain restrictions. That is what we want in production and
 * exactly what makes each one unverifiable from outside: a test that drives a
 * real sign-in and asserts a Gmail user cannot reach /owner passes whether or
 * not our check works, because Google refused them before our code ran. The
 * check could be deleted and that test would stay green.
 *
 * SEO ANALYST found the same shape in a different subsystem: a gate check
 * asserting GA does not load on /status passed with the frontend route gate
 * deliberately broken, because site.mjs's CSP blocked the request first. A
 * network assertion aimed at control A, satisfied by control B doing A's job.
 *
 * So every test below observes this layer's own behaviour.
 */

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com'
const config = { clientId: CLIENT_ID, clientSecret: 'not-a-real-secret', redirectUri: 'https://kensmobiletire.com/api/owner/session/google/callback' }

/** A token that should pass, so each test below can remove exactly one thing. */
const valid = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  email: 'ken@kensmobiletire.com',
  email_verified: 'true',
  hd: OWNER_DOMAIN,
  ...over,
})

/** Drop a key entirely, rather than setting it undefined. */
const without = (claim) => {
  const claims = valid()
  delete claims[claim]
  return claims
}

test('the fixture this file is built on is actually accepted', () => {
  // Every absent-claim test below asserts a rejection. If the fixture stopped
  // being valid for an unrelated reason, all of them would still pass while
  // testing nothing -- the same defect as a suite that has only ever seen
  // well-formed tokens. This is the one test that fails in that case.
  const decision = verifyGoogleClaims(valid(), config)
  assert.equal(decision.ok, true, decision.reason)
  assert.equal(decision.email, 'ken@kensmobiletire.com')
})

// --- One test per claim, each with the claim ABSENT -------------------------
//
// Absent is the case the defensive form passes:
//
//   if (claims.hd && claims.hd !== OWNER_DOMAIN) reject()   // admits every
//                                                           // consumer account
//
// A consumer Google account carries no `hd` at all, so that guard never runs
// and the single line that is the entire authorization decision does nothing.
// Every check here is a required equality on a present value.

for (const claim of ['iss', 'aud', 'email', 'email_verified', 'hd']) {
  test(`a token with no ${claim} is rejected, not skipped`, () => {
    const decision = verifyGoogleClaims(without(claim), config)
    assert.equal(decision.ok, false, `a missing ${claim} must be a rejection`)
    assert.match(decision.reason, new RegExp(claim.replace('_', '.?')),
      `the reason should name ${claim}, so a refusal can be diagnosed without guessing`)
  })
}

test('an empty string is absent, not a value', () => {
  // '' is falsy, so the conditional form skips it exactly as it skips
  // undefined, and `'' !== OWNER_DOMAIN` is the only reason this rejects.
  for (const claim of ['iss', 'aud', 'email', 'hd']) {
    assert.equal(verifyGoogleClaims(valid({ [claim]: '' }), config).ok, false, `${claim}: '' must reject`)
  }
})

test('no claims at all is a rejection, not a crash', () => {
  for (const nothing of [{}, null, undefined]) {
    const decision = verifyGoogleClaims(nothing, config)
    assert.equal(decision.ok, false)
    assert.ok(decision.reason, 'a rejection always carries a reason')
  }
})

// --- The domain check, which under domain-only IS the authorization ---------

test('hd must equal the owner domain exactly', () => {
  // Nothing sits behind `hd`: no allow-list, no exact-address match. This is
  // the entire authorization decision, so near-misses are worth naming.
  const refused = [
    'gmail.com',
    'kensmobiletire.com.evil.example',   // suffix attack on a startsWith
    'evilkensmobiletire.com',            // prefix attack on an endsWith
    'KENSMOBILETIRE.COM',                // Google returns the domain lowercased
    ' kensmobiletire.com',
    'sub.kensmobiletire.com',            // a subdomain is a different Workspace
  ]
  for (const hd of refused) {
    assert.equal(verifyGoogleClaims(valid({ hd }), config).ok, false, `hd ${JSON.stringify(hd)} must be refused`)
  }
})

test('a consumer Google account is refused, and refused by THIS layer', () => {
  // The shape that matters: a real, verified, correctly-audienced Google
  // account with no `hd` at all. Internal consent would also stop this person,
  // which is why the assertion is here and not in a browser.
  const consumer = without('hd')
  consumer.email = 'someone@gmail.com'
  const decision = verifyGoogleClaims(consumer, config)
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /hd/, 'refused for the missing domain claim specifically')
})

// --- aud, the one that would hurt most if missed ---------------------------

test('a token minted for another application is refused', () => {
  // A forged or borrowed token is precisely the one most likely to carry a
  // wrong or missing `aud` while every other claim looks perfect.
  const decision = verifyGoogleClaims(valid({ aud: '999-someone-else.apps.googleusercontent.com' }), config)
  assert.equal(decision.ok, false)
  assert.match(decision.reason, /aud/)
})

test('the issuer must be Google, in either form Google uses', () => {
  for (const iss of GOOGLE_ISSUERS) {
    assert.equal(verifyGoogleClaims(valid({ iss }), config).ok, true, `${iss} is a Google issuer`)
  }
  for (const iss of ['https://accounts.google.com.evil.example', 'accounts.google.com.evil.example', 'https://evil.example']) {
    assert.equal(verifyGoogleClaims(valid({ iss }), config).ok, false, `${iss} is not`)
  }
})

// --- email_verified, where the endpoint's types are the trap ---------------

test('email_verified is accepted in both shapes Google returns, and in no others', () => {
  // The tokeninfo endpoint is a debug endpoint and returns its values as
  // strings; an ID token payload carries a real boolean. Both are Google
  // saying the same thing, so both are accepted -- explicitly, by listing
  // them, rather than by a truthiness test that would also accept the string
  // 'false', which is truthy and means the opposite.
  assert.equal(verifyGoogleClaims(valid({ email_verified: true }), config).ok, true)
  assert.equal(verifyGoogleClaims(valid({ email_verified: 'true' }), config).ok, true)
  for (const nope of ['false', false, 'TRUE', 'yes', 1, '1', null]) {
    assert.equal(verifyGoogleClaims(valid({ email_verified: nope }), config).ok, false,
      `email_verified ${JSON.stringify(nope)} must not be read as verified`)
  }
})

// --- The actor string, which the audit trail depends on --------------------

test('a verified email can never take the reserved owner: marker shape', () => {
  // `owner:` is the namespace for "authenticated, but we cannot say who" --
  // owner:shared-password and owner:minted-session. quotes.decided_by must
  // never claim a person decided something a shared password or a minted
  // session did, so the two vocabularies have to stay disjoint by shape.
  //
  // They do, and not by luck: a colon is not valid in an unquoted email
  // local-part, and a verified Workspace address always carries an @ and this
  // domain. Asserted rather than assumed, because the whole audit trail rests
  // on it.
  const actor = actorFromEmail('ken@kensmobiletire.com')
  assert.equal(actor, 'ken@kensmobiletire.com')
  assert.ok(!actor.startsWith('owner:'), 'a person must never be written into the non-identity namespace')
  assert.match(actor, /@/, 'and must stay recognisable as a person by shape')
})

test('the verifier returns the email, so nothing downstream has to re-parse a token', () => {
  const decision = verifyGoogleClaims(valid({ email: 'someone.else@kensmobiletire.com' }), config)
  assert.equal(decision.ok, true)
  assert.equal(actorFromEmail(decision.email), 'someone.else@kensmobiletire.com')
})

// --- Configuration, which fails at boot rather than at login ---------------

test('readGoogleConfig reports "not configured" rather than throwing', () => {
  // Change one lands with the password still working, so an unconfigured
  // OAuth client must leave the server bootable and the password path intact.
  // This is the additive phase's three-case behaviour; it inverts in change
  // two, when no OAuth config becomes a refuse-to-boot.
  assert.equal(readGoogleConfig({}), null)
  assert.equal(readGoogleConfig({ KMT_GOOGLE_CLIENT_ID: '', KMT_GOOGLE_CLIENT_SECRET: '' }), null)
})

test('a half-configured OAuth client refuses to boot rather than half-working', () => {
  // One variable set and the other missing is a misconfiguration, not a
  // decision not to use Google. Failing at boot names the variable; failing at
  // login looks like Google is down, on a Saturday, to someone who cannot fix
  // it. Same reasoning as KMT_SESSION_HOURS in readAuthConfig.
  assert.throws(() => readGoogleConfig({ KMT_GOOGLE_CLIENT_ID: CLIENT_ID }), /KMT_GOOGLE_CLIENT_SECRET/)
  assert.throws(() => readGoogleConfig({ KMT_GOOGLE_CLIENT_SECRET: 'x' }), /KMT_GOOGLE_CLIENT_ID/)
})

test('the redirect URI is the canonical host over https, with no trailing slash', () => {
  // kmt.fly.dev answers 301 to the canonical host (measured), so a URI
  // registered against any other name puts a redirect inside the callback and
  // the flow fails at its last step looking like Google's fault. Google
  // matches the registered URI exactly, so drift here is not recoverable at
  // runtime -- it is a console edit.
  const google = readGoogleConfig({ KMT_GOOGLE_CLIENT_ID: CLIENT_ID, KMT_GOOGLE_CLIENT_SECRET: 'x' })
  assert.equal(google.redirectUri, 'https://kensmobiletire.com/api/owner/session/google/callback')
  assert.ok(!google.redirectUri.endsWith('/'))
})
