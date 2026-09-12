#!/usr/bin/env node
/**
 * Turn a staging run's private containers into the raw image files + bindings
 * that `seal-image-packet.mjs` expects.
 *
 *   node scripts/unwrap-staged-images.mjs ABS_STAGING_DIR ABS_PACKET_DIR ABS_OUT_DIR
 *
 * WHY THIS EXISTS. `import-product-images.mjs` stores each fetched image as a
 * private CONTAINER under `<staging>/images/<sha256>.<format>`: four bytes of
 * big-endian metadata length, that many bytes of canonical JSON, then the
 * original image. The filename ends `.png`, and the file is not a PNG.
 *
 * That cost a production round trip on 2026-09-12. Bindings were written
 * pointing straight at those paths because the names looked like images; the
 * packet sealed cleanly, the import ran on the live machine, and the isolated
 * decoder refused all eight with `decode-or-resource-limit`. The bytes were
 * never images. Nothing but reading the first sixteen bytes would have said so.
 *
 * So the unwrapping is a tool rather than something each operator rediscovers,
 * and it VERIFIES rather than assumes: every unwrapped payload is hashed and
 * checked against the content-addressed name it was stored under. A container
 * whose body does not hash to its own filename is refused, not written.
 *
 * Reads only. Writes only into the output directory given. No network.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The container header: four bytes of big-endian length, then that much JSON. */
export const CONTAINER_LENGTH_BYTES = 4

/**
 * Split one staged container into its metadata and its image payload.
 *
 * Refuses a header that cannot be true rather than slicing past the end of the
 * buffer and handing back nonsense: a truncated container and a valid one
 * differ only in this arithmetic.
 */
export function splitStagedContainer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < CONTAINER_LENGTH_BYTES + 2) {
    throw new Error(`not a staged container: ${bytes?.length ?? 0} bytes is too short to hold a header`)
  }
  const metadataLength = bytes.readUInt32BE(0)
  if (metadataLength < 2 || CONTAINER_LENGTH_BYTES + metadataLength >= bytes.length) {
    throw new Error(`not a staged container: header claims ${metadataLength} metadata bytes in a ${bytes.length}-byte file`)
  }
  const metadataBytes = bytes.subarray(CONTAINER_LENGTH_BYTES, CONTAINER_LENGTH_BYTES + metadataLength)
  let metadata
  try { metadata = JSON.parse(metadataBytes.toString('utf8')) } catch {
    throw new Error('not a staged container: the declared metadata span is not JSON')
  }
  return { metadata, image: bytes.subarray(CONTAINER_LENGTH_BYTES + metadataLength) }
}

/**
 * supplierId -> { sha256, format }, read from the staging run's own database.
 *
 * The container metadata carries the storage key and the hash but NOT the
 * supplier it belongs to, so this binding exists in exactly one place. Looking
 * it up rather than parsing it out of a filename is the difference between
 * reading the record and guessing from the name -- which is the mistake this
 * whole file exists to stop repeating.
 */
export function readStagedAssets(stagingDirectory) {
  const candidates = readdirSync(stagingDirectory).filter(name => name.endsWith('.sqlite'))
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one run database in ${stagingDirectory}, found ${candidates.length}: ${candidates.join(', ') || '(none)'}`)
  }
  const db = new DatabaseSync(path.join(stagingDirectory, candidates[0]))
  try {
    const rows = db.prepare('SELECT supplier_id, sha256, format FROM image_assets').all()
    return new Map(rows.map(row => [row.supplier_id, { sha256: row.sha256, format: row.format }]))
  } finally { db.close() }
}

/**
 * Unwrap every container a packet's candidates refer to, in packet order.
 *
 * Order is not cosmetic: `sealImagePacket` requires the bindings array to match
 * the snapshot's candidate order exactly, index for index.
 */
export function unwrapStagedImages({ stagingDirectory, packetDirectory, outputDirectory }) {
  for (const [label, value] of [['staging', stagingDirectory], ['packet', packetDirectory], ['output', outputDirectory]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} directory must be an absolute path`)
  }
  const snapshot = JSON.parse(readFileSync(path.join(packetDirectory, 'snapshot.json'), 'utf8'))
  if (!Array.isArray(snapshot.candidates) || !snapshot.candidates.length) throw new Error('packet snapshot has no candidates')

  const assets = readStagedAssets(stagingDirectory)
  const images = path.join(stagingDirectory, 'images')
  mkdirSync(outputDirectory, { recursive: true })

  const bindings = []
  for (const candidate of snapshot.candidates) {
    const asset = assets.get(candidate.supplierId)
    if (!asset) throw new Error(`${candidate.supplierId}: no staged asset row; this packet and this staging run do not belong together`)
    const source = path.join(images, `${asset.sha256}.${asset.format}`)
    if (!existsSync(source)) throw new Error(`${candidate.supplierId}: staged container missing at ${source}`)

    const { image } = splitStagedContainer(readFileSync(source))
    const actual = createHash('sha256').update(image).digest('hex')
    if (actual !== asset.sha256) {
      throw new Error(`${candidate.supplierId}: unwrapped payload hashes ${actual}, but it was stored as ${asset.sha256}. Refusing rather than writing bytes that are not what the run recorded.`)
    }
    const format = asset.format === 'jpg' ? 'jpeg' : asset.format
    const destination = path.join(outputDirectory, `${asset.sha256}.${format}`)
    writeFileSync(destination, image)
    bindings.push({ supplierId: candidate.supplierId, format, path: destination })
  }

  const bindingsPath = path.join(outputDirectory, 'bindings.json')
  writeFileSync(bindingsPath, JSON.stringify(bindings, null, 1))
  return { bindingsPath, count: bindings.length, bindings }
}

// `pathToFileURL` rather than comparing resolved paths: a raw string compare of
// a file:// URL against a Windows path does not hold, which cost a real bug in
// scripts/build-image-mapping.mjs (an unguarded main() firing on import).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [stagingDirectory, packetDirectory, outputDirectory, ...extra] = process.argv.slice(2)
    if (!stagingDirectory || !packetDirectory || !outputDirectory || extra.length) throw new Error('Arguments required')
    const result = unwrapStagedImages({ stagingDirectory, packetDirectory, outputDirectory })
    console.log(`Unwrapped ${result.count} images, every payload verified against its own content-addressed name.`)
    console.log(`Bindings written in packet order: ${result.bindingsPath}`)
    console.log(`Next: node scripts/seal-image-packet.mjs ${packetDirectory} ${result.bindingsPath}`)
  } catch (error) {
    console.error('Unwrapping refused. Use: node scripts/unwrap-staged-images.mjs ABS_STAGING_DIR ABS_PACKET_DIR ABS_OUT_DIR')
    console.error(`  reason: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
