import { randomBytes } from 'node:crypto'

import { InputError } from './inventory.mjs'
import { catalogFromLiveRows } from '../src/data/catalog.js'
import { calculateDraftQuote } from '../src/pricing.js'

/**
 * Requests and the quotes drafted for them.
 *
 * Until now these lived in the customer's browser, which meant a request no
 * owner could see and a quote no other device could read. They move here, into
 * the database that already holds inventory, because the draft has to be
 * computed over the catalog this process already serves -- and because a second
 * store would be infrastructure with no payoff at this size.
 *
 * The quote is drafted by calculateDraftQuote from src/pricing.js, imported
 * unchanged, the way this backend already imports markup and the catalog. One
 * pricing implementation, so the server and the screen cannot disagree about
 * what a customer was told.
 *
 * Access is by unguessable id, or by the key of the browser that submitted:
 * there is no listing without one, and no accounts. See decisions.md.
 */

const now = () => new Date().toISOString()

/** 128 bits from the platform CSPRNG: not guessable, not enumerable. */
export const newId = () => randomBytes(16).toString('hex')

const FORM_FIELDS = [
  'vehicleInfo',
  'tireSelection',
  'location',
  'date',
  'locationType',
  'serviceZip',
  'locationNotes',
]

/** Bounded so a request cannot carry an essay. */
const LIMITS = {
  vehicleInfo: 200, tireSelection: 200, location: 300, date: 40,
  locationType: 40, serviceZip: 20, locationNotes: 1000,
}

const REQUIRED = ['vehicleInfo', 'tireSelection', 'location', 'date']

function cleanCustomerKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{16,64}$/i.test(value.trim())) {
    throw new InputError('A customer key is required, and must be the one this browser was given.')
  }
  return value.trim().toLowerCase()
}

/**
 * Validate what the form submits.
 *
 * The same shape of check saveOffer makes: refuse on the way in, with a message
 * a person could act on, rather than storing something the rest of the system
 * has to keep making excuses for.
 */
function cleanRequest(input) {
  if (!input || typeof input !== 'object') throw new InputError('Send the request as an object.')

  const cleaned = {}
  for (const field of FORM_FIELDS) {
    const value = input[field]
    if (value === undefined || value === null) { cleaned[field] = ''; continue }
    if (typeof value !== 'string') throw new InputError(field + ' must be text.')
    const trimmed = value.trim()
    if (trimmed.length > LIMITS[field]) throw new InputError(field + ' is too long.')
    cleaned[field] = trimmed
  }

  for (const field of REQUIRED) {
    if (!cleaned[field]) throw new InputError(field + ' is required.')
  }
  return cleaned
}

export class Quotes {
  constructor(inventory) {
    this.inventory = inventory
    this.db = inventory.db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_customer ON requests(customer_key, created_at);
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK(status IN ('draft', 'approved', 'rejected', 'paid'))
      );
      CREATE INDEX IF NOT EXISTS quotes_request ON quotes(request_id);
    `)
  }

  /** The catalog the customer was shown: live rows, composed the way the flow composes them. */
  catalog() {
    return catalogFromLiveRows(this.inventory.catalog())
  }

  transaction(fn) {
    return this.inventory.transaction(fn)
  }

  /**
   * Store a request and the quote drafted for it, in one transaction.
   *
   * A request without its quote is a customer waiting for a reply nobody
   * drafted, so neither row exists unless both do.
   */
  submit(input) {
    const customerKey = cleanCustomerKey(input?.customerKey)
    const request = cleanRequest(input)

    const catalog = this.catalog()
    if (!catalog.some(tire => tire.id === request.tireSelection)) {
      throw new InputError('That tire is not one we currently offer. Choose another.')
    }

    const id = newId()
    const stamp = now()
    const draft = calculateDraftQuote({ ...request, id }, catalog)

    return this.transaction(() => {
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
        .run(id, customerKey, JSON.stringify(request), stamp, stamp)
      this.db.prepare('INSERT INTO quotes VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), id, JSON.stringify(draft), 'draft', 1, stamp, stamp)
      return this.get(id)
    })
  }

  shapeRow(row) {
    if (!row) return null
    const quote = this.db
      .prepare('SELECT * FROM quotes WHERE request_id=? ORDER BY created_at DESC')
      .get(row.id)
    return {
      request: {
        id: row.id, ...JSON.parse(row.payload),
        createdAt: row.created_at, updatedAt: row.updated_at,
      },
      quote: quote
        ? {
            id: quote.id, requestId: quote.request_id, ...JSON.parse(quote.payload),
            status: quote.status, version: quote.version,
            createdAt: quote.created_at, updatedAt: quote.updated_at,
          }
        : null,
    }
  }

  /** One request by id alone: holding the id is the access. */
  get(id) {
    if (typeof id !== 'string' || !id) return null
    return this.shapeRow(this.db.prepare('SELECT * FROM requests WHERE id=?').get(id))
  }

  /** Everything one browser submitted, newest first, and nobody else's. */
  listForCustomer(customerKey) {
    const key = cleanCustomerKey(customerKey)
    return this.db
      .prepare('SELECT * FROM requests WHERE customer_key=? ORDER BY created_at DESC')
      .all(key)
      .map(row => this.shapeRow(row))
  }

  /**
   * Every request with its quote, newest first, for the owner's screen.
   *
   * The tire is resolved here rather than on the screen: the quote was drafted
   * against a catalog that may since have changed, and the owner reviewing it
   * should see the tire that was quoted. A row the catalog no longer carries
   * still shows its id, because "this tire is gone" is information the owner
   * needs, not a reason to render a blank.
   */
  listForOwner() {
    const catalog = this.catalog()
    return this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all().map(row => {
      const shaped = this.shapeRow(row)
      const tire = catalog.find(item => item.id === shaped.request.tireSelection) ?? null
      return {
        ...shaped,
        tire: tire
          ? { id: tire.id, name: tire.name, size: tire.size, price: tire.price }
          : { id: shaped.request.tireSelection, name: null, size: null, price: null },
      }
    })
  }

  /**
   * Approve or reject a draft.
   *
   * The version check is the one PUT /api/owner/offers/:id already makes, for
   * the same reason: two owner windows, or a phone and a laptop, and the second
   * save would otherwise silently overwrite a decision made in the first. A
   * stale version is a 409 and the caller reloads.
   *
   * Only a draft can be decided. Re-approving an approved quote, or rejecting
   * one the customer has already paid, is not a decision -- it is a screen that
   * was looking at something out of date, which is what the version says.
   */
  decide(id, decision, version) {
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new InputError('A quote is either approved or rejected.')
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new InputError('Send the version you were shown, so a stale screen cannot overwrite a newer decision.')
    }

    return this.transaction(() => {
      const found = this.get(id)
      if (!found?.quote) throw new InputError('No such request.', 404)
      if (found.quote.version !== version) {
        throw new InputError('This quote changed in another window. Reload the list before deciding.', 409)
      }
      if (found.quote.status !== 'draft') {
        throw new InputError(`This quote is already ${found.quote.status}, so there is nothing to decide.`, 409)
      }

      this.db.prepare('UPDATE quotes SET status=?, version=version+1, updated_at=? WHERE id=?')
        .run(decision, now(), found.quote.id)
      return this.get(id)
    })
  }

  keyFor(id) {
    return this.db.prepare('SELECT customer_key FROM requests WHERE id=?').get(id)?.customer_key ?? null
  }

  /**
   * Mark an approved quote paid.
   *
   * Payment is still the fake step that always succeeds, but the result is
   * recorded here so both sides see it from their own devices. A draft cannot
   * be paid: that would be a customer paying a price the owner has not agreed
   * to. A wrong key is answered "no such request" rather than "not yours",
   * because the second sentence confirms the request exists.
   */
  pay(id, customerKey) {
    const key = cleanCustomerKey(customerKey)
    const stored = this.keyFor(id)
    if (stored === null || stored !== key) throw new InputError('No such request.', 404)

    const found = this.get(id)
    if (!found?.quote) throw new InputError('No such request.', 404)
    if (found.quote.status === 'paid') return found
    if (found.quote.status !== 'approved') {
      throw new InputError('This quote has not been approved yet, so there is nothing to pay.', 409)
    }

    return this.transaction(() => {
      this.db.prepare('UPDATE quotes SET status=?, version=version+1, updated_at=? WHERE id=?')
        .run('paid', now(), found.quote.id)
      return this.get(id)
    })
  }
}
