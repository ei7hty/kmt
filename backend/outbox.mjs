import { randomBytes } from 'node:crypto'

import { InputError } from './inventory.mjs'

/**
 * The record of every email KMT has tried to send, real or not.
 *
 * t37's mail seam writes here whether or not a provider is configured: with
 * one, a row records what was actually sent and how the provider answered;
 * without one, a row records what would have been sent, status `unsent`, so
 * the flow is verifiable with no provider account and no real inbox. Either
 * way this module never decides what to send or when -- it only ever
 * remembers that something was recorded, which is what makes a failed send
 * visible on the owner's Outbox panel instead of silently swallowed.
 *
 * This module is the storage layer only: no template, no provider call, no
 * route. `backend/mail.mjs`'s `send()` and the four message bodies, and the
 * session-gated `GET /api/owner/outbox` panel, are their own pieces of t37,
 * built on top of `record()`/`list()`/`forRequest()` here.
 *
 * Every message carries the request it is about (`requestId`), indexed, so
 * "every message sent about this request" is a lookup rather than a
 * body-text search -- for a removal request, for showing Ken what was sent,
 * for debugging a failed send. What should happen to those messages under a
 * removal request (redacted, kept as historical record, or something else)
 * is not decided here; see docs/data-policy.md.
 */

/** Every status a message may hold. Widening this later is a migration, the same as quotes.status. */
export const OUTBOX_STATUSES = ['unsent', 'sent', 'failed']

/**
 * The current shape of the table, as one place both creation and migration use.
 *
 * `request_id` is nullable and unenforced by a foreign key on purpose: an
 * outbox row must never become impossible to write because the request it is
 * about was deleted or is momentarily unavailable inside a transaction, and
 * nothing here deletes a request in the first place. It exists so "every
 * message about this request" is a WHERE clause instead of a body-text
 * search -- for a removal request, for showing Ken what was sent about a
 * request, for debugging a failed send -- without deciding anything about
 * what should happen to a message once found. That decision (docs/data-policy.md)
 * is not this module's to make; not having the link would have made it for us.
 */
const OUTBOX_COLUMNS = `
  id TEXT PRIMARY KEY, request_id TEXT, to_address TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unsent', provider_id TEXT, error TEXT,
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
   * `status` defaults to `unsent` because that is the shape every message
   * starts in: written before the provider is asked, or written instead of
   * asking because none is configured. A caller that already knows the
   * outcome (a provider answered synchronously) may pass `sent` or `failed`
   * directly rather than recording twice.
   *
   * `requestId` is optional -- not every message a future caller records has
   * to be about one request -- but every message t37 sends today is, and
   * should carry it.
   */
  record({ to, subject, body, status = 'unsent', requestId = null, providerId = null, error = null }) {
    if (typeof to !== 'string' || !to.trim()) throw new InputError('An outbox message needs an address.')
    if (typeof subject !== 'string' || !subject.trim()) throw new InputError('An outbox message needs a subject.')
    if (typeof body !== 'string' || !body) throw new InputError('An outbox message needs a body.')
    if (!OUTBOX_STATUSES.includes(status)) throw new InputError(`status must be one of ${OUTBOX_STATUSES.join(', ')}.`)

    const id = randomBytes(16).toString('hex')
    const stamp = now()
    this.db.prepare(`INSERT INTO outbox (id, request_id, to_address, subject, body, status, provider_id, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requestId, to.trim(), subject, body, status, providerId, error, stamp, stamp)
    return this.get(id)
  }

  /**
   * Move a recorded message to `sent` or `failed`, once the provider (or its
   * absence) has answered.
   *
   * `providerId` is kept if a later call does not carry one, so a message
   * marked `sent` with the provider's id does not lose it if something later
   * updates only the error field.
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
      id: row.id, requestId: row.request_id ?? null, to: row.to_address, subject: row.subject, body: row.body,
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
   * `request_id`, not a search through free-text bodies. What happens to
   * what this finds (redacted, kept as historical record, or something else)
   * is a policy decision this method does not make.
   */
  forRequest(requestId) {
    if (typeof requestId !== 'string' || !requestId) return []
    return this.db.prepare('SELECT *, rowid FROM outbox WHERE request_id=? ORDER BY created_at DESC, rowid DESC')
      .all(requestId).map(row => this.shapeRow(row))
  }
}
