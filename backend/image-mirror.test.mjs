import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Inventory } from './inventory.mjs'
import { assertAllowedImageUrl, assertSafeResolvedAddress, createImageAssetRepository, ensureImageAssetSchema, imageStorageKey, ImageAssetStorageConflictError, listImageCandidates, reconcileImageCandidates } from './image-assets.mjs'
import { createSafeImageFetcher, ImageMirrorError, mirrorRemoteImages } from '../scripts/image-mirror.mjs'

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
  const writes = []
  return {
    writes,
    async put(input) {
      const stored = { storageKey: `images/${input.sha256}.${input.format}`, storageUrl: `https://storage.example.test/${input.sha256}`, sha256: input.sha256, format: input.format }
      writes.push({ ...input, ...stored })
      return stored
    },
  }
}

function expectedCandidate(candidate) {
  return { supplierId: candidate.supplierId, supplierSku: candidate.supplierSku, originalUrl: candidate.originalUrl, revision: candidate.candidateRevision }
}

function trustedFetcher(fn) {
  fn.safeTransport = true
  return fn
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
  const candidate = listImageCandidates(inventory)[0]
  const approvedHash = 'a'.repeat(64)
  repository.recordStored(1, {
    storageKey: imageStorageKey(approvedHash, 'webp'), storageUrl: 'https://storage.example.test/known-good',
    sha256: approvedHash, bytes: 4, width: 2, height: 2, format: 'webp',
    fetchedAt: '2026-09-07T12:01:00.000Z', storedAt: '2026-09-07T12:01:01.000Z', usageStatus: 'approved',
  }, expectedCandidate(candidate))
  const approved = listImageCandidates(inventory)[0]
  let calls = 0
  const dryRun = await mirrorRemoteImages([approved], { allowedHosts: ['cdn.example.test'], fetcher: async () => { calls++ }, inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage() })
  assert.equal(dryRun.dryRun, true)
  assert.equal(calls, 0)
  const execution = await mirrorRemoteImages([approved], { dryRun: false, allowedHosts: ['cdn.example.test'], fetcher: trustedFetcher(async () => { calls++ }), inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage(), delayMs: 0 })
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
  const byHash = new Map()
  let active = 0
  let peak = 0
  const result = await mirrorRemoteImages(records, {
    dryRun: false, delayMs: 0,
    fetcher: trustedFetcher(async () => { active++; peak = Math.max(peak, active); active--; return fakeImageResponse(bytes) }),
    inspectImage: async () => ({ width: 2, height: 2, format: 'webp' }),
    repository: { findByHash: hash => byHash.get(hash) ?? null, recordStored: (id, asset) => { const result = { storageKey: asset.storageKey, storageUrl: asset.storageUrl, sha256: asset.sha256, format: asset.format }; byHash.set(asset.sha256, result); stored.push({ id, asset }); return { status: 'stored' } }, recordFailure: (id, failure) => failures.push({ id, failure }) },
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
      dryRun: false, delayMs: 0, fetcher: trustedFetcher(async () => { calls++; return response }),
      inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), storage: fakeStorage(),
      repository: { findByHash() { return null }, recordStored() { return { status: 'stored' } }, recordFailure: (id, failure) => failures.push({ id, failure }) },
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
      fetcher: trustedFetcher(async () => response),
      inspectImage: () => state === 'dimensions-too-large' ? ({ width: 11, height: 2, format: 'png' }) : ({ width: 2, height: 2, format: 'png' }),
      storage: fakeStorage(), repository: { findByHash() { return null }, recordStored() { return { status: 'stored' } }, recordFailure: (id, failure) => failures.push(failure) },
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
      fetcher: trustedFetcher(async (url, options) => { stored.fetchOptions = options; return response ?? fakeImageResponse(new Uint8Array([1, 2, 3, 4])) }),
      inspectImage: inspect,
      storage,
      repository: {
        findByHash() { return null },
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
      ...adapters.options, fetcher: trustedFetcher(async () => { calls++; return fakeImageResponse(new Uint8Array([1])) }),
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
    findByHash: base.findByHash,
    recordFailure: base.recordFailure,
    recordStored: (id, asset) => {
      inventory.db.prepare("UPDATE image_assets SET usage_status='approved', storage_key='images/approved.webp', storage_url='https://storage.example.test/approved', sha256='approved', bytes=9, width=3, height=3, format='webp', fetched_at='before', stored_at='before', provenance='owner-approved' WHERE id=?").run(id)
      return base.recordStored(id, asset, expectedCandidate(before))
    },
  }
  const result = await mirrorRemoteImages([before], {
    dryRun: false, delayMs: 0, allowedHosts: ['cdn.example.test'], fetcher: trustedFetcher(async () => fakeImageResponse(new Uint8Array([1, 2, 3, 4]))),
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
  const candidates = repository.list()
  repository.recordStored(1, { storageKey: firstKey, storageUrl: 'https://storage.example.test/shared', sha256: firstHash, bytes: 4, width: 2, height: 2, format: 'webp', fetchedAt: 'before', storedAt: 'before' }, expectedCandidate(candidates[0]))
  assert.throws(() => repository.recordStored(2, { storageKey: firstKey, storageUrl: 'https://storage.example.test/shared', sha256: secondHash, bytes: 4, width: 2, height: 2, format: 'webp', fetchedAt: 'after', storedAt: 'after' }, expectedCandidate(candidates[1])), ImageAssetStorageConflictError)
  const rows = listImageCandidates(inventory)
  assert.equal(rows.filter(row => row.storageKey).length, 1)
  assert.equal(inventory.db.prepare('SELECT count(*) AS n FROM image_storage').get().n, 1)
})

test('canonical IP parsing rejects private, loopback, link-local, ULA, mapped, and reserved literals', () => {
  const ipv4 = ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']
  const ipv6 = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:127.0.0.1', '::ffff:169.254.1.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::a00:1', '2002:7f00:1::', '2001::ffff:7f00:1']
  for (const address of ipv4) {
    assert.throws(() => assertAllowedImageUrl(`https://${address}./image.webp`, [address]), /private|local|allowlisted/, address)
    assert.throws(() => assertSafeResolvedAddress(address), /private|local|link-local|non-public/, address)
  }
  for (const address of ipv6) {
    assert.throws(() => assertAllowedImageUrl(`https://[${address}]/image.webp`, [address]), /private|local|allowlisted/, address)
    assert.throws(() => assertSafeResolvedAddress(address), /private|local|link-local|non-public/, address)
  }
  assert.equal(assertAllowedImageUrl('https://[::ffff:93.184.216.34]/image.webp', ['::ffff:5db8:d822']), 'https://[::ffff:5db8:d822]/image.webp')
})

test('safe transport rejects IPv4-translation and tunneling addresses before connect', async () => {
  for (const address of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::a00:1', '2002:7f00:1::', '2001::ffff:7f00:1']) {
    const safe = createSafeImageFetcher({ fetch: async (url, options) => {
      options.onConnect({ url, address })
      return fakeImageResponse(new Uint8Array([1, 2, 3, 4]))
    } }, { allowedHosts: ['cdn.example.test'] })
    await assert.rejects(() => safe(IMAGE_URL), /address refused/, address)
  }
})

test('safe transport blocks an allowed-to-forbidden redirect before a forbidden connection', async () => {
  let forbiddenConnections = 0
  const safe = createSafeImageFetcher({
    async fetch(url, options) {
      options.onConnect({ url, address: '93.184.216.34' })
      try { options.onRedirect('https://[fd00::1]/image.webp') } catch { return { status: 403 } }
      forbiddenConnections++
      options.onConnect({ url: 'https://cdn.example.test/final.webp', address: '93.184.216.34' })
      return fakeImageResponse(new Uint8Array([1, 2, 3, 4]))
    },
  }, { allowedHosts: ['cdn.example.test'], maxRedirects: 2 })
  const response = await safe('https://cdn.example.test/start.webp', { maxBytes: 10 })
  assert.equal(response.status, 403)
  assert.equal(forbiddenConnections, 0)
})

test('all challenge body representations become a global refusal before a second request', async () => {
  const bodies = [
    { body: 'captcha challenge', headers: { 'content-type': 'text/html' } },
    { bytes: new TextEncoder().encode('captcha challenge'), headers: { 'content-type': 'text/html' } },
    { body: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); yield new TextEncoder().encode('captcha challenge') } }, headers: { 'content-type': 'text/html' } },
    { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.enqueue(new TextEncoder().encode('captcha challenge')); controller.close() } }), headers: { 'content-type': 'text/html' } },
  ]
  for (const body of bodies) {
    let calls = 0
    const failures = []
    const result = await mirrorRemoteImages([
      { id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' },
      { id: 2, originalUrl: IMAGE_URL + '?second', remoteImagePresent: true, usageStatus: 'candidate' },
    ], {
      dryRun: false, delayMs: 0, timeoutMs: 100, allowedHosts: ['cdn.example.test'],
      fetcher: trustedFetcher(async () => { calls++; return { ...body, status: 200, finalUrl: IMAGE_URL } }),
      inspectImage: () => { throw new Error('inspector must not run') }, storage: fakeStorage(),
      repository: { findByHash() { return null }, recordStored() { return { status: 'stored' } }, recordFailure: (id, failure) => failures.push(failure) },
    })
    assert.equal(result.stoppedOnRefusal, true)
    assert.equal(calls, 1)
    assert.equal(failures[0].state, 'provider-refusal')
  }
})

test('stream timeout aborts and closes a stalled body, while empty chunks are ignored', async () => {
  let returned = false
  const stalled = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], {
    dryRun: false, delayMs: 0, timeoutMs: 20, allowedHosts: ['cdn.example.test'],
    fetcher: trustedFetcher(async () => ({ status: 200, finalUrl: IMAGE_URL, headers: { 'content-type': 'image/webp' }, body: {
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => { returned = true; return Promise.resolve({ done: true }) } } },
    } })), inspectImage: () => { throw new Error('inspector must not run') }, storage: fakeStorage(),
    repository: { findByHash() { return null }, recordStored() { return { status: 'stored' } }, recordFailure() {} },
  })
  assert.equal(stalled.failures[0].state, 'timeout')
  assert.equal(returned, true)

  const adapters = mirrorAdapters({ response: { status: 200, finalUrl: IMAGE_URL, headers: { 'content-type': 'image/webp' }, body: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); yield new Uint8Array(); yield new Uint8Array([1, 2, 3, 4]) } } } })
  const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], adapters.options)
  assert.equal(result.stored, 1)
})

test('identity and revision binding prevents stale URL or SKU rows from committing', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  reconcileImageCandidates(inventory, [tire()], { allowedHosts: ALLOWED_HOSTS, at: 'revision-a' })
  const repository = createImageAssetRepository(inventory)
  const candidate = repository.list()[0]
  const asset = { storageKey: imageStorageKey('d'.repeat(64), 'webp'), storageUrl: 'https://storage.example.test/d', sha256: 'd'.repeat(64), bytes: 4, width: 2, height: 2, format: 'webp', fetchedAt: 'now', storedAt: 'now' }
  assert.deepEqual(repository.recordStored(candidate.id, asset, { ...expectedCandidate(candidate), originalUrl: IMAGE_URL + '?wrong' }), { status: 'stale-conflict' })
  assert.deepEqual(repository.recordStored(candidate.id, asset, { ...expectedCandidate(candidate), revision: 'old-revision' }), { status: 'stale-conflict' })
  reconcileImageCandidates(inventory, [tire({ source: { ...tire().source, sku: 'SKU-CHANGED' } })], { allowedHosts: ALLOWED_HOSTS, at: 'revision-b' })
  assert.deepEqual(repository.recordStored(candidate.id, asset, { supplierId: candidate.supplierId, supplierSku: 'SKU123', originalUrl: IMAGE_URL, revision: 'revision-a' }), { status: 'stale-conflict' })
  assert.equal(repository.list()[0].storageKey, null)
})

test('repository owns cross-run dedupe across two IDs and a database reopen', async t => {
  const { inventory, folder } = inventoryFixture()
  let reopened
  t.after(() => { try { reopened?.close() } catch { /* already closed */ } try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  const second = tire({ id: 'giga-sku456', name: 'Second', imageUrls: [IMAGE_URL.replace('SKU123', 'SKU456')], source: { sku: 'SKU456', url: PRODUCT_URL.replace('SKU123', 'SKU456'), fetchedAt: '2026-09-07T12:00:00.000Z' } })
  inventory.refreshSize(SIZE, [tire(), second])
  reconcileImageCandidates(inventory, [tire(), second], { allowedHosts: ALLOWED_HOSTS })
  const repository = createImageAssetRepository(inventory)
  const storage = { writes: [], async put(input) { this.writes.push(input); return { storageKey: input.storageKey, storageUrl: `https://storage.example.test/${input.sha256}`, sha256: input.sha256, format: input.format } } }
  const bytes = new Uint8Array([9, 8, 7, 6])
  const result = await mirrorRemoteImages(repository.list(), { dryRun: false, delayMs: 0, allowedHosts: ['cdn.example.test'], fetcher: trustedFetcher(async () => fakeImageResponse(bytes)), inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), storage, repository })
  assert.equal(result.stored, 1)
  assert.equal(result.deduped, 1)
  assert.equal(storage.writes.length, 1)
  assert.equal(storage.writes[0].ifAbsent, true)
  const hash = repository.list()[0].sha256
  assert.equal(repository.list()[1].sha256, hash)
  assert.equal(inventory.db.prepare('SELECT count(*) AS n FROM image_storage').get().n, 1)
  inventory.close()
  reopened = new Inventory(inventoryFilename(inventory), [SIZE])
  const reopenedRepository = createImageAssetRepository(reopened)
  assert.deepEqual(reopenedRepository.findByHash(hash), { storageKey: imageStorageKey(hash, 'webp'), storageUrl: `https://storage.example.test/${hash}`, sha256: hash, format: 'webp' })
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM image_storage').get().n, 1)
})

test('rejected candidates are not selected or retried without an explicit reset', async () => {
  const adapters = mirrorAdapters()
  const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'rejected' }], adapters.options)
  assert.deepEqual(result.selected, [])
  assert.equal(result.attempted, 0)
  assert.equal(adapters.stored.length, 0)
  assert.equal(adapters.failures.length, 0)
})

test('HTTPS destination validation applies an explicit port policy', () => {
  assert.throws(() => assertAllowedImageUrl('https://cdn.example.test:8443/image.webp', ['cdn.example.test']), /port 8443/)
  assert.equal(assertAllowedImageUrl('https://cdn.example.test:8443/image.webp', ['cdn.example.test'], { allowedPorts: [8443] }), 'https://cdn.example.test:8443/image.webp')
})

test('decoder receives bounded budgets and malformed or oversized decoded content never reaches storage', async () => {
  const contexts = []
  const adapters = mirrorAdapters({ inspect: (bytes, context) => { contexts.push(context); return { width: 2, height: 2, format: 'webp' } } })
  const result = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], {
    ...adapters.options, maxPixels: 100, maxFrames: 2, maxDecodeMs: 250, delayMs: 0,
  })
  assert.equal(result.stored, 1)
  assert.equal(contexts[0].maxPixels, 100)
  assert.equal(contexts[0].maxFrames, 2)
  assert.equal(contexts[0].maxDecodeMs, 250)
  assert.equal(contexts[0].signal instanceof AbortSignal, true)

  const oversized = mirrorAdapters({ inspect: () => ({ width: 11, height: 11, format: 'webp' }) })
  const oversizedResult = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], {
    ...oversized.options, maxWidth: 100, maxHeight: 100, maxPixels: 100, delayMs: 0,
  })
  assert.equal(oversizedResult.failures[0].state, 'dimensions-too-large')
  assert.equal(oversized.storage.writes.length, 0)

  const truncated = mirrorAdapters({ inspect: () => { throw new ImageMirrorError('truncated image', 'decode-error') } })
  const truncatedResult = await mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true, usageStatus: 'candidate' }], { ...truncated.options, delayMs: 0 })
  assert.equal(truncatedResult.failures[0].state, 'decode-error')
  assert.equal(truncated.storage.writes.length, 0)
})

test('image schema upgrades a hand-built pre-revision table without losing rows', t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  inventory.db.exec(`
    CREATE TABLE image_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id TEXT NOT NULL REFERENCES supplier(id), supplier_sku TEXT NOT NULL,
      product_url TEXT, identity_key TEXT NOT NULL, remote_image_url TEXT,
      remote_image_present INTEGER NOT NULL DEFAULT 0 CHECK(remote_image_present IN (0, 1)),
      source_metadata_present INTEGER NOT NULL DEFAULT 0 CHECK(source_metadata_present IN (0, 1)),
      storage_key TEXT, storage_url TEXT, sha256 TEXT, bytes INTEGER, width INTEGER, height INTEGER,
      format TEXT, fetched_at TEXT, stored_at TEXT, provenance TEXT NOT NULL DEFAULT 'supplier-product-page',
      usage_status TEXT NOT NULL DEFAULT 'candidate' CHECK(usage_status IN ('candidate', 'approved', 'rejected')),
      failure_state TEXT, failure_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(supplier_id, identity_key)
    )
  `)
  const supplierId = inventory.db.prepare('SELECT id FROM supplier LIMIT 1').get().id
  inventory.db.prepare(`INSERT INTO image_assets(supplier_id, supplier_sku, identity_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`).run(supplierId, 'SKU123', IMAGE_URL, 'before', 'before')
  ensureImageAssetSchema(inventory)
  const columns = inventory.db.prepare('PRAGMA table_info(image_assets)').all().map(row => row.name)
  assert.equal(columns.includes('candidate_revision'), true)
  assert.equal(inventory.db.prepare('SELECT count(*) AS n FROM image_assets').get().n, 1)
  assert.equal(inventory.db.prepare('SELECT usage_status FROM image_assets').get().usage_status, 'candidate')
})

test('reconciliation retires removed source URLs and never fetches them again', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  const oldUrl = 'https://cdn.example.test/old.webp'
  const newUrl = 'https://cdn.example.test/new.webp'
  reconcileImageCandidates(inventory, [tire({ imageUrls: [oldUrl] })], { allowedHosts: ALLOWED_HOSTS, at: 'r1' })
  reconcileImageCandidates(inventory, [tire({ imageUrls: [newUrl], source: { ...tire().source, fetchedAt: 'r2' } })], { allowedHosts: ALLOWED_HOSTS, at: 'r2' })
  const repository = createImageAssetRepository(inventory)
  const rows = repository.list()
  assert.equal(rows.find(row => row.originalUrl === oldUrl).sourceCurrent, false)
  assert.equal(rows.find(row => row.originalUrl === newUrl).sourceCurrent, true)
  const fetched = []
  const storage = fakeStorage()
  const result = await mirrorRemoteImages(rows, {
    dryRun: false, delayMs: 0, allowedHosts: ['cdn.example.test'],
    fetcher: trustedFetcher(async url => { fetched.push(url); return fakeImageResponse(new Uint8Array([1, 2, 3, 4]), 'image/webp', 200, newUrl) }),
    inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), storage, repository,
  })
  assert.deepEqual(fetched, [newUrl])
  assert.equal(result.stored, 1)
  assert.equal(repository.list().find(row => row.originalUrl === oldUrl).storageKey, null)
})
