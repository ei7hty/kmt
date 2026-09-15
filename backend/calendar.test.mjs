import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Inventory } from './inventory.mjs'
import { Quotes, SHARED_PASSWORD_ACTOR } from './quotes.mjs'
import { Outbox } from './outbox.mjs'
import { Mailer, NullAdapter } from './mail.mjs'
import { TEMPLATES } from './mail-templates.mjs'
import { createRequestsApi } from './api.mjs'
import {
  CALENDAR_EVENT_STATUSES, CALENDAR_SCOPE, Calendar, GoogleCalendarClient, NullCalendarClient,
  calendarEventsFor, createCalendar, describeCalendar, ensureCalendarTable, eventFor, explainRefusal, readCalendarConfig, signAssertion,
} from './calendar.mjs'

const SIZE = '215/60R16'
const tire = (id = 'giga-a') => ({ id, name: 'Test Touring', size: SIZE, price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' } })
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })
const KEY = 'a'.repeat(32)
/** Well clear of the server's 7-day date floor (t48), always ahead of today. */
const SOON = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
const form = () => ({ customerKey: KEY, tireSize: SIZE, tireSelection: 'giga-a', quantity: 4, vehicleInfo: '2020 Toyota Corolla',
  location: '456 Demo Ave, Everett, MA 02149', locationType: 'Home', serviceZip: '02149', locationNotes: 'Blue sedan, gate code 1234',
  date: SOON, customerName: 'Jamie Rivera', customerEmail: 'Jamie@Example.com', customerPhone: '6175550100', customerNotes: 'Dog in the yard' })

/** A real RSA key, generated once: the assertion is verified, not pattern-matched. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' })
const CONFIG = { calendarId: 'abc123@group.calendar.google.com', serviceClient: 'kmt-mail@kmt-project.iam.gserviceaccount.com', privateKey: PEM }
const MAIL_CONFIG = { provider: 'none', host: '', port: 587, user: '', password: '', from: 'quotes@kensmobiletire.com', ownerEmail: 'owner@example.com', ownerName: 'Ken', warnings: [] }

/**
 * A `fetch` that plays Google: answers the token exchange, then whatever the
 * script says for each Calendar call, and remembers every request so a test
 * can read what was actually sent. No socket is ever opened.
 */
function fakeGoogle(script = [], { token = null } = {}) {
  const calls = []
  const answers = [...script]
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (url === 'https://oauth2.googleapis.com/token') {
      if (token) return { ok: false, status: token.status, text: async () => JSON.stringify(token.body) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) }
    }
    // A GET is the removal sweep asking for events by request id; with no
    // scripted answer it finds nothing, so the tests written before the
    // sweep keep their meaning.
    const next = answers.shift() ?? (init.method === 'GET' ? { status: 200, body: { items: [] } } : { status: 200, body: { id: 'evt-1' } })
    return { ok: next.status < 300, status: next.status, text: async () => next.body === undefined ? '' : (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) }
  }
  return { calls, fetch }
}

/** A paid request in an in-memory world, with an outbox-only mailer to catch the owner alert. */
function world(t, { config = CONFIG, script, env, token } = {}) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  inventory.importSnapshot(snapshot([tire()]))
  const quotes = new Quotes(inventory)
  const outbox = new Outbox(inventory.db)
  const lines = []
  const log = line => lines.push(line)
  const mailer = new Mailer({ outbox, quotes, adapter: new NullAdapter(), config: MAIL_CONFIG, origin: 'https://kensmobiletire.com', log })
  const google = fakeGoogle(script, { token })
  const calendar = env
    ? createCalendar({ db: inventory.db, quotes, mailer, env, origin: 'https://kensmobiletire.com', fetch: google.fetch, log })
    : new Calendar({ db: inventory.db, quotes, mailer, config, origin: 'https://kensmobiletire.com', log,
      client: config ? new GoogleCalendarClient(config, { fetch: google.fetch }) : new NullCalendarClient() })
  const paidRequest = () => {
    const { request, quote } = quotes.submit(form())
    quotes.decide(request.id, 'sent', quote.version, null, SHARED_PASSWORD_ACTOR)
    return quotes.pay(request.id).request
  }
  return { inventory, quotes, outbox, mailer, calendar, google, lines, paidRequest }
}

/* ------------------------------------------------------------ configuration */

test('the configuration is the environment: no calendar id means off; an id without the service account is refused at boot', () => {
  assert.equal(readCalendarConfig({}), null)
  assert.equal(readCalendarConfig({ KMT_CALENDAR_ID: '   ' }), null, 'blank is unset')
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal' }), /KMT_CALENDAR_SERVICE_CLIENT and KMT_CALENDAR_PRIVATE_KEY is not/)
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal', KMT_CALENDAR_SERVICE_CLIENT: 'sa@x' }), /KMT_CALENDAR_PRIVATE_KEY is not\. .*JSON key file.*KMT_MAIL_\*\) are not them/)
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal', KMT_CALENDAR_PRIVATE_KEY: PEM }), /KMT_CALENDAR_SERVICE_CLIENT is not\./)
  // The mail names are not a fallback: in production they hold an SMTP host and a mailbox password.
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal', KMT_MAIL_SERVICE_CLIENT: 'sa@x', KMT_MAIL_PRIVATE_KEY: PEM }), /KMT_CALENDAR_SERVICE_CLIENT and KMT_CALENDAR_PRIVATE_KEY is not/)
  // A key that is not a key is told apart from a key that is missing.
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal', KMT_CALENDAR_SERVICE_CLIENT: 'sa@x', KMT_CALENDAR_PRIVATE_KEY: 'GOCSPX-not-a-key' }), /not a private key this server can sign with .*KMT_MAIL_\*\) are not them.*PEM header to footer/)
  const on = readCalendarConfig({ KMT_CALENDAR_ID: ' cal ', KMT_CALENDAR_SERVICE_CLIENT: 'sa@x', KMT_CALENDAR_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') })
  assert.deepEqual(on, { calendarId: 'cal', serviceClient: 'sa@x', privateKey: PEM.trim() }, 'a PEM pasted with escaped newlines is the same key')
  assert.match(describeCalendar(null), /KMT_CALENDAR_ID unset; paid jobs are not added/)
  assert.match(describeCalendar(on), /all-day events to cal by service account sa@x/)
})

test('the assertion is a real RS256 JWT for the calendar scope, with no impersonation', () => {
  const at = () => 1_800_000_000_000
  const jwt = signAssertion({ serviceClient: CONFIG.serviceClient, privateKey: PEM, now: at })
  const [header, claims, signature] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  const decoded = JSON.parse(Buffer.from(claims, 'base64url'))
  assert.deepEqual(decoded, { iss: CONFIG.serviceClient, scope: CALENDAR_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 })
  assert.equal('sub' in decoded, false, 'the account acts as itself on a shared calendar; no delegation subject')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${claims}`)
  assert.ok(verifier.verify(publicKey, signature, 'base64url'), 'the signature verifies against the public half')
  const again = createVerify('RSA-SHA256')
  again.update(`${header}.${claims}`)
  assert.ok(!again.verify(publicKey, signature.replace(/^./, c => c === 'A' ? 'B' : 'A'), 'base64url'), 'and a tampered signature does not')
})

/* ------------------------------------------------------------------ the event */

test('the event is one whole day on the preferred date, titled for the job and the customer, with no email in it', () => {
  const request = { id: 'r1', date: '2026-10-31', quantity: 4, customerName: 'Jamie Rivera', customerPhone: '6175550100', customerEmail: 'jamie@example.com',
    vehicleInfo: '2020 Toyota Corolla', locationType: 'Home', location: '456 Demo Ave, Everett, MA 02149', locationNotes: 'gate code 1234', customerNotes: 'Dog in the yard' }
  const event = eventFor({ request, quote: { total: 250 }, tire: { name: 'Test Touring', size: SIZE }, origin: 'https://kensmobiletire.com' })
  assert.equal(event.summary, `4 × Test Touring (${SIZE}) — Jamie Rivera`)
  assert.deepEqual(event.start, { date: '2026-10-31' })
  assert.deepEqual(event.end, { date: '2026-11-01' }, 'the exclusive end is the next calendar day, across a month boundary')
  assert.equal(event.location, request.location)
  assert.match(event.description, /Phone: 6175550100/)
  assert.match(event.description, /Where: Home — 456 Demo Ave/)
  assert.match(event.description, /Location notes: gate code 1234/)
  assert.match(event.description, /Anything else: Dog in the yard/)
  assert.match(event.description, /Total: \$250\.00/)
  assert.match(event.description, /https:\/\/kensmobiletire\.com\/owner\/quotes\?request=r1/)
  assert.doesNotMatch(JSON.stringify(event), /jamie@example\.com/, 'the customer\'s email is not in the calendar')
  assert.deepEqual(event.extendedProperties, { private: { kmtRequestId: 'r1' } })
  assert.deepEqual(eventFor({ request: { id: 'r2', date: '2026-12-31' }, quote: null, tire: null, origin: 'https://x' }).end, { date: '2027-01-01' }, 'and across a year boundary')
  assert.throws(() => eventFor({ request: { id: 'r3', date: 'tomorrow' }, origin: 'https://x' }), /YYYY-MM-DD/)
})

/* ------------------------------------------------------------------- writes */

test('a paid request becomes one created row: token exchange, then an insert into the configured calendar', async t => {
  const { calendar, google, paidRequest, outbox } = world(t)
  const request = paidRequest()
  const row = await calendar.record(request.id)
  assert.equal(row.status, 'created')
  assert.equal(row.eventId, 'evt-1')
  assert.equal(row.calendarId, CONFIG.calendarId, 'the calendar id is stored beside the event id')
  assert.equal(row.requestId, request.id)
  assert.equal(google.calls.length, 2)
  assert.equal(google.calls[0].url, 'https://oauth2.googleapis.com/token')
  assert.match(google.calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/)
  const insert = google.calls[1]
  assert.equal(insert.method, 'POST')
  assert.equal(insert.url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendarId)}/events`)
  assert.equal(insert.headers.Authorization, 'Bearer tok-1')
  const sent = JSON.parse(insert.body)
  assert.equal(sent.start.date, SOON)
  assert.match(sent.summary, /4 × Test Touring .* — Jamie Rivera/)
  assert.deepEqual(calendar.forRequest(request.id).map(r => r.status), ['created'])
  assert.equal(outbox.list({ limit: 10 }).length, 0, 'nothing was mailed: it worked')
})

test('a second record for the same request makes no second event', async t => {
  const { calendar, google, paidRequest } = world(t)
  const request = paidRequest()
  await calendar.record(request.id)
  assert.equal(await calendar.record(request.id), null)
  assert.equal(google.calls.length, 2, 'no further call to Google')
  assert.equal(calendar.forRequest(request.id).length, 1)
})

test('the access token is reused until a minute before it expires, then exchanged again', async () => {
  let clock = 1_800_000_000_000
  const google = fakeGoogle([{ status: 200, body: { id: 'e1' } }, { status: 200, body: { id: 'e2' } }, { status: 200, body: { id: 'e3' } }])
  const client = new GoogleCalendarClient(CONFIG, { fetch: google.fetch, now: () => clock })
  await client.insert('cal', { summary: 'a' })
  clock += 3600_000 - 61_000
  await client.insert('cal', { summary: 'b' })
  assert.equal(google.calls.filter(c => c.url.endsWith('/token')).length, 1, 'one exchange serves both, inside the margin')
  clock += 2_000
  await client.insert('cal', { summary: 'c' })
  assert.equal(google.calls.filter(c => c.url.endsWith('/token')).length, 2, 'past the margin a new token is fetched')
})

test('nothing is recorded for an unpaid request, an unknown one, or when the feature is off', async t => {
  const { calendar, quotes, google } = world(t)
  const { request } = quotes.submit(form())
  assert.equal(await calendar.record(request.id), null, 'a draft is not a job')
  assert.equal(await calendar.record('nope'), null)
  assert.equal(google.calls.length, 0)
  const off = world(t, { config: null })
  const paid = off.paidRequest()
  assert.equal(off.calendar.enabled, false)
  assert.equal(await off.calendar.record(paid.id), null)
  assert.equal(off.calendar.forRequest(paid.id).length, 0, 'off means no row either, not a failed one')
  assert.equal(off.google.calls.length, 0)
})

test('a refusal from Google is a failed row with the error, and an email to Ken saying to add it by hand', async t => {
  const { calendar, mailer, outbox, paidRequest, lines } = world(t, { script: [{ status: 403, body: { error: { message: 'Forbidden: calendar not shared' } } }] })
  const request = paidRequest()
  const row = await calendar.record(request.id)
  await mailer.idle()
  assert.equal(row.status, 'failed')
  assert.equal(row.eventId, null)
  assert.match(row.error, /Google Calendar answered 403 on POST .*Forbidden: calendar not shared/)
  assert.ok(lines.some(line => /calendar: FAILED .* answered 403/.test(line)))
  const alerts = outbox.forRequest(request.id)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].type, 'calendar-failed')
  assert.equal(alerts[0].to, 'owner@example.com', 'owner audience')
  assert.equal(alerts[0].data.calendarId, CONFIG.calendarId)
  assert.match(alerts[0].data.reason, /^The service account may not change this calendar \(403\)/, 'the alert leads with which gate is shut')
  const { subject, text } = TEMPLATES['calendar-failed'].render(alerts[0].data)
  assert.match(subject, new RegExp(`Calendar: add by hand — ${SOON}, 4 × Test Touring`))
  assert.match(text, /Add it by hand/)
  assert.match(text, /Where: Home — 456 Demo Ave/)
  assert.match(text, /Why: The service account may not change this calendar \(403\): share it/)
  assert.match(text, /\/owner\/quotes\?request=/)
  assert.doesNotMatch(text, /Jamie@Example\.com/i, 'the customer\'s email is not in the alert')
  // A failed attempt does not block a retry: the next record tries again.
  const retry = await calendar.record(request.id)
  assert.equal(retry.status, 'created', 'the guard skips only rows that hold a live event')
})

test('a thrown transport error (timeout, DNS) is the same failed row, never an unhandled rejection', async t => {
  const { calendar, paidRequest, mailer, outbox } = world(t)
  calendar.client.fetch = async () => { throw new Error('fetch failed: ENOTFOUND') }
  const request = paidRequest()
  const task = calendar.after(request.id)
  await calendar.idle()
  await mailer.idle()
  assert.equal((await task).status, 'failed')
  assert.match(calendar.forRequest(request.id)[0].error, /ENOTFOUND/)
  assert.equal(outbox.forRequest(request.id)[0].type, 'calendar-failed')
})

test('a malformed success from Google (no id) is a failure, not a created row with nothing to delete', async t => {
  const { calendar, paidRequest } = world(t, { script: [{ status: 200, body: { kind: 'calendar#event' } }] })
  const row = await calendar.record(paidRequest().id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /without its id/)
})

test('the three gates fail distinguishably: credentials, API enablement, share -- and the two Google cannot tell apart are named as such', async t => {
  const notEnabled = { status: 403, body: { error: { code: 403, message: 'Google Calendar API has not been used in project 1234 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } } }
  const readOnly = { status: 403, body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } } }
  const notFound = { status: 404, body: { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } } }
  const cases = [
    [{ script: [notEnabled] }, /^The Google Calendar API is not enabled on the service account's project \(403 accessNotConfigured\)/],
    [{ script: [readOnly] }, /^The service account may not change this calendar \(403\): share it .* "Make changes to events"/],
    [{ script: [notFound] }, /^Google shows this service account no calendar under KMT_CALENDAR_ID \(404\): either the id is wrong, or the calendar is not shared .* both the same way/],
    [{ token: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }, /^Google refused the service account's credentials at the token exchange \(400\)\. KMT_CALENDAR_SERVICE_CLIENT and KMT_CALENDAR_PRIVATE_KEY/],
  ]
  for (const [setup, expected] of cases) {
    const { calendar, mailer, outbox, paidRequest } = world(t, setup)
    const row = await calendar.record(paidRequest().id)
    await mailer.idle()
    assert.equal(row.status, 'failed')
    assert.match(row.error, expected)
    assert.match(row.error, /Google (Calendar|token exchange) answered \d{3}/, 'and still carries Google\'s own answer after the explanation')
    const alert = outbox.forRequest(row.requestId)[0]
    assert.equal(alert.type, 'calendar-failed')
    assert.match(alert.data.reason, expected, 'Ken\'s alert leads with the gate, not the status code')
  }
  assert.equal(explainRefusal(500, 'boom', 'calendar'), null, 'an answer this cannot classify gets no invented explanation')
  const plain = world(t, { script: [{ status: 500, body: 'boom' }] })
  const unexplained = await plain.calendar.record(plain.paidRequest().id)
  assert.match(unexplained.error, /^Google Calendar answered 500 on POST/, 'and the row then starts with Google\'s answer, no guess in front of it')
})

test('a redaction after KMT_CALENDAR_ID has moved still deletes the event where it was made, using the stored calendar id', async t => {
  const { calendar, inventory, quotes, paidRequest } = world(t)
  const request = paidRequest()
  await calendar.record(request.id)
  const moved = { ...CONFIG, calendarId: 'moved@group.calendar.google.com' }
  const google = fakeGoogle([{ status: 204 }])
  const later = new Calendar({ db: inventory.db, quotes, config: moved, client: new GoogleCalendarClient(moved, { fetch: google.fetch }), log: () => {} })
  const summary = await later.forget(request.id)
  assert.equal(summary.deleted, 1)
  const del = google.calls.filter(c => c.method === 'DELETE').at(-1)
  assert.ok(del.url.includes(encodeURIComponent(CONFIG.calendarId)), 'the stored calendar id, not the configured one')
  assert.ok(!del.url.includes('moved'), del.url)
})

/* ------------------------------------------------------------------- the API */

test('paying through the API adds the job after the answer; a repeated pay makes no second event', async t => {
  const { quotes, calendar, google, mailer } = world(t)
  const requestsApi = createRequestsApi(quotes, { mailer, calendar })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const submitted = await (await post('/api/requests', form())).json()
  const { version } = quotes.get(submitted.request.id).quote
  quotes.decide(submitted.request.id, 'sent', version, null, SHARED_PASSWORD_ACTOR)
  await mailer.idle()
  await calendar.idle()
  assert.equal(calendar.forRequest(submitted.request.id).length, 0, 'nothing before payment')

  const paid = await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  assert.equal(paid.quote.status, 'paid')
  assert.equal('calendar' in paid, false, 'the customer answer says nothing about a calendar')
  await calendar.idle()
  assert.deepEqual(calendar.forRequest(submitted.request.id).map(r => r.status), ['created'])

  await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  await calendar.idle()
  assert.equal(calendar.forRequest(submitted.request.id).length, 1)
  assert.equal(google.calls.filter(c => !c.url.endsWith('/token')).length, 1)
})

test('the API without a calendar behaves as before: paying works and nothing is recorded', async t => {
  const { quotes, mailer, inventory } = world(t, { config: null })
  const requestsApi = createRequestsApi(quotes, { mailer })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const submitted = await (await post('/api/requests', form())).json()
  quotes.decide(submitted.request.id, 'sent', quotes.get(submitted.request.id).quote.version, null, SHARED_PASSWORD_ACTOR)
  const paid = await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  assert.equal(paid.quote.status, 'paid')
  assert.equal(calendarEventsFor(inventory.db, submitted.request.id).length, 0)
})

/* --------------------------------------------------------------- the server */

test('createCalendar reads the environment: off with nothing set, on with the three variables, refused with one', async t => {
  const off = world(t, { env: {} })
  assert.equal(off.calendar.enabled, false)
  assert.equal(off.calendar.client.name, 'none')
  const on = world(t, { env: { KMT_CALENDAR_ID: CONFIG.calendarId, KMT_CALENDAR_SERVICE_CLIENT: CONFIG.serviceClient, KMT_CALENDAR_PRIVATE_KEY: PEM } })
  assert.equal(on.calendar.enabled, true)
  assert.equal(on.calendar.client.name, 'google')
  assert.equal((await on.calendar.record(on.paidRequest().id)).status, 'created')
  // A half-set config no longer THROWS out of createCalendar -- it disables
  // the calendar and lets the server boot (the 2026-09-15 outage; see the
  // tests at the end of this file). `readCalendarConfig` still refuses in
  // the same words, which is what this now asserts: the refusal is intact,
  // and what changed is only what it costs.
  const halfSet = world(t, { env: { KMT_CALENDAR_ID: 'cal' } })
  assert.equal(halfSet.calendar.enabled, false)
  assert.match(halfSet.calendar.configError.message, /KMT_CALENDAR_SERVICE_CLIENT/)
  assert.throws(() => readCalendarConfig({ KMT_CALENDAR_ID: 'cal' }), /KMT_CALENDAR_SERVICE_CLIENT/)
})

/* ------------------------------------------------------------ the table */

test('the table is created once and survives being opened again; a database from before the feature gains only the table', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE requests (id TEXT PRIMARY KEY)')
  ensureCalendarTable(db)
  ensureCalendarTable(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name)
  assert.deepEqual(tables, ['calendar_events', 'requests'])
  assert.deepEqual(calendarEventsFor(db, 'r1'), [])
  for (const status of CALENDAR_EVENT_STATUSES) {
    db.prepare("INSERT INTO calendar_events (id, request_id, calendar_id, event_id, status, created_at, updated_at) VALUES (?, 'r1', 'c', 'e', ?, 't', 't')").run(status, status)
  }
  assert.throws(() => db.prepare("INSERT INTO calendar_events (id, request_id, calendar_id, event_id, status, created_at, updated_at) VALUES ('x', 'r1', 'c', 'e', 'pending', 't', 't')").run(), /CHECK/)
  const bare = new DatabaseSync(':memory:')
  assert.deepEqual(calendarEventsFor(bare, 'r1'), [], 'a database without the table answers empty rather than throwing: the redaction plan runs read-only against any database')
})

/* --------------------------------------------------------------- forgetting */

test('forget removes the request\'s events from Google and marks the rows deleted; an event Google already lost counts as gone', async t => {
  const { calendar, google, paidRequest } = world(t, { script: [{ status: 200, body: { id: 'evt-9' } }, { status: 204 }] })
  const request = paidRequest()
  await calendar.record(request.id)
  const summary = await calendar.forget(request.id)
  assert.deepEqual({ deleted: summary.deleted, failed: summary.failed, pending: summary.pending }, { deleted: 1, failed: 0, pending: 0 })
  const del = google.calls.filter(c => c.method === 'DELETE').at(-1)
  assert.equal(del.url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.calendarId)}/events/evt-9`)
  assert.deepEqual(calendar.forRequest(request.id).map(r => r.status), ['deleted'])
  assert.deepEqual(await calendar.forget(request.id).then(s => [s.deleted, s.rows.length]), [0, 0], 'idempotent')

  const gone = world(t, { script: [{ status: 200, body: { id: 'evt-10' } }, { status: 410, body: 'Gone' }] })
  const r2 = gone.paidRequest()
  await gone.calendar.record(r2.id)
  assert.equal((await gone.calendar.forget(r2.id)).deleted, 1, '410 means it is already not there, which is the goal')
})

test('a delete Google refuses stays on the row as delete-failed, with the error, and is retried by the next forget', async t => {
  const { calendar, paidRequest } = world(t, { script: [{ status: 200, body: { id: 'evt-9' } }, { status: 500, body: 'boom' }, { status: 204 }] })
  const request = paidRequest()
  await calendar.record(request.id)
  const first = await calendar.forget(request.id)
  assert.equal(first.failed, 1)
  const [row] = calendar.forRequest(request.id)
  assert.equal(row.status, 'delete-failed')
  assert.match(row.error, /answered 500/)
  assert.equal(await calendar.record(request.id), null, 'a delete-failed row still holds a live event: no second one is made')
  const second = await calendar.forget(request.id)
  assert.equal(second.deleted, 1)
  assert.equal(calendar.forRequest(request.id)[0].status, 'deleted')
})

test('the removal sweep deletes an event Google holds that no row recorded, and records that it did', async t => {
  // record() creates at Google and only then writes the row, so a process
  // that dies between the two leaves an orphan. The privacy notice promises
  // the entry is deleted on removal; this is what keeps that true.
  const { calendar, google, paidRequest } = world(t, { script: [
    { status: 200, body: { items: [{ id: 'orphan-9', summary: 'x' }] } },   // GET: the sweep finds one
    { status: 204 },                                                        // DELETE it
  ] })
  const request = paidRequest()
  assert.equal(calendar.forRequest(request.id).length, 0, 'no row: the table knows nothing')
  const summary = await calendar.forget(request.id)
  assert.deepEqual({ deleted: summary.deleted, swept: summary.swept, failed: summary.failed, pending: summary.pending }, { deleted: 0, swept: 1, failed: 0, pending: 0 })
  const get = google.calls.find(c => c.method === 'GET')
  assert.ok(get.url.includes(`/calendars/${encodeURIComponent(CONFIG.calendarId)}/events?privateExtendedProperty=${encodeURIComponent('kmtRequestId=' + request.id)}`), get.url)
  const del = google.calls.at(-1)
  assert.equal(del.method, 'DELETE')
  assert.ok(del.url.endsWith('/events/orphan-9'))
  const [row] = calendar.forRequest(request.id)
  assert.equal(row.status, 'deleted')
  assert.equal(row.eventId, 'orphan-9')
  assert.match(row.error, /found by the removal sweep/, 'the record says how it was found')
})

test('the removal sweep covers a create the table recorded as failed but Google completed, and leaves known rows alone', async t => {
  // A timeout after Google created the event: the row says failed, the
  // event exists. And a second calendar id from an older row is swept too.
  const { calendar, google, paidRequest, inventory, quotes } = world(t, { script: [
    { status: 500, body: 'timeout after create' },                          // the create "fails"
  ] })
  const request = paidRequest()
  await calendar.record(request.id)
  assert.equal(calendar.forRequest(request.id)[0].status, 'failed')
  const older = new Calendar({ db: inventory.db, quotes, config: { ...CONFIG, calendarId: 'old@group.calendar.google.com' }, client: calendar.client, log: () => {} })
  older.insertRow({ requestId: request.id, calendarId: 'old@group.calendar.google.com', eventId: 'known-1', status: 'created' })
  google.calls.length = 0
  const answers = [
    { status: 204 },                                                        // DELETE known-1 by its row
    { status: 200, body: { items: [{ id: 'ghost-1' }] } },                  // GET configured calendar: the failed create's ghost
    { status: 204 },                                                        // DELETE ghost-1
    { status: 200, body: { items: [{ id: 'known-1' }] } },                  // GET old calendar: only the one already handled
  ]
  calendar.client.fetch = async (url, init = {}) => {
    google.calls.push({ url, method: init.method })
    if (url.endsWith('/token')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }) }
    const next = answers.shift() ?? { status: 200, body: { items: [] } }
    return { ok: next.status < 300, status: next.status, text: async () => next.body === undefined ? '' : JSON.stringify(next.body) }
  }
  const summary = await calendar.forget(request.id)
  assert.deepEqual({ deleted: summary.deleted, swept: summary.swept, failed: summary.failed, pending: summary.pending }, { deleted: 1, swept: 1, failed: 0, pending: 0 })
  const deletes = google.calls.filter(c => c.method === 'DELETE').map(c => c.url.split('/events/')[1])
  assert.deepEqual(deletes, ['known-1', 'ghost-1'], 'known-1 is deleted once by its row, never again by the sweep')
  assert.deepEqual(calendar.forRequest(request.id).map(r => [r.eventId, r.status]).sort(), [[null, 'failed'], ['ghost-1', 'deleted'], ['known-1', 'deleted']])
})

test('a sweep the calendar refuses counts as failed: the removal is not called complete on a calendar that could not be read', async t => {
  const { calendar, paidRequest } = world(t, { script: [{ status: 403, body: 'Forbidden' }] })
  const summary = await calendar.forget(paidRequest().id)
  assert.equal(summary.failed, 1)
  assert.equal(summary.swept, 0)
})

test('forget with the feature off cannot reach Google: the rows stay and are reported as pending, never silently dropped', async t => {
  const { calendar, paidRequest, inventory, quotes } = world(t)
  const request = paidRequest()
  await calendar.record(request.id)
  const off = new Calendar({ db: inventory.db, quotes, client: new NullCalendarClient(), config: null, log: () => {} })
  const summary = await off.forget(request.id)
  assert.deepEqual({ deleted: summary.deleted, failed: summary.failed, pending: summary.pending }, { deleted: 0, failed: 0, pending: 1 })
  assert.equal(summary.rows[0].eventId, 'evt-1', 'and names the event so it can be deleted by hand')
  assert.equal(calendar.forRequest(request.id)[0].status, 'created')
})

/* ------------------------------------------------------- the removal script */

/**
 * `scripts/redact.mjs` from the outside: a request with a live event, a
 * shell with no calendar credentials. The rows are blanked, and the run says
 * loudly that the Google event still exists and exits 1 -- never a clean
 * "Done" over an event that is still out there.
 */
test('redact.mjs names the calendar event in the dry run, and without credentials reports the removal incomplete and exits 1', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'kmt-calendar-redact-'))
  const dbPath = join(dir, 'owner.sqlite')
  const inventory = new Inventory(dbPath, [SIZE])
  inventory.importSnapshot(snapshot([tire()]))
  const quotes = new Quotes(inventory)
  const { request, quote } = quotes.submit(form())
  quotes.decide(request.id, 'sent', quote.version, null, SHARED_PASSWORD_ACTOR)
  quotes.pay(request.id)
  const google = fakeGoogle()
  const calendar = new Calendar({ db: inventory.db, quotes, config: CONFIG, client: new GoogleCalendarClient(CONFIG, { fetch: google.fetch }), log: () => {} })
  await calendar.record(request.id)
  inventory.close()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const env = { ...process.env, KMT_OWNER_DB: dbPath }
  delete env.KMT_CALENDAR_ID
  const run = (...args) => spawnSync(process.execPath, ['scripts/redact.mjs', '--request', request.id, ...args], { encoding: 'utf8', env })
  const dry = run()
  assert.equal(dry.status, 0, dry.stderr)
  assert.ok(dry.stdout.includes(`Google Calendar: 1 recorded event(s) to delete -- ${CONFIG.calendarId}/evt-1`), dry.stdout)
  assert.match(dry.stdout, /Nothing was written/)

  const write = run('--write')
  assert.equal(write.status, 1, 'incomplete removal is a non-zero exit')
  assert.match(write.stdout, /Google Calendar: deleted 0 recorded, 0 found by sweep, refused 0, unreachable 1/)
  assert.ok(write.stderr.includes(`REMOVAL INCOMPLETE: 1 calendar event(s) still exist in Google: ${CONFIG.calendarId}/evt-1`), write.stderr)
  assert.match(write.stderr, /KMT_CALENDAR_ID is not set in this shell/)
  const after = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assert.equal(calendarEventsFor(after, request.id)[0].status, 'created', 'the row still says the event exists, because it does')
    assert.doesNotMatch(after.prepare('SELECT payload FROM requests WHERE id=?').get(request.id).payload, /Jamie Rivera/, 'the database half of the removal still happened')
  } finally { after.close() }

  const again = run('--write')
  assert.equal(again.status, 1, 'and it stays incomplete, not "nothing to do", until the event is gone')
  assert.match(again.stderr, /REMOVAL INCOMPLETE/)
})

/* ------------------------------------- a bad config disables the calendar,
                                          never the server (the 2026-09-15 outage) */

/**
 * The PEM as PowerShell delivered it on 2026-09-15.
 *
 * `KMT_CALENDAR_PRIVATE_KEY="$(node -p ...private_key)"` -- a double-quoted
 * command substitution joins the output's lines with SPACES, so Fly received
 * a one-line PEM with spaces where the newlines belong. The unescape handles
 * a literal `\n` and has nothing to say about a space, so `createPrivateKey`
 * threw `DECODER routines::unsupported`, `readCalendarConfig` threw with it,
 * and the machine crash-looped: apex and kmt.fly.dev both answering nothing
 * for about four minutes.
 */
const MANGLED_PEM = PEM.replace(/\n/g, ' ')

test('a refused calendar config disables the calendar and the server still boots', () => {
  const env = { KMT_CALENDAR_ID: 'cal@group.calendar.google.com', KMT_CALENDAR_SERVICE_CLIENT: 'sa@x', KMT_CALENDAR_PRIVATE_KEY: MANGLED_PEM }

  // The control first: this key really is refused, so the assertions below
  // are about a genuine fault rather than a value that happens to parse.
  assert.throws(() => readCalendarConfig(env), /not a private key this server can sign with/)

  // And the whole point: creating the calendar from that same env does NOT
  // throw. Before this, it did, and it took the customer site with it.
  let calendar
  assert.doesNotThrow(() => { calendar = createCalendar({ db: new DatabaseSync(':memory:'), quotes: null, env, log: () => {} }) })
  assert.equal(calendar.enabled, false, 'a calendar with a refused config must not think it is on')
  assert.ok(calendar.configError, 'the fault is kept, not swallowed')

  // The boot line distinguishes refused from unset. "Unset" for a mangled key
  // sends the reader hunting for a secret that is sitting right there.
  const line = describeCalendar(calendar.config, calendar.configError)
  assert.match(line, /REFUSED/)
  assert.match(line, /the site is serving/)
  assert.match(line, /not a private key/, 'the boot line carries the actual fault, not a generic one')

  // The control on the other two states, so "REFUSED" means something.
  assert.match(describeCalendar(null, null), /unset/)
  assert.match(describeCalendar(CONFIG, null), /paid jobs are added/)
})

test('a paid job on a refused calendar records a failure and tells Ken, once', async (t) => {
  const env = { KMT_CALENDAR_ID: 'cal@group.calendar.google.com', KMT_CALENDAR_SERVICE_CLIENT: 'sa@x', KMT_CALENDAR_PRIVATE_KEY: MANGLED_PEM }
  const { calendar, outbox, paidRequest, lines } = world(t, { env })
  const request = paidRequest()

  const row = await calendar.record(request.id)
  assert.ok(row, 'a paid job that could not be scheduled must leave a record')
  assert.equal(row.status, 'failed')
  assert.equal(row.calendarId, 'cal@group.calendar.google.com', 'the row names the calendar the job was meant for')
  assert.match(row.error, /disabled by a configuration fault/)
  assert.ok(lines.some(line => /CONFIG-FAILED/.test(line)), 'and says so in the log')

  const alerts = outbox.forRequest(request.id).filter(message => message.type === 'calendar-failed')
  assert.equal(alerts.length, 1, 'Ken hears about it on the job that needed it')

  // Twice must not mail twice. A repeated payment callback is ordinary, and
  // five identical emails for one fault teach him to ignore the sixth.
  assert.equal(await calendar.record(request.id), null)
  assert.equal(outbox.forRequest(request.id).filter(message => message.type === 'calendar-failed').length, 1)
})

test('a calendar nobody asked for stays silent, which is the difference that matters', async (t) => {
  // Unset is a choice, not a fault. It must not fill the outbox with alerts
  // about a feature Ken never turned on -- this is the case that would make
  // the alert above worthless if it were not kept apart.
  const { calendar, outbox, paidRequest } = world(t, { env: {} })
  const request = paidRequest()

  assert.equal(calendar.enabled, false)
  assert.equal(calendar.configError, null, 'unset is not an error')
  assert.equal(await calendar.record(request.id), null, 'no row')
  assert.equal(outbox.forRequest(request.id).filter(message => message.type === 'calendar-failed').length, 0, 'no alert')
})
