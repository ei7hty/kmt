import { InputError } from './inventory.mjs'
import { newId } from './quotes.mjs'

/**
 * t65: "more than tires" -- a short inquiry a visitor leaves for work Ken
 * does beyond tires. Name, a way to reach them, what they need, the vehicle
 * if it matters to the job. This module owns the table and the schema
 * decisions that shape it; `POST /api/inquiries` (the route: validation
 * wiring, rate limits, response shape) and the owner screen's Inquiries list
 * are their own pieces of t65, built on `create()`/`get()`/`list()` here.
 *
 * A standalone table, not a request's sibling: an inquiry is not about a
 * tire, carries no `request_id`, and references nothing else in this
 * database. Real, typed columns rather than a JSON `payload` blob -- unlike
 * `requests`, whose wizard shape has grown and reshuffled fields more than
 * once, four fixed fields with no history of changing shape do not need a
 * blob's flexibility, and a column the code reads by name is one `PRAGMA
 * table_info` and one migration test can prove present, the way a JSON key
 * cannot be.
 *
 * No status, no category, no CHECK constraint on anything here -- the same
 * question asked and answered the same way for outbox's `type` in #157:
 * what is actually settled today, and what is a taxonomy someone else's
 * route or screen has not written yet. A workflow (new/contacted/closed?) or
 * a category (which kind of "more than tires" work?) is exactly that kind of
 * guess, and a CHECK constraint written before the vocabulary exists is a
 * migration someone else will have to run to fix a guess of mine. If
 * `POST /api/inquiries` or the owner screen need either, that is a schema
 * change to make when the vocabulary is real, the same way `quotes.status`
 * only widens when a status is actually added (`.forge/owner-backend.md`).
 *
 * Personal data: `name` and `contact` identify a specific person the way
 * `requests`' name/email/phone/location do, and docs/data-policy.md
 * documents them the same way -- a future removal request redacts by this
 * row's own `id` (there is no `request_id` to pair through, unlike outbox),
 * `UPDATE inquiries SET name=?, contact=?, updated_at=? WHERE id=?`, leaving
 * `vehicle_info`, `message` and the timestamps untouched. `vehicle_info`
 * stays for the same reason `requests.vehicleInfo` stays: it is what the job
 * is about, weakly identifying on its own, and the detail Ken needs if the
 * same person calls back. `message` -- what they said they need -- is the
 * substance of the inquiry itself, not a way to reach or identify them, so
 * it stays too. `INQUIRY_PERSONAL_FIELDS` names the two that don't, so a
 * future redaction implementation (not written here -- neither `requests`
 * nor `outbox` has one yet either; see docs/data-policy.md) has one place to
 * read the list from rather than re-deciding it.
 */
export const INQUIRY_PERSONAL_FIELDS = ['name', 'contact']

const now = () => new Date().toISOString()

const LIMITS = { name: 200, contact: 254, vehicleInfo: 200, message: 2000 }

/** Deliberately permissive: catches typos, not RFC edge cases (matches quotes.mjs's own). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Not a strict phone validator -- just enough digits to not be a name typed into the wrong box. */
const looksLikePhone = value => (value.match(/\d/g) || []).length >= 7

function cleanName(value) {
  if (typeof value !== 'string') throw new InputError('name must be text.')
  const trimmed = value.trim()
  if (!trimmed) throw new InputError('A name is required.')
  if (trimmed.length > LIMITS.name) throw new InputError(`name must be ${LIMITS.name} characters or fewer.`)
  return trimmed
}

/** "Phone or email" is one field, not two -- whichever the visitor has to hand. */
function cleanContact(value) {
  if (typeof value !== 'string') throw new InputError('contact must be text.')
  const trimmed = value.trim()
  if (!trimmed) throw new InputError('A phone number or email is required.')
  if (trimmed.length > LIMITS.contact) throw new InputError(`contact must be ${LIMITS.contact} characters or fewer.`)
  if (!EMAIL_PATTERN.test(trimmed) && !looksLikePhone(trimmed)) {
    throw new InputError('Enter a phone number or an email address.')
  }
  return trimmed
}

/** Optional: absent stores as null, distinct from an empty string someone actually typed. */
function cleanVehicleInfo(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new InputError('vehicleInfo must be text.')
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > LIMITS.vehicleInfo) throw new InputError(`vehicleInfo must be ${LIMITS.vehicleInfo} characters or fewer.`)
  return trimmed
}

function cleanMessage(value) {
  if (typeof value !== 'string') throw new InputError('message must be text.')
  const trimmed = value.trim()
  if (!trimmed) throw new InputError('Say what you need.')
  if (trimmed.length > LIMITS.message) throw new InputError(`message must be ${LIMITS.message} characters or fewer.`)
  return trimmed
}

/** The single place a stored row becomes an API shape -- same discipline as quotes.mjs's shapeRow. */
function shapeRow(row) {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    vehicleInfo: row.vehicle_info,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class Inquiries {
  /**
   * `db` is the same `node:sqlite` handle everything else here shares
   * (`inventory.db`), not a second file -- one thing on the volume, one
   * thing to back up, one thing t54's restore-integrity check has to know
   * about (`.forge/restore-integrity-check.mjs`).
   */
  constructor(db) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL,
        vehicle_info TEXT, message TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
  }

  create(input) {
    const name = cleanName(input?.name)
    const contact = cleanContact(input?.contact)
    const vehicleInfo = cleanVehicleInfo(input?.vehicleInfo)
    const message = cleanMessage(input?.message)
    const id = newId()
    const at = now()
    this.db.prepare(`
      INSERT INTO inquiries (id, name, contact, vehicle_info, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, contact, vehicleInfo, message, at, at)
    return this.get(id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM inquiries WHERE id=?').get(id)
    return row ? shapeRow(row) : null
  }

  /**
   * Oldest first, matching the owner screen's brief. `rowid` breaks a tie
   * between two inquiries left in the same millisecond -- outbox.test.mjs
   * caught the same gap the hard way (a passing suite until two inserts
   * landed close enough together to sort arbitrarily), so it is here from
   * the start rather than added after the same test fails once more.
   */
  list() {
    return this.db.prepare('SELECT * FROM inquiries ORDER BY created_at ASC, rowid ASC').all().map(shapeRow)
  }
}
