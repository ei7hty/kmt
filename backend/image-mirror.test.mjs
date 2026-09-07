import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Inventory } from './inventory.mjs'
import { createImageAssetRepository, ensureImageAssetSchema, listImageCandidates, reconcileImageCandidates } from './image-assets.mjs'
import { ImageMirrorError, mirrorRemoteImages } from '../scripts/image-mirror.mjs'

const SIZE = '215/60R16'
const PRODUCT_URL = 'https://www.giga-tires.com/tires/example/roadmaster/SKU123'
const IMAGE_URL = 'https://cdn.example.test/SKU123.webp'

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

function fakeImageResponse(bytes, contentType = 'image/webp', status = 200) {
  return { status, headers: { 'content-type': contentType }, bytes }
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
  const report = reconcileImageCandidates(inventory, [tire()])
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
  const report = reconcileImageCandidates(inventory, [tire({ imageUrls: [] })])
  assert.equal(report.reconciled, 1)
  const row = listImageCandidates(inventory)[0]
  assert.equal(row.remoteImagePresent, false)
  assert.equal(row.originalUrl, null)
  assert.equal(row.sourceMetadataPresent, true)
})

test('dry run is the safe default and approved assets are never fetched or overwritten', async t => {
  const { inventory, folder } = inventoryFixture()
  t.after(() => { try { inventory.close() } catch { /* already closed */ } rmSync(folder, { recursive: true, force: true }) })
  reconcileImageCandidates(inventory, [tire()])
  const repository = createImageAssetRepository(inventory)
  repository.recordStored(1, {
    storageKey: 'images/known-good.webp', storageUrl: 'https://storage.example.test/known-good',
    sha256: 'known-good', bytes: 4, width: 2, height: 2, format: 'webp',
    fetchedAt: '2026-09-07T12:01:00.000Z', storedAt: '2026-09-07T12:01:01.000Z', usageStatus: 'approved',
  })
  const approved = listImageCandidates(inventory)[0]
  let calls = 0
  const dryRun = await mirrorRemoteImages([approved], { fetcher: async () => { calls++ }, inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage() })
  assert.equal(dryRun.dryRun, true)
  assert.equal(calls, 0)
  const execution = await mirrorRemoteImages([approved], { dryRun: false, fetcher: async () => { calls++ }, inspectImage: () => ({ width: 2, height: 2, format: 'webp' }), repository, storage: fakeStorage(), delayMs: 0 })
  assert.equal(execution.attempted, 0)
  assert.equal(calls, 0)
  assert.equal(listImageCandidates(inventory)[0].storageKey, 'images/known-good.webp')
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
    repository: { recordStored: (id, asset) => stored.push({ id, asset }), recordFailure: (id, failure) => failures.push({ id, failure }) },
    storage,
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
      repository: { recordStored() {}, recordFailure: (id, failure) => failures.push({ id, failure }) },
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
      storage: fakeStorage(), repository: { recordStored() {}, recordFailure: (id, failure) => failures.push(failure) },
    })
    assert.equal(result.failures[0].state, state)
    assert.equal(failures[0].state, state)
  }
})

test('execution fails closed when adapters are not explicitly injected', async () => {
  await assert.rejects(
    () => mirrorRemoteImages([{ id: 1, originalUrl: IMAGE_URL, remoteImagePresent: true }], { dryRun: false }),
    error => error instanceof ImageMirrorError && error.state === 'configuration',
  )
})
