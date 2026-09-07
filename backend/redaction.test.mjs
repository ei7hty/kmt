/**
 * Redaction: does a removal request actually remove everything, and nothing else?
 *
 * The classification tests below are written against the four exported lists
 * rather than against a hand-typed set of field names. That is deliberate:
 * a test that names the fields itself would pass forever after someone adds a
 * seventh personal key and forgets this file, which is the exact failure
 * `.forge/personal-data-removal.md` was written about. Adding a key to any
 * list makes these tests demand it be redacted, with no edit here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Inventory } from './inventory.mjs'
import { Inquiries, INQUIRY_PERSONAL_FIELDS } from './inquiries.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS, OUTBOX_REDACTED_COLUMNS } from './outbox.mjs'
import { Quotes, REQUEST_PERSONAL_DATA_KEYS } from './quotes.mjs'
import {
  isRedacted, planInquiryRedaction, planRequestRedaction,
  redactInquiry, redactRequest, REDACTED, tableExists, verifyRequestRedaction,
} from './redaction.mjs'

const SIZE = '215/60R16'
const REQUEST_ID = 'a'.repeat(32)
const STAMP = '2026-09-06T00:00:00.000Z'

/** Everything a real request carries, so a redaction has something to find in every field. */
const fullPayload = (overrides = {}) => ({
  vehicleInfo: '2021 Honda Civic', tireSelection: 'giga-a', quantity: 4,
  date: '2026-09-09', locationType: 'home', serviceZip: '02148',
  customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com',
  customerPhone: '+16174108319', location: '456 Demo Ave, Malden MA',
  locationNotes: 'Key is under the mat', customerNotes: 'Please text before arriving',
  ...overrides,
})

const quotePayload = { lineItems: [{ description: 'Tire', quantity: 4, unitPrice: 42.04 }], total: 218.15, exception: false, exceptionReasons: [] }

function setup(t, { payload = fullPayload(), withOutbox = true, withInquiries = false } = {}) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  const quotes = new Quotes(inventory)

  inventory.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
    .run(REQUEST_ID, 'b'.repeat(16), JSON.stringify(payload), STAMP, STAMP)
  inventory.db.prepare('INSERT INTO quotes (id, request_id, payload, status, version, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('q1', REQUEST_ID, JSON.stringify(quotePayload), 'cancelled', 3, 'Moving house, reach me on 617-555-0134 instead', STAMP, STAMP)

  let outbox = null
  if (withOutbox) {
    outbox = new Outbox(inventory.db)
    outbox.record({
      requestId: REQUEST_ID, type: 'quote-sent',
      data: {
        to_name: 'Jamie Rivera', to_email: 'jamie@example.com', customerPhone: '+16174108319',
        location: '456 Demo Ave, Malden MA', locationNotes: 'Key is under the mat',
        customerNotes: 'Please text before arriving',
        tire: 'giga-a', quantity: 4, total: 218.15, serviceZip: '02148',
      },
      to: 'jamie@example.com', toName: 'Jamie Rivera',
    })
    // A failed send, because the provider's own message is the field the
    // completeness audit found unclassified (finding 2).
    const failed = outbox.record({
      requestId: REQUEST_ID, type: 'payment-recorded',
      data: { to_name: 'Jamie Rivera', to_email: 'jamie@example.com', total: 218.15 },
      to: 'jamie@example.com', toName: 'Jamie Rivera',
    })
    outbox.updateStatus(failed.id, {
      status: 'failed',
      error: '550 5.1.1 <jamie@example.com>: Recipient address rejected: User unknown',
    })
  }

  const inquiries = withInquiries ? new Inquiries(inventory.db) : null
  return { inventory, quotes, outbox, inquiries, db: inventory.db }
}

const readRequest = db => JSON.parse(db.prepare('SELECT payload FROM requests WHERE id=?').get(REQUEST_ID).payload)
const readQuote = db => db.prepare('SELECT * FROM quotes WHERE request_id=?').get(REQUEST_ID)
const readMessages = db => db.prepare('SELECT * FROM outbox WHERE request_id=?').all(REQUEST_ID)

/* ------------------------------------------------------------- the happy path --- */

test('a removal blanks every classified request field and leaves the rest exactly as it was', t => {
  const { inventory, db } = setup(t)
  const before = readRequest(db)

  redactRequest(inventory, REQUEST_ID)

  const after = readRequest(db)
  for (const key of REQUEST_PERSONAL_DATA_KEYS) {
    assert.equal(after[key], REDACTED, `${key} is classified personal and must read as redacted`)
  }
  for (const key of Object.keys(before)) {
    if (REQUEST_PERSONAL_DATA_KEYS.includes(key)) continue
    assert.deepEqual(after[key], before[key], `${key} is not personal and must survive untouched`)
  }
})

test('the quote ledger survives in full: only the reason text moves', t => {
  const { inventory, db } = setup(t)
  const before = readQuote(db)

  redactRequest(inventory, REQUEST_ID)

  const after = readQuote(db)
  assert.equal(after.status, before.status, 'the decision itself is the ledger')
  assert.equal(after.version, before.version, 'the version is the ledger')
  assert.equal(after.created_at, before.created_at)
  assert.deepEqual(JSON.parse(after.payload), JSON.parse(before.payload), 'line items and total are the ledger')
  assert.equal(after.reason, REDACTED, 'free text attached to a decision is not the ledger')
})

test('the proof that the owner decided survives a removal, which is why redaction may never touch quotes.status', t => {
  const { inventory, db } = setup(t)
  db.prepare('UPDATE quotes SET status=?, version=? WHERE request_id=?').run('sent', 4, REQUEST_ID)

  redactRequest(inventory, REQUEST_ID)

  const after = readQuote(db)
  assert.equal(after.status, 'sent', 'the owner approval gate is what nothing may weaken')
  assert.equal(after.version, 4)
})

test('the browser key is not contact information and stays: revoking device access is a different ask', t => {
  const { inventory, db } = setup(t)
  redactRequest(inventory, REQUEST_ID)
  assert.equal(db.prepare('SELECT customer_key FROM requests WHERE id=?').get(REQUEST_ID).customer_key, 'b'.repeat(16))
})

test('every outbox column and data key a removal is responsible for is blanked, on every message', t => {
  const { inventory, db } = setup(t)
  redactRequest(inventory, REQUEST_ID)

  const messages = readMessages(db)
  assert.equal(messages.length, 2, 'both messages about this request')
  for (const message of messages) {
    for (const column of OUTBOX_REDACTED_COLUMNS) {
      assert.equal(message[column], REDACTED, `outbox.${column} is classified and must read as redacted`)
    }
    const data = JSON.parse(message.data)
    for (const key of OUTBOX_PERSONAL_DATA_KEYS) {
      assert.equal(data[key], REDACTED, `outbox data.${key} is classified and must read as redacted`)
    }
    assert.equal(data.total, 218.15, 'the business fields beside them are the record and survive')
  }
})

test("the provider's error text is redacted, because it is the failure path that keeps the address", t => {
  const { inventory, db } = setup(t)
  const before = readMessages(db).find(message => message.status === 'failed')
  assert.match(before.error, /jamie@example\.com/, 'the fixture reproduces an SMTP rejection naming the mailbox')

  redactRequest(inventory, REQUEST_ID)

  const after = readMessages(db).find(message => message.status === 'failed')
  assert.equal(after.error, REDACTED)
  assert.equal(after.status, 'failed', 'that the send failed is a record and survives')
})

test('the redacted request reads clean through the API path a customer link uses, not only in the table', t => {
  const { inventory, quotes } = setup(t)
  assert.ok(verifyRequestRedaction(quotes, REQUEST_ID).length > 0, 'the check can fail: it fails before the redaction')
  redactRequest(inventory, REQUEST_ID)
  assert.deepEqual(verifyRequestRedaction(quotes, REQUEST_ID), [], 'and passes after it')
})

/* ------------------------------------------------------------------ idempotence --- */

test('redacting an already-redacted request changes nothing and is not an error', t => {
  const { inventory, db } = setup(t)
  redactRequest(inventory, REQUEST_ID)
  const after = readRequest(db)

  assert.doesNotThrow(() => redactRequest(inventory, REQUEST_ID))
  assert.deepEqual(readRequest(db), after, 'the second pass is a no-op read straight off the row')
})

test('a plan for an already-redacted request reports nothing to do, so the operator is told rather than guessing', t => {
  const { inventory, db } = setup(t)
  assert.equal(planRequestRedaction(db, REQUEST_ID).empty, false)
  redactRequest(inventory, REQUEST_ID)
  assert.equal(planRequestRedaction(db, REQUEST_ID).empty, true)
})

/* ----------------------------------------------------------------- bad targets --- */

test('an unknown id is refused, and nothing is written', t => {
  const { inventory, db } = setup(t)
  const before = readRequest(db)
  assert.throws(() => redactRequest(inventory, 'f'.repeat(32)), /No request with id/)
  assert.deepEqual(readRequest(db), before)
})

test('a missing or empty id is refused before it reaches a WHERE clause', t => {
  const { inventory } = setup(t)
  for (const bad of [null, '', '   ', undefined, 42]) {
    assert.throws(() => redactRequest(inventory, bad), /needs the request id/)
  }
})

/* ------------------------------------------------------- rollback, and legacy rows --- */

test('a failure part-way through rolls the whole removal back: no request redacted without its messages', t => {
  const { inventory, db } = setup(t)
  const before = readRequest(db)
  const victim = readMessages(db)[1]
  // The failure has to happen *during* the write, not while planning, or this
  // proves nothing about the transaction. An earlier version of this test used
  // malformed JSON in a message's `data`, which reads like a mid-write failure
  // and is not one: `planRequestRedaction` parses every message before a single
  // row is touched, so it threw before any write and the test passed even with
  // the transaction removed. Caught by deleting the transaction and watching
  // this test still pass. A trigger fires where the write actually is.
  db.exec(`CREATE TRIGGER fail_second_message BEFORE UPDATE ON outbox
           WHEN old.id = '${victim.id}'
           BEGIN SELECT RAISE(ABORT, 'simulated failure part-way through'); END`)
  t.after(() => { try { db.exec('DROP TRIGGER IF EXISTS fail_second_message') } catch { /* db already closed */ } })

  assert.throws(() => redactRequest(inventory, REQUEST_ID), /simulated failure/)

  assert.deepEqual(readRequest(db), before, 'the request payload was rolled back')
  assert.equal(readQuote(db).reason, 'Moving house, reach me on 617-555-0134 instead', 'the quote reason was rolled back')
  assert.equal(readMessages(db)[0].to_address, 'jamie@example.com', 'the message redacted before the failure was rolled back too')
})

test('a message whose stored data is not JSON stops the removal before anything is written', t => {
  const { inventory, db } = setup(t)
  const before = readRequest(db)
  db.prepare('UPDATE outbox SET data=? WHERE id=?').run('{not json', readMessages(db)[1].id)

  assert.throws(() => redactRequest(inventory, REQUEST_ID))
  assert.deepEqual(readRequest(db), before, 'planning reads every message first, so a corrupt row refuses the whole removal')
})

test('a legacy row that never carried the newer fields redacts without a special case', t => {
  // Pre-#53 and pre-t64: no contact fields, no notes at all.
  const { inventory, db } = setup(t, {
    payload: { vehicleInfo: '2015 Ford F-150', tireSelection: 'giga-b', date: '2026-09-09' },
  })
  assert.doesNotThrow(() => redactRequest(inventory, REQUEST_ID))

  const after = readRequest(db)
  assert.equal(after.vehicleInfo, '2015 Ford F-150', 'what it did carry is untouched')
  for (const key of REQUEST_PERSONAL_DATA_KEYS) {
    assert.equal(after[key], REDACTED)
  }
  // Worth being explicit about, because it is a real cost of the policy's
  // "no special case" ruling: a field never collected now reads as removed.
  // docs/data-policy.md rules it; this pins it so it is visible, not a
  // surprise. Changing it is a policy call.
  assert.equal('customerNotes' in after, true, 'the marker is added even where nothing was collected')
})

test('a plan on a legacy row reports only the fields that actually hold something', t => {
  const { db } = setup(t, {
    payload: { vehicleInfo: '2015 Ford F-150', customerName: 'Jamie Rivera' },
  })
  assert.deepEqual(planRequestRedaction(db, REQUEST_ID).requestFields, ['customerName'])
})

/* ---------------------------------------------------------------- absent tables --- */

test('a database with no outbox table redacts the request and says the table is not there', t => {
  const { inventory, db } = setup(t, { withOutbox: false })
  assert.equal(tableExists(db, 'outbox'), false)

  const plan = planRequestRedaction(db, REQUEST_ID)
  assert.equal(plan.outboxTable, false)
  assert.deepEqual(plan.outbox, [])

  assert.doesNotThrow(() => redactRequest(inventory, REQUEST_ID))
  assert.equal(readRequest(db).customerName, REDACTED)
})

test('a database whose inquiries table was never created says so plainly rather than failing obscurely', t => {
  // t65 wired `Inquiries` into both entry points, so production has this table
  // now. A restored backup taken before that, or any database built without
  // the class, still does not -- and that is what this asserts. The setup here
  // deliberately does not construct `Inquiries`, which is also what keeps the
  // check honest: the table is absent because nothing made it, not because a
  // flag says so.
  const { db } = setup(t)
  assert.equal(tableExists(db, 'inquiries'), false)
  assert.throws(() => planInquiryRedaction(db, 'whatever'), /no inquiries table/)
})

/* -------------------------------------------------------------------- inquiries --- */

test('an inquiry redacts its classified fields and keeps what the inquiry was about', t => {
  const { inventory, inquiries, db } = setup(t, { withInquiries: true })
  const created = inquiries.create({
    name: 'Sam Okafor', contact: 'sam@example.com',
    vehicleInfo: '2018 Transit', message: 'Do you do fleet work?',
  })

  redactInquiry(inventory, created.id)

  const after = db.prepare('SELECT * FROM inquiries WHERE id=?').get(created.id)
  for (const field of INQUIRY_PERSONAL_FIELDS) {
    assert.equal(after[field], REDACTED, `${field} is classified and must read as redacted`)
  }
  assert.equal(after.vehicle_info, '2018 Transit', 'what it is about is not how to reach them')
  assert.equal(after.message, 'Do you do fleet work?')
})

test('redacting an inquiry twice is a no-op, and an unknown inquiry id is refused', t => {
  const { inventory, inquiries } = setup(t, { withInquiries: true })
  const created = inquiries.create({ name: 'Sam', contact: 'sam@example.com', message: 'Hello' })
  redactInquiry(inventory, created.id)
  assert.doesNotThrow(() => redactInquiry(inventory, created.id))
  assert.throws(() => redactInquiry(inventory, 'nope'), /No inquiry with id/)
})

/* ------------------------------------------------------------------ the marker --- */

test('one marker, exported, so a row fixed at a SQL prompt and a row fixed by code are indistinguishable', () => {
  assert.equal(REDACTED, '[redacted]', 'docs/operations.md types this same literal into its fallback SQL')
  assert.equal(isRedacted('[redacted]'), true)
  assert.equal(isRedacted(''), false, 'an empty field is "never collected", not "removed"')
  assert.equal(isRedacted(null), false)
})
