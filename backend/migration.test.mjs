import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Inventory } from './inventory.mjs'
import { Quotes, QUOTE_STATUSES } from './quotes.mjs'

/**
 * The deployed database, opened by today's code.
 *
 * Every other test builds its tables fresh, and so do both CI jobs, so every
 * other test agrees with whatever CHECK constraint the code happens to write.
 * The one database that does not is the only one that matters: fly.toml mounts
 * a volume, its quotes table was created before `sent`, `done` and `cancelled`
 * existed, and CREATE TABLE IF NOT EXISTS will not touch it.
 *
 * So this test does not build the table from the code under test. It writes the
 * schema the deployed database actually carries, puts a row in it shaped like
 * the real approved-then-paid one, and then opens it the way the server does.
 */

/** The quotes table exactly as it was created before this change. */
const OLD_SCHEMA = `
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX requests_customer ON requests(customer_key, created_at);
  CREATE TABLE quotes (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(status IN ('draft', 'approved', 'rejected', 'paid'))
  );
  CREATE INDEX quotes_request ON quotes(request_id);
`

/** The t33 proof row: submitted, approved on the owner's device, paid from a phone. */
const REQUEST_ID = 'f80ada133275b41c327b6c35fb5555a4'
const QUOTE_PAYLOAD = JSON.stringify({ total: 135.98, tireSelection: 'giga-a' })
const STAMP = '2026-09-05T22:10:00.000Z'

/**
 * A file holding that schema and that row, plus the two ways to open it.
 *
 * Everything opened is closed in one hook, before the directory goes: Windows
 * will not delete a file something still holds, and WAL means the database is
 * three of them. One hook, because per-handle hooks run in the order they were
 * registered and the directory was registered first.
 */
function deployedDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kmt-migration-'))
  const opened = []
  t.after(() => {
    for (const handle of opened.reverse()) { try { handle.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const file = join(dir, 'kmt.db')
  const seed = new DatabaseSync(file)
  seed.exec(OLD_SCHEMA)
  seed.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
    .run(REQUEST_ID, 'a1b2c3d4e5f60718', JSON.stringify({ vehicleInfo: 'TEST 2021 Honda Civic' }), STAMP, STAMP)
  seed.prepare('INSERT INTO quotes VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('q-old', REQUEST_ID, QUOTE_PAYLOAD, 'paid', 3, STAMP, STAMP)
  seed.close()

  /** Opening the file the way server.mjs does, migration and all. */
  const open = () => {
    const inventory = new Inventory(file, ['215/60R16'])
    opened.push(inventory)
    return { inventory, quotes: new Quotes(inventory) }
  }
  /** Opening it as SQLite alone, to ask what the schema will actually accept. */
  const raw = () => {
    const handle = new DatabaseSync(file)
    opened.push(handle)
    return handle
  }
  return { open, raw }
}

test('the deployed schema refuses the new statuses before migrating', t => {
  const db = deployedDatabase(t).raw()
  for (const status of ['sent', 'done', 'cancelled']) {
    assert.throws(
      () => db.prepare('UPDATE quotes SET status=? WHERE id=?').run(status, 'q-old'),
      /CHECK constraint failed/,
      `the old schema should refuse ${status} -- if it does not, this test proves nothing`,
    )
  }
})

test('opening a deployed database widens the constraint and keeps the row', t => {
  const { quotes } = deployedDatabase(t).open()

  const found = quotes.get(REQUEST_ID)
  assert.equal(found.quote.status, 'paid', 'the paid row survives the rebuild')
  assert.equal(found.quote.version, 3, 'and so does its version, which decisions are checked against')
  assert.equal(found.quote.id, 'q-old')
  assert.equal(found.quote.total, 135.98, 'the quote payload is copied, not re-drafted')
  assert.equal(found.quote.createdAt, STAMP)
  assert.equal(found.quote.reason, null, 'a row from before the column reads as no reason')
  assert.equal(found.request.vehicleInfo, 'TEST 2021 Honda Civic')
})

test('every status is writable after the migration', t => {
  const { quotes } = deployedDatabase(t).open()
  for (const status of QUOTE_STATUSES) {
    quotes.db.prepare('UPDATE quotes SET status=? WHERE id=?').run(status, 'q-old')
    assert.equal(quotes.get(REQUEST_ID).quote.status, status)
  }
})

test('a status outside the list is still refused', t => {
  const { quotes } = deployedDatabase(t).open()
  assert.throws(
    () => quotes.db.prepare('UPDATE quotes SET status=? WHERE id=?').run('refunded', 'q-old'),
    /CHECK constraint failed/,
    'the rebuild must widen the constraint, not remove it',
  )
})

test('reopening the file a second time changes nothing', t => {
  const database = deployedDatabase(t)
  const first = database.open()
  first.quotes.db.prepare('UPDATE quotes SET status=?, reason=? WHERE id=?').run('done', 'finished', 'q-old')
  first.inventory.close()

  // The migration decides by reading the stored schema, so a second open has to
  // be a no-op -- not a second rebuild that quietly drops what the first wrote.
  const { quotes } = database.open()
  const found = quotes.get(REQUEST_ID)
  assert.equal(found.quote.status, 'done')
  assert.equal(found.quote.reason, 'finished')
  assert.equal(quotes.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='quotes_migrating'").get().n, 0,
    'the scratch table must not be left behind')
})

test('the index survives, so the owner list is not a scan', t => {
  const { quotes } = deployedDatabase(t).open()
  const indexes = quotes.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='quotes'").all()
  assert.ok(indexes.some(row => row.name === 'quotes_request'), `got ${JSON.stringify(indexes)}`)
})

test('a fresh database is already right and is not rebuilt', t => {
  const inventory = new Inventory(':memory:', ['215/60R16'])
  t.after(() => inventory.close())
  new Quotes(inventory)
  const sql = inventory.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotes'").get().sql
  for (const status of QUOTE_STATUSES) assert.ok(sql.includes(`'${status}'`), `missing ${status}`)
  assert.ok(sql.includes('reason'), 'the reason column is part of the current shape')
})
