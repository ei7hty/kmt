// Synthetic offline crash/concurrency worker. Never used by application code.
import { createImageStagingStorage } from '../../image-staging.mjs'
import { imageStorageKey, sha256Bytes } from '../../image-assets.mjs'
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
const sha256 = sha256Bytes(bytes)
const storage = createImageStagingStorage({ directory: process.argv[2], storeId: 'test-store', checkpoint: phase => { if (phase === process.argv[3]) process.exit(86) } })
await storage.put({ bytes, contentType: 'image/png', sha256, width: 1, height: 1, format: 'png', storageKey: imageStorageKey(sha256, 'png'), ifAbsent: true })
