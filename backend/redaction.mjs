/**
 * Fulfilling a customer's removal request, in code rather than by hand.
 *
 * `/privacy` promises, in production, that a customer can have their name,
 * contact details and address removed. Until this module existed the only
 * way to keep that promise was hand-typed SQL against production
 * (`docs/operations.md`), copied from four constant lists it could not stay
 * in step with. `.forge/personal-data-removal.md` is the inventory and the
 * argument; this is the mechanism it recommends.
 *
 * ## Why the whole operation is in one module
 *
 * The four lists stay where they are -- each beside the schema it describes,
 * which is deliberate and worth keeping. What lives here is everything that
 * *acts* on them: the marker, the per-table redactions, and the transaction
 * that makes a request and its outbox messages redact together or not at all.
 *
 * That gives one import direction (this module reads the lists; nothing reads
 * back) and one place where atomicity and the marker are decided. The
 * alternative -- a method on each class plus a coordinator -- needs the marker
 * in a fifth place and lets three classes disagree about what "redacted"
 * means. `docs/data-policy.md` proposes hanging it off `Quotes`; that is
 * rejected here for a narrower reason: `Quotes` would have to reach into two
 * schemas it does not own to do it.
 *
 * ## What this deliberately is not
 *
 * **Not an HTTP endpoint, and must not become one.** It is reached by
 * `scripts/redact.mjs` over `flyctl ssh`, so the authorisation is a human with
 * machine access rather than one shared password on the public internet
 * (#286's acceptance criteria say so, and the repository is public now).
 *
 * **Not a delete.** R27 governs the row and is not weakened: what moves is a
 * handful of fields inside rows that stay. The quote ledger -- status,
 * version, total, line items, timestamps -- is never touched, so the proof
 * that the owner approved a quote survives a removal intact. See
 * `docs/data-policy.md` for the policy and `.forge/personal-data-removal.md`
 * for why the ledger and the prose attached to a decision are different
 * things.
 *
 * **Not a schema change.** Every field written here already exists, so there
 * is no `migrate()` and no migration test. If a future change to this file
 * needs a column, it needs both.
 */

import { INQUIRY_PERSONAL_FIELDS } from './inquiries.mjs'
import { InputError } from './inventory.mjs'
import { OUTBOX_PERSONAL_DATA_KEYS, OUTBOX_REDACTED_COLUMNS } from './outbox.mjs'
import { REQUEST_PERSONAL_DATA_KEYS } from './quotes.mjs'

/**
 * What a removed field reads as afterwards.
 *
 * A literal, not an empty string and not a deleted key, so a reader can tell
 * "this was removed" from "this was never collected". `docs/operations.md`
 * types the same string into its fallback SQL by hand; it is exported here so
 * a row fixed at a SQL prompt and a row redacted by this code are
 * indistinguishable afterwards, which is what that document asks for and
 * could not previously guarantee.
 */
export const REDACTED = '[redacted]'

/** Already handled? Redaction is idempotent, and this is how that is read off the row. */
export const isRedacted = value => value === REDACTED

const now = () => new Date().toISOString()

/**
 * Does this database have this table?
 *
 * Not every database this runs against has every table. `outbox` and
 * `inquiries` were both added after requests and quotes were already live,
 * so a restored backup, or a copy taken before either shipped, can be missing
 * one. A removal must treat that as "nothing of theirs is here", not as a
 * failure: absence is the correct answer for that database, not a fault for
 * whoever happens to look to repair.
 *
 * And it must not create the table on the way past -- which is the second
 * reason the CLI inspects through a read-only handle. Each of these tables is
 * created by its owning class's constructor, so merely opening a database
 * read-write through one of them brings the table into existence; on a copy
 * being examined, that silently makes the file disagree with the production
 * it was taken from. `inquiries` was the live example of this until t65 wired
 * `Inquiries` into both entry points (`server.mjs`, `dev.mjs`); the hazard is
 * unchanged for the next table added the same way.
 */
export const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))

/**
 * Overwrite `keys` in a parsed object, reporting which ones actually held
 * something first.
 *
 * Every key in the list is written whether or not it was present, which is
 * `docs/data-policy.md`'s explicit ruling ("Redacting an already-absent field
 * is the same write as redacting a present one -- there is no special case").
 * Worth knowing that this has a cost the policy does not name: a legacy row
 * that never carried `customerNotes` ends up carrying `customerNotes:
 * '[redacted]'`, which reads as "this was removed" about something never
 * collected. Pinned by a legacy-row test so the behaviour is visible rather
 * than surprising; changing it is a policy call, not a code call.
 */
function overwrite(object, keys) {
  const had = []
  for (const key of keys) {
    if (key in object && !isRedacted(object[key]) && object[key] !== null && object[key] !== '') had.push(key)
    object[key] = REDACTED
  }
  return had
}

/**
 * What a removal would do, computed without writing anything.
 *
 * Read-only by construction so the CLI's default pass can run against a
 * read-only handle. The plan is also what gets printed before a write is
 * allowed: #286 requires the command to name its exact target first.
 */
export function planRequestRedaction(db, requestId) {
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new InputError('A removal needs the request id it applies to.')
  }
  const id = requestId.trim()
  const row = db.prepare('SELECT id, payload, updated_at FROM requests WHERE id=?').get(id)
  if (!row) throw new InputError(`No request with id ${id}.`, 404)

  const payload = JSON.parse(row.payload)
  const requestFields = REQUEST_PERSONAL_DATA_KEYS.filter(
    key => key in payload && !isRedacted(payload[key]) && payload[key] !== null && payload[key] !== '',
  )

  // Why a quote was rejected or cancelled: free text, written by the owner
  // *and* by the customer through the public cancel endpoint, and the field a
  // leaving customer is most likely to type something personal into. The
  // decision itself -- status, version, total, line items, timestamps -- is
  // the ledger and is untouched; the prose attached to it is not the ledger.
  // See `.forge/personal-data-removal.md`, finding 1.
  const reasons = db.prepare('SELECT id, reason FROM quotes WHERE request_id=?').all(id)
    .filter(quote => quote.reason !== null && !isRedacted(quote.reason))

  const messages = []
  if (tableExists(db, 'outbox')) {
    for (const message of db.prepare('SELECT id, data, to_address, to_name, error FROM outbox WHERE request_id=?').all(id)) {
      const data = JSON.parse(message.data)
      const dataKeys = OUTBOX_PERSONAL_DATA_KEYS.filter(
        key => key in data && !isRedacted(data[key]) && data[key] !== null && data[key] !== '',
      )
      const columns = OUTBOX_REDACTED_COLUMNS.filter(column => !isRedacted(message[column]) && message[column] !== null)
      if (dataKeys.length || columns.length) messages.push({ id: message.id, dataKeys, columns })
    }
  }

  return {
    kind: 'request',
    id,
    requestFields,
    quoteReasons: reasons.map(quote => quote.id),
    outbox: messages,
    outboxTable: tableExists(db, 'outbox'),
    get empty() {
      return !this.requestFields.length && !this.quoteReasons.length && !this.outbox.length
    },
  }
}

/** The same, for an inquiry -- which nothing links to a request, so it is found by its own id. */
export function planInquiryRedaction(db, inquiryId) {
  if (typeof inquiryId !== 'string' || !inquiryId.trim()) {
    throw new InputError('A removal needs the inquiry id it applies to.')
  }
  const id = inquiryId.trim()
  if (!tableExists(db, 'inquiries')) throw new InputError('This database has no inquiries table.', 404)
  const row = db.prepare('SELECT * FROM inquiries WHERE id=?').get(id)
  if (!row) throw new InputError(`No inquiry with id ${id}.`, 404)

  const fields = INQUIRY_PERSONAL_FIELDS.filter(field => !isRedacted(row[field]) && row[field] !== null && row[field] !== '')
  return { kind: 'inquiry', id, fields, get empty() { return !this.fields.length } }
}

/**
 * Apply a plan. Caller supplies the transaction; nothing here commits.
 *
 * Split from planning so the write is one statement sequence with no reads
 * that could see a different database than the plan did, and so a partial
 * failure -- a malformed `data` blob on one outbox row, say -- rolls the
 * whole thing back rather than leaving a request redacted and its sent
 * messages not.
 */
function applyPlan(db, plan) {
  const stamp = now()
  if (plan.kind === 'inquiry') {
    const row = db.prepare('SELECT * FROM inquiries WHERE id=?').get(plan.id)
    if (!row) throw new InputError(`No inquiry with id ${plan.id}.`, 404)
    const assignments = INQUIRY_PERSONAL_FIELDS.map(field => `${field}=?`).join(', ')
    db.prepare(`UPDATE inquiries SET ${assignments}, updated_at=? WHERE id=?`)
      .run(...INQUIRY_PERSONAL_FIELDS.map(() => REDACTED), stamp, plan.id)
    return { inquiries: 1 }
  }

  const request = db.prepare('SELECT payload FROM requests WHERE id=?').get(plan.id)
  if (!request) throw new InputError(`No request with id ${plan.id}.`, 404)
  const payload = JSON.parse(request.payload)
  overwrite(payload, REQUEST_PERSONAL_DATA_KEYS)
  db.prepare('UPDATE requests SET payload=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(payload), stamp, plan.id)

  let reasons = 0
  for (const quote of db.prepare('SELECT id, reason FROM quotes WHERE request_id=?').all(plan.id)) {
    if (quote.reason === null || isRedacted(quote.reason)) continue
    db.prepare('UPDATE quotes SET reason=?, updated_at=? WHERE id=?').run(REDACTED, stamp, quote.id)
    reasons += 1
  }

  let messages = 0
  if (tableExists(db, 'outbox')) {
    // Every column and key is written on every matched row, not only the ones
    // the plan found non-empty: the plan is a report for a human, and the
    // write must not depend on it having been computed against the same
    // moment. Idempotent either way -- the same literal twice is a no-op.
    const columnAssignments = OUTBOX_REDACTED_COLUMNS.map(column => `${column}=?`).join(', ')
    for (const message of db.prepare('SELECT id, data FROM outbox WHERE request_id=?').all(plan.id)) {
      const data = JSON.parse(message.data)
      overwrite(data, OUTBOX_PERSONAL_DATA_KEYS)
      db.prepare(`UPDATE outbox SET ${columnAssignments}, data=?, updated_at=? WHERE id=?`)
        .run(...OUTBOX_REDACTED_COLUMNS.map(() => REDACTED), JSON.stringify(data), stamp, message.id)
      messages += 1
    }
  }

  return { requests: 1, quoteReasons: reasons, outbox: messages }
}

/**
 * Plan and apply in one transaction, on a writable database.
 *
 * `inventory` is anything carrying `transaction()` and `db` -- the `Inventory`
 * every entry point already builds. `BEGIN IMMEDIATE` there takes the write
 * lock up front, so a refresh running in the same process cannot interleave.
 */
export function redactRequest(inventory, requestId) {
  return inventory.transaction(() => applyPlan(inventory.db, planRequestRedaction(inventory.db, requestId)))
}

export function redactInquiry(inventory, inquiryId) {
  return inventory.transaction(() => applyPlan(inventory.db, planInquiryRedaction(inventory.db, inquiryId)))
}

/**
 * Read a redacted request back the way the customer's own link does, and
 * confirm nothing personal survived.
 *
 * `docs/operations.md` already tells the operator to check the API rather
 * than the table, because a row blanked in `sqlite3` that still answers with
 * the old name over `GET /api/requests/:id` has not been removed from the one
 * point of view that matters. This holds the code to the same check: it reads
 * through `Quotes.get(id, 'owner')`, the widest audience, so a field the
 * customer shape would have hidden anyway cannot pass by being invisible.
 *
 * Returns the list of fields that still hold something, which should be empty.
 */
export function verifyRequestRedaction(quotes, requestId) {
  const found = quotes.get(requestId, 'owner')
  if (!found?.request) throw new InputError(`No request with id ${requestId}.`, 404)
  const remaining = REQUEST_PERSONAL_DATA_KEYS.filter(key => {
    const value = found.request[key]
    return value !== undefined && value !== null && value !== '' && !isRedacted(value)
  })
  const reasons = found.quote && found.quote.reason !== null && !isRedacted(found.quote.reason)
    ? ['quote.reason'] : []
  return [...remaining, ...reasons]
}
