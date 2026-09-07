import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Inventory } from './inventory.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS, OUTBOX_REDACTED_COLUMNS, OUTBOX_STATUSES } from './outbox.mjs'

const SIZE = '215/60R16'

/** A request row a foreign key can actually point at. */
function seedRequest(db, id = 'req-1') {
  db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
    .run(id, 'a1b2c3d4e5f60718', JSON.stringify({ vehicleInfo: '2021 Honda Civic' }), '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')
  return id
}

function setup(t) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  // Inventory does not create `requests` -- Quotes does, and Outbox's foreign
  // key needs it to exist before a row can reference it.
  inventory.db.exec(`CREATE TABLE requests (
    id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  const requestId = seedRequest(inventory.db)
  return { outbox: new Outbox(inventory.db), db: inventory.db, requestId }
}

const renderData = (overrides = {}) => ({
  to_name: 'Jamie Rivera', to_email: 'jamie@example.com', customerPhone: '+16174108319',
  location: '456 Demo Ave', locationNotes: 'Driveway',
  vehicleInfo: '2021 Honda Civic', tireSelection: 'giga-a', quantity: 4, total: 249.99,
  ...overrides,
})

test('a message is recorded queued by default, and read back whole', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({
    requestId, type: 'request_received', data: renderData(),
    to: 'jamie@example.com', toName: 'Jamie Rivera',
  })
  assert.match(message.id, /^[0-9a-f]{32}$/, 'a 128-bit id, not a guessable one')
  assert.equal(message.requestId, requestId)
  assert.equal(message.type, 'request_received')
  assert.equal(message.templateVersion, 1, 'defaults to the first version')
  assert.equal(message.to, 'jamie@example.com')
  assert.equal(message.toName, 'Jamie Rivera')
  assert.equal(message.status, 'queued')
  assert.equal(message.providerId, null)
  assert.equal(message.error, null)
  assert.equal(outbox.get(message.id).data.total, 249.99, 'the rendering data round-trips through JSON')
  assert.equal(outbox.get(message.id).body, undefined, 'no body column exists to read back')
})

test('a message needs the request it is about, a type, rendering data, and a recipient', t => {
  const { outbox, requestId } = setup(t)
  const full = { requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' }
  assert.throws(() => outbox.record({ ...full, requestId: undefined }), /needs the request/)
  assert.throws(() => outbox.record({ ...full, requestId: '' }), /needs the request/)
  assert.throws(() => outbox.record({ ...full, type: '' }), /needs a type/)
  assert.throws(() => outbox.record({ ...full, data: undefined }), /needs its rendering data/)
  assert.throws(() => outbox.record({ ...full, data: 'not an object' }), /needs its rendering data/)
  assert.throws(() => outbox.record({ ...full, to: '  ' }), /needs an address/)
  assert.throws(() => outbox.record({ ...full, toName: '' }), /needs a recipient name/)
  assert.throws(() => outbox.record({ ...full, templateVersion: 0 }), /templateVersion must be/)
})

test('a request_id that names no real request is refused by the foreign key, not silently stored', t => {
  const { outbox } = setup(t)
  assert.throws(
    () => outbox.record({ requestId: 'req-does-not-exist', type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' }),
    /FOREIGN KEY constraint failed/,
  )
})

test('a status outside queued, sent, failed and bounced is refused, on record and on update', t => {
  const { outbox, requestId } = setup(t)
  assert.throws(
    () => outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A', status: 'delivered' }),
    /status must be one of/,
  )
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  assert.throws(() => outbox.updateStatus(message.id, { status: 'delivered' }), /status must be one of/)
  assert.deepEqual(OUTBOX_STATUSES, ['queued', 'sent', 'failed', 'bounced'])
})

test('updateStatus moves a message to sent, failed or bounced, and keeps a provider id a later call omits', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })

  const sent = outbox.updateStatus(message.id, { status: 'sent', providerId: 'resend-123' })
  assert.equal(sent.status, 'sent')
  assert.equal(sent.providerId, 'resend-123')

  // A bounce arriving after the send must not erase the provider id that
  // already proved the message went out.
  const bounced = outbox.updateStatus(message.id, { status: 'bounced', error: 'mailbox full' })
  assert.equal(bounced.status, 'bounced')
  assert.equal(bounced.providerId, 'resend-123', 'the earlier provider id survives an update that says nothing about it')
  assert.equal(bounced.error, 'mailbox full')
})

test('updating a message that does not exist is refused rather than silently doing nothing', t => {
  const { outbox } = setup(t)
  assert.throws(() => outbox.updateStatus('0'.repeat(32), { status: 'sent' }), /No such outbox message/)
})

test('list answers recent messages newest first, and respects a limit', t => {
  const { outbox, requestId } = setup(t)
  for (let i = 0; i < 5; i++) {
    outbox.record({ requestId, type: 'request_received', data: renderData(), to: `c${i}@example.com`, toName: `C${i}` })
  }
  const all = outbox.list()
  assert.equal(all.length, 5)
  assert.equal(all[0].to, 'c4@example.com', 'newest first')
  assert.equal(all[4].to, 'c0@example.com')

  const limited = outbox.list({ limit: 2 })
  assert.deepEqual(limited.map(m => m.to), ['c4@example.com', 'c3@example.com'])
})

test('a message carries the request it is about, and forRequest finds every message for one request', t => {
  const { outbox, db } = setup(t)
  const requestA = seedRequest(db, 'req-a')
  const requestB = seedRequest(db, 'req-b')
  outbox.record({ requestId: requestA, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  outbox.record({ requestId: requestA, type: 'request_alert', data: renderData(), to: 'owner@example.com', toName: 'Ken' })
  outbox.record({ requestId: requestB, type: 'request_received', data: renderData(), to: 'b@example.com', toName: 'B' })

  const messagesForA = outbox.forRequest(requestA)
  assert.equal(messagesForA.length, 2, 'both messages about req-a, and none of req-b')
  assert.ok(messagesForA.every(m => m.requestId === requestA))

  assert.deepEqual(outbox.forRequest('req-nothing-sent-for-this-one'), [], 'a request with no messages answers empty, not an error')
  assert.deepEqual(outbox.forRequest(''), [], 'a blank id answers empty rather than matching every row')
})

test('forRequest is answered from an index, not a table scan', t => {
  const { db } = setup(t)
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM outbox WHERE request_id=?').all('req-1')
  assert.ok(plan.some(row => /USING INDEX outbox_request/.test(row.detail)), `expected an index search, got: ${plan.map(r => r.detail).join(' | ')}`)
})

test('the personal keys a redaction has to find are named, not guessed at call time', () => {
  assert.deepEqual(
    OUTBOX_PERSONAL_DATA_KEYS,
    ['to_name', 'to_email', 'customerPhone', 'location', 'locationNotes', 'customerNotes'],
    'if you change this list, update the UPDATE outbox statement in docs/operations.md',
  )
})

test('the bare columns a redaction blanks directly are named too, separately from the keys inside data', () => {
  assert.deepEqual(
    OUTBOX_REDACTED_COLUMNS,
    ['to_address', 'to_name', 'error'],
    'if you change this list, update the fallback UPDATE outbox statement in docs/operations.md',
  )
})

test('error is in the redacted set because the provider, not this code, decides what goes in it', () => {
  assert.ok(
    OUTBOX_REDACTED_COLUMNS.includes('error'),
    'mail.mjs writes String(error?.message) from the provider here; SMTP rejections name the mailbox. See .forge/personal-data-removal.md finding 2.',
  )
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
    handle.exec('PRAGMA foreign_keys=ON')
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
  const message = outbox.record({ requestId: 'req-1', type: 'request_alert', data: renderData(), to: 'owner@example.com', toName: 'Ken' })
  assert.equal(outbox.get(message.id).to, 'owner@example.com')

  // Nothing that was already in the file moved.
  assert.equal(db.prepare('SELECT payload FROM requests WHERE id=?').get('req-1').payload,
    JSON.stringify({ vehicleInfo: '2021 Honda Civic' }))
  assert.equal(db.prepare("SELECT id FROM supplier WHERE id='giga-a'").get().id, 'giga-a')
})

test('a second, genuinely separate connection to the same file sees the table, the row and the request link', t => {
  // Not the same live handle reused -- opening a real new connection to the
  // same file on disk, which is the actual shape of a Fly deploy: the old
  // process's connection is gone, and a new process opens the file fresh.
  const { open } = deployedDatabase(t)

  const first = open()
  const firstOutbox = new Outbox(first)
  const written = firstOutbox.record({ requestId: 'req-1', type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  first.close()

  const second = open()
  const secondOutbox = new Outbox(second)
  const found = secondOutbox.get(written.id)
  assert.ok(found, 'the row written by the first connection is visible to a fresh one')
  assert.equal(found.to, 'a@example.com')
  assert.equal(found.requestId, 'req-1', 'the request link survives a real close and reopen too')
  assert.equal(secondOutbox.forRequest('req-1').length, 1, 'and the indexed lookup finds it on the fresh connection')
})

test('reopening a database that already has the table changes nothing and loses nothing', t => {
  const { open } = deployedDatabase(t)

  const first = open()
  new Outbox(first).record({ requestId: 'req-1', type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  first.close()

  const second = open()
  const secondOutbox = new Outbox(second) // CREATE TABLE IF NOT EXISTS must be a no-op here, not an error
  assert.equal(secondOutbox.list().length, 1, 'the earlier row is still there, and nothing was duplicated')
})

test('the deployed schema has an outbox table but no resolved_at, and opening it adds one that reads null', t => {
  const { open } = deployedDatabase(t)

  // The table as it existed before this change -- OUTBOX_COLUMNS minus
  // resolved_at -- built by hand so the test proves the ALTER guard, not
  // just that Outbox's own constructor agrees with itself.
  const first = open()
  first.exec(`
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      type TEXT NOT NULL, template_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL,
      to_address TEXT NOT NULL, to_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(status IN ('queued','sent','failed','bounced'))
    );
    CREATE INDEX outbox_request ON outbox(request_id);
  `)
  const before = first.prepare('PRAGMA table_info(outbox)').all().map(c => c.name)
  assert.ok(!before.includes('resolved_at'), 'the fixture must predate the column, or this test proves nothing')
  first.prepare(`INSERT INTO outbox
      (id, request_id, type, template_version, data, to_address, to_name, status, provider_id, error, created_at, updated_at)
      VALUES ('m-old', 'req-1', 'request_received', 1, ?, 'a@example.com', 'A', 'failed', NULL, '535 5.7.8 old failure', '2026-09-06T23:49:00.000Z', '2026-09-06T23:49:00.000Z')`)
    .run(JSON.stringify(renderData()))
  first.close()

  const second = open()
  const outbox = new Outbox(second) // constructor's ALTER guard must add resolved_at here
  const after = second.prepare('PRAGMA table_info(outbox)').all().map(c => c.name)
  assert.ok(after.includes('resolved_at'), 'opening it adds the column')

  const row = outbox.get('m-old')
  assert.equal(row.resolvedAt, null, 'a row from before resolved_at existed reads it as null, not failing to load')
  assert.equal(row.resolutionNote, null, 'resolution_note is added by the same guard and reads null too')
  assert.equal(row.error, '535 5.7.8 old failure', 'and the row is otherwise untouched')
})

test('resolve() marks a row settled without changing what status claims happened, and the note goes to its own column', t => {
  const { outbox, requestId } = setup(t)
  const queued = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  assert.equal(queued.resolvedAt, null)

  const resolved = outbox.resolve(queued.id, 'never attempted under the null adapter')
  assert.equal(resolved.status, 'queued', 'resolve() does not invent an attempt that never happened')
  assert.ok(resolved.resolvedAt, 'resolved_at is set')
  assert.equal(resolved.resolutionNote, 'never attempted under the null adapter')
  assert.equal(resolved.error, null, 'error stays null -- nothing was ever attempted, and resolve() must not write there')
})

test('resolve() never touches error, in either direction: a real failure keeps its diagnostic untouched', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  outbox.updateStatus(message.id, { status: 'failed', error: '535 5.7.8 credential dead' })

  const resolved = outbox.resolve(message.id, 'closed incident, credential rotated')
  assert.equal(resolved.status, 'failed', 'still failed -- the attempt really was rejected')
  assert.ok(resolved.resolvedAt)
  assert.equal(resolved.resolutionNote, 'closed incident, credential rotated')
  assert.equal(resolved.error, '535 5.7.8 credential dead',
    'the real provider error survives in its own column -- a resolution note lives in resolution_note, never in error')
})

test('resolve() is idempotent: resolving an already-resolved row leaves it unchanged', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  const first = outbox.resolve(message.id, 'first note')
  const second = outbox.resolve(message.id, 'a different note, should be ignored')
  assert.equal(second.resolvedAt, first.resolvedAt, 'resolved_at does not move on a second call')
  assert.equal(second.resolutionNote, 'first note', 'the first note is not replaced by a later one')
})

test('resolve() on a message that does not exist is refused, the same as updateStatus', t => {
  const { outbox } = setup(t)
  assert.throws(() => outbox.resolve('0'.repeat(32)), /No such outbox message/)
})

test('resolve() refuses a non-string note rather than letting it reach SQLite', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  assert.throws(() => outbox.resolve(message.id, 12345), /A resolution note must be text/,
    'a number must not silently land in a TEXT column')
  assert.throws(() => outbox.resolve(message.id, { note: 'x' }), /A resolution note must be text/,
    'an object must be refused with a real error, not thrown as an unhandled node:sqlite binding failure')
  assert.equal(outbox.get(message.id).resolvedAt, null, 'a refused note must not partially resolve the row')
})

test('resolve() rejects a note over 500 characters, the same bound cleanReason holds cancellations to', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  assert.throws(() => outbox.resolve(message.id, 'x'.repeat(501)), /too long/)
  const resolved = outbox.resolve(message.id, 'x'.repeat(500))
  assert.equal(resolved.resolutionNote.length, 500, 'exactly the bound is accepted')
})

test('resolve() treats an empty or whitespace-only note the same as no note at all', t => {
  const { outbox, requestId } = setup(t)
  const message = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'a@example.com', toName: 'A' })
  const resolved = outbox.resolve(message.id, '   ')
  assert.equal(resolved.resolutionNote, null)
  assert.ok(resolved.resolvedAt, 'the row is still resolved -- a blank note is not a refused one')
})

test('unresolvedFailures answers only failed rows nobody has settled, newest first', t => {
  const { outbox, requestId } = setup(t)
  outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'q@example.com', toName: 'Q' })
  const sent = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 's@example.com', toName: 'S' })
  outbox.updateStatus(sent.id, { status: 'sent' })
  const failedOld = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'f1@example.com', toName: 'F1' })
  outbox.updateStatus(failedOld.id, { status: 'failed', error: 'old failure' })
  const failedNew = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'f2@example.com', toName: 'F2' })
  outbox.updateStatus(failedNew.id, { status: 'failed', error: 'new failure' })
  const failedSettled = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'f3@example.com', toName: 'F3' })
  outbox.updateStatus(failedSettled.id, { status: 'failed', error: 'already handled' })
  outbox.resolve(failedSettled.id, 'handled')

  const unresolved = outbox.unresolvedFailures()
  assert.deepEqual(unresolved.map(m => m.to), ['f2@example.com', 'f1@example.com'],
    'queued, sent and resolved rows are excluded; unresolved failures come back newest first')
})

test('unresolvedFailures is not a recency window: a failure stays visible past 200 newer messages of other statuses', t => {
  const { outbox, requestId } = setup(t)
  const failure = outbox.record({ requestId, type: 'request_received', data: renderData(), to: 'f@example.com', toName: 'F' })
  outbox.updateStatus(failure.id, { status: 'failed', error: 'still unresolved' })

  // The general list() window this replaces would have scrolled the failure
  // out of a limit=200 read by now -- 250 newer rows of an unrelated status.
  for (let i = 0; i < 250; i++) {
    outbox.record({ requestId, type: 'request_received', data: renderData(), to: `q${i}@example.com`, toName: `Q${i}` })
  }

  assert.equal(outbox.list({ limit: 200 }).some(m => m.id === failure.id), false,
    'sanity check: the general recency-windowed list really has scrolled past it')
  const unresolved = outbox.unresolvedFailures()
  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].id, failure.id, 'but the failure-filtered query still sees it -- no scan window to scroll past')
})
