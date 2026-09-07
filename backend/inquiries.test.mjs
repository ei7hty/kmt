import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'

import { InputError } from './inventory.mjs'
import { Inquiries, INQUIRY_PERSONAL_FIELDS, INQUIRY_STATUSES } from './inquiries.mjs'
import { cleanInquiry } from './inquiries-api.mjs'
import { createApi, isKnownApiPath, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmt-inquiries-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A real file holding today's actual full production schema and real rows,
 * built by hand rather than from the code under test -- the same standard
 * outbox.test.mjs's deployedDatabase() set: prove the migration against a
 * database that looks like the deployed one, not against a fixture that
 * happens to agree with whatever this file already believes.
 */
function deployedDatabase(dir) {
  const file = path.join(dir, 'deployed.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE offers (id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER, enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE coverage (size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL, error TEXT, attempted_at TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1, reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(status IN ('draft', 'sent', 'approved', 'rejected', 'paid', 'done', 'cancelled'))
    );
    INSERT INTO supplier VALUES ('giga-1', '215/60R16', '{}', '2026-09-06', 1);
    INSERT INTO metadata VALUES ('seeded', '{"at":"2026-09-06"}');
    INSERT INTO requests VALUES ('req-1', 'customerkey', '{}', '2026-09-06', '2026-09-06');
    INSERT INTO quotes (id, request_id, payload, status, created_at, updated_at) VALUES ('quote-1', 'req-1', '{}', 'draft', '2026-09-06', '2026-09-06');
  `)
  db.close()
  return file
}

test('the inquiries table arrives on a deployed database without disturbing existing rows', () => withTmpDir(dir => {
  const file = deployedDatabase(dir)

  // A genuinely separate connection, the way a real boot would open the
  // volume's file -- never the handle that built the fixture above.
  const db = new DatabaseSync(file)
  new Inquiries(db)
  db.close()

  const reopened = new DatabaseSync(file)
  try {
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM supplier').get().n, 1)
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM quotes').get().n, 1)
    assert.equal(reopened.prepare("SELECT value FROM metadata WHERE key='seeded'").get().value, '{"at":"2026-09-06"}')
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM inquiries').get().n, 0)
    const columns = reopened.prepare('PRAGMA table_info(inquiries)').all().map(c => c.name)
    assert.deepEqual(columns, ['id', 'name', 'contact', 'vehicle_info', 'message', 'status', 'created_at', 'updated_at'])
  } finally {
    reopened.close()
  }
}))

test('a second open (CREATE TABLE IF NOT EXISTS against a database that already has the table) is a no-op, not a rebuild', () => withTmpDir(dir => {
  const file = deployedDatabase(dir)
  const first = new DatabaseSync(file)
  const inquiries = new Inquiries(first)
  const created = inquiries.create({ name: 'Ana', contact: 'ana@example.com', message: 'Need a brake inspection' })
  first.close()

  const second = new DatabaseSync(file)
  try {
    new Inquiries(second)
    assert.deepEqual({ ...second.prepare('SELECT id, name FROM inquiries WHERE id=?').get(created.id) }, { id: created.id, name: 'Ana' })
    assert.equal(second.prepare('SELECT count(*) AS n FROM inquiries').get().n, 1)
  } finally {
    second.close()
  }
}))

test('create() stores all four fields and get() reads them back through separate connections', () => withTmpDir(dir => {
  const file = deployedDatabase(dir)
  const writer = new DatabaseSync(file)
  const created = new Inquiries(writer).create({
    name: 'Ben Torres', contact: '(555) 019-2231', vehicleInfo: '2016 Silverado', message: 'Brake job, squealing for two weeks',
  })
  writer.close()

  const reader = new DatabaseSync(file, { readOnly: true })
  try {
    const found = new Inquiries(reader).get(created.id)
    assert.deepEqual(found, created)
    assert.equal(found.name, 'Ben Torres')
    assert.equal(found.contact, '(555) 019-2231')
    assert.equal(found.vehicleInfo, '2016 Silverado')
    assert.equal(found.message, 'Brake job, squealing for two weeks')
    assert.equal(typeof found.createdAt, 'string')
    assert.equal(found.createdAt, found.updatedAt)
  } finally {
    reader.close()
  }
}))

test('vehicleInfo is optional and stores as null, distinct from an empty string someone actually typed', () => withTmpDir(dir => {
  const db = new DatabaseSync(deployedDatabase(dir))
  const inquiries = new Inquiries(db)
  const withoutVehicle = inquiries.create({ name: 'Cass', contact: 'cass@example.com', message: 'Do you do brake fluid flushes?' })
  assert.equal(withoutVehicle.vehicleInfo, null)
  const withBlankVehicle = inquiries.create({ name: 'Cass', contact: 'cass@example.com', message: 'Same question', vehicleInfo: '   ' })
  assert.equal(withBlankVehicle.vehicleInfo, null)
  db.close()
}))

test('each required field is validated, and the message names which one failed', () => withTmpDir(dir => {
  const db = new DatabaseSync(deployedDatabase(dir))
  const inquiries = new Inquiries(db)
  const valid = { name: 'Dee', contact: 'dee@example.com', message: 'Need an alignment' }

  assert.throws(() => inquiries.create({ ...valid, name: '' }), InputError)
  assert.throws(() => inquiries.create({ ...valid, name: 'x'.repeat(201) }), InputError)
  assert.throws(() => inquiries.create({ ...valid, contact: '' }), InputError)
  assert.throws(() => inquiries.create({ ...valid, contact: 'not an email or phone' }), InputError)
  assert.throws(() => inquiries.create({ ...valid, message: '' }), InputError)
  assert.throws(() => inquiries.create({ ...valid, message: 'x'.repeat(2001) }), InputError)
  assert.throws(() => inquiries.create({ ...valid, vehicleInfo: 'x'.repeat(201) }), InputError)

  // A contact that is plainly a phone number, not an email, is still valid --
  // "phone or email" is one field, and digits alone should satisfy it.
  assert.doesNotThrow(() => inquiries.create({ ...valid, contact: '555-019-2231' }))
  db.close()
}))

test('the public inquiry shape normalizes the contact before it becomes a limiter key', () => {
  assert.deepEqual(cleanInquiry({ name: ' Ana ', contact: '(617) 410-8319', vehicleInfo: ' ', message: ' Brake help ' }), {
    name: 'Ana', contact: '+16174108319', vehicleInfo: null, message: 'Brake help',
  })
  assert.throws(() => cleanInquiry({ name: 'Ana', contact: 'not contact', message: 'Help' }), InputError)
})

test('list() answers newest first and breaks a same-millisecond tie by rowid', () => withTmpDir(dir => {
  const db = new DatabaseSync(deployedDatabase(dir))
  const inquiries = new Inquiries(db)
  // Two inserts sharing whatever millisecond Date.now() returns for both --
  // real on a fast machine, and exactly the gap that stayed invisible in
  // outbox.mjs until a test happened to run fast enough to hit it.
  const first = inquiries.create({ name: 'Early', contact: 'early@example.com', message: 'first' })
  const second = inquiries.create({ name: 'Later', contact: 'later@example.com', message: 'second' })
  db.exec(`UPDATE inquiries SET created_at='2026-09-06T00:00:00.000Z' WHERE id IN ('${first.id}', '${second.id}')`)

  const rows = inquiries.list()
  assert.deepEqual(rows.map(r => r.id), [second.id, first.id])
  db.close()
}))

test('the growable workflow moves forward through new, replied and closed without a database CHECK', () => withTmpDir(dir => {
  const db = new DatabaseSync(deployedDatabase(dir))
  const inquiries = new Inquiries(db)
  const first = inquiries.create({ name: 'A', contact: 'a@example.com', message: 'Alignment' })
  const second = inquiries.create({ name: 'B', contact: 'b@example.com', message: 'Brakes' })
  assert.deepEqual(INQUIRY_STATUSES, ['new', 'replied', 'closed'])
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='inquiries'").get().sql.includes('CHECK'), false)
  assert.deepEqual(inquiries.counts(), { new: 2, replied: 0, closed: 0 })
  assert.equal(inquiries.move(first.id, 'replied').status, 'replied')
  assert.equal(inquiries.move(first.id, 'closed').status, 'closed')
  assert.equal(inquiries.move(second.id, 'closed').status, 'closed', 'a message that needs no reply may close directly')
  assert.deepEqual(inquiries.counts(), { new: 0, replied: 0, closed: 2 })
  assert.throws(() => inquiries.move(first.id, 'new'), { status: 409 })
  assert.throws(() => inquiries.move(first.id, 'contacted'), /Unknown inquiry status/)
  assert.throws(() => inquiries.move('missing', 'closed'), { status: 404 })
  db.close()
}))

test('owner inquiry list, read and status routes require a valid owner session', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const inquiries = new Inquiries(db)
  const created = inquiries.create({ name: 'Owner only', contact: 'owner@example.com', message: 'Private message' })
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' }))
  const api = createApi({}, null, null, null, { inquiries })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (!isKnownApiPath(url.pathname)) { response.writeHead(404).end(); return }
    if (!isPublicApiCall(request.method, url.pathname) && !auth.isAuthenticated(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' })); return
    }
    if (await api(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  for (const path of ['/api/owner/inquiries', `/api/owner/inquiries/${created.id}`]) {
    assert.equal((await fetch(base + path)).status, 401)
  }
  assert.equal((await fetch(`${base}/api/owner/inquiries/${created.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"status":"replied"}' })).status, 401)

  const login = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"a-long-enough-password"}' })
  assert.equal(login.status, 200)
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] }
  const listed = await (await fetch(base + '/api/owner/inquiries', { headers })).json()
  assert.equal(listed.inquiries[0].message, 'Private message')
  assert.equal((await (await fetch(`${base}/api/owner/inquiries/${created.id}`, { headers })).json()).inquiry.contact, 'owner@example.com')
  const moved = await (await fetch(`${base}/api/owner/inquiries/${created.id}/status`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"status":"replied"}' })).json()
  assert.equal(moved.inquiry.status, 'replied')
})

test('INQUIRY_PERSONAL_FIELDS names exactly the two columns a future redaction rewrites, per docs/data-policy.md', () => {
  assert.deepEqual(INQUIRY_PERSONAL_FIELDS, ['name', 'contact'])
})
