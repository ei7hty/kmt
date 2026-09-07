import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Inventory } from './inventory.mjs'
import { createImageAssetRepository, ensureImageAssetSchema, imageStorageKey, ImageAssetStorageConflictError, listImageCandidates, reconcileImageCandidates } from './image-assets.mjs'
import { ImageMirrorError, mirrorRemoteImages } from '../scripts/image-mirror.mjs'

const SIZE = '215/60R16'
const PRODUCT_URL = 'https://www.giga-tires.com/tires/example/roadmaster/SKU123'
const IMAGE_URL = 'https://cdn.example.test/SKU123.webp'
const ALLOWED_HOSTS = ['www.giga-tires.com', 'cdn.example.test']

function tire(overrides = {}) {
  return {
    id: 'giga-sku123', name: 'Example RoadMaster', size: SIZE, price: 82.49,
    inStock: true, category: 'all-season', imageUrls: [IMAGE_URL],
    source: { sku: 'SKU123', url: PRODUCT_URL, fetchedAt: '2026-09-07T12:00:00.000Z' },
    ...overrides,
  }
}

function inventoryFixture() {
  const folder = mkdtempSync(join(tmpdir(), 'kmt-image-mirror-'))
  const filename = join(folder, 'inventory.sqlite')
  const inventory = new Inventory(filename, [SIZE])
  inventory.testFilename = filename
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-07T12:00:00.000Z', sizes: [SIZE], tires: [tire()] })
  return { inventory, folder }
}

function fakeImageResponse(bytes, contentType = 'image/webp', status = 200, finalUrl = IMAGE_URL) {
  return { status, headers: { 'content-type': contentType }, bytes, finalUrl }
}

function fakeStorage() {
  const byHash = new Map()
  const writes = []
  return {
    writes,
    async findByHash(hash) { return byHash.get(hash) ?? null },
    async put(input) {
      const stored = { storageKey: `images/${input.sha256}.${input.format}`, storageUrl: `https://storage.example.test/${input.sha256}` }
      byHash.set(input.sha256, stored)
      writes.push({ ...input, ...stored })
      return stored
    },
  }
}

test('image asset migration reconciles stable identity, source presence, and round-trips', t => {
  const { inventory, folder } = inventoryFixture()
  let reopened
  t.after(() => { try { reopened?.close() } catch { /* already closed */ } try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  ensureImageAssetSchema(inventory)
  const report = reconcileImageCandidates(inventory, [tire()], { allowedHosts: ALLOWED_HOSTS })
  assert.deepEqual(report, { reconciled: 1, suppliers: 1 })
  const row = listImageCandidates(inventory)[0]
  assert.equal(row.supplierId, 'giga-sku123')
  assert.equal(row.supplierSku, 'SKU123')
  assert.equal(row.productUrl, PRODUCT_URL)
  assert.equal(row.remoteImagePresent, true)
  assert.equal(row.sourceMetadataPresent, true)
  assert.equal(row.usageStatus, 'candidate')
  inventory.close()
  reopened = new Inventory(inventoryFilename(inventory), [SIZE])
  assert.equal(listImageCandidates(reopened)[0].originalUrl, IMAGE_URL)
})

function inventoryFilename(inventory) {
  return inventory.testFilename
}

test('reconciliation records missing remote image metadata without inventing a URL', t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  const report = reconcileImageCandidates(inventory, [tire({ imageUrls: [] })], { allowedHosts: ALLOWED_HOSTS })
  assert.equal(report.reconciled, 1)
  const row = listImageCandidates(inventory)[0]
  assert.equal(row.remoteImagePresent, false)
  assert.equal(row.originalUrl, null)
  assert.equal(row.sourceMetadataPresent, true)
})

test('reconciliation rejects a non-HTTPS or non-allowlisted source before writing a candidate', t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  assert.throws(() => reconcileImageCandidates(inventory, [tire({ imageUrls: ['http://cdn.example.test/image.webp'] })], { allowedHosts: ['cdn.example.test', 'www.giga-tires.com'] }), /HTTPS/)
  assert.throws(() => reconcileImageCandidates(inventory, [tire({ imageUrls: ['https://evil.example.test/image.webp'] })], { allowedHosts: ALLOWED_HOSTS }), /not allowlisted/)
  assert.equal(inventory.db.prepare('SELECT count(*) AS n FROM image_assets').get()?.n ?? 0, 0)
})

test('dry run is the safe default and approved assets are never fetched or overwritten', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  reconcileImageCandidates(inventory, [tire()], { allowedHosts: ALLOWED_HOSTS })
  const repository = createImageAssetRepository(inventory)
  const approvedHash = 'a'.repeat(64)
  repository.recordStored(1, {
    storageKey: imageStorageKey(approvedHash, 'webp'), storageUrl: 'https://storage.example.test/known-good',
    sha256: approvedHash, bytes: 4, width: 2, height: 2, format: 'webp',
    fetchedAt: '2026-09-07T12:01:00.000Z', storedAt: '2026-09-07T12:01:01.000Z', usageStatus: 'approved',
  })
  const approved = listImageCandidates(inventory)[0]
  let calls = 0
  const dryRun = await mirrorRemoteImages([approved], { allowedHosts: ['cdn.example.test'], fetcher: async () => { calls++ }, inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage() })
  assert.equal(dryRun.dryRun, true)
  assert.equal(calls, 0)
  const execution = await mirrorRemoteImages([approved], { dryRun: false, allowedHosts: ['cdn.example.test'], fetcher: async () => { calls++ }, inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage(), delayMs: 0 })
  assert.equal(execution.attempted, 0)
  assert.equal(calls, 0)
  assert.equal(listImageCandidates(inventory)[0].storageKey, imageStorageKey(approvedHash, 'webp'))
})

test('serial mirror hashes and deduplicates fixture bytes without retries', async () => {
  const records = [
    { id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' },
    { id: 2, originalUrl: IMAGE_URL.replace('SKU123', 'SKU456'), remoteImagePresent: true, usageStatus: 'candidate' },
  ]
  const bytes = new Uint8Array([1, 2, 3, 4])
  const storage = fakeStorage()
  const stored = []
  const failures = []
  let active = 0
  let peak = 0
  const result = await mirrorRemoteImages(records, {
    dryRun: false, delayMs: 0,
    fetcher: async () => { active++; peak = Math.max(peak, active); active--; return fakeImageResponse(bytes) },
    inspectImage: async () => ({ width: 2, height: 2, format: 'webp' }),
    repository: { recordStored: (id, asset) => { stored.push({ id, asset }); return { status: 'stored' } }, recordFailure: (id, failure) => failures.push({ id, failure }) },
    storage, allowedHosts: ['cdn.example.test'],
  })
  assert.equal(result.stored, 1)
  assert.equal(result.deduped, 1)
  assert.equal(storage.writes.length, 1)
  assert.equal(stored.length, 2)
  assert.equal(failures.length, 0)
  assert.equal(peak, 1)
  assert.equal(stored[0].asset.usageStatus, 'candidate')
})

test('403/429 and refusal text stop the whole run with no retries', async () => {
  for (const response of [fakeImageResponse(new Uint8Array(), 'image/webp', 429), { status: 200, headers: { 'content-type': 'text/html' }, body: 'captcha challenge' }]) {
    const failures = []
    let calls = 0
    const result = await mirrorRemoteImages([
      { id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' },
      { id: 2, originalUrl: IMAGE_URL + '?second', remoteImagePresent: true, usageStatus: 'candidate' },
    ], {
      dryRun: false, delayMs: 0, fetcher: async () => { calls++; return response },
      inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), storage: fakeStorage(),
      repository: { recordStored() { return { status: 'stored' } }, recordFailure: (id, failure) => failures.push({ id, failure }) },
      allowedHosts: ['cdn.example.test'],
    })
    assert.equal(result.stoppedOnRefusal, true)
    assert.equal(calls, 1)
    assert.equal(failures.length, 1)
    assert.equal(result.failures[0].id, 1)
  }
})

test('wrong type, oversize, and invalid dimensions are recorded without retrying', async () => {
  const cases = [
    [fakeImageResponse(new Uint8Array([1]), 'text/html'), 'wrong-content-type'],
    [fakeImageResponse(new Uint8Array([1, 2, 3]), 'image/png'), 'oversize'],
    [fakeImageResponse(new Uint8Array([1]), 'image/png'), 'dimensions-too-large'],
  ]
  for (const [response, state] of cases) {
    const failures = []
    const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], {
      dryRun: false, delayMs: 0, maxBytes: state === 'oversize' ? 2 : 10,
      maxWidth: state === 'dimensions-too-large' ? 10 : 10_000,
      fetcher: async () => response,
      inspectImage: () => state === 'dimensions-too-large' ? ({ width: 11, height: 2, format: 'png' }) : ({ width: 2, height: 2, format: 'png' }),
      storage: fakeStorage(), repository: { recordStored() { return { status: 'stored' } }, recordFailure: (id, failure) => failures.push(failure) },
      allowedHosts: ['cdn.example.test'],
    })
    assert.equal(result.failures[0].state, state)
    assert.equal(failures[0].state, state)
  }
})

test('execution fails closed when adapters are not explicitly injected', async () => {
  await assert.rejects(
    () => mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true }], { dryRun: false, allowedHosts: ['cdn.example.test'] }),
    error => error instanceof ImageMirrorError && error.state === 'configuration',
  )
})

function mirrorAdapters({ response, inspect = () => ({ width: 2, height: 2, format: 'webp' }), storage = fakeStorage() } = {}) {
  const failures = []
  const stored = []
  return {
    failures,
    stored,
    storage,
    options: {
      dryRun: false, delayMs: 0, allowedHosts: ['cdn.example.test'],
      fetcher: async (url, options) => { stored.fetchOptions = options; return response ?? fakeImageResponse(new Uint8Array([1, 2, 3, 4])) },
      inspectImage: inspect,
      storage,
      repository: {
        recordStored: (id, asset) => { stored.push({ id, asset }); return { status: 'stored' } },
        recordFailure: (id, failure) => failures.push({ id, failure }),
      },
    },
  }
}

test('forbidden, malformed, credential-bearing, local, and disallowed URLs fail before the fetch adapter', async () => {
  const urls = [
    'http://cdn.example.test/image.webp',
    'https://user:password@cdn.example.test/image.webp',
    'https://localhost/image.webp',
    'https://127.0.0.1/image.webp',
    'https://169.254.169.254/image.webp',
    'not a URL',
    'https://other.example.test/image.webp',
  ]
  for (const originalUrl of urls) {
    let calls = 0
    const adapters = mirrorAdapters()
    const result = await mirrorRemoteImages([{ id: 1, originalUrl, remoteImagePresent: true, usageStatus: 'candidate' }], {
      ...adapters.options, fetcher: async () => { calls++; return fakeImageResponse(new Uint8Array([1])) },
    })
    assert.equal(calls, 0, originalUrl)
    assert.equal(adapters.failures[0].failure.state, 'invalid-destination', originalUrl)
    assert.equal(result.stored, 0, originalUrl)
  }
})

test('an allowed final URL succeeds, but a disallowed redirect stops before consuming its body', async () => {
  const allowed = mirrorAdapters({ response: fakeImageResponse(new Uint8Array([1, 2, 3, 4])) })
  const success = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], allowed.options)
  assert.equal(success.stored, 1)
  let consumed = false
  const redirected = mirrorAdapters({ response: {
    status: 200, finalUrl: 'https://evil.example.test/image.webp', headers: { 'content-type': 'image/webp' },
    body: { async *[Symbol.asyncIterator]() { consumed = true; yield new Uint8Array([1]) } },
  } })
  const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], redirected.options)
  assert.equal(result.stoppedOnRefusal, true)
  assert.equal(consumed, false)
  assert.equal(redirected.storage.writes.length, 0)
})

test('declared and streamed oversized bodies are bounded before inspection or storage', async () => {
  const declared = mirrorAdapters({ response: { status: 200, finalUrl: IMAGE_URL, headers: { 'content-type': 'image/webp', 'content-length': '11' }, bytes: new Uint8Array([1]) } })
  const declaredResult = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], { ...declared.options, maxBytes: 10 })
  assert.equal(declaredResult.failures[0].state, 'oversize')
  assert.equal(declared.stored.length, 0)
  assert.equal(declared.storage.writes.length, 0)
  assert.equal(declared.stored.fetchOptions.maxBytes, 10)

  let chunksRead = 0
  const streamed = mirrorAdapters({ response: {
    status: 200, finalUrl: IMAGE_URL, headers: { 'content-type': 'image/webp' },
    body: { async *[Symbol.asyncIterator]() { chunksRead++; yield new Uint8Array([1, 2, 3, 4, 5, 6]); chunksRead++; yield new Uint8Array([7]) } },
  }, inspect: () => { throw new Error('inspector must not run') } })
  const streamedResult = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], { ...streamed.options, maxBytes: 6 })
  assert.equal(streamedResult.failures[0].state, 'oversize')
  assert.equal(chunksRead, 2)
  assert.equal(streamed.stored.length, 0)
  assert.equal(streamed.storage.writes.length, 0)
})

test('canonical MIME/decoded pairs are accepted, while mismatches and untrusted formats never reach storage', async () => {
  for (const [mime, format] of Object.entries({ 'image/gif': 'gif', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' })) {
    const adapters = mirrorAdapters({ response: fakeImageResponse(new Uint8Array([1, 2, 3, 4]), mime), inspect: () => ({ width: 2, height: 2, format }) })
    const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], adapters.options)
    assert.equal(result.stored, 1, mime)
    assert.equal(adapters.storage.writes[0].storageKey.endsWith(`.${format}`), true)
  }
  for (const format of ['jpeg', 'avif', '../webp', 'image/png']) {
    const adapters = mirrorAdapters({ inspect: () => ({ width: 2, height: 2, format }) })
    const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], adapters.options)
    assert.equal(result.failures[0].state, format === 'jpeg' || format === 'image/png' ? 'format-mismatch' : 'invalid-format', format)
    assert.equal(adapters.storage.writes.length, 0, format)
  }
})

test('approval winning between selection and commit preserves the approved asset and excludes it from success counts', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  reconcileImageCandidates(inventory, [tire()], { allowedHosts: ALLOWED_HOSTS })
  const base = createImageAssetRepository(inventory)
  const before = { ...listImageCandidates(inventory)[0] }
  const storage = fakeStorage()
  const raceRepository = {
    recordFailure: base.recordFailure,
    recordStored: (id, asset) => {
      inventory.db.prepare("UPDATE image_assets SET usage_status='approved', storage_key='images/approved.webp', storage_url='https://storage.example.test/approved', sha256='approved', bytes=9, width=3, height=3, format='webp', fetched_at='before', stored_at='before', provenance='owner-approved' WHERE id=?").run(id)
      return base.recordStored(id, asset)
    },
  }
  const result = await mirrorRemoteImages([before], {
    dryRun: false, delayMs: 0, allowedHosts: ['cdn.example.test'], fetcher: async () => fakeImageResponse(new Uint8Array([1, 2, 3, 4])),
    inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), storage, repository: raceRepository,
  })
  assert.equal(result.stored, 0)
  assert.equal(result.conflicts, 1)
  assert.equal(result.failures.length, 0)
  const after = listImageCandidates(inventory)[0]
  assert.equal(after.usageStatus, 'approved')
  assert.equal(after.storageKey, 'images/approved.webp')
  assert.equal(after.sha256, 'approved')
  assert.equal(after.provenance, 'owner-approved')
  assert.notEqual(after.storageKey, before.storageKey)
})

test('a storage key cannot be durably rebound to another hash, and the second row remains unstored', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  const second = tire({ id: 'giga-sku456', name: 'Second', imageUrls: [IMAGE_URL.replace('SKU123', 'SKU456')], source: { sku: 'SKU456', url: PRODUCT_URL.replace('SKU123', 'SKU456'), fetchedAt: '2026-09-07T12:00:00.000Z' } })
  inventory.refreshSize(SIZE, [tire(), second])
  reconcileImageCandidates(inventory, [tire(), second], { allowedHosts: ALLOWED_HOSTS })
  const repository = createImageAssetRepository(inventory)
  const firstHash = 'b'.repeat(64)
  const secondHash = 'c'.repeat(64)
  const firstKey = imageStorageKey(firstHash, 'webp')
  repository.recordStored(1, { storageKey: firstKey, storageUrl: 'https://storage.example.test/shared', sha256: firstHash, bytes: 4, width: 2, height: 2, format: 'webp', fetchedAt: 'before', storedAt: 'before' })
  assert.throws(() => repository.recordStored(2, { storageKey: firstKey, storageUrl: 'https://storage.example.test/shared', sha256: secondHash, bytes: 4, width: 2, height: 2, format: 'webp', fetchedAt: 'after', storedAt: 'after' }), ImageAssetStorageConflictError)
  const rows = listImageCandidates(inventory)
  assert.equal(rows.filter(row => row.storageKey).length, 1)
  assert.equal(inventory.db.prepare('SELECT count(*) AS n FROM image_storage').get().n, 1)
})
