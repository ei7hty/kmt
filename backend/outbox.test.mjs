import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Inventory } from './inventory.mjs'
import { Outbox, OUTBOX_STATUSES } from './outbox.mjs'

const SIZE = '215/60R16'

function setup(t) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  return new Outbox(inventory.db)
}

test('a message is recorded unsent by default, and read back whole', t => {
  const outbox = setup(t)
  const message = outbox.record({ to: 'jamie@example.com', subject: 'We received your request', body: 'Thanks, Jamie.' })
  assert.match(message.id, /^[0-9a-f]{32}$/, 'a 128-bit id, not a guessable one')
  assert.equal(message.to, 'jamie@example.com')
  assert.equal(message.status, 'unsent')
  assert.equal(message.providerId, null)
  assert.equal(message.error, null)
  assert.equal(outbox.get(message.id).body, 'Thanks, Jamie.')
})

test('an address, a subject and a body are all required', t => {
  const outbox = setup(t)
  assert.throws(() => outbox.record({ subject: 'x', body: 'x' }), /needs an address/)
  assert.throws(() => outbox.record({ to: '  ', subject: 'x', body: 'x' }), /needs an address/)
  assert.throws(() => outbox.record({ to: 'a@example.com', body: 'x' }), /needs a subject/)
  assert.throws(() => outbox.record({ to: 'a@example.com', subject: 'x' }), /needs a body/)
})

test('a status outside unsent, sent and failed is refused, on record and on update', t => {
  const outbox = setup(t)
  assert.throws(() => outbox.record({ to: 'a@example.com', subject: 'x', body: 'x', status: 'bounced' }), /status must be one of/)
  const message = outbox.record({ to: 'a@example.com', subject: 'x', body: 'x' })
  assert.throws(() => outbox.updateStatus(message.id, { status: 'delivered' }), /status must be one of/)
  assert.deepEqual(OUTBOX_STATUSES, ['unsent', 'sent', 'failed'])
})

test('updateStatus moves a message to sent or failed, and keeps a provider id a later call omits', t => {
  const outbox = setup(t)
  const message = outbox.record({ to: 'a@example.com', subject: 'x', body: 'x' })

  const sent = outbox.updateStatus(message.id, { status: 'sent', providerId: 'resend-123' })
  assert.equal(sent.status, 'sent')
  assert.equal(sent.providerId, 'resend-123')

  // A later update that names no provider id must not erase the one already
  // recorded -- the id is evidence of what happened, not a field to blank.
  const again = outbox.updateStatus(message.id, { status: 'sent' })
  assert.equal(again.providerId, 'resend-123', 'the earlier provider id survives an update that says nothing about it')

  const failed = outbox.record({ to: 'b@example.com', subject: 'x', body: 'x' })
  const failedResult = outbox.updateStatus(failed.id, { status: 'failed', error: 'provider timed out' })
  assert.equal(failedResult.status, 'failed')
  assert.equal(failedResult.error, 'provider timed out')
})

test('updating a message that does not exist is refused rather than silently doing nothing', t => {
  const outbox = setup(t)
  assert.throws(() => outbox.updateStatus('0'.repeat(32), { status: 'sent' }), /No such outbox message/)
})

test('list answers recent messages newest first, and respects a limit', t => {
  const outbox = setup(t)
  for (let i = 0; i < 5; i++) {
    outbox.record({ to: `c${i}@example.com`, subject: `subject ${i}`, body: 'x' })
  }
  const all = outbox.list()
  assert.equal(all.length, 5)
  assert.equal(all[0].to, 'c4@example.com', 'newest first')
  assert.equal(all[4].to, 'c0@example.com')

  const limited = outbox.list({ limit: 2 })
  assert.equal(limited.length, 2)
  assert.deepEqual(limited.map(m => m.to), ['c4@example.com', 'c3@example.com'])
})

/* --------------------------------------------------- the migration case --- */

/**
 * The deployed database, exactly as it stands today: the tables Inventory
 * and Quotes already create, real rows in them, and no `outbox` table at
 * all -- because this PR is what adds it. Everything opened is closed in one
 * hook, before the directory goes: Windows will not delete a file something
 * still holds, and WAL means the database is three of them.
 */
function deployedDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kmt-outbox-migration-'))
  const opened = []
  t.after(() => {
    for (const handle of opened.reverse()) { try { handle.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const file = join(dir, 'kmt.db')
  const seed = new DatabaseSync(file)
  seed.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX supplier_size ON supplier(size);
    CREATE TABLE offers (id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER, enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, CHECK(price_cents IS NULL OR price_cents > 0));
    CREATE TABLE coverage (size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL, error TEXT, attempted_at TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX requests_customer ON requests(customer_key, created_at);
    CREATE TABLE quotes (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(status IN ('draft','sent','approved','rejected','paid','done','cancelled')));
    CREATE INDEX quotes_request ON quotes(request_id);
  `)
  seed.prepare("INSERT INTO supplier VALUES ('giga-a', ?, ?, ?, 1)")
    .run(SIZE, JSON.stringify({ id: 'giga-a', name: 'Test Touring', size: SIZE, price: 50, inStock: true, category: 'all-season', description: '95H BSW' }), '2026-09-06T00:00:00.000Z')
  seed.prepare("INSERT INTO requests VALUES ('req-1', 'a1b2c3d4e5f60718', ?, ?, ?)")
    .run(JSON.stringify({ vehicleInfo: '2021 Honda Civic' }), '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')
  seed.close()

  const open = () => {
    const handle = new DatabaseSync(file)
    opened.push(handle)
    return handle
  }
  return { file, open }
}

test('opening a deployed database (no outbox table yet) adds it without touching existing rows', t => {
  const { open } = deployedDatabase(t)

  const db = open()
  const outbox = new Outbox(db)

  // The table exists now, and is usable immediately.
  const message = outbox.record({ to: 'owner@example.com', subject: 'A request arrived', body: 'x' })
  assert.equal(outbox.get(message.id).to, 'owner@example.com')

  // Nothing that was already in the file moved.
  assert.equal(db.prepare('SELECT payload FROM requests WHERE id=?').get('req-1').payload,
    JSON.stringify({ vehicleInfo: '2021 Honda Civic' }))
  assert.equal(db.prepare("SELECT id FROM supplier WHERE id='giga-a'").get().id, 'giga-a')
})

test('a second, genuinely separate connection to the same file sees the table and the row', t => {
  // Not the same live handle reused -- opening a real new connection to the
  // same file on disk, which is the actual shape of a Fly deploy: the old
  // process's connection is gone, and a new process opens the file fresh.
  const { open } = deployedDatabase(t)

  const first = open()
  const firstOutbox = new Outbox(first)
  const written = firstOutbox.record({ to: 'a@example.com', subject: 'x', body: 'x' })
  first.close()

  const second = open()
  const secondOutbox = new Outbox(second)
  const found = secondOutbox.get(written.id)
  assert.ok(found, 'the row written by the first connection is visible to a fresh one')
  assert.equal(found.to, 'a@example.com')
})

test('reopening a database that already has the table changes nothing and loses nothing', t => {
  const { open } = deployedDatabase(t)

  const first = open()
  new Outbox(first).record({ to: 'a@example.com', subject: 'x', body: 'x' })
  first.close()

  const second = open()
  const secondOutbox = new Outbox(second) // CREATE TABLE IF NOT EXISTS must be a no-op here, not an error
  assert.equal(secondOutbox.list().length, 1, 'the earlier row is still there, and nothing was duplicated')
})
