/**
 * Exporting the owner database's supplier table as a scrape snapshot.
 *
 * WHY THIS SCRIPT EXISTS, and therefore what has to hold. The committed
 * snapshot maps 703 of production's 1,357 models, so every photo gap outside
 * it was unreachable -- `build-image-mapping` reads a snapshot because that is
 * where `source.url` lives, and it refuses a model with no row. The missing
 * rows are not lost: they are in the owner database, imported from scrapes
 * that were never committed back. Reading them out costs the supplier nothing.
 *
 * The two properties that matter are that the shape is one the mapping tool
 * accepts, and that NOTHING BUT TIRE DATA leaves the machine -- the export is
 * downloaded off a production server holding customer requests, quotes and an
 * outbox.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-snapshot.mjs')

const tire = (id, size, extra = {}) => ({
  id, name: `Tire ${id}`, size, price: 50, inStock: true, category: 'all-season',
  description: 'Touring All Season · 95H BSW',
  source: { sku: id.slice(5).toUpperCase(), stock: 12, listPrice: 60, url: `https://www.giga-tires.com/tires/${id}` },
  ...extra,
})

/** An owner database with the tables this reads and the tables it must not. */
function ownerDatabase(t) {
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-export-snapshot-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'owner.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL,
      last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE quotes (id TEXT PRIMARY KEY, customer_email TEXT NOT NULL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, recipient TEXT NOT NULL);
  `)
  const add = (row, active = 1) => db.prepare('INSERT INTO supplier VALUES (?,?,?,?,?)')
    .run(row.id, row.size, JSON.stringify(row), '2026-09-13T00:00:00Z', active)
  add(tire('giga-a', '205/65R15'))
  add(tire('giga-b', '225/50R17'))
  add(tire('giga-c', '205/65R15', { name: 'Tire giga-a' })) // same model, second size
  add(tire('giga-gone', '195/60R15'), 0) // delisted at the supplier
  db.prepare('INSERT INTO quotes VALUES (?,?)').run('q1', 'someone@example.com')
  db.prepare('INSERT INTO outbox VALUES (?,?)').run('m1', 'someone@example.com')
  db.close()
  return { folder, file }
}

const run = (file, out) => JSON.parse(execFileSync(process.execPath, [SCRIPT, file, out], { encoding: 'utf8' }))

test('the export is a snapshot the mapping tool reads, with every row carrying its supplier url', t => {
  const { folder, file } = ownerDatabase(t)
  const out = path.join(folder, 'snapshot.json')
  const summary = run(file, out)

  assert.equal(summary.tires, 3, 'three active rows; the delisted one is not offered and must not be photographed')
  assert.equal(summary.models, 2, 'two distinct models -- one of them in two sizes')
  assert.equal(summary.sizes, 2)

  const snapshot = JSON.parse(readFileSync(out, 'utf8'))
  // `build-image-mapping` reads exactly `snapshot.tires`, and refuses any
  // candidate whose row has no `source.sku`/`source.url`. A shape that looked
  // right but lost the source block would fail much later, in a supplier run.
  assert.deepEqual(Object.keys(snapshot).sort(), ['coverage', 'scrapedAt', 'sizes', 'source', 'tires'])
  assert.equal(snapshot.tires.length, 3)
  for (const row of snapshot.tires) {
    assert.ok(row.source?.url, `${row.id} lost its supplier url, which is the whole reason a snapshot is read`)
    assert.ok(row.source?.sku, `${row.id} lost its sku`)
    assert.ok(row.id && row.name && row.size, `${row.id} lost an identifying field`)
  }
})

test('a row the supplier has delisted is left out', t => {
  const { folder, file } = ownerDatabase(t)
  const out = path.join(folder, 'snapshot.json')
  run(file, out)
  const ids = JSON.parse(readFileSync(out, 'utf8')).tires.map(row => row.id)
  assert.ok(!ids.includes('giga-gone'), 'a delisted tire cannot be bought, so photographing it is wasted supplier traffic')
  assert.deepEqual(ids.sort(), ['giga-a', 'giga-b', 'giga-c'], 'and nothing else was dropped with it')
})

test('nothing but tire data leaves the machine', t => {
  // The property that lets this be downloaded off a production server at all.
  // The database it reads holds customer quotes and an outbox; the file it
  // writes must carry neither, by shape and by content.
  const { folder, file } = ownerDatabase(t)
  const out = path.join(folder, 'snapshot.json')
  run(file, out)
  const text = readFileSync(out, 'utf8')

  assert.doesNotMatch(text, /someone@example\.com/, 'a customer address reached an export meant to carry tires')
  assert.doesNotMatch(text, /outbox|recipient|customer_email/i)
  // The control: the fixture really does hold that address, so the assertion
  // above is the export being narrow rather than the fixture being empty.
  const db = new DatabaseSync(file)
  assert.equal(db.prepare('SELECT count(*) n FROM quotes').get().n, 1)
  db.close()
})

test('it reads, and cannot write, the database it is pointed at', t => {
  const { folder, file } = ownerDatabase(t)
  const before = readFileSync(file)
  run(file, path.join(folder, 'snapshot.json'))
  assert.deepEqual(readFileSync(file), before, 'the owner database changed during an export that only reads it')
})

test('it refuses without both paths rather than guessing one', t => {
  const { file } = ownerDatabase(t)
  for (const args of [[], [file]]) {
    // THE MESSAGE, not merely the throw. Without the explicit check it still
    // fails -- `new DatabaseSync(undefined)` or `writeFileSync(undefined)`
    // throws on its own -- so asserting "it threw" passes just as happily
    // against no check at all, and leaves the operator a stack trace instead
    // of the two paths this needs. Caught by mutating the guard away and
    // watching the suite stay green.
    let stderr = ''
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      error => { stderr = String(error.stderr ?? ''); return true },
      `${args.length} argument(s) was accepted; a guessed output path writes somewhere nobody asked for`)
    assert.match(stderr, /Use: node export-snapshot\.mjs ABS_DB ABS_OUT/,
      `${args.length} argument(s) failed without saying what to pass: ${stderr.split('\n')[0]}`)
  }
  // The control: two arguments IS accepted, so the refusals above are the
  // check working rather than the script failing for some other reason.
  const { folder, file: f2 } = ownerDatabase(t)
  const out = path.join(folder, 'ok.json')
  run(f2, out)
  assert.ok(existsSync(out))
})
