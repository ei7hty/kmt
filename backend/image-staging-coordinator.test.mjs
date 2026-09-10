import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { sha256Bytes } from './image-assets.mjs'
import { IMAGE_PILOT_POLICY, compileImageProviderProfile } from './image-provider-profile.mjs'
import { createImageRunProvenance, verifyImageRunProvenance } from './image-run-provenance.mjs'
import { createSafeImageFetcher } from '../scripts/image-mirror.mjs'
import { PROVIDER_MODE, provenanceTransport, runApprovedImageStaging, runOfflineImageStagingFixtures } from './image-staging-coordinator.mjs'
import { decoderPython, realImageFixtures, incompletePayloads } from './fixtures/image-provider/decoder-fixtures.mjs'

const images = realImageFixtures()
function plan(host = 'cdn.example.test') {
  const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, candidates: Array.from({ length: 5 }, (_, i) => ({
    supplierId: `fixture-${i}`, supplierSku: `sku-${i}`, revision: 'revision-1',
    productUrl: `https://${host}/product/${i}`, originalUrl: `https://${host}/image/${i}`,
  })) }))
  return { profile: { version: 1, providerId: 'offline-fixture', allowedHosts: [host], policy: structuredClone(IMAGE_PILOT_POLICY) },
    snapshotBytes, expectedSnapshotDigest: sha256Bytes(snapshotBytes), python: decoderPython,
    fixtures: new Map(Array.from({ length: 5 }, (_, i) => [`https://${host}/image/${i}`,
      { status: 200, contentType: 'image/png', bytes: images.png, redirect: null }])) }
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'kmt-image-offline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
test('exact-five fixture run persists snapshot, private provenance and candidate-only SQL truth', async t => {
  const directory = await workspace(t), input = { ...plan(), directory }
  const result = await runOfflineImageStagingFixtures(input)
  assert.equal(result.selected, 5); assert.equal(result.attempted, 5); assert.equal(result.stored, 1); assert.equal(result.deduped, 4)
  assert.equal(result.failed, 0); assert.equal(result.integrity.complete, true)
  assert.ok(result.states.every(row => row.usageStatus === 'candidate' && row.sha256 === sha256Bytes(images.png)))
  const publicResult = JSON.stringify(result)
  assert.ok(!publicResult.includes(directory)); assert.ok(!publicResult.includes('https://')); assert.ok(!publicResult.includes('kmt-staging://'))
  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM image_snapshot').get().bytes), input.snapshotBytes)
  assert.throws(() => db.exec("UPDATE image_assets SET usage_status='approved'"), /never approves/)
  assert.throws(() => db.exec('DELETE FROM image_snapshot'), /immutable snapshot/)
  const events = db.prepare('SELECT type, payload FROM image_run_events ORDER BY seq').all()
  for (const type of ['candidate-start', 'connect', 'response', 'decoded', 'commit-intent', 'commit-result']) assert.equal(events.filter(e => e.type === type).length, 5)
  const source = JSON.parse(events.find(e => e.type === 'candidate-start').payload)
  assert.equal(source.supplierSku, 'sku-0'); assert.equal(source.revision, 'revision-1')
  assert.equal(source.profileDigest, result.profileDigest); assert.equal(source.snapshotDigest, result.snapshotDigest)
  const decoded = JSON.parse(events.find(e => e.type === 'decoded').payload)
  assert.equal(decoded.decoder, '12.3.0'); assert.equal(decoded.validation, 'png-zlib-complete-v1')
  assert.ok(['windows-job', 'posix-rlimit'].includes(decoded.isolation))
  assert.throws(() => db.exec('DELETE FROM image_run_events'), /append-only/)
  assert.throws(() => db.exec("UPDATE image_run_events SET payload='{}'"), /append-only/)
  db.close()
})
test('incomplete JPEG entropy with preserved EOI never creates storage mappings or candidate hashes', async t => {
  const root = await workspace(t)
  for (const variant of incompletePayloads(images).filter(item => item.format === 'jpeg')) {
    const input = plan(), directory = join(root, `missing-${variant.missing}`)
    for (const fixture of input.fixtures.values()) { fixture.contentType = 'image/jpeg'; fixture.bytes = variant.bytes }
    const result = await runOfflineImageStagingFixtures({ ...input, directory })
    assert.equal(result.attempted, 5); assert.equal(result.failed, 5); assert.equal(result.stored, 0); assert.equal(result.deduped, 0)
    const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_storage').get().n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_assets WHERE sha256 IS NOT NULL OR storage_key IS NOT NULL').get().n, 0)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM image_run_events WHERE type='decoded' OR type='commit-intent'").get().n, 0)
    } finally { db.close() }
    assert.ok(!(await readdir(directory)).includes('images'), 'no object publication')
  }
})
test('incomplete PNG stream and unsupported GIF/WebP never attach or publish', async t => {
  const root = await workspace(t)
  for (const format of ['png', 'gif', 'webp']) {
    const variant = incompletePayloads(images).find(item => item.format === format && item.missing === 1)
    const input = plan(), directory = join(root, format)
    for (const fixture of input.fixtures.values()) { fixture.contentType = `image/${format}`; fixture.bytes = variant.bytes }
    const result = await runOfflineImageStagingFixtures({ ...input, directory })
    assert.equal(result.failed, 5); assert.equal(result.stored, 0); assert.equal(result.deduped, 0)
    assert.ok(result.states.every(row => row.sha256 === null))
    const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_storage').get().n, 0) }
    finally { db.close() }
    assert.ok(!(await readdir(directory)).includes('images'))
  }
})
test('valid strict JPEG still stores and deduplicates with validator evidence', async t => {
  const input = plan(), directory = await workspace(t)
  for (const fixture of input.fixtures.values()) { fixture.contentType = 'image/jpeg'; fixture.bytes = images.jpeg }
  const result = await runOfflineImageStagingFixtures({ ...input, directory })
  assert.equal(result.stored, 1); assert.equal(result.deduped, 4); assert.equal(result.failed, 0)
  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  try {
    const decoded = JSON.parse(db.prepare("SELECT payload FROM image_run_events WHERE type='decoded' LIMIT 1").get().payload)
    assert.equal(decoded.validation, 'simplejpeg-1.9.0-strict')
  } finally { db.close() }
})
// `candidates.pop()` left this list when the packet size stopped being five: a
// snapshot with one fewer candidate is a smaller run, not a truncated one, and
// is covered by its own test below. An EMPTY snapshot is still refused -- a run
// of nothing is a mistake rather than a smaller run -- so the zero case took
// pop()'s place here. Every other mutation in the list is a real invariant and
// none of them is about the count: duplicate rows, a reused supplier id,
// credentials in a URL, and a snapshot that pre-approves its own candidates.
test('staging refuses wrong hash, empty set, stale identity, credentials and unknown fields before filesystem writes', async t => {
  const directory = await workspace(t)
  for (const change of [data => data.candidates.push(data.candidates[0]),
    data => { data.candidates[1].supplierId = data.candidates[0].supplierId },
    data => { data.candidates[0].originalUrl = 'https://secret@cdn.example.test/image' },
    data => { data.candidates[0].usageStatus = 'approved' },
    data => { data.candidates.length = 0 }]) {
    const input = plan(), snapshot = JSON.parse(input.snapshotBytes); change(snapshot)
    input.snapshotBytes = Buffer.from(JSON.stringify(snapshot)); input.expectedSnapshotDigest = sha256Bytes(input.snapshotBytes)
    await assert.rejects(runOfflineImageStagingFixtures({ ...input, directory }))
  }
  await assert.rejects(runOfflineImageStagingFixtures({ ...plan(), directory, expectedSnapshotDigest: 'a'.repeat(64) }))
  assert.deepEqual(await readdir(directory), [])
})
test('a snapshot with fewer candidates stages fewer images rather than refusing', async t => {
  const directory = await workspace(t)
  const input = plan(), snapshot = JSON.parse(input.snapshotBytes)
  const dropped = snapshot.candidates.pop()
  input.snapshotBytes = Buffer.from(JSON.stringify(snapshot))
  input.expectedSnapshotDigest = sha256Bytes(input.snapshotBytes)
  const result = await runOfflineImageStagingFixtures({ ...input, directory })
  assert.ok(dropped, 'the fixture had a candidate to drop, or this proves nothing')
  // `attempted` is the assertion that matters: four candidates were actually
  // run rather than the snapshot being refused for not containing five.
  assert.equal(result.attempted, snapshot.candidates.length)
  // `selected` reported 5 unconditionally before this change, so a four-image
  // run claimed five were selected -- a number true only while it could not vary.
  assert.equal(result.selected, snapshot.candidates.length)
  assert.equal(result.failed, 0)
  assert.equal(result.stoppedOnRefusal, false)
  // Not `stored === 4`: every fixture serves the same PNG bytes, so
  // content-addressed storage keeps one object and dedupes the rest. The
  // invariant is that each attempt is accounted for, not that each is a file.
  assert.equal(result.stored + result.deduped, snapshot.candidates.length)
})
// This test's second half used to assert the provider entry point threw
// /PROJECT MANAGER/, because a compiled-in approval registry stood in front of
// it. That registry is gone on the owner's ruling that approval lives in the
// owner screen, so the assertion moved rather than its expected value: what must
// still hold is that the two seams cannot be crossed in either direction.
test('the fixture seam and the provider seam cannot be crossed in either direction', async t => {
  const directory = await workspace(t)
  // A reserved example domain, never contacted.
  await assert.rejects(runOfflineImageStagingFixtures({ ...plan('cdn.example.com'), directory }))
  // Fixtures handed to the provider run are a caller who believes they are
  // offline while addressing the network. Refused, not ignored.
  await assert.rejects(runApprovedImageStaging({ ...plan(), directory }))
  assert.deepEqual(await readdir(directory), [])
})

test('a snapshot over the politeness ceiling is refused before any filesystem work', async t => {
  const directory = await workspace(t)
  const input = plan(), snapshot = JSON.parse(input.snapshotBytes), one = snapshot.candidates[0]
  snapshot.candidates = Array.from({ length: IMAGE_PILOT_POLICY.candidateLimit + 1 }, (_, i) => ({
    ...one, supplierId: `over-${i}`, supplierSku: `sku-over-${i}`,
    productUrl: `https://cdn.example.test/product/over-${i}`, originalUrl: `https://cdn.example.test/image/over-${i}`,
  }))
  input.snapshotBytes = Buffer.from(JSON.stringify(snapshot))
  input.expectedSnapshotDigest = sha256Bytes(input.snapshotBytes)
  // candidateLimit was enforced by assertApprovedImagePlan, which went with the
  // approval registry. It is not an approval detail -- it is the load one run
  // puts on somebody else's server -- so it moved into the plan.
  await assert.rejects(runOfflineImageStagingFixtures({ ...input, directory }))
  assert.deepEqual(await readdir(directory), [])
})

test('the provenance decorator records the trail without deciding anything', async () => {
  const events = []
  const append = (type, fields) => events.push([type, fields])
  const advance = () => ({ supplierId: 'fixture-0', supplierSku: 'sku-0', candidateRevision: 'revision-1', productUrl: 'https://cdn.example.test/product/0' })
  const seen = []
  const inner = { fetch: async (url, options) => {
    options.onConnect({ url, address: '93.184.216.34' })
    options.onRedirect('https://cdn.example.test/image/moved')
    options.onConnect({ url: 'https://cdn.example.test/image/moved', address: '93.184.216.34' })
    return { status: 200, headers: {}, finalUrl: 'https://cdn.example.test/image/moved', bytes: Buffer.from('bytes') }
  } }
  const response = await provenanceTransport(inner, { advance, append }).fetch('https://cdn.example.test/image/0', {
    onConnect: details => { seen.push(['connect', details.url]); return 'authorized' },
    onRedirect: next => { seen.push(['redirect', next]); return next },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(events.map(([type]) => type), ['candidate-start', 'connect', 'redirect', 'connect', 'response'])
  // The decorator must not swallow or rewrite the caller's authorization: every
  // callback still reaches it, which is what keeps createSafeImageFetcher's host
  // and resolved-address checks biting through the wrapper.
  assert.deepEqual(seen, [['connect', 'https://cdn.example.test/image/0'],
    ['redirect', 'https://cdn.example.test/image/moved'],
    ['connect', 'https://cdn.example.test/image/moved']])
  assert.equal(events.find(([type]) => type === 'redirect')[1].finalUrl, 'https://cdn.example.test/image/0',
    'the redirect names the hop being left, not the one being entered')
})

test('an authorization throw from the caller is not absorbed by the decorator', async () => {
  const advance = () => ({ supplierId: 'fixture-0', supplierSku: 'sku-0', candidateRevision: 'revision-1', productUrl: 'https://cdn.example.test/product/0' })
  const inner = { fetch: async (url, options) => { options.onConnect({ url, address: '10.0.0.1' }); return { status: 200, headers: {}, finalUrl: url, bytes: Buffer.alloc(1) } } }
  const decorated = provenanceTransport(inner, { advance, append: () => {} })
  await assert.rejects(() => decorated.fetch('https://cdn.example.test/image/0', {
    onConnect: () => { throw new Error('address refused') },
  }), /address refused/)
})

test('the provider mode carries the profile pacing and a transport the safe fetcher accepts', () => {
  const profile = compileImageProviderProfile({ version: 1, providerId: 'offline-fixture',
    allowedHosts: ['cdn.example.test'], policy: structuredClone(IMAGE_PILOT_POLICY) })
  assert.equal(PROVIDER_MODE.delayMs({ profile }), IMAGE_PILOT_POLICY.delayMs)
  assert.notEqual(PROVIDER_MODE.delayMs({ profile }), 0, 'a provider run is paced; only the fixture harness is not')
  assert.doesNotMatch(PROVIDER_MODE.failureMessage, /offline/i)
  const transport = PROVIDER_MODE.prepare({}, { profile })({ advance: () => ({}), append: () => {} })
  assert.equal(typeof transport.fetch, 'function')
  // The decorator is a transport, not a replacement for the layer that
  // authorizes hosts and resolved addresses.
  assert.equal(typeof createSafeImageFetcher(transport, profile), 'function')
})
test('redirect trail and final URLs persist, forbidden redirects globally stop at one', async t => {
  const directory = await workspace(t), input = plan()
  input.fixtures.get('https://cdn.example.test/image/0').status = 302
  input.fixtures.get('https://cdn.example.test/image/0').redirect = 'https://private.example.test/no'
  const result = await runOfflineImageStagingFixtures({ ...input, directory })
  assert.equal(result.attempted, 1); assert.equal(result.stoppedOnRefusal, true); assert.equal(result.stored, 0)
  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  const redirect = JSON.parse(db.prepare("SELECT payload FROM image_run_events WHERE type='redirect'").get().payload)
  assert.equal(redirect.finalUrl, 'https://cdn.example.test/image/0'); assert.equal(redirect.redirectUrl, 'https://private.example.test/no')
  db.close()
})
test('403 and challenge stop the run; malformed decoder inputs never attach storage', async t => {
  const root = await workspace(t)
  for (const [name, status, bytes, stopped] of [['denial', 403, images.png, true], ['challenge', 200, Buffer.from('captcha'), true], ['malformed', 200, Buffer.from('invalid PNG'), false]]) {
    const input = plan()
    input.fixtures.get('https://cdn.example.test/image/0').status = status
    input.fixtures.get('https://cdn.example.test/image/0').bytes = bytes
    const result = await runOfflineImageStagingFixtures({ ...input, directory: join(root, name) })
    assert.equal(result.failed, 1); assert.equal(result.stoppedOnRefusal, stopped)
    assert.equal(result.states[0].sha256, null); assert.equal(result.attempted, stopped ? 1 : 5)
  }
})
test('append-only hash chain detects tampering and interrupted prefix remains incomplete', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const log = createImageRunProvenance(db, { runId: randomUUID(), profileDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) })
    log.append('run-start', { selected: ['1', '2', '3', '4', '5'] })
    log.append('commit-intent', { candidateId: 1, sha256: 'c'.repeat(64) })
    assert.equal(verifyImageRunProvenance(db).complete, false)
    assert.throws(() => log.append('candidate-failure', { path: '/private/secret' }))
    db.exec("DROP TRIGGER image_events_no_update; UPDATE image_run_events SET payload='{}' WHERE seq=1")
    assert.throws(() => verifyImageRunProvenance(db), /integrity failure/)
  } finally { db.close() }
})
test('snapshot remains a private artifact; CLI execution is still unavailable', async () => {
  const script = await readFile(new URL('../scripts/image-mirror.mjs', import.meta.url), 'utf8')
  assert.ok(script.includes('Execution is unavailable from the CLI'))
})
test('successful redirects persist final URL; MIME disagreement refuses attachment', async t => {
  const directory = await workspace(t), input = plan()
  input.fixtures.set('https://cdn.example.test/final', { status: 200, contentType: 'image/png', bytes: images.png, redirect: null })
  Object.assign(input.fixtures.get('https://cdn.example.test/image/0'), { status: 302, redirect: '/final' })
  input.fixtures.get('https://cdn.example.test/image/1').contentType = 'image/jpeg'
  const result = await runOfflineImageStagingFixtures({ ...input, directory })
  assert.equal(result.failed, 1); assert.equal(result.states[1].sha256, null)
  const db = new DatabaseSync(join(directory, `${result.runId}.sqlite`))
  try {
    const responses = db.prepare("SELECT payload FROM image_run_events WHERE type='response'").all().map(row => JSON.parse(row.payload))
    assert.ok(responses.some(row => row.finalUrl === 'https://cdn.example.test/final' && row.sha256 === sha256Bytes(images.png)))
  } finally { db.close() }
})
test('abrupt coordinator process death preserves a verifiable incomplete provenance prefix', async t => {
  const directory = await workspace(t)
  const child = spawn(process.execPath, ['backend/fixtures/image-provider/coordinator-worker.mjs', directory], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, KMT_IMAGE_DECODER_PYTHON: decoderPython },
  })
  const closed = once(child, 'close')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000)
  try {
    const [code] = await closed
    assert.equal(code, 86, 'fixture must terminate after its actual durable candidate-start')
  } finally { clearTimeout(timeout); child.kill('SIGKILL') }
  const name = (await readdir(directory)).find(value => value.endsWith('.sqlite'))
  const db = new DatabaseSync(join(directory, name))
  try {
    const integrity = verifyImageRunProvenance(db)
    assert.ok(integrity.events > 1); assert.equal(integrity.complete, false)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM image_assets WHERE usage_status <> 'candidate'").get().n, 0)
  } finally { db.close() }
})
