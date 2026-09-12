import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

import { splitStagedContainer, unwrapStagedImages, CONTAINER_LENGTH_BYTES } from './unwrap-staged-images.mjs'

/**
 * A staged container, built the way `image-staging.mjs` writes one: four bytes
 * of big-endian metadata length, canonical JSON, then the image payload.
 */
function container(metadata, image) {
  const meta = Buffer.from(JSON.stringify(metadata))
  const header = Buffer.alloc(CONTAINER_LENGTH_BYTES)
  header.writeUInt32BE(meta.length, 0)
  return Buffer.concat([header, meta, image])
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') // a PNG signature + IHDR start

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'kmt-unwrap-'))
  const staging = path.join(root, 'staging')
  const packet = path.join(root, 'packet')
  const out = path.join(root, 'out')
  mkdirSync(path.join(staging, 'images'), { recursive: true })
  mkdirSync(packet, { recursive: true })

  const images = [PNG, Buffer.concat([PNG, Buffer.from('second')])]
  const rows = images.map((image, i) => ({
    supplierId: `giga-fixture-${i}`,
    sha256: createHash('sha256').update(image).digest('hex'),
    format: 'png',
    image,
  }))
  for (const row of rows) {
    writeFileSync(path.join(staging, 'images', `${row.sha256}.png`),
      container({ storageKey: `images/${row.sha256}.png`, sha256: row.sha256 }, row.image))
  }

  const db = new DatabaseSync(path.join(staging, 'run.sqlite'))
  db.exec('CREATE TABLE image_assets (supplier_id TEXT, sha256 TEXT, format TEXT)')
  for (const row of rows) {
    db.prepare('INSERT INTO image_assets VALUES (?,?,?)').run(row.supplierId, row.sha256, row.format)
  }
  db.close()

  writeFileSync(path.join(packet, 'snapshot.json'), JSON.stringify({
    version: 2, candidates: rows.map(row => ({ supplierId: row.supplierId })),
  }))

  t.after(() => {})
  return { root, staging, packet, out, rows }
}

test('unwraps every container and verifies each payload against its own name', t => {
  const s = sandbox(t)
  const result = unwrapStagedImages({ stagingDirectory: s.staging, packetDirectory: s.packet, outputDirectory: s.out })

  assert.equal(result.count, 2)
  for (const [i, binding] of result.bindings.entries()) {
    assert.equal(binding.supplierId, s.rows[i].supplierId, 'bindings must follow the packet candidate order exactly')
    // The written file is the IMAGE, not the container it came out of.
    const written = readFileSync(binding.path)
    assert.deepEqual(written, s.rows[i].image)
    assert.notEqual(written.length, readFileSync(path.join(s.staging, 'images', `${s.rows[i].sha256}.png`)).length,
      'a container is strictly larger than the image inside it; writing the container back is the bug this tool exists to prevent')
  }
  assert.ok(readdirSync(s.out).includes('bindings.json'))
})

test('a container whose payload does not hash to its stored name is refused, not written', t => {
  const s = sandbox(t)
  // Same filename, different bytes inside: exactly the shape of a swapped or
  // truncated object. Nothing may be written for it.
  const name = `${s.rows[0].sha256}.png`
  writeFileSync(path.join(s.staging, 'images', name),
    container({ storageKey: `images/${name}`, sha256: s.rows[0].sha256 }, Buffer.from('not the image')))

  assert.throws(() => unwrapStagedImages({ stagingDirectory: s.staging, packetDirectory: s.packet, outputDirectory: s.out }),
    /hashes .*but it was stored as/)
})

test('splitStagedContainer refuses headers that cannot be true', () => {
  assert.throws(() => splitStagedContainer(Buffer.alloc(3)), /too short/)
  const lying = Buffer.alloc(20)
  lying.writeUInt32BE(9999, 0)
  assert.throws(() => splitStagedContainer(lying), /claims 9999 metadata bytes/)
  const notJson = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('****'), PNG])
  assert.throws(() => splitStagedContainer(notJson), /not JSON/)
})

test('a packet naming a supplier the staging run never fetched is refused', t => {
  const s = sandbox(t)
  writeFileSync(path.join(s.packet, 'snapshot.json'), JSON.stringify({
    version: 2, candidates: [{ supplierId: 'giga-not-in-this-run' }],
  }))
  assert.throws(() => unwrapStagedImages({ stagingDirectory: s.staging, packetDirectory: s.packet, outputDirectory: s.out }),
    /do not belong together/)
})

test('relative paths are refused on every directory argument', t => {
  const s = sandbox(t)
  for (const bad of [
    { stagingDirectory: 'staging', packetDirectory: s.packet, outputDirectory: s.out },
    { stagingDirectory: s.staging, packetDirectory: 'packet', outputDirectory: s.out },
    { stagingDirectory: s.staging, packetDirectory: s.packet, outputDirectory: 'out' },
  ]) {
    assert.throws(() => unwrapStagedImages(bad), /must be an absolute path/)
  }
})
