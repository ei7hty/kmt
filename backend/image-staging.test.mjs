import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir, rename, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createImageStagingStorage } from './image-staging.mjs'
import { imageStorageKey, sha256Bytes } from './image-assets.mjs'

// Valid 1x1 PNG, generated fixture; no provider source or network dependency.
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
const sha256 = sha256Bytes(bytes)
const asset = { bytes, byteLength: bytes.length, contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey: imageStorageKey(sha256, 'png'), ifAbsent: true }
async function fixture(t, checkpoint) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kmt-image-staging-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, storage: createImageStagingStorage({ directory, storeId: 'test-store', checkpoint }), file: path.join(directory, asset.storageKey) }
}

test('flushed blob and immutable metadata publish together and survive reopen', async t => {
  const { directory, storage, file } = await fixture(t)
  const first = await storage.put(asset)
  assert.match(first.storageUrl, /^kmt-staging:\/\/test-store\/[a-f0-9-]{36}\/images\//)
  assert.deepEqual(await storage.put(asset), first)
  const reopened = createImageStagingStorage({ directory, storeId: 'test-store' })
  assert.deepEqual(await reopened.verify({ ...asset, storageUrl: first.storageUrl }), first)
  const container = await readFile(file)
  assert.deepEqual(container.subarray(4 + container.readUInt32BE(0)), bytes)
  for (const change of [{ width: 2 }, { height: 2 }, { contentType: 'image/jpeg' }, { bytes: Buffer.from([1]) }]) {
    await assert.rejects(() => storage.put({ ...asset, ...change }))
  }
  await assert.rejects(() => createImageStagingStorage({ directory, storeId: 'other-store' }).put(asset), /another store/)
})

test('repository references fail closed for missing/corrupt bytes, metadata, length and store identity', async t => {
  const { storage, file } = await fixture(t)
  const record = await storage.put(asset)
  const valid = await readFile(file)
  const metadataOnly = valid.subarray(0, 4 + valid.readUInt32BE(0))
  const wrongHash = Buffer.from(valid); wrongHash[wrongHash.length - 1] ^= 1
  const badMetadata = Buffer.from(valid); badMetadata[10] ^= 1
  for (const corrupt of [metadataOnly, wrongHash, badMetadata, Buffer.concat([valid, Buffer.from([0])]), Buffer.from([0])]) {
    await writeFile(file, corrupt)
    await assert.rejects(() => storage.verify({ ...asset, storageUrl: record.storageUrl }))
    await assert.rejects(() => storage.put(asset))
    assert.deepEqual(await readFile(file), corrupt, 'never repair or overwrite corrupt objects')
  }
  await rm(file)
  await assert.rejects(() => storage.verify({ ...asset, storageUrl: record.storageUrl }), { code: 'ENOENT' })
  const other = await fixture(t)
  await other.storage.put(asset)
  await assert.rejects(() => other.storage.verify({ ...asset, storageUrl: record.storageUrl }), /another store/)
})

for (const phase of ['open', 'metadata', 'write', 'flush', 'publication']) {
  test(`failure at ${phase} publishes nothing; restart converges`, async t => {
    let armed = true
    const { directory, storage, file } = await fixture(t, current => { if (armed && current === phase) throw new Error(`injected ${phase}`) })
    await assert.rejects(() => storage.put(asset), /injected/)
    await assert.rejects(() => readFile(file), { code: 'ENOENT' })
    armed = false
    const recovered = await createImageStagingStorage({ directory, storeId: 'test-store' }).put(asset)
    assert.equal(recovered.sha256, sha256)
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)])
  })
  test(`abort at ${phase} cannot publish after the promise rejects`, async t => {
    const controller = new AbortController()
    const { storage, file } = await fixture(t, current => { if (current === phase) controller.abort() })
    await assert.rejects(() => storage.put({ ...asset, signal: controller.signal }), { name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await assert.rejects(() => readFile(file), { code: 'ENOENT' })
  })
}

test('already aborted staging does not even create a root', async t => {
  const { directory } = await fixture(t)
  const child = path.join(directory, 'unused')
  await assert.rejects(() => createImageStagingStorage({ directory: child, storeId: 'test-store' }).put({ ...asset, signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(() => readdir(child), { code: 'ENOENT' })
})

test('publication won remains recoverable after abort or failure in acknowledgment', async t => {
  for (const fail of [false, true]) {
    const controller = new AbortController()
    const { directory, storage } = await fixture(t, phase => {
      if (phase === 'published') { controller.abort(); if (fail) throw new Error('ack failure') }
    })
    if (fail) await assert.rejects(() => storage.put({ ...asset, signal: controller.signal }), error => error.published === true && error.asset.sha256 === sha256)
    else assert.equal((await storage.put({ ...asset, signal: controller.signal })).sha256, sha256)
    assert.equal((await createImageStagingStorage({ directory, storeId: 'test-store' }).put(asset)).sha256, sha256)
  }
})

test('independent writers converge, and conflicting immutable metadata never clobbers', async t => {
  const { directory, storage } = await fixture(t)
  const writers = Array.from({ length: 12 }, () => createImageStagingStorage({ directory, storeId: 'test-store' }))
  const outcomes = await Promise.all(writers.map(writer => writer.put(asset)))
  for (const result of outcomes) assert.deepEqual(result, outcomes[0])
  await assert.rejects(() => storage.put({ ...asset, width: 2 }), /immutable metadata/)
})

test('absolute and real path isolation rejects junctions before writing descendants', async t => {
  assert.throws(() => createImageStagingStorage({ directory: 'relative', storeId: 'test-store' }), /absolute/)
  const { directory } = await fixture(t)
  const protectedRoot = path.join(directory, 'public')
  await mkdir(protectedRoot)
  const alias = path.join(directory, 'alias')
  await symlink(protectedRoot, alias, 'junction')
  await assert.rejects(() => createImageStagingStorage({ directory: path.join(alias, 'nested'), storeId: 'test-store' }).put(asset), /symlink|junction/)
  assert.deepEqual(await readdir(protectedRoot), [])
})

test('rechecks root and object parent after initialization and every awaited boundary', async t => {
  const { directory, storage } = await fixture(t)
  await storage.put(asset)
  const original = path.join(directory, 'images')
  const moved = path.join(directory, 'old-images')
  const outside = path.join(directory, 'elsewhere')
  await mkdir(outside)
  await rename(original, moved)
  await symlink(outside, original, 'junction')
  await assert.rejects(() => storage.put(asset), /symlink|junction/)
  assert.deepEqual(await readdir(outside), [])
})

test('object and store marker links are refused', async t => {
  const { directory, storage, file } = await fixture(t)
  const record = await storage.put(asset)
  const other = path.join(directory, 'saved-object')
  await rename(file, other)
  // Windows file symlinks require developer mode; hardlink mutation is also
  // detected by the immutable hash/metadata verification, covered above.
  if (process.platform !== 'win32') {
    await symlink(other, file)
    await assert.rejects(() => storage.verify({ ...asset, storageUrl: record.storageUrl }), /link/)
  }
  const marker = path.join(directory, '.kmt-image-staging.json')
  await rm(marker)
  await mkdir(marker)
  await assert.rejects(() => storage.put(asset), /corrupt|link/)
})

async function worker(directory, phase = 'none') {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/image-provider/staging-worker.mjs', import.meta.url)), directory, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stderr }))
  })
}

test('actual process crashes leave either no publication or a complete recoverable object', async t => {
  for (const phase of ['metadata', 'write', 'flush', 'publication', 'published']) {
    const { directory, storage, file } = await fixture(t)
    const crashed = await worker(directory, phase)
    assert.equal(crashed.code, 86, crashed.stderr)
    if (phase !== 'published') await assert.rejects(() => readFile(file), { code: 'ENOENT' })
    const record = await storage.put(asset)
    assert.equal((await storage.verify({ ...asset, storageUrl: record.storageUrl })).sha256, sha256)
  }
})

test('concurrent OS processes converge on a single immutable publication', async t => {
  const { directory, storage } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 5 }, () => worker(directory)))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  const record = await storage.put(asset)
  assert.equal((await storage.verify({ ...asset, storageUrl: record.storageUrl })).bytes, bytes.length)
})

test('copying a store marker to a different real root cannot impersonate the original store', async t => {
  const first = await fixture(t)
  const record = await first.storage.put(asset)
  const second = await fixture(t)
  await writeFile(path.join(second.directory, '.kmt-image-staging.json'), await readFile(path.join(first.directory, '.kmt-image-staging.json')))
  await assert.rejects(() => second.storage.verify({ ...asset, storageUrl: record.storageUrl }), /another store/)
})
