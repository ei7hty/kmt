import test from 'node:test'
import assert from 'node:assert/strict'

import { Inventory, modelImageUrls, modelKey } from './inventory.mjs'
import { supplierImageRevision } from './image-manifest.mjs'

/**
 * One approved photo, every size of that model.
 *
 * A tire's product shot is of the tread and sidewall pattern, which belongs to
 * the MODEL and not to the size, so a photo approved on 205/55R16 is an honest
 * picture of the same tire in 225/50R17. Until now it was shown on exactly the
 * one row it was attached to.
 *
 * Measured on production 2026-09-13, which is why this exists: 189 approved
 * photos, every one attached to exactly one row, and the 189 models they belong
 * to span 2,528 listings. 2,339 rows were drawing a grey placeholder beside a
 * photo of the same tire.
 *
 * EVERY APPROVED ROW GETS ITS OWN HASH, and that is load-bearing rather than
 * tidy. The first version of this file gave every photo the same sha, so a row
 * showing its OWN photo and a row showing a model-mate's were byte-identical
 * answers -- and the mutation that lets a sibling override a row's own photo
 * survived the whole suite. A fixture that cannot tell the two apart cannot
 * test which one happened.
 */

/** A distinct, valid-looking digest per supplier id. */
const shaFor = (id) => {
  let hex = ''
  for (const character of id) hex += character.charCodeAt(0).toString(16).padStart(2, '0')
  return (hex + '0'.repeat(64)).slice(0, 64)
}
const urlOf = (id) => `/api/images/${shaFor(id)}.jpeg`

const tire = (id, size, name) => ({
  id, name, size, price: 80, inStock: true, category: 'all-season',
  description: 'Fixture', source: { sku: id, url: `https://www.giga-tires.com/${size}/x/y/tirecode/${id}` },
})

/**
 * An inventory holding `rows`, with an approved photo on whichever ids are
 * named. Seeded through the tables directly, the way photo-visibility.test.mjs
 * does, because the decode-and-approve path is not what is under test.
 */
function withPhotos(t, rows, approvedIds) {
  const inventory = new Inventory(':memory:', [...new Set(rows.map(row => row.size))])
  t.after(() => inventory.close())
  const db = inventory.db
  for (const row of rows) {
    db.prepare('INSERT INTO supplier (id, size, payload, last_seen, active) VALUES (?,?,?,?,1)')
      .run(row.id, row.size, JSON.stringify(row), 'now')
  }
  if (approvedIds.length) {
    db.prepare('INSERT INTO image_packets VALUES (?,?,?,?,?)').run('p1', Buffer.from('m'), Buffer.from('p'), Buffer.from('s'), 'now')
    db.prepare("INSERT INTO image_decisions VALUES (1,'p1',1,'imported','o','now','','h1')").run()
    db.prepare("INSERT INTO image_decisions VALUES (2,'p1',2,'approved','o','now','h1','h2')").run()
    approvedIds.forEach((id, ordinal) => {
      const row = rows.find(candidate => candidate.id === id)
      db.prepare('INSERT INTO image_packet_assets VALUES (?,?,?,?,?,?)')
        .run('p1', ordinal, id, supplierImageRevision(row), JSON.stringify({ sha256: shaFor(id), format: 'jpeg', bytes: 10 }), 'decoder')
      db.prepare('INSERT INTO image_publications (supplier_id, packet, ordinal, hidden) VALUES (?,?,?,0)').run(id, 'p1', ordinal)
    })
  }
  return inventory
}

const urlFor = (inventory, size, id) =>
  inventory.catalog({ size }).find(row => row.id === id)?.imageUrl

test('a photo approved on one size shows on every size of that model', t => {
  // The whole feature, and the state production is in today.
  const rows = [
    tire('giga-a-16', '205/55R16', 'Royal Black Racing Trac'),
    tire('giga-a-17', '225/50R17', 'Royal Black Racing Trac'),
    tire('giga-a-18', '235/45R18', 'Royal Black Racing Trac'),
  ]
  const inventory = withPhotos(t, rows, ['giga-a-16'])
  for (const row of rows) {
    assert.equal(urlFor(inventory, row.size, row.id), urlOf('giga-a-16'), `${row.size} showed no photo`)
  }
})

test('THE SIZE FILTER IS THE TRAP: the photo lives in a size the query never returns', t => {
  // `catalog(size)` filters to one size, and the photo of that model very
  // likely sits on a different one -- which is the entire point of the feature.
  // Building the model map out of the rows `catalog()` is about to return would
  // find nothing, change nothing, and look implemented.
  //
  // So this asks for ONLY the size with no photo of its own.
  const rows = [
    tire('giga-b-16', '205/55R16', 'Aplus Pro Racing'),
    tire('giga-b-17', '225/50R17', 'Aplus Pro Racing'),
  ]
  const inventory = withPhotos(t, rows, ['giga-b-16'])
  const answered = inventory.catalog({ size: '225/50R17' })

  assert.equal(answered.length, 1, 'the fixture must return exactly the size with no photo of its own')
  assert.equal(answered[0].id, 'giga-b-17')
  assert.equal(answered[0].imageUrl, urlOf('giga-b-16'))
})

test('a photo never crosses to a different model', t => {
  const rows = [
    tire('giga-c-16', '205/55R16', 'Has A Photo'),
    tire('giga-d-16', '205/55R16', 'Different Model'),
  ]
  const inventory = withPhotos(t, rows, ['giga-c-16'])
  const answered = inventory.catalog({ size: '205/55R16' })

  assert.equal(answered.find(row => row.id === 'giga-c-16').imageUrl, urlOf('giga-c-16'))
  assert.equal(answered.find(row => row.id === 'giga-d-16').imageUrl, undefined,
    'a photo of one model was shown on another')
})

test('a model with no photo anywhere carries no imageUrl at all', t => {
  const rows = [tire('giga-e-16', '205/55R16', 'Unphotographed')]
  const inventory = withPhotos(t, rows, [])
  const [answered] = inventory.catalog({ size: '205/55R16' })

  assert.equal('imageUrl' in answered, false,
    'the field is omitted, not null -- the customer-field contract allows it only when present')
})

test("a row's own photo always wins over a model-mate's", t => {
  // The fallback may only ever fill a gap. If a size is photographed on its own
  // -- a re-shoot, a different tread -- that photo is the one for that row and
  // no sibling may displace it.
  //
  // Both rows are approved with DIFFERENT digests, so "showed its own" and
  // "showed its sibling's" are distinguishable answers. With one shared digest
  // they are the same string and this test passes either way, which is exactly
  // what happened before a mutation caught it.
  const rows = [
    tire('giga-f-16', '205/55R16', 'Twice Shot'),
    tire('giga-f-17', '225/50R17', 'Twice Shot'),
  ]
  const inventory = withPhotos(t, rows, ['giga-f-16', 'giga-f-17'])

  assert.equal(urlFor(inventory, '205/55R16', 'giga-f-16'), urlOf('giga-f-16'),
    'the 16 showed a photo that is not its own')
  assert.equal(urlFor(inventory, '225/50R17', 'giga-f-17'), urlOf('giga-f-17'),
    'the 17 showed a photo that is not its own')
  assert.notEqual(urlOf('giga-f-16'), urlOf('giga-f-17'), 'the fixture only discriminates while the two digests differ')
})

test('a row with no model name never joins a nameless group', t => {
  // Without the guard every nameless row keys on the empty string, so one
  // nameless tire with a photo would hand it to every other nameless tire,
  // across brands and categories. Found by a mutation that survived: nothing
  // covered a blank name.
  const named = tire('giga-h-16', '205/55R16', 'Has A Name')
  const nameless = { ...tire('giga-i-16', '205/55R16', ''), name: '' }
  const alsoNameless = { ...tire('giga-j-16', '205/55R16', ''), name: '   ' }

  const inventory = withPhotos(t, [named, nameless, alsoNameless], ['giga-i-16'])
  const answered = inventory.catalog({ size: '205/55R16' })

  assert.equal(answered.find(row => row.id === 'giga-j-16')?.imageUrl, undefined,
    'a nameless row inherited a photo from another nameless row')
  assert.equal(answered.find(row => row.id === 'giga-h-16')?.imageUrl, undefined,
    'a named row inherited a photo from a nameless one')
  assert.equal(modelImageUrls(inventory.db, new Map([['giga-i-16', urlOf('giga-i-16')]])).has(''), false)
})

// --- The model map itself ----------------------------------------------------

test('modelKey groups the same name whatever its spacing or case', () => {
  assert.equal(modelKey('Royal Black Racing Trac'), modelKey('  royal black RACING trac  '))
  assert.notEqual(modelKey('Aplus Pro Racing'), modelKey('Aplus Pro Racing II'))
  assert.equal(modelKey(undefined), '')
  assert.equal(modelKey(42), '')
})

test('the model map picks one photo per model, and picks the same one twice', t => {
  // Two sizes of a model both approved: whichever is chosen must be chosen
  // again next request, or the page changes picture on reload for no reason.
  //
  // THE INSERTION ORDER IS THE FIXTURE. The lowest id is inserted FIRST, so
  // "lowest id wins" and "last one processed wins" give different answers. With
  // the lowest id inserted last the two agree, and replacing the tie-break with
  // `if (true)` left this green -- which is how it was written first, and what
  // the mutation caught.
  const rows = [
    tire('giga-a-16', '205/55R16', 'Two Photos'),
    tire('giga-z-17', '225/50R17', 'Two Photos'),
  ]
  const inventory = withPhotos(t, rows, ['giga-z-17', 'giga-a-16'])
  const urls = new Map([['giga-z-17', '/api/images/z.jpeg'], ['giga-a-16', '/api/images/a.jpeg']])

  const first = modelImageUrls(inventory.db, urls)
  const second = modelImageUrls(inventory.db, urls)
  assert.equal(first.get(modelKey('Two Photos')), second.get(modelKey('Two Photos')))
  assert.equal(first.get(modelKey('Two Photos')), '/api/images/a.jpeg', 'lowest id wins, deterministically')
})

test('an empty approval set builds an empty map and asks the database nothing', t => {
  const inventory = withPhotos(t, [tire('giga-g-16', '205/55R16', 'Any')], [])
  assert.equal(modelImageUrls(inventory.db, new Map()).size, 0)
  assert.equal(modelImageUrls(inventory.db, null).size, 0)
})
