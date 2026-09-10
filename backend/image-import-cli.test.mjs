import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sha256Bytes } from './image-assets.mjs'
import { IMAGE_PILOT_POLICY } from './image-provider-profile.mjs'
import { runOfflineImageStagingFixtures } from './image-staging-coordinator.mjs'
import { decoderPython, realImageFixtures } from './fixtures/image-provider/decoder-fixtures.mjs'
import {
  assertReviewedHosts, deriveStagingSnapshot, describeRun, importProductImages, parseArguments,
} from '../scripts/import-product-images.mjs'

const images = realImageFixtures()
const HOST = 'cdn.example.test'
const PRODUCT_HOST = 'shop.example.test'

/** A packet snapshot exactly as `collectImagePilot` writes one: version 2, with provenance and enrichedRows. */
const packetSnapshot = (count = 3, host = HOST) => ({
  version: 2,
  candidates: Array.from({ length: count }, (unused, i) => ({
    supplierId: `fixture-${i}`, supplierSku: `sku-${i}`,
    productUrl: `https://${PRODUCT_HOST}/product/${i}`,
    originalUrl: `https://${host}/image/${i}`,
    revision: 'revision-1',
  })),
  provenance: {
    codeSha: 'a'.repeat(40), seed: 1, inputDigest: 'b'.repeat(64), mappingDigest: 'c'.repeat(64),
    selection: 'fixture', productHosts: [PRODUCT_HOST], imageHosts: [host], observations: [],
  },
  enrichedRows: Array.from({ length: count }, (unused, i) => ({ id: `fixture-${i}` })),
})

const profileFor = (host = HOST) => ({
  version: 1, providerId: 'offline-fixture',
  allowedHosts: [host, PRODUCT_HOST].sort(),
  policy: structuredClone(IMAGE_PILOT_POLICY),
})

async function packetDirectory(t, { snapshot = packetSnapshot(), profile = profileFor() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kmt-image-packet-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot))
  await writeFile(join(root, 'profile.json'), JSON.stringify(profile))
  return root
}

async function stagingDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'kmt-image-staging-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const fixturesFor = (count = 3, host = HOST) => new Map(Array.from({ length: count }, (unused, i) => [
  `https://${host}/image/${i}`, { status: 200, contentType: 'image/png', bytes: images.png, redirect: null },
]))

// ---------------------------------------------------------------- derivation

test('the derived snapshot is built from the five named fields, not copied', () => {
  const source = packetSnapshot(2)
  const derived = deriveStagingSnapshot(Buffer.from(JSON.stringify(source)))
  const staged = JSON.parse(derived.bytes.toString())

  assert.equal(staged.version, 1)
  assert.deepEqual(Object.keys(staged), ['version', 'candidates'],
    'planFrom matches its key set exactly, so provenance and enrichedRows must not survive the conversion')
  assert.deepEqual(Object.keys(staged.candidates[0]),
    ['supplierId', 'supplierSku', 'productUrl', 'originalUrl', 'revision'],
    'and each candidate is exactly the five fields planFrom requires, in a fixed order')
  assert.equal(derived.count, 2)
})

test('two packets with the same meaning and different key order derive byte-identical bytes', () => {
  const source = packetSnapshot(2)
  // The same candidates, written with their keys in the opposite order. JSON
  // preserves textual order through parse and stringify, so a conversion that
  // copied the parsed object through would derive different bytes -- and
  // therefore a different digest -- for a packet that says the same thing.
  const reordered = {
    ...source,
    candidates: source.candidates.map(candidate => ({
      revision: candidate.revision, originalUrl: candidate.originalUrl,
      productUrl: candidate.productUrl, supplierSku: candidate.supplierSku, supplierId: candidate.supplierId,
    })),
  }
  const first = deriveStagingSnapshot(Buffer.from(JSON.stringify(source)))
  const second = deriveStagingSnapshot(Buffer.from(JSON.stringify(reordered)))

  assert.equal(second.bytes.toString(), first.bytes.toString(), 'canonical, not merely deterministic')
  assert.equal(second.digest, first.digest)
  assert.notEqual(second.sourceDigest, first.sourceDigest,
    'the packets really are different bytes; it is the derivation that makes them agree')
})

test('an unexpected field in a packet candidate cannot ride into the staged snapshot', () => {
  const source = packetSnapshot(1)
  source.candidates[0].approvedBy = 'nobody'
  const staged = JSON.parse(deriveStagingSnapshot(Buffer.from(JSON.stringify(source))).bytes.toString())
  assert.deepEqual(Object.keys(staged.candidates[0]),
    ['supplierId', 'supplierSku', 'productUrl', 'originalUrl', 'revision'])
})

test('the derivation refuses a packet it cannot convert rather than converting it partly', () => {
  const missing = packetSnapshot(1)
  delete missing.candidates[0].revision
  assert.throws(() => deriveStagingSnapshot(Buffer.from(JSON.stringify(missing))), /refused/)

  const v1 = { version: 1, candidates: packetSnapshot(1).candidates }
  assert.throws(() => deriveStagingSnapshot(Buffer.from(JSON.stringify(v1))), /refused/,
    'a snapshot that is already v1 is not a packet snapshot and is not silently passed through')

  assert.throws(() => deriveStagingSnapshot(Buffer.from(JSON.stringify({ version: 2, candidates: [] }))), /refused/)
})

test('the digest is of the derived bytes, which is what staging verifies', () => {
  const derived = deriveStagingSnapshot(Buffer.from(JSON.stringify(packetSnapshot(2))))
  assert.equal(derived.digest, sha256Bytes(derived.bytes))
})

// ------------------------------------------------------------ reviewed hosts

test('every host the run may contact has to be typed out, exactly', () => {
  const hosts = [HOST, PRODUCT_HOST]
  assert.deepEqual(assertReviewedHosts(hosts, [PRODUCT_HOST, HOST]), [...hosts].sort(),
    'order and case do not matter; the set does')
  assert.deepEqual(assertReviewedHosts(hosts, [HOST.toUpperCase(), PRODUCT_HOST]), [...hosts].sort())

  assert.throws(() => assertReviewedHosts(hosts, [HOST]), /not the hosts/,
    'confirming a subset is not confirming the packet')
  assert.throws(() => assertReviewedHosts(hosts, [...hosts, 'cdn.elsewhere.test']), /not the hosts/)
  assert.throws(() => assertReviewedHosts(hosts, []), /not the hosts/)
})

test('the host refusal names both lists, because the person running this is the person who reviews them', () => {
  try {
    assertReviewedHosts([HOST], ['wrong.example.test'])
    assert.fail('expected a refusal')
  } catch (error) {
    assert.deepEqual(error.declared, [HOST])
    assert.deepEqual(error.given, ['wrong.example.test'])
  }
})

// ------------------------------------------------------------------ the run

test('a packet is acquired end to end, and both digests come back with it', async t => {
  const packet = await packetDirectory(t)
  const directory = await stagingDirectory(t)
  const result = await importProductImages(
    { packetDirectory: packet, stagingDirectory: directory, confirmHosts: [HOST, PRODUCT_HOST], python: decoderPython },
    { run: runOfflineImageStagingFixtures, fixtures: fixturesFor() },
  )

  assert.equal(result.selected, 3)
  assert.equal(result.attempted, 3)
  assert.equal(result.stored, 1, 'the three fixtures are the same bytes, so one is stored and two dedupe')
  assert.equal(result.deduped, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.integrity.complete, true)
  assert.equal(result.snapshotConverted, true)
  assert.equal(result.candidates, 3)

  const source = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(join(packet, 'snapshot.json'), 'utf8')))
  const derived = deriveStagingSnapshot(Buffer.from(JSON.stringify(source)))
  assert.equal(result.approvedSnapshotDigest, derived.sourceDigest, "the packet's own snapshot digest")
  assert.equal(result.stagedSnapshotDigest, derived.digest, 'and the derived one that was actually staged')
  assert.notEqual(result.approvedSnapshotDigest, result.stagedSnapshotDigest,
    'they differ, which is exactly why the link has to be recorded rather than assumed')
  assert.equal(result.snapshotDigest, result.stagedSnapshotDigest,
    "staging's own record agrees with what the caller says was staged")

  // What staging stored is the DERIVED snapshot, and it is intact on disk.
  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  const stored = Buffer.from(db.prepare('SELECT bytes FROM image_snapshot').get().bytes)
  db.close()
  assert.equal(stored.toString(), derived.bytes.toString())
})

test('a packet whose hosts were not confirmed never reaches the transport', async t => {
  const packet = await packetDirectory(t)
  const directory = await stagingDirectory(t)
  let called = false
  await assert.rejects(() => importProductImages(
    { packetDirectory: packet, stagingDirectory: directory, confirmHosts: [HOST], python: decoderPython },
    { run: async () => { called = true }, fixtures: fixturesFor() },
  ), /not the hosts/)
  assert.equal(called, false, 'the run is never started, so nothing is fetched and nothing is written')
})

test('a relative staging directory is refused before anything is read', async t => {
  const packet = await packetDirectory(t)
  await assert.rejects(() => importProductImages(
    { packetDirectory: packet, stagingDirectory: 'staging', confirmHosts: [HOST, PRODUCT_HOST] },
    { run: async () => assert.fail('must not run') },
  ), /refused/)
})

// ------------------------------------------------------- the conversion link

test('the provenance log records the packet digest it was derived from, beside the one it staged', async t => {
  const packet = await packetDirectory(t)
  const directory = await stagingDirectory(t)
  const result = await importProductImages(
    { packetDirectory: packet, stagingDirectory: directory, confirmHosts: [HOST, PRODUCT_HOST], python: decoderPython },
    { run: runOfflineImageStagingFixtures, fixtures: fixturesFor() },
  )

  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  const start = JSON.parse(db.prepare("SELECT payload FROM image_run_events WHERE type='run-start'").get().payload)
  db.close()

  assert.equal(start.sourceSnapshotDigest, result.approvedSnapshotDigest,
    "the packet's own v2 snapshot, which is what a person approves")
  assert.equal(start.snapshotDigest, result.stagedSnapshotDigest,
    'and the derived v1, which is what was verified and fetched under')
  assert.notEqual(start.sourceSnapshotDigest, start.snapshotDigest,
    'two different digests for one acquisition -- which is why recording the link is the point')
})

test('a run that derived nothing records no source digest, rather than restating its own', async t => {
  const directory = await stagingDirectory(t)
  // Staging a v1 snapshot directly, the way the offline fixture tests do: no
  // conversion happened, so there is no earlier digest and the log says so by
  // its absence rather than by repeating the staged one.
  const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, candidates: packetSnapshot(1).candidates }))
  const result = await runOfflineImageStagingFixtures({
    profile: profileFor(), snapshotBytes, expectedSnapshotDigest: sha256Bytes(snapshotBytes),
    directory, python: decoderPython, fixtures: fixturesFor(1),
  })

  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  const start = JSON.parse(db.prepare("SELECT payload FROM image_run_events WHERE type='run-start'").get().payload)
  db.close()
  assert.equal('sourceSnapshotDigest' in start, false)
})

test('a malformed source digest is refused before the run starts', async t => {
  const directory = await stagingDirectory(t)
  const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, candidates: packetSnapshot(1).candidates }))
  await assert.rejects(() => runOfflineImageStagingFixtures({
    profile: profileFor(), snapshotBytes, expectedSnapshotDigest: sha256Bytes(snapshotBytes),
    sourceSnapshotDigest: 'not-a-digest',
    directory, python: decoderPython, fixtures: fixturesFor(1),
  }), /refused/, 'it reaches an append-only log, so it is validated rather than trusted')
})

// -------------------------------------------------------------- what is said

test('a run the host turned away is reported as a stop, never as something to retry', () => {
  const refusedRun = {
    runId: '11111111-1111-4111-8111-111111111111',
    approvedSnapshotDigest: 'a'.repeat(64), stagedSnapshotDigest: 'b'.repeat(64), profileDigest: 'c'.repeat(64),
    hosts: [HOST], selected: 3, attempted: 1, stored: 0, deduped: 0, failed: 1,
    stoppedOnRefusal: true, integrity: { events: 7, complete: true },
  }
  const text = describeRun(refusedRun)
  assert.match(text, /TURNED THIS RUN AWAY/)
  assert.match(text, /do not retry/i)
  assert.match(text, /browser transport|user agent/i,
    'the message has to name the thing nobody may reach for, not just decline to do it')

  const cleanRun = { ...refusedRun, stoppedOnRefusal: false }
  assert.doesNotMatch(describeRun(cleanRun), /TURNED THIS RUN AWAY/)
})

test('the run summary names both digests and the conversion, so an audit needs no inference', () => {
  const text = describeRun({
    runId: '11111111-1111-4111-8111-111111111111',
    approvedSnapshotDigest: 'a'.repeat(64), stagedSnapshotDigest: 'b'.repeat(64), profileDigest: 'c'.repeat(64),
    hosts: [HOST], selected: 3, attempted: 3, stored: 3, deduped: 0, failed: 0,
    stoppedOnRefusal: false, integrity: { events: 20, complete: true },
  })
  assert.match(text, new RegExp('a'.repeat(64)))
  assert.match(text, new RegExp('b'.repeat(64)))
  assert.match(text, /converted from the packet's v2/)
})

// --------------------------------------------------------- the server boundary

test('nothing the server runs imports the acquisition command', async () => {
  // The owner's ruling is that this never runs on the server, and the argv
  // guard only stops an import from EXECUTING the file -- `importProductImages`
  // is exported and does reach the network, so the real guarantee is that no
  // server module pulls it in. That is a fact about the rest of the tree, so it
  // is checked here rather than asserted in a comment nobody re-reads.
  const { readdir, readFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = dirname(dirname(fileURLToPath(import.meta.url)))

  const offenders = []
  for (const directory of ['backend', 'src', 'src/owner', 'src/components']) {
    let entries
    try { entries = await readdir(join(root, directory)) } catch { continue }
    for (const entry of entries) {
      if (!/\.(mjs|js|jsx)$/.test(entry) || entry.includes('.test.')) continue
      const source = await readFile(join(root, directory, entry), 'utf8')
      if (source.includes('import-product-images')) offenders.push(`${directory}/${entry}`)
    }
  }
  assert.deepEqual(offenders, [], 'a server-side import of the acquisition command would put the fetch on the server')
})

// ------------------------------------------------------------------ argument

test('the command needs both directories and the hosts, in either flag form', () => {
  assert.deepEqual(parseArguments(['/packet', '/staging', '--confirm-hosts', 'a.test,b.test']),
    { packetDirectory: '/packet', stagingDirectory: '/staging', confirmHosts: ['a.test', 'b.test'], python: undefined })
  assert.deepEqual(parseArguments(['/packet', '/staging', '--confirm-hosts=a.test']).confirmHosts, ['a.test'])
  assert.equal(parseArguments(['/packet', '/staging', '--python=/usr/bin/python3']).python, '/usr/bin/python3')

  assert.throws(() => parseArguments(['/packet']), /Unexpected arguments/)
  assert.throws(() => parseArguments(['/packet', '/staging', '/extra']), /Unexpected arguments/)
})
