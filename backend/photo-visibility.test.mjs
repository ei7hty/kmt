import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { ensureImagePublicationSchema, approvedImageUrls, photoState } from './image-publication.mjs'
import { supplierImageRevision } from './image-manifest.mjs'

/**
 * Per-product photo visibility: the owner can switch ONE product's photo off
 * without revoking the packet it came from.
 *
 * Revocation already existed and is the wrong tool for this. It is per-packet
 * and terminal -- one wrong photo in a batch of ninety-six could only be dealt
 * with by revoking all ninety-six, permanently. `hidden` is per-product and
 * reversible, and it lives on the projection table so the immutable decision
 * log is untouched.
 */

const TIRE = {
  id: 'giga-test0011520565h', name: 'Test Tire', size: '205/65R15', price: 80,
  inStock: true, category: 'all-season', description: 'Fixture',
  source: { sku: 'TEST001', url: 'https://www.giga-tires.com/205-65-15/x/y/tirecode/T1' },
}
const SHA = 'a'.repeat(64)

/** A database holding one approved, published photo for TIRE. */
function published(t, { revoked = false } = {}) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL,
    last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);`)
  ensureImagePublicationSchema(db)
  db.prepare('INSERT INTO supplier VALUES (?,?,?,?,1)').run(TIRE.id, TIRE.size, JSON.stringify(TIRE), 'now')
  db.prepare('INSERT INTO image_packets VALUES (?,?,?,?,?)').run('p1', Buffer.from('m'), Buffer.from('p'), Buffer.from('s'), 'now')
  db.prepare('INSERT INTO image_packet_assets VALUES (?,?,?,?,?,?)')
    .run('p1', 0, TIRE.id, supplierImageRevision(TIRE), JSON.stringify({ sha256: SHA, format: 'jpeg', bytes: 10 }), 'decoder')
  db.prepare("INSERT INTO image_decisions VALUES (1,'p1',1,'imported','o','now','','h1')").run()
  db.prepare("INSERT INTO image_decisions VALUES (2,'p1',2,'approved','o','now','h1','h2')").run()
  if (revoked) db.prepare("INSERT INTO image_decisions VALUES (3,'p1',3,'revoked','o','now','h2','h3')").run()
  db.prepare('INSERT INTO image_publications (supplier_id, packet, ordinal, hidden) VALUES (?,?,?,0)').run(TIRE.id, 'p1', 0)
  return db
}

/** The joined row shape `photoState` reads, as inventory.list produces it. */
function joined(db) {
  return db.prepare(`SELECT ip.hidden AS photo_hidden, ip.packet AS photo_packet, ip.ordinal AS photo_ordinal,
      ia.source_hash AS photo_source_hash, ia.metadata AS photo_metadata,
      EXISTS(SELECT 1 FROM image_decisions d WHERE d.packet=ip.packet AND d.action='approved') AS photo_approved,
      EXISTS(SELECT 1 FROM image_decisions r WHERE r.packet=ip.packet AND r.action='revoked') AS photo_revoked
    FROM supplier s LEFT JOIN image_publications ip ON ip.supplier_id=s.id
    LEFT JOIN image_packet_assets ia ON ia.packet=ip.packet AND ia.ordinal=ip.ordinal WHERE s.id=?`).get(TIRE.id)
}

test('MIGRATION: hidden is added to a table that already exists without it', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT, payload TEXT, last_seen TEXT, active INTEGER);
    CREATE TABLE image_packets (digest TEXT PRIMARY KEY, manifest BLOB, profile BLOB, snapshot BLOB, imported_at TEXT);
    CREATE TABLE image_packet_assets (packet TEXT, ordinal INTEGER, supplier_id TEXT, source_hash TEXT,
      metadata TEXT, decoder TEXT, PRIMARY KEY(packet, ordinal));`)
  // The pre-migration shape: no `hidden`. CREATE TABLE IF NOT EXISTS will not
  // touch it, which is exactly how a new column reaches a fresh database and
  // never reaches production.
  db.exec(`CREATE TABLE image_publications (supplier_id TEXT PRIMARY KEY, packet TEXT NOT NULL, ordinal INTEGER NOT NULL);`)
  db.prepare('INSERT INTO image_publications VALUES (?,?,?)').run(TIRE.id, 'p1', 0)
  assert.equal(db.prepare('PRAGMA table_info(image_publications)').all().some(c => c.name === 'hidden'), false)

  ensureImagePublicationSchema(db)

  const columns = db.prepare('PRAGMA table_info(image_publications)').all()
  const hidden = columns.find(c => c.name === 'hidden')
  assert.ok(hidden, 'the migration must add hidden to an existing table')
  assert.equal(db.prepare('SELECT hidden FROM image_publications WHERE supplier_id=?').get(TIRE.id).hidden, 0,
    'an existing publication defaults to visible -- a migration must not hide photos that were already live')
})

test('MIGRATION is idempotent: running it twice does not fail or duplicate the column', t => {
  const db = published(t)
  ensureImagePublicationSchema(db)
  ensureImagePublicationSchema(db)
  assert.equal(db.prepare('PRAGMA table_info(image_publications)').all().filter(c => c.name === 'hidden').length, 1)
})

test('a published photo is live, and hiding it takes it off the customer catalogue', t => {
  const db = published(t)
  assert.equal(photoState(joined(db), TIRE).state, 'live')
  assert.equal(approvedImageUrls(db).get(TIRE.id), `/api/images/${SHA}.jpeg`)

  db.prepare('UPDATE image_publications SET hidden=1 WHERE supplier_id=?').run(TIRE.id)

  assert.equal(photoState(joined(db), TIRE).state, 'hidden')
  assert.equal(approvedImageUrls(db).has(TIRE.id), false, 'a hidden photo must not be served to customers')
})

test('hiding is reversible, unlike revoking', t => {
  const db = published(t)
  db.prepare('UPDATE image_publications SET hidden=1 WHERE supplier_id=?').run(TIRE.id)
  assert.equal(approvedImageUrls(db).has(TIRE.id), false)
  db.prepare('UPDATE image_publications SET hidden=0 WHERE supplier_id=?').run(TIRE.id)
  assert.equal(approvedImageUrls(db).has(TIRE.id), true, 'unhiding must restore the photo without a new packet')
})

test('hiding a photo does not touch the decision log', t => {
  const db = published(t)
  const before = db.prepare('SELECT seq, action, hash FROM image_decisions ORDER BY seq').all()
  db.prepare('UPDATE image_publications SET hidden=1 WHERE supplier_id=?').run(TIRE.id)
  const after = db.prepare('SELECT seq, action, hash FROM image_decisions ORDER BY seq').all()
  assert.deepEqual(after, before, 'the approval chain records what was approved; hiding is not a revision of that')
})

test('a supplier row that changed since approval reads stale, not live and not absent', t => {
  const db = published(t)
  // A price change is enough: the revision hash covers the whole payload.
  const moved = { ...TIRE, price: 99 }
  db.prepare('UPDATE supplier SET payload=? WHERE id=?').run(JSON.stringify(moved), TIRE.id)

  const state = photoState(joined(db), moved)
  assert.equal(state.state, 'stale')
  assert.ok(state.url, 'stale still knows its URL -- the owner needs to see what stopped being served')
  assert.equal(approvedImageUrls(db).has(TIRE.id), false, 'and it is genuinely not served')
})

test('every state is distinguishable: none, pending, revoked, hidden, stale, live', t => {
  const db = published(t)
  assert.equal(photoState(joined(db), TIRE).state, 'live')

  const none = photoState({ photo_packet: null }, TIRE)
  assert.equal(none.state, 'none')
  assert.equal(none.url, null)

  assert.equal(photoState({ photo_packet: 'p1', photo_approved: 0, photo_revoked: 0 }, TIRE).state, 'pending')
  assert.equal(photoState({ photo_packet: 'p1', photo_approved: 1, photo_revoked: 1 }, TIRE).state, 'revoked')
})

test('a revoked packet reads revoked even while its publication row survives', t => {
  const db = published(t, { revoked: true })
  assert.equal(photoState(joined(db), TIRE).state, 'revoked')
  assert.equal(approvedImageUrls(db).has(TIRE.id), false)
})
