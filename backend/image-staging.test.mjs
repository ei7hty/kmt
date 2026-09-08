import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createImageStagingStorage } from './image-staging.mjs'
import { imageStorageKey, sha256Bytes } from './image-assets.mjs'

test('staging storage is durable, content addressed, and immutable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmt-image-staging-'))
  try {
    const storage = createImageStagingStorage({ directory, storeId: 'test-store' })
    const bytes = new Uint8Array([1, 2, 3])
    const sha256 = sha256Bytes(bytes)
    const storageKey = imageStorageKey(sha256, 'png')
    const first = await storage.put({ bytes, contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey, ifAbsent: true })
    assert.equal(first.storageUrl, `kmt-staging://test-store/${first.storageKey}`)
    const second = await storage.put({ bytes, contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey: first.storageKey, ifAbsent: true })
    assert.deepEqual(second, first)
    await assert.rejects(() => storage.put({ bytes: new Uint8Array([9]), contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey: first.storageKey, ifAbsent: true }), /byte hash/)
    assert.deepEqual([...await readFile(path.join(directory, first.storageKey))], [...bytes])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('staging storage requires an absolute isolated directory', () => {
  assert.throws(() => createImageStagingStorage({ directory: 'relative/path', storeId: 'test-store' }), /absolute path/)
  assert.throws(() => createImageStagingStorage({ directory: path.resolve('public', 'images'), storeId: 'test-store' }), /private/)
})

test('staging storage detects missing or corrupt blobs and honors abort before publication', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmt-image-staging-'))
  try {
    const storage = createImageStagingStorage({ directory, storeId: 'test-store' })
    const bytes = new Uint8Array([4, 5, 6])
    const sha256 = sha256Bytes(bytes)
    const storageKey = imageStorageKey(sha256, 'png')
    const asset = { bytes, contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey, ifAbsent: true }
    await storage.put(asset)
    await rm(path.join(directory, storageKey))
    await assert.rejects(() => storage.put(asset), /missing/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => storage.put({ ...asset, sha256: sha256Bytes(new Uint8Array([7])), storageKey: imageStorageKey(sha256Bytes(new Uint8Array([7])), 'png'), bytes: new Uint8Array([7]), signal: controller.signal }), /aborted/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
