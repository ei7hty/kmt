import assert from 'node:assert/strict'

// AUDIT_BASE like the other audits, so one server can serve the whole gate.
// The fallback is the local dev server; a hosted-shape server on any port
// works too, with KMT_OWNER_PASSWORD (or a session minted with
// scripts/mint-session.mjs, passed as KMT_OWNER_SESSION_COOKIE) set to what
// it was started with.
// No default, on purpose -- see the same refusal in deployed-site-check.mjs.
// A script that silently audits SOMETHING rather than refusing to audit
// NOTHING answers confidently about a target nobody chose. #481 fixed three
// of these and its claim row said "three instances, one root"; a grep for the
// removed behaviour found six more, this among them. The count was a sample
// read as a census.
const base = process.env.AUDIT_BASE
if (!base) {
  console.error('Set AUDIT_BASE explicitly; this refuses to guess which server to audit.')
  console.error('It used to default to 127.0.0.1:4180 -- a port several audits shared, which is how one session reached another session\u2019s server and produced a finding that had to be retracted.')
  process.exit(2)
}

/**
 * The detection half of the two-hour email outage (2026-09-06 23:49-01:52):
 * the Google App Password behind SMTP was revoked -- silently, no warning,
 * no notification, no log entry -- and the first symptom was a `535` on the
 * next send. Seven messages failed, including Ken's own `request-arrived`
 * alerts, so he was blind to incoming requests the whole time. Nobody
 * looked at the Outbox panel for two hours; this is a script that looks so
 * a person does not have to remember to.
 *
 * `failed` is never a legitimate resting state the way `queued` is under
 * the null adapter -- so this needs no age threshold and no configuration
 * precondition, unlike the separate queued-row detector. Any *unresolved*
 * failed row is worth reporting the moment this runs; `resolved_at`
 * (backend/outbox.mjs) is how a failure that has actually been dealt with
 * -- tonight's seven, once looked at -- stops being reported without this
 * script pretending it never happened or inventing an age past which a
 * live failure quietly stops counting.
 *
 * Deliberately not a retry and not a repair: at-least-once delivery is
 * ruled and specced as its own change (#285). This only reports what was
 * attempted and did not get through; it does not attempt anything itself.
 *
 * Deliberately not the active probe either (DEV OPS's `transporter.verify()`
 * check, which answers "is the seam alive right now"): this answers "did a
 * message that was actually attempted get through", which is a different
 * question and does not substitute for it. Tonight's outage would have
 * tripped this within a minute of the first failed send rather than the
 * two hours it actually took someone to look.
 *
 * The one rule from the incident report worth repeating here: the alert
 * has to name the reason, not just the count. `535 5.7.8 BadCredentials` is
 * what turns "mail is failing" into "the credential is dead" -- a count
 * alone sends someone to read the database before they know what they are
 * looking for.
 */

/**
 * Signed in when the server asks. backend/server.mjs answers 401 to
 * /api/owner/* without a session; backend/dev.mjs has no login route at all
 * and answers 404 to the attempt, the same distinction owner-inventory-
 * audit.mjs already draws -- against dev.mjs the owner API is open, so an
 * empty cookie is correct rather than a failure to sign in.
 *
 * Minted checked before the password -- the same order and the same reason
 * owner-inventory-audit.mjs's own plain-fetch session block uses: once
 * Google-only sign-in is live there is no password to send here at all, and
 * scripts/mint-session.mjs is how this keeps working after that. Format-
 * checked before ever asking the server anything, so a malformed
 * KMT_OWNER_SESSION_COOKIE names itself rather than surfacing as a
 * confusing 401 indistinguishable from no credential at all.
 */
const cookie = await (async () => {
  const minted = process.env.KMT_OWNER_SESSION_COOKIE || ''
  if (minted) {
    const separator = minted.indexOf('=')
    if (separator < 1) throw new Error(`KMT_OWNER_SESSION_COOKIE must be "name=value"; got ${JSON.stringify(minted)}.`)
    return minted
  }
  const password = process.env.KMT_OWNER_PASSWORD || ''
  if (!password) return ''
  const login = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  })
  if (login.status === 404) return ''
  assert.equal(login.status, 200,
    'owner sign-in for the outbox read -- is KMT_OWNER_PASSWORD set to what the server was started with, or KMT_OWNER_SESSION_COOKIE to a session minted with scripts/mint-session.mjs?')
  return login.headers.get('set-cookie').split(';')[0]
})()

// GET /api/owner/outbox/unresolved-failures, not the general outbox listing
// filtered client-side: that general listing is a recency window over every
// status (backend/api.mjs clamps it at 200), so filtering it here would be
// bounded by how much unrelated mail happened to be sent since the last
// look, a bound that tightens as the business grows and never announces
// itself. This route is filtered at the query -- `status='failed' AND
// resolved_at IS NULL` -- so what comes back is bounded by how many
// unresolved failures actually exist, not by traffic. `limit` here is a
// safety cap on that set, not a recency window: hitting it means that many
// live unresolved failures exist at once, which is its own incident.
const outbox = await fetch(base + '/api/owner/outbox/unresolved-failures?limit=200', { headers: cookie ? { Cookie: cookie } : {} })
assert.equal(outbox.status, 200, 'the owner outbox API answered ' + outbox.status)
const { messages: failed } = await outbox.json()

if (failed.length === 0) {
  console.log('OK: 0 unresolved failed outbox rows.')
} else {
  console.error(`FAIL: ${failed.length} failed outbox row${failed.length === 1 ? '' : 's'}:`)
  for (const message of failed) {
    console.error(`  ${message.type} to request ${message.requestId} at ${message.updatedAt}: ${message.error || '(no error recorded)'}`)
  }
  process.exitCode = 1
}
