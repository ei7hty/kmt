import { mkdir, open, lstat, link, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { imageStorageKey, sha256Bytes } from './image-assets.mjs'

const MIME_BY_FORMAT = Object.freeze({ gif: 'image/gif', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })
const PROTECTED_PARTS = new Set(['public', 'dist', 'data', 'deploy', 'production'])

function requiredDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Image staging directory must be an absolute path')
  const resolved = path.resolve(directory)
  if (resolved.split(path.sep).some(part => PROTECTED_PARTS.has(part.toLowerCase()))) throw new TypeError('Image staging directory must be private and outside served or production data roots')
  return resolved
}

function requiredStoreId(storeId) {
  if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(storeId)) throw new TypeError('Image staging store id must be an explicit safe identifier')
  return storeId
}

function paths(directory, key) { return { file: path.join(directory, key), meta: path.join(directory, `${key}.json`) } }

function checkSignal(signal) {
  if (signal?.aborted) {
    const error = new Error('Image staging write aborted')
    error.name = 'AbortError'
    error.state = 'timeout'
    throw error
  }
}

async function privateRoot(root) {
  await mkdir(root, { recursive: true })
  const resolved = await realpath(root)
  if (resolved.split(path.sep).some(part => PROTECTED_PARTS.has(part.toLowerCase()))) throw new TypeError('Image staging directory must be private and outside served or production data roots')
  let current = path.parse(root).root
  for (const part of path.relative(current, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new TypeError('Image staging directory cannot contain symlink or junction components')
  }
  return resolved
}

async function publishNoClobber(target, data, signal) {
  checkSignal(signal)
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    checkSignal(signal)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    checkSignal(signal)
    await link(temporary, target)
  } finally {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function verifyExisting(file, meta, expected) {
  let actualBytes
  try { actualBytes = new Uint8Array(await readFile(file)) } catch (error) {
    if (error.code === 'ENOENT') {
      const metadataExists = await readFile(meta, 'utf8').then(() => true).catch(metadataError => {
        if (metadataError.code === 'ENOENT') return false
        throw metadataError
      })
      throw new Error(metadataExists ? 'Image staging metadata exists but the blob is missing' : 'Image staging object is absent', { cause: error })
    }
    throw error
  }
  let actualMeta
  try { actualMeta = JSON.parse(await readFile(meta, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Image staging blob exists but metadata is missing', { cause: error })
    throw error
  }
  if (actualBytes.byteLength !== expected.bytes || sha256Bytes(actualBytes) !== expected.sha256 ||
      JSON.stringify(actualMeta) !== JSON.stringify(expected)) throw new Error('Image staging object is corrupt or maps to different immutable metadata')
  return actualMeta
}

/** Durable private staging storage. It has no HTTP/public serving path. */
export function createImageStagingStorage({ directory = process.env.KMT_IMAGE_STAGING_DIR, storeId = process.env.KMT_IMAGE_STAGING_STORE_ID, urlPrefix = null } = {}) {
  const root = requiredDirectory(directory)
  const id = requiredStoreId(storeId)
  const locatorPrefix = urlPrefix ?? `kmt-staging://${id}/`
  if (locatorPrefix !== `kmt-staging://${id}/`) throw new TypeError('Image staging locator must be the store-bound non-HTTP prefix')
  let rootReady
  const ensureRoot = async signal => {
    checkSignal(signal)
    if (!rootReady) rootReady = privateRoot(root)
    const resolved = await rootReady
    checkSignal(signal)
    const marker = path.join(resolved, '.kmt-image-staging.json')
    const markerValue = JSON.stringify({ store: 'kmt-image-staging-v2', storeId: id, locatorPrefix })
    try {
      if ((await readFile(marker, 'utf8')) !== markerValue) throw new Error('Image staging root belongs to another store')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { await publishNoClobber(marker, markerValue, signal) } catch (publishError) {
        if (publishError.code !== 'EEXIST') throw publishError
        if ((await readFile(marker, 'utf8')) !== markerValue) throw new Error('Image staging root belongs to another store', { cause: publishError })
      }
    }
    return resolved
  }
  return {
    root,
    storeId: id,
    async put({ bytes, contentType, sha256, width, height, format, storageKey, ifAbsent, signal }) {
      if (ifAbsent !== true) throw new TypeError('Image staging storage requires conditional writes')
      const canonical = imageStorageKey(sha256, format)
      if (storageKey !== canonical) throw new TypeError('Image staging storage requires the canonical content-addressed key')
      if (!(bytes instanceof Uint8Array) || sha256Bytes(bytes) !== sha256) throw new TypeError('Image staging storage verifies the byte hash before publication')
      if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new TypeError('Image staging storage requires valid dimensions')
      if (contentType !== MIME_BY_FORMAT[format]) throw new TypeError('Image staging storage requires canonical MIME metadata')
      checkSignal(signal)
      const directory = await ensureRoot(signal)
      const { file, meta } = paths(directory, storageKey)
      await mkdir(path.dirname(file), { recursive: true })
      await privateRoot(path.dirname(file))
      const record = { storageKey, storageUrl: `${locatorPrefix}${storageKey}`, sha256, format, contentType, width, height, bytes: bytes.byteLength }
      try { return await verifyExisting(file, meta, record) } catch (error) {
        if (error.message.includes('corrupt') || error.message.includes('different immutable')) throw error
        if (error.message.includes('metadata exists but the blob is missing')) throw error
        if (!error.message.includes('object is absent') && !error.message.includes('blob exists but metadata is missing')) throw error
      }
      try { await publishNoClobber(file, bytes, signal) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        return verifyExisting(file, meta, record)
      }
      checkSignal(signal)
      try { await publishNoClobber(meta, JSON.stringify(record), signal) } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      return await verifyExisting(file, meta, record)
    },
  }
}
