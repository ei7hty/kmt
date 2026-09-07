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

/* --------------------------------------- the t35 column-add case (#233's follow-up) */

/**
 * The quotes table exactly as t36 (#55) left it: every current status, the
 * `reason` column -- but before t35 added `draft_line_items` and
 * `draft_total_cents`. This is the deployed database's actual shape today,
 * and it is a different migration path from `OLD_SCHEMA` above: the CHECK
 * constraint already lists every status, so `migrate()`'s rebuild branch is
 * skipped entirely and only the `ALTER TABLE ADD COLUMN` + backfill path
 * runs. Nothing above exercises that path -- every fixture in this file uses
 * `OLD_SCHEMA`, which always takes the rebuild branch, and the rebuild
 * incidentally creates the new columns as part of recreating the table from
 * today's `QUOTES_COLUMNS`. A database that is current on statuses but one
 * column-add behind takes a route none of those tests touch.
 */
const T36_SCHEMA = `
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX requests_customer ON requests(customer_key, created_at);
  CREATE TABLE quotes (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
    payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1, reason TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(status IN (${QUOTE_STATUSES.map(status => `'${status}'`).join(', ')}))
  );
  CREATE INDEX quotes_request ON quotes(request_id);
`

const T36_REQUEST_ID = 'a35b2c1d0e9f887766554433221100ff'
const T36_QUOTE_PAYLOAD = JSON.stringify({
  total: 249.97,
  tireSelection: 'giga-a',
  lineItems: [
    { description: 'Four tires', quantity: 4, unitPrice: 48.74 },
    { description: 'Mobile installation service', quantity: 1, unitPrice: 55 },
  ],
})

/** A t36-shaped file, plus the two ways to open it -- same pattern as `deployedDatabase` above. */
function t36Database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kmt-migration-t36-'))
  const opened = []
  t.after(() => {
    for (const handle of opened.reverse()) { try { handle.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const file = join(dir, 'kmt.db')
  const seed = new DatabaseSync(file)
  seed.exec(T36_SCHEMA)
  seed.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
    .run(T36_REQUEST_ID, 'b1c2d3e4f5061708', JSON.stringify({ vehicleInfo: 'TEST 2022 Toyota Corolla' }), STAMP, STAMP)
  seed.prepare('INSERT INTO quotes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('q-t36', T36_REQUEST_ID, T36_QUOTE_PAYLOAD, 'sent', 2, null, STAMP, STAMP)
  seed.close()

  const open = () => {
    const inventory = new Inventory(file, ['215/60R16'])
    opened.push(inventory)
    return { inventory, quotes: new Quotes(inventory) }
  }
  return { open }
}

test('a t36 database takes the column-add path, not the rebuild, and the row is untouched', t => {
  const { quotes } = t36Database(t).open()
  assert.equal(
    quotes.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='quotes_migrating'").get().n, 0,
    'a database already current on statuses must not take the rebuild branch',
  )
  const found = quotes.get(T36_REQUEST_ID)
  assert.equal(found.quote.status, 'sent', 'the row itself is untouched by the column add')
  assert.equal(found.quote.version, 2)
  assert.equal(found.quote.total, 249.97, 'the live quote payload is not rewritten')
})

test('the column-add path backfills draftLineItems and draftTotal from the existing payload', t => {
  const { quotes } = t36Database(t).open()
  // Owner audience: draftLineItems/draftTotal are owner-only (the immutable
  // original draft), gated out of the customer shape in shapeRow.
  const found = quotes.get(T36_REQUEST_ID, 'owner')
  assert.deepEqual(found.quote.draftLineItems, [
    { description: 'Four tires', quantity: 4, unitPrice: 48.74 },
    { description: 'Mobile installation service', quantity: 1, unitPrice: 55 },
  ], 'a row from before draft_line_items existed reads its lineItems from the live payload')
  assert.equal(found.quote.draftTotal, 249.97, 'and its total the same way, in dollars, not the stored cents')
})

test('reopening a t36 database a second time changes nothing further', t => {
  const database = t36Database(t)
  database.open().inventory.close()
  const { quotes } = database.open()
  const found = quotes.get(T36_REQUEST_ID, 'owner')
  assert.equal(found.quote.draftTotal, 249.97, 'the backfilled columns are not recomputed on a second open')
  assert.equal(
    quotes.db.prepare('SELECT count(*) n FROM quotes WHERE draft_line_items IS NULL OR draft_total_cents IS NULL').get().n,
    0,
    'nothing is left unbackfilled after the first open',
  )
})

/* --------------------------------------------- decided_by (#290 schema half) --- */

test('the deployed schema has no decided_by, and opening it adds one that reads null', t => {
  const fixture = deployedDatabase(t)
  const before = fixture.raw().prepare('PRAGMA table_info(quotes)').all().map(column => column.name)
  assert.ok(!before.includes('decided_by'), 'the fixture must predate the column, or this test proves nothing')

  const { inventory } = fixture.open()
  const after = inventory.db.prepare('PRAGMA table_info(quotes)').all().map(column => column.name)
  assert.ok(after.includes('decided_by'), 'migrate() adds it')

  const row = inventory.db.prepare('SELECT decided_by FROM quotes WHERE id=?').get('q-old')
  assert.equal(row.decided_by, null,
    "a quote decided before the column existed has no recorded actor, and back-filling one would invent a record")
})

/**
 * The rebuild path must carry `decided_by` forward.
 *
 * This is the test for the change that made the rebuild's column list
 * dynamic. Before it, that list was written by hand and named neither
 * `decided_by` nor the two draft columns -- which was harmless while every
 * unnamed column could be re-derived from `payload`, and stops being harmless
 * the moment one cannot. A quote knows its total; it cannot work out who
 * approved it.
 *
 * So the fixture is the awkward middle case that will actually exist in
 * production between now and the next status widening: a table that already
 * carries `decided_by` with a real value in it, and still has an old CHECK
 * that forces a rebuild.
 */
test('a status widening does not discard who decided: the rebuild copies decided_by forward', t => {
  const dir = mkdtempSync(join(tmpdir(), 'kmt-migration-decided-'))
  const opened = []
  t.after(() => {
    for (const handle of opened.reverse()) { try { handle.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true })
  })

  const file = join(dir, 'kmt.db')
  const seed = new DatabaseSync(file)
  // The old CHECK, so migrate() takes the rebuild path -- but with the column
  // present and populated, which is the state this test exists for.
  seed.exec(`
    CREATE TABLE requests (
      id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1, reason TEXT, decided_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(status IN ('draft', 'approved', 'rejected', 'paid'))
    );
  `)
  seed.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
    .run(REQUEST_ID, 'a1b2c3d4e5f60718', JSON.stringify({ vehicleInfo: 'TEST' }), STAMP, STAMP)
  seed.prepare(`INSERT INTO quotes
      (id, request_id, payload, status, version, reason, decided_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('q-decided', REQUEST_ID, QUOTE_PAYLOAD, 'approved', 2, null, 'owner:ken@kensmobiletire.com', STAMP, STAMP)
  seed.close()

  const inventory = new Inventory(file, ['215/60R16'])
  opened.push(inventory)
  new Quotes(inventory)

  const row = inventory.db.prepare('SELECT status, version, decided_by FROM quotes WHERE id=?').get('q-decided')
  assert.equal(row.decided_by, 'owner:ken@kensmobiletire.com',
    'the rebuild must carry decided_by forward -- it cannot be re-derived from anything')
  assert.equal(row.status, 'approved', 'and the rest of the row is unchanged')
  assert.equal(row.version, 2)

  // And the widening actually happened, so this really did take the rebuild
  // path rather than passing because nothing ran.
  const stored = inventory.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotes'").get().sql
  for (const status of QUOTE_STATUSES) {
    assert.ok(stored.includes(`'${status}'`), `the rebuilt CHECK carries ${status}`)
  }
})
