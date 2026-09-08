import { open } from 'node:fs/promises'
import { constants, lstatSync, mkdirSync, realpathSync, openSync, closeSync, readSync, fstatSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { imageStorageKey, sha256Bytes, IMAGE_ASSET_MIME_FORMATS } from './image-assets.mjs'

const PROTECTED_PARTS = new Set(['public', 'dist', 'data', 'deploy', 'production'])
const MAX_BYTES = 5 * 1024 * 1024
const VERSION = 'kmt-image-staging-v3'

function checkSignal(signal) {
  if (signal?.aborted) {
    const error = new Error('Image staging operation aborted')
    error.name = 'AbortError'
    error.state = 'timeout'
    throw error
  }
}
function isolated(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('Image staging directory must be an absolute path')
  const root = path.resolve(value)
  if (root.split(path.sep).some(part => PROTECTED_PARTS.has(part.toLowerCase()))) throw new TypeError('Image staging directory must be private and outside served or production data roots')
  return root
}

// Walk BEFORE creating descendants. Never mkdir recursively through an alias.
// Repeat on every I/O boundary; a cached realpath is not containment evidence.
function directoryAt(directory, create = false) {
  let current = path.parse(directory).root
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }); syncDirectory(path.dirname(current)) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Image staging refuses symlink or junction directory components')
    isolated(realpathSync(current))
  }
  const stat = lstatSync(directory)
  return { real: realpathSync(directory), dev: stat.dev, ino: stat.ino }
}
function sameNode(a, b) { return a.dev === b.dev && a.ino === b.ino }
function readRegular(file, maxSize) {
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxSize) throw new Error('Image staging object is corrupt or is a link')
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameNode(before, fstatSync(fd))) throw new Error('Image staging object changed during open')
    const bytes = Buffer.alloc(Math.min(before.size + 1, maxSize + 1))
    let total = 0
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, total)
      if (!count) break
      total += count
    }
    if (total !== before.size || fstatSync(fd).size !== before.size) throw new Error('Image staging object changed length during read')
    return bytes.subarray(0, total)
  } finally { closeSync(fd) }
}
function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node. File fsync is still
  // mandatory there; on POSIX persist the published directory entry as well.
  if (process.platform === 'win32') return
  const fd = openSync(directory, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** A private, bounded object container: metadata and bytes publish together. */
export function createImageStagingStorage({ directory = process.env.KMT_IMAGE_STAGING_DIR, storeId = process.env.KMT_IMAGE_STAGING_STORE_ID, urlPrefix = null, checkpoint = async () => {} } = {}) {
  const root = isolated(directory)
  if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(storeId)) throw new TypeError('Image staging store id must be an explicit safe identifier')
  if (urlPrefix !== null) throw new TypeError('Image staging locators are bound to the persistent store identity')
  let rootIdentity
  let identity
  function guard(create = false) {
    const current = directoryAt(root, create)
    if (rootIdentity && (!sameNode(rootIdentity, current) || rootIdentity.real !== current.real)) throw new Error('Image staging root identity changed')
    rootIdentity ??= current
    return current
  }
  function ensureRoot(signal) {
    checkSignal(signal)
    guard(true)
    const marker = path.join(root, '.kmt-image-staging.json')
    try { lstatSync(marker) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const temporary = path.join(root, `.store-${randomUUID()}.tmp`)
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ version: VERSION, storeId, identity: randomUUID(), root: rootIdentity.real }))
        fsyncSync(fd)
        guard()
        checkSignal(signal)
        try { linkSync(temporary, marker); syncDirectory(root) } catch (publishError) { if (publishError.code !== 'EEXIST') throw publishError }
      } finally { closeSync(fd); guard(); unlinkSync(temporary) }
    }
    const stored = JSON.parse(readRegular(marker, 4096))
    if (stored.version !== VERSION || stored.storeId !== storeId || stored.root !== rootIdentity.real || !/^[a-f0-9-]{36}$/.test(stored.identity) || identity && identity !== stored.identity) throw new Error('Image staging root belongs to another store or version')
    identity = stored.identity
    checkSignal(signal)
  }
  function metadata(input) {
    if (input.storageKey !== imageStorageKey(input.sha256, input.format)) throw new TypeError('Image staging requires the canonical content-addressed key')
    if (IMAGE_ASSET_MIME_FORMATS[input.contentType] !== input.format) throw new TypeError('Image staging requires canonical MIME metadata')
    if (!Number.isInteger(input.width) || input.width < 1 || !Number.isInteger(input.height) || input.height < 1 || !Number.isInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MAX_BYTES) throw new TypeError('Image staging requires bounded bytes and valid dimensions')
    return { storageKey: input.storageKey, storageUrl: `kmt-staging://${storeId}/${identity}/${input.storageKey}`, sha256: input.sha256, format: input.format, contentType: input.contentType, width: input.width, height: input.height, bytes: input.byteLength }
  }
  function location(key, create = false) {
    guard()
    const parent = path.join(root, 'images')
    directoryAt(parent, create)
    const file = path.join(root, key)
    if (path.relative(rootIdentity.real, realpathSync(parent)) !== 'images' || path.dirname(file) !== parent) throw new Error('Image staging object escaped its real root')
    return file
  }
  function verify(file, expected) {
    const container = readRegular(file, MAX_BYTES + 4100)
    if (container.length < 4) throw new Error('Image staging object is corrupt')
    const size = container.readUInt32BE(0)
    if (size > 4096 || size + 4 > container.length) throw new Error('Image staging metadata is corrupt')
    const actual = JSON.parse(container.subarray(4, size + 4))
    const bytes = container.subarray(size + 4)
    if (JSON.stringify(actual) !== JSON.stringify(expected) || bytes.length !== expected.bytes || sha256Bytes(bytes) !== expected.sha256) throw new Error('Image staging object is corrupt or maps to different immutable metadata')
    return actual
  }
  async function step(phase, signal) {
    await checkpoint(phase)
    checkSignal(signal)
    guard()
  }
  return {
    root, storeId,
    async verify(input) {
      checkSignal(input.signal)
      ensureRoot(input.signal)
      const expected = metadata(input)
      if (input.storageUrl !== expected.storageUrl) throw new Error('Image staging reference belongs to another store')
      await step('verify', input.signal)
      const result = verify(location(input.storageKey), expected)
      checkSignal(input.signal)
      return result
    },
    async put(input) {
      const { bytes, signal } = input
      checkSignal(signal)
      if (input.ifAbsent !== true) throw new TypeError('Image staging storage requires conditional writes')
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES || sha256Bytes(bytes) !== input.sha256) throw new TypeError('Image staging verifies the bounded byte hash before publication')
      // Copy caller-owned bytes before the first await.
      const body = Buffer.from(bytes)
      ensureRoot(signal)
      const record = metadata({ ...input, byteLength: body.length })
      const file = location(record.storageKey, true)
      try { return verify(file, record) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const temporary = path.join(path.dirname(file), `.object-${randomUUID()}.tmp`)
      let handle
      let published = false
      try {
        await step('open', signal)
        location(record.storageKey)
        handle = await open(temporary, 'wx', 0o600)
        await step('metadata', signal)
        const meta = Buffer.from(JSON.stringify(record))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(meta.length)
        await handle.writeFile(Buffer.concat([header, meta]))
        for (let offset = 0; offset < body.length; offset += 65536) {
          await step('write', signal)
          await handle.writeFile(body.subarray(offset, offset + 65536))
        }
        await step('flush', signal)
        await handle.sync()
        await step('publication', signal)
        location(record.storageKey)
        // Synchronous linearization: abort cannot be delivered between this
        // check and no-clobber publication. Both bytes and metadata are flushed.
        checkSignal(signal)
        try { linkSync(temporary, file); published = true }
        catch (error) { if (error.code !== 'EEXIST') throw error }
        syncDirectory(path.dirname(file))
        // Once publication wins, return/recover that outcome even if abort lands.
        await checkpoint('published')
        return verify(location(record.storageKey), record)
      } catch (error) {
        if (published) { error.published = true; error.asset = record }
        throw error
      } finally {
        await handle?.close().catch(() => {})
        // Cleanup cannot erase a publication-won result. If the parent changed,
        // leave an unreferenced temp file rather than unlink through an alias.
        try { guard(); directoryAt(path.dirname(file)); unlinkSync(temporary) }
        catch { /* Unpublished temporary files are ignored by readers/retries. */ }
      }
    },
  }
}
