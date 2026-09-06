import { randomBytes } from 'node:crypto'

import { InputError } from './inventory.mjs'

/**
 * The record of every email KMT has tried to send, real or not.
 *
 * t37's mail seam writes here whether or not a provider is configured: with
 * one, a row records what was actually sent and how the provider answered;
 * without one, a row records what would have been sent, status `queued`, so
 * the flow is verifiable with no provider account and no real inbox. This
 * module never decides what to send, when, or what a message says -- it
 * only ever remembers that something was recorded, which is what makes a
 * failed send visible on the owner's Outbox panel instead of silently
 * swallowed.
 *
 * The store is structure, not prose. `mail.mjs` renders a template against
 * `data` at send time and hands the result to the provider; **the rendered
 * body is never persisted**. If a failed send needs debugging later, the
 * row's `data` and the template it names reproduce exactly what was sent --
 * which is also what makes redaction exact rather than approximate: there is
 * no free-text body for a removal request to half-scrub. A partial text
 * scrub looks complete and is not; a structured field either is redacted or
 * is not, and which is checkable.
 *
 * So a removal request redacts by `request_id` with a `WHERE` clause, no
 * text matching: `to_address`, `to_name`, and the personal keys inside
 * `data` (`to_name`, `to_email`, `customerPhone`, `location`,
 * `locationNotes`) replaced with the same marker the request's own
 * redaction uses, in the same transaction as that redaction. Everything
 * else -- `type`, `templateVersion`, the business fields inside `data`
 * (tire, size, quantity, unit price, lines, total, date, service ZIP,
 * request id, status), `status`, `providerId`, the timestamps -- survives:
 * which message, when, about which request, sent or bounced, at what total.
 * Both halves of docs/data-policy.md's promise hold at once: the message is
 * still there as a record, and the person's details are gone from it.
 * Building that cross-table transaction is not this module's job -- it is
 * wherever the request's own redaction lives -- but the columns exist so it
 * is a `WHERE` clause when it is built, not a schema change.
 *
 * This module is the storage layer only: no template, no provider call, no
 * route. `backend/mail.mjs`'s `send()` and the five message templates, and
 * the session-gated `GET /api/owner/outbox` panel, are their own pieces of
 * t37, built on top of `record()`/`list()`/`forRequest()` here.
 */

/** Every status a message may hold. Widening this later is a migration, the same as quotes.status. */
export const OUTBOX_STATUSES = ['queued', 'sent', 'failed', 'bounced']

/**
 * Personal fields inside `data`, redacted together with `to_address` and
 * `to_name` on a removal request. Not this module's method to call (the
 * transaction spans `requests` too), but the list lives beside the schema it
 * describes rather than wherever that method ends up.
 */
export const OUTBOX_PERSONAL_DATA_KEYS = ['to_name', 'to_email', 'customerPhone', 'location', 'locationNotes']

/**
 * The current shape of the table, as one place both creation and migration use.
 *
 * `request_id` is NOT NULL with a foreign key, the same as `quotes.request_id`
 * -- every message this table has ever needed to hold is about a request, and
 * a message about nothing is not a case worth a nullable column for. `type`
 * has no CHECK: the five message types are `mail.mjs`'s taxonomy to name and
 * document, not a value this module can guess correctly today without
 * risking a legitimate type failing a constraint written before it existed.
 * `data` is the template's rendering context, JSON, including a copy of the
 * recipient's name and email alongside the business fields -- `to_address`/
 * `to_name` are their own columns too because sending needs them without
 * parsing JSON first.
 */
const OUTBOX_COLUMNS = `
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
  type TEXT NOT NULL, template_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL,
  to_address TEXT NOT NULL, to_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(status IN (${OUTBOX_STATUSES.map(status => `'${status}'`).join(', ')}))
`

const now = () => new Date().toISOString()

export class Outbox {
  /**
   * `db` is the same `node:sqlite` handle everything else here shares --
   * `inventory.db`, the way `Quotes` and `createSessionStore` take it, not a
   * second database file. One file on the volume, one thing to back up.
   */
  constructor(db) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (${OUTBOX_COLUMNS});
      CREATE INDEX IF NOT EXISTS outbox_request ON outbox(request_id);
    `)
  }

  /**
   * Record one message, sent or not.
   *
   * `status` defaults to `queued` because that is the shape every message
   * starts in: written before the provider is asked, or written instead of
   * asking because none is configured. A caller that already knows the
   * outcome (a provider answered synchronously) may pass `sent` or `failed`
   * directly rather than recording twice.
   *
   * `data` is stored as given, stringified -- this module does not know the
   * template's fields and must not invent opinions about them. It is the
   * caller's job to put the personal keys under the names
   * `OUTBOX_PERSONAL_DATA_KEYS` expects, so a later redaction can find them.
   */
  record({ requestId, type, templateVersion = 1, data, to, toName, status = 'queued', providerId = null, error = null }) {
    if (typeof requestId !== 'string' || !requestId) throw new InputError('An outbox message needs the request it is about.')
    if (typeof type !== 'string' || !type.trim()) throw new InputError('An outbox message needs a type.')
    if (!Number.isInteger(templateVersion) || templateVersion < 1) throw new InputError('templateVersion must be a positive integer.')
    if (data === undefined || data === null || typeof data !== 'object') throw new InputError('An outbox message needs its rendering data.')
    if (typeof to !== 'string' || !to.trim()) throw new InputError('An outbox message needs an address.')
    if (typeof toName !== 'string' || !toName.trim()) throw new InputError('An outbox message needs a recipient name.')
    if (!OUTBOX_STATUSES.includes(status)) throw new InputError(`status must be one of ${OUTBOX_STATUSES.join(', ')}.`)

    const id = randomBytes(16).toString('hex')
    const stamp = now()
    this.db.prepare(`INSERT INTO outbox
        (id, request_id, type, template_version, data, to_address, to_name, status, provider_id, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requestId, type.trim(), templateVersion, JSON.stringify(data), to.trim(), toName.trim(), status, providerId, error, stamp, stamp)
    return this.get(id)
  }

  /**
   * Move a recorded message to `sent`, `failed` or `bounced`, once the
   * provider (or its absence) has answered.
   *
   * `providerId` is kept if a later call does not carry one, so a message
   * marked `sent` with the provider's id does not lose it if something later
   * updates only the error field (a bounce arriving after the send, say).
   */
  updateStatus(id, { status, providerId = null, error = null }) {
    if (!OUTBOX_STATUSES.includes(status)) throw new InputError(`status must be one of ${OUTBOX_STATUSES.join(', ')}.`)
    if (!this.get(id)) throw new InputError('No such outbox message.', 404)

    this.db.prepare(`UPDATE outbox SET status=?, provider_id=COALESCE(?, provider_id), error=?, updated_at=? WHERE id=?`)
      .run(status, providerId, error, now(), id)
    return this.get(id)
  }

  shapeRow(row) {
    return {
      id: row.id, requestId: row.request_id, type: row.type, templateVersion: row.template_version,
      data: JSON.parse(row.data), to: row.to_address, toName: row.to_name,
      status: row.status, providerId: row.provider_id ?? null, error: row.error ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  /** One message by id. */
  get(id) {
    if (typeof id !== 'string' || !id) return null
    const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(id)
    return row ? this.shapeRow(row) : null
  }

  /**
   * Recent messages, newest first, for the owner's Outbox panel.
   *
   * Ordered by `created_at` and then by `rowid`: two messages recorded in
   * the same millisecond -- the submit and owner-alert emails t37 sends
   * together are exactly this case -- would otherwise sort in whichever
   * order SQLite happens to return equal timestamps, which is not
   * necessarily the order they were recorded in. `rowid` only breaks ties;
   * `created_at` is still the primary order a reader sees.
   */
  list({ limit = 50 } = {}) {
    return this.db.prepare('SELECT *, rowid FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit).map(row => this.shapeRow(row))
  }

  /**
   * Every message recorded about one request, newest first.
   *
   * The lookup a removal request, a debugging session, or an owner asking
   * "what did we send about this" all need -- an indexed WHERE clause over
   * `request_id`, not a search through anything free-text, because there is
   * no free-text body to search.
   */
  forRequest(requestId) {
    if (typeof requestId !== 'string' || !requestId) return []
    return this.db.prepare('SELECT *, rowid FROM outbox WHERE request_id=? ORDER BY created_at DESC, rowid DESC')
      .all(requestId).map(row => this.shapeRow(row))
  }
}
