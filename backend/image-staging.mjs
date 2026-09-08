import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

import { imageStorageKey, sha256Bytes } from './image-assets.mjs'

function requiredDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Image staging directory must be an absolute path')
  const resolved = path.resolve(directory)
  if (resolved.split(path.sep).some(part => ['public', 'dist', 'data'].includes(part.toLowerCase()))) throw new TypeError('Image staging directory must be private and outside served or production data roots')
  return resolved
}

function metadataPath(directory, key) { return path.join(directory, `${key}.json`) }
function bytesPath(directory, key) { return path.join(directory, key) }

/** Durable, private filesystem storage. It has no HTTP/public serving path. */
export function createImageStagingStorage({ directory = process.env.KMT_IMAGE_STAGING_DIR, urlPrefix = process.env.KMT_IMAGE_STAGING_URL_PREFIX ?? 'staging://kmt-images/' } = {}) {
  const root = requiredDirectory(directory)
  if (typeof urlPrefix !== 'string' || !urlPrefix || /\s/.test(urlPrefix)) throw new TypeError('Image staging URL prefix must be a non-empty opaque prefix')
  return {
    root,
    async put({ bytes, contentType, sha256, width, height, format, storageKey, ifAbsent }) {
      if (ifAbsent !== true) throw new TypeError('Image staging storage requires conditional writes')
      const canonical = imageStorageKey(sha256, format)
      if (storageKey !== canonical) throw new TypeError('Image staging storage requires the canonical content-addressed key')
      if (!(bytes instanceof Uint8Array) || sha256Bytes(bytes) !== sha256) throw new TypeError('Image staging storage verifies the byte hash before publication')
      if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !Number.isInteger(bytes.byteLength)) throw new TypeError('Image staging storage requires valid dimensions and bytes')
      const expectedContentType = { gif: 'image/gif', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format]
      if (contentType !== expectedContentType) throw new TypeError('Image staging storage requires canonical MIME metadata')
      const file = bytesPath(root, storageKey)
      const meta = metadataPath(root, storageKey)
      await mkdir(path.dirname(file), { recursive: true })
      const marker = path.join(root, '.kmt-image-staging.json')
      const markerValue = JSON.stringify({ store: 'kmt-image-staging-v1', urlPrefix })
      try {
        if ((await readFile(marker, 'utf8')) !== markerValue) throw new Error('Image staging root belongs to another store')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await open(marker, 'wx').then(async handle => { await handle.writeFile(markerValue); await handle.close() })
      }
      const record = { storageKey, storageUrl: `${urlPrefix}${storageKey}`, sha256, format, contentType, width, height, bytes: bytes.byteLength }
      try {
        const existing = JSON.parse(await readFile(meta, 'utf8'))
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Image staging key already maps to different metadata')
        return existing
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await open(file, 'wx').then(async handle => { try { await handle.writeFile(bytes); await handle.close() } catch (error) { await handle.close().catch(() => {}); throw error } }).catch(async error => {
        if (error.code !== 'EEXIST') throw error
        const existing = JSON.parse(await readFile(meta, 'utf8'))
        if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Image staging key already maps to different metadata')
      })
      if ((await readFile(meta, 'utf8').catch(() => null)) !== null) return record
      await open(meta, 'wx').then(async handle => { try { await handle.writeFile(JSON.stringify(record)); await handle.close() } catch (error) { await handle.close().catch(() => {}); throw error } })
      return record
    },
  }
}
