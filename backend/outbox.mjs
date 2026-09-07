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
 * The `metadata` key holding the instant this database started recording send
 * attempts. See the watermark note in the constructor for why it exists and
 * why it is written `INSERT OR IGNORE`.
 */
export const ATTEMPT_TRACKING_KEY = 'outboxAttemptTrackingFrom'

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
    // `attempted_at` (#285) is the third column of this shape, and it exists
    // because the two before it could not answer the question a retry has to
    // ask. A row is written `queued` *before* the provider is called and
    // updated after, so there is no record that an attempt began: a crash
    // between a successful send and `updateStatus` leaves `queued` on a
    // message that was actually delivered, and that row is byte-identical to
    // an ordinary null-adapter row (`status queued, error null, provider_id
    // null`). Measured, not reasoned about. So `WHERE status='queued'` is not
    // a broken query -- it is a question the schema could not answer, and a
    // retry built on it re-sends quotes that already arrived.
    //
    // Written immediately before `adapter.send()` in mail.mjs, which is what
    // makes it crash-safe by construction: the write that records the attempt
    // precedes the thing that can be interrupted, and nothing about it depends
    // on shutdown running. It also does double duty as the once-only guard --
    // an auto-retried row has it set, so it leaves the retryable set for good
    // and there is no attempt counter or backoff state to keep.
    const columns = new Set(this.db.prepare('PRAGMA table_info(outbox)').all().map(column => column.name))
    if (!columns.has('resolved_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN resolved_at TEXT')
    if (!columns.has('resolution_note')) this.db.exec('ALTER TABLE outbox ADD COLUMN resolution_note TEXT')
    if (!columns.has('attempted_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN attempted_at TEXT')
    // `resent_at` records the one case that needs explaining later: a message
    // that had already reached the provider being sent again, by hand, because
    // Ken judged that the customer never got the first one. `sent` means the
    // provider accepted it, not that anyone read it -- so this is a legitimate
    // action, and six months on it is the row rather than a rotated log line
    // that answers "why does this customer have two quote emails".
    //
    // Deliberately not a counter (ruled over-building for a one-man business
    // with rare failures) and deliberately not a status (orthogonal to what
    // the row IS, and widening that CHECK means a table rebuild). A nullable
    // timestamp answers the question actually asked -- did this happen, and
    // when -- and nothing more. Same plain guarded ALTER as the two above it.
    //
    // IT KEEPS THE FIRST STAMP WHERE `attempted_at` KEEPS THE LATEST, and the
    // inconsistency is the point rather than an oversight to tidy away:
    // **`attempted_at` answers "could this have arrived", which is about the
    // most recent attempt; `resent_at` answers "did we ever knowingly send a
    // second copy", which does not become more true afterwards.** Two fields,
    // two questions, two tense rules. Anyone making these consistent with each
    // other will break one of them.
    if (!columns.has('resent_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN resent_at TEXT')

    // And the watermark, which is the half that is easy to leave out.
    //
    // Every row written before that ALTER gets `attempted_at = NULL`, because
    // the column did not exist when it was recorded -- so `queued AND
    // attempted_at IS NULL` reads the whole of history as never-attempted and
    // therefore safe to resend. The column is only a discriminator for rows
    // written after it exists, and nothing in the column says where that line
    // falls. This records it: the instant attempt tracking began, once.
    //
    // `INSERT OR IGNORE`, never `INSERT OR REPLACE`, and the difference is the
    // whole mechanism. REPLACE would advance the watermark on every boot, so
    // each restart would exclude exactly the rows that restart had just
    // stranded -- a feature that passes every test and does nothing in
    // production. Write-once belongs in the SQL, not in a rule someone has to
    // remember. (Verified across three simulated boots before this shipped.)
    //
    // `metadata` is inventory.mjs's table but a shared key/value store by
    // construction -- `markup`, `pricing`, `pricingLines`, `seeded` and `job`
    // already sit there from unrelated concerns, so one more key from this
    // migration is the pattern rather than an exception. Guarded because
    // `Outbox` is constructed with a bare `db` in some tests: no metadata
    // table means no watermark, and `retryable()` then returns nothing, which
    // is the safe direction to fail.
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)')
      .run(ATTEMPT_TRACKING_KEY, JSON.stringify(now()))
  }

  /**
   * The instant this database began recording send attempts. Rows older than
   * it carry no information in `attempted_at` and are permanently out of
   * scope for any automatic retry.
   */
  attemptTrackingFrom() {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(ATTEMPT_TRACKING_KEY)
    return row ? JSON.parse(row.value) : null
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

  /**
   * `deliveryRisk` is the rule over `attempted_at`, computed here rather than
   * re-derived in the owner screen: what a resend of this row would risk.
   * `none` -- it never reached a provider, so sending it costs nothing.
   * `possible-duplicate` -- it was handed over and the outcome was never
   * recorded, so it may already have arrived.
   *
   * Server-side because it is a delivery fact, not a display choice. The same
   * null check written in a component is a second copy of the rule that
   * decides what `retryable()` will auto-send, and the two would drift the
   * first time either moved. Agreed with OWNER OPERATIONS ENGINEER, who maps
   * it straight to copy ("never sent" / "may have arrived") with no
   * derivation on their side.
   *
   * The wording is load-bearing, per the OWNER AGENT: *may have arrived*, not
   * *was sent once*. The second quietly becomes false once a row accumulates
   * more than one ambiguous attempt -- an original and a resend that is also
   * interrupted -- which is exactly the case nobody would go back and check.
   */
  shapeRow(row) {
    return {
      id: row.id, requestId: row.request_id, type: row.type, templateVersion: row.template_version,
      data: JSON.parse(row.data), to: row.to_address, toName: row.to_name,
      status: row.status, providerId: row.provider_id ?? null, error: row.error ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? null, resolutionNote: row.resolution_note ?? null,
      attemptedAt: row.attempted_at ?? null,
      deliveryRisk: row.attempted_at ? 'possible-duplicate' : 'none',
      resentAt: row.resent_at ?? null,
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
   * Stamp that an attempt is about to be made. Called immediately before the
   * provider is asked, never after -- the ordering is the whole point, since
   * the process can die inside the send and the row has to already say that
   * something was tried.
   *
   * Deliberately does not touch `updated_at`: that column is how long a send
   * took (`updated_at - created_at` across `sent` rows is what the drain
   * bound was derived from, and what DEV OPS's stranded-row threshold reads),
   * and moving it here would make every duration read as zero.
   *
   * NOT idempotent, unlike `resolve()` beside it, and the difference is
   * deliberate. This column reads "when was this last handed to a provider",
   * so a resend moves it. An earlier draft kept the first stamp -- a resend
   * never rewrites the record of the first try -- which sounds careful and
   * answers the wrong question: after Ken resends, *may this have arrived* is
   * about the resend, not about the attempt he already knows failed. Ruled by
   * the OWNER AGENT while this was in review.
   *
   * Nothing needs the first attempt's time: `created_at` still says when the
   * message was composed, `retryable()` only asks whether this is null, and an
   * attempt counter was ruled out as over-building for a one-man business with
   * rare failures. So one timestamp with one meaning, rather than two meanings
   * competing for one column.
   */
  markAttempted(id) {
    if (!this.get(id)) throw new InputError('No such outbox message.', 404)
    this.db.prepare('UPDATE outbox SET attempted_at=? WHERE id=?').run(now(), id)
    return this.get(id)
  }

  /**
   * Messages that are owed a send and are provably safe to send again.
   *
   * Four conditions, and every one of them is load-bearing -- this is the
   * query that decides whether a customer gets a second copy of a quote, so
   * each clause is a required equality on a value that is present rather than
   * a filter whose absent case passes:
   *
   * - `status='queued'` -- still owed. A `failed` row was attempted and
   *   rejected; re-sending it is Ken's decision through the owner screen, not
   *   this query's.
   * - `attempted_at IS NULL` -- never handed to a provider. The one clause
   *   that separates *never sent* from *may have arrived*, and the reason
   *   this column exists.
   * - `resolved_at IS NULL` -- nobody has settled it. Covers DB ADMIN's eight
   *   frozen pre-SMTP rows once their backfill runs (#367).
   * - `created_at >= :watermark` -- written after attempt tracking began.
   *   Covers those same eight independently, since they predate it. Two
   *   guards on that set on purpose: they do not fail together, one being a
   *   timestamp comparison and the other a column set by another mechanism.
   *
   * `>=` rather than `>`, decided rather than fallen into: the watermark is
   * written in this constructor, before the server accepts a connection, so
   * no row can predate it within the same process. A row sharing its
   * millisecond was written after tracking existed and is in scope. There is
   * a test on exactly that boundary.
   *
   * `type` is required, not optional, because the audience split is the
   * ruling this query serves: only `request-arrived` (the sole owner-audience
   * template) is ever retried automatically. Passing no type would quietly
   * mean "every type", which is the customer-facing double-send this whole
   * change exists to prevent -- so the absent case is a refusal, not a
   * default.
   *
   * `limit` is a safety cap on the returned set, not a recency window, the
   * same distinction `unresolvedFailures()` draws: hitting it means that many
   * messages were stranded at once, which is its own incident.
   */
  retryable({ type, limit = 25 } = {}) {
    if (typeof type !== 'string' || !type.trim()) throw new InputError('retryable() needs the message type to retry.')
    const watermark = this.attemptTrackingFrom()
    if (!watermark) return []
    return this.db.prepare(`SELECT *, rowid FROM outbox
        WHERE status='queued' AND attempted_at IS NULL AND resolved_at IS NULL
          AND created_at >= ? AND type = ?
        ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(watermark, type.trim(), limit).map(row => this.shapeRow(row))
  }

  /**
   * Stamp that an already-sent message was sent again by hand.
   *
   * Only ever called for a row that was `sent` -- a resend of a `queued` or
   * `failed` row is an ordinary retry and needs no explaining. Keeps the FIRST
   * such stamp rather than the latest, unlike `attempted_at`: `attempted_at`
   * answers "could this have arrived", which is about the most recent attempt,
   * while this answers "did we ever knowingly send a second copy", which is
   * about the first time it happened and does not become more true afterwards.
   *
   * Leaves `updated_at` alone for the same reason `markAttempted` does: that
   * column is how long a send took, and the status write that follows this
   * moves it anyway.
   */
  markResent(id) {
    const found = this.get(id)
    if (!found) throw new InputError('No such outbox message.', 404)
    if (found.resentAt) return found

    this.db.prepare('UPDATE outbox SET resent_at=? WHERE id=?').run(now(), id)
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
