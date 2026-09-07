import assert from 'node:assert/strict'

// AUDIT_BASE like the other audits, so one server can serve the whole gate.
// The fallback is the local dev server; a hosted-shape server on any port
// works too, with KMT_OWNER_PASSWORD set to what it was started with.
const base = process.env.AUDIT_BASE || 'http://127.0.0.1:4180'

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
 * precondition, unlike the separate queued-row detector. Any failed row is
 * worth reporting the moment this runs.
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
 */
const cookie = await (async () => {
  const password = process.env.KMT_OWNER_PASSWORD || ''
  if (!password) return ''
  const login = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  })
  if (login.status === 404) return ''
  assert.equal(login.status, 200, 'owner sign-in for the outbox read -- is KMT_OWNER_PASSWORD set to what the server was started with?')
  return login.headers.get('set-cookie').split(';')[0]
})()

// The largest window the endpoint offers (backend/api.mjs clamps at 200): a
// failure older than that has already scrolled past what this can see, the
// same limit the owner's own Outbox panel has.
const outbox = await fetch(base + '/api/owner/outbox?limit=200', { headers: cookie ? { Cookie: cookie } : {} })
assert.equal(outbox.status, 200, 'the owner outbox API answered ' + outbox.status)
const { messages } = await outbox.json()

const failed = messages.filter(message => message.status === 'failed')

if (failed.length === 0) {
  console.log('OK: 0 failed outbox rows in the most recent ' + messages.length + '.')
} else {
  console.error(`FAIL: ${failed.length} failed outbox row${failed.length === 1 ? '' : 's'}:`)
  for (const message of failed) {
    console.error(`  ${message.type} to request ${message.requestId} at ${message.updatedAt}: ${message.error || '(no error recorded)'}`)
  }
  process.exitCode = 1
}
