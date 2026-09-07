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
 * `locationNotes`, `customerNotes`) replaced with the same marker the
 * request's own redaction uses, in the same transaction as that redaction.
 * `customerNotes` (t64, "anything else I should know?") is free text --
 * the field most likely to hold the thing a removal request is actually
 * about, a gate code or a note about where someone parks -- so it belongs
 * on this list as surely as `locationNotes` does, not as an afterthought
 * added once a customer asked. Everything
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
 *
 * `resolve()` and `unresolvedFailures()` are the same idea applied to
 * settling a row: acknowledging it without inventing a status for
 * "acknowledged," and reading back only what is still live rather than a
 * recency window filtered after the fact.
 */

/** Every status a message may hold. Widening this later is a migration, the same as quotes.status. */
export const OUTBOX_STATUSES = ['queued', 'sent', 'failed', 'bounced']

/**
 * Personal fields inside `data`, redacted together with `to_address` and
 * `to_name` on a removal request. Not this module's method to call (the
 * transaction spans `requests` too), but the list lives beside the schema it
 * describes rather than wherever that method ends up.
 */
export const OUTBOX_PERSONAL_DATA_KEYS = ['to_name', 'to_email', 'customerPhone', 'location', 'locationNotes', 'customerNotes']

/**
 * The real columns -- as distinct from the personal keys inside `data` this
 * module already names. `OUTBOX_PERSONAL_DATA_KEYS` does not cover them:
 * they are their own columns, not JSON keys, and a hand-list with only one
 * of its halves pinned is exactly the shape of gap #230 found in
 * `requests.payload`.
 *
 * `error` joined `to_address` and `to_name` here for a different reason than
 * they are here, and the reason is worth keeping. Those two are ours: we put
 * the address in them. `error` holds `String(error?.message)` from the mail
 * provider (`mail.mjs`), which is **unbounded text from a system we do not
 * control**, written into a row a removal request is supposed to clear. SMTP
 * replies to `RCPT TO` conventionally name the mailbox -- `550 5.1.1
 * <someone@example.com>: Recipient address rejected` is the ordinary shape --
 * so the failure path is the one that keeps the address the success path
 * never stored in prose. Its content is the provider's choice, not ours, and
 * that decides the classification whatever any particular bounce turns out
 * to say. Found by the completeness audit, `.forge/personal-data-removal.md`
 * finding 2; note that no bounce was produced against the live relay, so
 * this is classified on the mechanism rather than on a measured leak.
 *
 * If you change this list, `backend/redaction.mjs` picks the change up on its
 * own -- it builds its statement from this array rather than restating it --
 * but the fallback SQL in docs/operations.md's manual removal procedure is
 * hand-typed and does not. Update it there too.
 */
export const OUTBOX_REDACTED_COLUMNS = ['to_address', 'to_name', 'error']

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

/**
 * The optional sentence Ken types when he resolves a row -- the same
 * contract `quotes.mjs`'s `cleanReason` already holds a cancellation
 * reason to (nothing is a valid note; a non-string is refused, not
 * coerced; 500 characters, rejected rather than silently truncated, since
 * this is typed by a person through a form, not an internally-constructed
 * diagnostic string the way `error` is).
 */
function cleanNote(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new InputError('A resolution note must be text.')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > 500) throw new InputError('That note is too long.')
  return trimmed
}

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
    // `resolved_at` is nullable and carries no CHECK, unlike `status` --
    // widening that enum to a fifth "settled" value would mean the same
    // CHECK-rebuild migrate() does for quotes.status, for a concept that
    // is orthogonal to status rather than a value of it (a `queued` row
    // that was never attempted and a `failed` row from a closed incident
    // are both "not a live problem" without either one stopping being
    // what it was). A plain ALTER, the same guard quotes.mjs uses for
    // draft_line_items/decided_by.
    //
    // `resolution_note` is its own column, not a write into `error`: that
    // column holds `String(error?.message)` from the provider (a real
    // `535 5.7.8 ...`, the exact reason the alert has to name), and it is
    // in `OUTBOX_REDACTED_COLUMNS` because a bounce reply conventionally
    // echoes the recipient's address back. A resolution note is
    // operational text someone typed, not personal data and not a
    // provider's diagnostic -- mixing it into `error` would let a later
    // resolve() bury the forensic record under an explanation, and would
    // subject an operational note to a redaction path built for something
    // else entirely.
    const columns = new Set(this.db.prepare('PRAGMA table_info(outbox)').all().map(column => column.name))
    if (!columns.has('resolved_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN resolved_at TEXT')
    if (!columns.has('resolution_note')) this.db.exec('ALTER TABLE outbox ADD COLUMN resolution_note TEXT')
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
      resolvedAt: row.resolved_at ?? null, resolutionNote: row.resolution_note ?? null,
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
   * Mark one message settled: acknowledged, and not a live problem, without
   * claiming anything about `status` that isn't true. A `queued` row that
   * was never attempted stays `queued` -- it did not suddenly get sent --
   * and a `failed` row stays `failed` -- the attempt really was rejected.
   * `resolved_at` says only "someone looked at this and it's accounted
   * for," orthogonal to what happened.
   *
   * `note` goes to its own `resolution_note` column, never to `error`:
   * `error` is the provider's diagnostic (or empty, for a `queued` row
   * that was never attempted), and `resolve()` must not touch it in
   * either direction -- not overwriting a real `535 5.7.8 ...` with an
   * explanation, and not quietly filling a blank one either, since
   * `error` staying `null` on a settled `queued` row is the accurate
   * record that nothing was ever attempted.
   *
   * Idempotent: resolving an already-resolved row returns it unchanged
   * rather than erroring or overwriting `resolved_at`, so a correction
   * script can be re-run safely.
   *
   * `note` is cleaned the same way a cancellation reason is
   * (`cleanNote`/`cleanReason`, the same 500-character, text-only
   * contract): unlike `error`, which is always built internally from a
   * real `Error` and can be trusted to be a bounded string, `note`
   * reaches here from an HTTP body -- unvalidated, it would let `{ note:
   * 12345 }` land a number in a TEXT column and `{ note: {...} }` throw
   * inside `node:sqlite` as an unhandled 500, on the one route Ken
   * reaches for after something has already gone wrong.
   */
  resolve(id, note = null) {
    const cleaned = cleanNote(note)
    const found = this.get(id)
    if (!found) throw new InputError('No such outbox message.', 404)
    if (found.resolvedAt) return found

    this.db.prepare('UPDATE outbox SET resolved_at=?, resolution_note=?, updated_at=? WHERE id=?')
      .run(now(), cleaned, now(), id)
    return this.get(id)
  }

  /**
   * Failed messages nobody has settled -- what a monitor should actually
   * see, and not the same thing as "the failures within however many rows
   * of any status happened to be recent."
   *
   * `list()` is a recency window over every status, so a caller that reads
   * it and filters for `failed` is bounded by total traffic: enough `sent`/
   * `queued` rows between a failure and the next look pushes it out of
   * view, and that bound tightens as the business grows, silently. This
   * query is filtered at the source instead -- `WHERE status='failed' AND
   * resolved_at IS NULL` -- so the set it returns is bounded by how many
   * unresolved failures actually exist, not by how much unrelated mail was
   * sent since. `limit` is a safety cap for that set, not a recency window:
   * hitting it means there are that many live unresolved failures at once,
   * which is its own incident, not a windowing artifact.
   *
   * Deliberately `status='failed'`, not "any unresolved row" -- do not
   * widen this to include `queued`. `resolved_at` on a `queued` row means
   * something different (a request whose emails will never send because
   * six requests reached terminal states before this one could, not a
   * failure), and `queued` under the null adapter is `mail.mjs`'s ordinary
   * resting state whether or not it is ever resolved. Generalising this
   * query would make the watcher fire on rows that were never a problem in
   * the first place, exactly the false-alarm shape the DNS check and
   * #348 were both caught for tonight. `failed` never has that ambiguity,
   * which is the whole reason it needs no age threshold and this query
   * needs no case-by-case reading of `resolution_note` to tell the two
   * apart.
   */
  unresolvedFailures({ limit = 200 } = {}) {
    return this.db.prepare(
      "SELECT *, rowid FROM outbox WHERE status='failed' AND resolved_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(limit).map(row => this.shapeRow(row))
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
