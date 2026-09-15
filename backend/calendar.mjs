import { createPrivateKey, createSign, randomBytes } from 'node:crypto'

import { InputError } from './inventory.mjs'

/**
 * A paid job, written into Ken's Google Calendar as an all-day entry.
 *
 * Phase A of the calendar work, and the line it must not cross is the one
 * the OWNER AGENT drew on 2026-09-13 (`.forge/decisions.md`): nothing the
 * customer sees changes, and nothing implies a confirmed time. The request
 * carries a preferred *day* (`quotes.mjs`'s `cleanDate`, a Massachusetts
 * calendar day, seven days out at least), so the entry is an all-day event on
 * that day, in a calendar of Ken's own, and the customer is told nothing
 * about it. Reading the calendar back to shape what a customer may pick is
 * the scheduling R6 rules out and is not here.
 *
 * **Why `paid`, and only `paid`.** Payment is still the fake step that always
 * succeeds (`project.md`), so `paid` is not a money event: it is the customer
 * confirming the job. `sent`/`approved` is an offer nobody has accepted, and
 * `paid` has no exit but `done`, so an entry made earlier would have nothing
 * to clean it up when the quote is declined.
 *
 * **Its own service account, its own two secrets, and a calendar shared
 * with it.** `KMT_CALENDAR_SERVICE_CLIENT` and `KMT_CALENDAR_PRIVATE_KEY`
 * are the `client_email` and `private_key` of a service-account JSON key
 * made for this feature alone, read here and nowhere else. **They are not
 * the mail secrets.** `mail.mjs` can run on a delegated service account,
 * but production mail does not: it is password SMTP (`KMT_MAIL_SMTP_*`),
 * and `KMT_MAIL_SERVICE_CLIENT` / `KMT_MAIL_PRIVATE_KEY` do not exist on
 * the machine -- an earlier draft of this file said "the same key mail
 * uses" and sent the OWNER AGENT looking for a credential that was never
 * there. There is deliberately no fallback to the mail names: in production
 * they hold an SMTP host and a mailbox password, and handing those to a JWT
 * signer would fail while naming the wrong thing. Two systems, two
 * credentials, either revocable without taking the other down.
 *
 * A calendar Ken creates and shares with that account's address ("make
 * changes to events") lets the key write events with no Admin-console scope
 * change: least privilege (one calendar, not anyone's identity across the
 * domain), and revocation is Ken un-sharing one calendar in a screen he
 * already knows, with nothing to deploy. The token exchange is the standard
 * service-account JWT grant, signed here with node:crypto -- no new
 * dependency, per `AGENTS.md`.
 *
 * **Failure posture, same as mail: recorded, never blocking.** A calendar
 * write happens after the payment has been answered, and a failure is a row
 * in `calendar_events` with status `failed` *and* an email to Ken through
 * the mailer (`calendar-failed`), because a log line is not somewhere he
 * looks and the first he would otherwise know is a customer on a doorstep.
 *
 * **What is stored, and what is not.** The local row keeps the calendar id
 * beside the event id (so a removal request can still find the event if
 * `KMT_CALENDAR_ID` is ever changed), the status, the error, and timestamps.
 * It never keeps the event's text: the name, address, phone and notes live in
 * Google and in the request row, which the existing redaction already
 * blanks. Deleting the Google event is the redaction's job for this table
 * (`scripts/redact.mjs`), through `forget()` below.
 *
 * Off is the default. With `KMT_CALENDAR_ID` unset `createCalendar` returns
 * a calendar whose `after()` does nothing and records nothing, and the boot
 * line says so; the branch is inert until the secret exists.
 */

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/calendar/v3'
/** Wide enough for a slow Google round trip, short enough not to hold a shutdown. */
const REQUEST_TIMEOUT_MS = 15_000
/** How much of a provider's error body the row and the log keep. */
const ERROR_LIMIT = 500

/** Every status a calendar row may hold. Widening this later is a migration, the same as quotes.status. */
export const CALENDAR_EVENT_STATUSES = ['created', 'failed', 'deleted', 'delete-failed']

const now = () => new Date().toISOString()

/**
 * Read the calendar configuration from the environment, or say it is off.
 *
 * Four cases, and the two in the middle are refused on purpose:
 *
 * - `KMT_CALENDAR_ID` unset: `null`. Off. The normal state until Ken has
 *   created and shared the calendar, and the server must boot in it.
 * - `KMT_CALENDAR_ID` set with a calendar secret missing: a misconfigured
 *   deploy, refused at boot the same way SMTP without its addresses is.
 *   Failing per-event instead would record `failed` on every paid job
 *   forever with nothing at boot saying why. The message names the two
 *   secrets, where they come from, and that the mail secrets are not them.
 * - Both calendar secrets set but the key does not parse: refused at boot
 *   too, and told apart from "missing" -- a key pasted with its newlines
 *   lost, or a client id/secret pair (an OAuth client, not a service
 *   account) in the key's place, is the most likely state on the first
 *   deploy, and "invalid_grant" from Google an hour later would not say so.
 * - All present and parseable: on.
 *
 * The mail names are never read here, and that is not an oversight to fix.
 */
export const CALENDAR_SECRETS_HINT = 'KMT_CALENDAR_SERVICE_CLIENT and KMT_CALENDAR_PRIVATE_KEY are the client_email and ' +
  'private_key of the calendar service account\'s JSON key file. The mail secrets (KMT_MAIL_*) are not them and are not read for this.'

export function readCalendarConfig(env = process.env) {
  const calendarId = (env.KMT_CALENDAR_ID || '').trim()
  if (!calendarId) return null
  const serviceClient = (env.KMT_CALENDAR_SERVICE_CLIENT || '').trim()
  const privateKey = (env.KMT_CALENDAR_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim()
  if (!serviceClient || !privateKey) {
    const missing = [!serviceClient && 'KMT_CALENDAR_SERVICE_CLIENT', !privateKey && 'KMT_CALENDAR_PRIVATE_KEY'].filter(Boolean).join(' and ')
    throw new Error(`KMT_CALENDAR_ID is set but ${missing} is not. ${CALENDAR_SECRETS_HINT} Set both, or unset KMT_CALENDAR_ID.`)
  }
  try {
    createPrivateKey(privateKey)
  } catch (error) {
    throw new Error(`KMT_CALENDAR_PRIVATE_KEY is set but is not a private key this server can sign with (${error.message}). ${CALENDAR_SECRETS_HINT} ` +
      'Paste the private_key value whole, PEM header to footer; newlines may be literal or written as \\n.', { cause: error })
  }
  return { calendarId, serviceClient, privateKey }
}

/** The boot line for the calendar: what a person confirms before believing an event exists. */
export function describeCalendar(config) {
  if (!config) return 'Calendar: KMT_CALENDAR_ID unset; paid jobs are not added to any calendar.'
  return `Calendar: paid jobs are added as all-day events to ${config.calendarId} by service account ${config.serviceClient}.`
}

const base64url = value => Buffer.from(value).toString('base64url')

/**
 * The signed JWT a service account trades for an access token.
 *
 * RS256 over `header.claims`, exactly the shape Google's token endpoint
 * checks. No `sub`: the account acts as itself on a calendar shared with
 * it, not as an impersonated user -- that is the whole reason the
 * delegation scope is not needed. `now` is injectable so a test can pin the
 * timestamps.
 */
export function signAssertion({ serviceClient, privateKey, scope = CALENDAR_SCOPE, now: at = () => Date.now() }) {
  const issuedAt = Math.floor(at() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: serviceClient, scope, aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  return `${header}.${claims}.${signer.sign(privateKey, 'base64url')}`
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * `dateStr` (YYYY-MM-DD) advanced by whole calendar days, in `Date.UTC` so
 * no daylight-saving transition can shorten a day -- the same arithmetic
 * `quotes.mjs` uses for the date floor, for the same reason.
 */
function addCalendarDays(dateStr, days) {
  const [, year, month, day] = DATE_PATTERN.exec(dateStr).map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/**
 * The event body for one paid request, as the Calendar API wants it.
 *
 * All-day: `start.date` is the preferred day and `end.date` is the day
 * after, which is how the API spells "one whole day" (end is exclusive).
 * The title says what and for whom, the location is the service address
 * so Ken's phone can navigate to it, and the description carries the rest
 * plus the link back to the request. The customer's email is left out:
 * nothing in a calendar entry needs it, and the request holds it.
 *
 * Pure: no clock, no network, no database, so a test can hold it to the
 * exact shape.
 */
export function eventFor({ request, quote, tire, origin }) {
  if (!DATE_PATTERN.test(request?.date ?? '')) throw new InputError('A calendar event needs the request\'s preferred date as YYYY-MM-DD.')
  const tireName = tire?.name ?? quote?.lineItems?.[0]?.description ?? 'tires'
  const size = tire?.size ? ` (${tire.size})` : ''
  const quantity = request.quantity ?? quote?.lineItems?.[0]?.quantity ?? null
  const what = `${quantity ? `${quantity} × ` : ''}${tireName}${size}`
  const lines = [
    what,
    `Customer: ${request.customerName ?? 'not given'}`,
    `Phone: ${request.customerPhone ?? 'not given'}`,
    `Vehicle: ${request.vehicleInfo || 'not given'}`,
    `Where: ${[request.locationType, request.location].filter(Boolean).join(' — ') || 'not given'}`,
  ]
  if (request.locationNotes && String(request.locationNotes).trim()) lines.push(`Location notes: ${String(request.locationNotes).trim()}`)
  if (request.customerNotes && String(request.customerNotes).trim()) lines.push(`Anything else: ${String(request.customerNotes).trim()}`)
  if (quote?.total != null) lines.push(`Total: $${Number(quote.total).toFixed(2)}`)
  lines.push('', `Request: ${origin}/owner/quotes?request=${encodeURIComponent(request.id)}`)
  return {
    summary: `${what} — ${request.customerName ?? 'customer'}`,
    location: request.location ?? undefined,
    description: lines.join('\n'),
    start: { date: request.date },
    end: { date: addCalendarDays(request.date, 1) },
    extendedProperties: { private: { kmtRequestId: request.id } },
  }
}

/**
 * Which of the three gates is shut, said in words Ken can act on.
 *
 * Between this server and an event on the calendar stand three separate
 * grants, and each fails differently: the service account's key must be
 * accepted (the token exchange), the Calendar API must be enabled on its
 * project, and the calendar must be shared with the service account's
 * address with write access. A single "calendar write failed" would hide
 * which one -- and a check that cannot tell which gate is shut is a check
 * that will one day report them all open. So the row's error and Ken's
 * alert lead with the gate, then carry Google's own words after it.
 *
 * One honest limit: a wrong calendar id and a calendar not shared with the
 * service account at all both come back from Google as 404. The message
 * says so rather than picking one.
 */
export function explainRefusal(status, body, at) {
  const text = String(body ?? '')
  if (at === 'token') {
    return `Google refused the service account's credentials at the token exchange (${status}). ${CALENDAR_SECRETS_HINT} Both must come from one key file, and the key must not have been deleted in the Cloud console.`
  }
  if (status === 403 && /accessNotConfigured|has not been used in project|is disabled/i.test(text)) {
    return 'The Google Calendar API is not enabled on the service account\'s project (403 accessNotConfigured): enable it in the Cloud console.'
  }
  if (status === 403) {
    return 'The service account may not change this calendar (403): share it with the service account\'s address with "Make changes to events", not a read-only share.'
  }
  if (status === 404) {
    return 'Google shows this service account no calendar under KMT_CALENDAR_ID (404): either the id is wrong, or the calendar is not shared with the service account\'s address at all -- Google answers both the same way, so check the share first, then the id.'
  }
  return null
}

const withReason = (why, detail) => (why ? `${why} ` : '') + detail

/**
 * The HTTPS half: one access token at a time, refreshed a minute early, and
 * the two Calendar calls this feature needs. `fetch` is injectable so the
 * tests never open a socket and can answer whatever Google might.
 */
export class GoogleCalendarClient {
  name = 'google'

  constructor(config, { fetch: fetchFn = globalThis.fetch, now: at = () => Date.now() } = {}) {
    this.config = config
    this.fetch = fetchFn
    this.now = at
    this.token = null
  }

  async accessToken() {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value
    const assertion = signAssertion({ serviceClient: this.config.serviceClient, privateKey: this.config.privateKey, now: this.now })
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(withReason(explainRefusal(response.status, text, 'token'), `Google token exchange answered ${response.status}: ${text.slice(0, ERROR_LIMIT)}`))
    const parsed = JSON.parse(text)
    if (!parsed.access_token) throw new Error('Google token exchange answered without an access_token.')
    this.token = { value: parsed.access_token, expiresAt: this.now() + Number(parsed.expires_in ?? 3600) * 1000 }
    return this.token.value
  }

  async call(method, path, payload) {
    const token = await this.accessToken()
    const response = await this.fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(withReason(explainRefusal(response.status, text, 'calendar'), `Google Calendar answered ${response.status} on ${method} ${path}: ${text.slice(0, ERROR_LIMIT)}`))
    return text ? JSON.parse(text) : null
  }

  /** Create one event; returns Google's id for it. */
  async insert(calendarId, event) {
    const created = await this.call('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, event)
    if (!created?.id) throw new Error('Google Calendar created an event but answered without its id.')
    return created.id
  }

  /**
   * Every event in a calendar that this server made for one request, by the
   * private property `eventFor` stamps on each one -- whether or not the
   * local table has a row for it. This is what makes a removal reach an
   * event the table never recorded (see `Calendar.forget`).
   */
  async findByRequest(calendarId, requestId) {
    const query = `privateExtendedProperty=${encodeURIComponent(`kmtRequestId=${requestId}`)}&showDeleted=false&maxResults=250`
    const listed = await this.call('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${query}`)
    return (listed?.items ?? []).map(item => item.id).filter(Boolean)
  }

  /** Delete one event. An event Google already lost (404/410) counts as deleted: the goal is that it is gone. */
  async remove(calendarId, eventId) {
    try {
      await this.call('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
    } catch (error) {
      if (!/answered (404|410) /.test(error.message)) throw error
    }
  }
}

/** Does nothing, records nothing. What an unset `KMT_CALENDAR_ID` means. */
export class NullCalendarClient {
  name = 'none'
}

/**
 * The table, as one place both the server and the redaction script read.
 * Created if missing on every open, additive only: a database from before
 * this feature gains the table and nothing else changes.
 */
export function ensureCalendarTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL, event_id TEXT,
      status TEXT NOT NULL, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(status IN (${CALENDAR_EVENT_STATUSES.map(status => `'${status}'`).join(', ')}))
    );
    CREATE INDEX IF NOT EXISTS calendar_events_request ON calendar_events(request_id);
  `)
}

const shapeRow = row => row && ({
  id: row.id, requestId: row.request_id, calendarId: row.calendar_id, eventId: row.event_id,
  status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
})

/** The rows for one request, oldest first. Works on a read-only handle: the redaction plan uses it. */
export function calendarEventsFor(db, requestId) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_events'").get()) return []
  return db.prepare('SELECT * FROM calendar_events WHERE request_id=? ORDER BY created_at').all(requestId).map(shapeRow)
}

export class Calendar {
  constructor({ db, quotes, client, config = null, mailer = null, origin = '', log = console.log }) {
    this.db = db
    this.quotes = quotes
    this.client = client
    this.config = config
    this.mailer = mailer
    this.origin = origin
    this.log = log
    this.inFlight = new Set()
    ensureCalendarTable(db)
  }

  get enabled() {
    return Boolean(this.config) && this.client.name !== 'none'
  }

  forRequest(requestId) {
    return calendarEventsFor(this.db, requestId)
  }

  insertRow({ requestId, calendarId, eventId, status, error = null }) {
    const id = randomBytes(16).toString('hex')
    const stamp = now()
    this.db.prepare(`INSERT INTO calendar_events (id, request_id, calendar_id, event_id, status, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requestId, calendarId, eventId, status, error, stamp, stamp)
    return shapeRow(this.db.prepare('SELECT * FROM calendar_events WHERE id=?').get(id))
  }

  updateRow(id, { status, error = null }) {
    if (!CALENDAR_EVENT_STATUSES.includes(status)) throw new InputError(`status must be one of ${CALENDAR_EVENT_STATUSES.join(', ')}.`)
    this.db.prepare('UPDATE calendar_events SET status=?, error=?, updated_at=? WHERE id=?').run(status, error, now(), id)
    return shapeRow(this.db.prepare('SELECT * FROM calendar_events WHERE id=?').get(id))
  }

  /**
   * Add the paid job for one request to the calendar. Returns the row, or
   * null when there was nothing to do: the feature is off, the request is
   * unknown or not paid, or an event already exists for it.
   *
   * The last guard matters because `pay()` answers a repeated POST with the
   * same paid quote, and the API fires this on every one: without it a
   * second tap on the pay button would put the job in Ken's day twice.
   *
   * Never throws past this line: a provider failure is a `failed` row and an
   * email to Ken. The request is read as the owner sees it, because the
   * customer shape carries no name, address or phone (t44).
   */
  async record(requestId) {
    if (!this.enabled) return null
    const found = this.quotes.get(requestId, 'owner')
    if (!found?.request || found.quote?.status !== 'paid') return null
    if (this.forRequest(requestId).some(row => row.status === 'created' || row.status === 'delete-failed')) return null
    const { request, quote } = found
    const tire = this.quotes.catalog().find(item => item.id === request.tireSelection) ?? null
    const { calendarId } = this.config
    try {
      const event = eventFor({ request, quote, tire, origin: this.origin })
      const eventId = await this.client.insert(calendarId, event)
      const row = this.insertRow({ requestId, calendarId, eventId, status: 'created' })
      this.log(`calendar: created ${row.id} for request ${requestId} on ${request.date} event=${eventId}`)
      return row
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, ERROR_LIMIT)
      const row = this.insertRow({ requestId, calendarId, eventId: null, status: 'failed', error: message })
      this.log(`calendar: FAILED ${row.id} for request ${requestId}: ${message}`)
      if (this.mailer) this.mailer.after('calendar-failed', requestId, { calendarId, reason: message.split('\n')[0].slice(0, 320) })
      return row
    }
  }

  /**
   * Fire-and-forget form for the API: the payment is already answered, so
   * the caller never awaits this. Tracked so a shutdown can drain it, the
   * same shape as `Mailer.after()`.
   */
  after(requestId) {
    const task = this.record(requestId).catch(error => this.log(`calendar: record for ${requestId} threw: ${error.message}`))
    this.inFlight.add(task)
    task.finally(() => this.inFlight.delete(task))
    return task
  }

  /** Wait for every in-flight write, including ones started while waiting (see `Mailer.idle()` for why it loops). */
  async idle() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
  }

  /**
   * Remove a request's events from Google, for a data-removal request.
   *
   * Returns `{ deleted, swept, failed, pending }`: how many were removed by
   * their rows, how many more were found in the calendar itself and removed
   * (below), how many Google refused (their rows say `delete-failed` with
   * the error), and how many could not even be attempted because the feature
   * is off here -- those stay `created` and the caller must say so, loudly,
   * because the event still exists somewhere this process cannot reach. A
   * row already `deleted` or `failed` (no event was ever made) is not
   * counted.
   *
   * THE SWEEP, and why the rows alone are not enough. `record()` asks Google
   * to create the event and only then writes the row, so a process that dies
   * between the two -- or a send that times out after Google has already
   * created the event and is recorded `failed` -- leaves an event Google
   * holds and the table does not. The privacy notice promises a removal
   * request deletes the calendar entry, and a promise kept "unless the
   * server crashed at the wrong millisecond" is not the promise made. So a
   * removal also asks each calendar this request could have been written to
   * (the configured one, and every one a row names) for events stamped with
   * this request's id, and deletes any it finds, recording a `deleted` row
   * for each so the removal leaves the same record a clean run would. A
   * sweep the calendar refuses counts as `failed`: the caller must not say
   * the removal is complete on a calendar it could not read.
   */
  async forget(requestId) {
    const rows = this.forRequest(requestId).filter(row => row.status === 'created' || row.status === 'delete-failed')
    const summary = { deleted: 0, swept: 0, failed: 0, pending: 0, rows }
    for (const row of rows) {
      if (!this.enabled) { summary.pending += 1; continue }
      try {
        await this.client.remove(row.calendarId, row.eventId)
        this.updateRow(row.id, { status: 'deleted' })
        summary.deleted += 1
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, ERROR_LIMIT)
        this.updateRow(row.id, { status: 'delete-failed', error: message })
        this.log(`calendar: delete FAILED ${row.id} event=${row.eventId}: ${message}`)
        summary.failed += 1
      }
    }
    if (!this.enabled) return summary

    const calendars = new Set([this.config.calendarId, ...this.forRequest(requestId).map(row => row.calendarId)])
    const known = new Set(this.forRequest(requestId).map(row => row.eventId).filter(Boolean))
    for (const calendarId of calendars) {
      let found
      try {
        found = await this.client.findByRequest(calendarId, requestId)
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, ERROR_LIMIT)
        this.log(`calendar: sweep FAILED calendar=${calendarId} request=${requestId}: ${message}`)
        summary.failed += 1
        continue
      }
      for (const eventId of found) {
        if (known.has(eventId)) continue
        try {
          await this.client.remove(calendarId, eventId)
          this.insertRow({ requestId, calendarId, eventId, status: 'deleted', error: 'found by the removal sweep; no row had recorded it' })
          this.log(`calendar: swept event=${eventId} for request ${requestId} from ${calendarId}`)
          summary.swept += 1
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, ERROR_LIMIT)
          this.insertRow({ requestId, calendarId, eventId, status: 'delete-failed', error: `found by the removal sweep; ${message}` })
          this.log(`calendar: sweep delete FAILED event=${eventId}: ${message}`)
          summary.failed += 1
        }
      }
    }
    return summary
  }
}

/** The calendar for a server or a script: on or off by configuration, nothing else. */
export function createCalendar({ db, quotes, mailer = null, env = process.env, origin = '', fetch: fetchFn = globalThis.fetch, log = console.log }) {
  const config = readCalendarConfig(env)
  const client = config ? new GoogleCalendarClient(config, { fetch: fetchFn }) : new NullCalendarClient()
  return new Calendar({ db, quotes, client, config, mailer, origin, log })
}
