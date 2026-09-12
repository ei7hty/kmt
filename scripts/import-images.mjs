#!/usr/bin/env node
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ImagePublication, imageDirectoryForDatabase } from '../backend/image-publication.mjs'
import { parseImagePacket } from '../backend/image-manifest.mjs'

// Bounded, no-follow reads; never accept arbitrary URLs as local inputs.
export function readPrivateImageInput(filename, maxBytes) {
  if (!path.isAbsolute(filename)) throw new Error('Absolute private input path required')
  let current = path.parse(filename).root
  for (const part of path.relative(current, filename).split(path.sep)) {
    current = path.join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('Private input links refused')
  }
  const before = lstatSync(filename)
  if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error('Private input size refused')
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Private input changed')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0, count
    while ((count = readSync(fd, bytes, offset, bytes.length - offset, offset))) offset += count
    if (offset !== before.size || fstatSync(fd).size !== before.size) throw new Error('Private input changed')
    return bytes.subarray(0, offset)
  } finally { closeSync(fd) }
}

export async function importImageFiles({ database, packetDirectory, manifestDigest, python }) {
  if (!path.isAbsolute(database) || !lstatSync(database).isFile() || lstatSync(database).isSymbolicLink() || realpathSync(database) !== path.resolve(database)) throw new Error('Existing private database required')
  const input = { manifestBytes: readPrivateImageInput(path.join(packetDirectory, 'manifest.json'), 65536),
    profileBytes: readPrivateImageInput(path.join(packetDirectory, 'profile.json'), 65536),
    snapshotBytes: readPrivateImageInput(path.join(packetDirectory, 'snapshot.json'), 65536), expectedManifestDigest: manifestDigest }
  const packet = parseImagePacket(input)
  const files = new Map()
  for (const asset of packet.assets) {
    const key = `${asset.sha256}.${asset.format}`
    if (!files.has(key)) files.set(key, readPrivateImageInput(path.join(packetDirectory, key), 5 * 1024 * 1024))
  }
  // Do not construct Inventory: importing images must not seed or mutate any
  // supplier, offer, pricing or customer rows in an existing owner database.
  const db = new DatabaseSync(database)
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
  const inventory = { db, transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  } }
  try {
    const images = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python })
    const result = await images.ingest(input, files)
    return { digest: result.digest, version: result.version, action: result.action, count: result.assets.length }
  } finally { db.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [database, packetDirectory, manifestDigest, ...extra] = process.argv.slice(2)
  try {
    if (extra.length) throw new Error('Unexpected arguments')
    console.log(JSON.stringify(await importImageFiles({ database, packetDirectory, manifestDigest, python: process.env.KMT_IMAGE_DECODER_PYTHON })))
  } catch (error) {
    console.error('Local image import refused. Use: node scripts/import-images.mjs ABS_DB ABS_PRIVATE_PACKET MANIFEST_SHA256. Inspect the private packet; no network fallback is available.')
    // The seventh bare catch on this one pipeline, and the worst placed: it is
    // the only step that runs on the production machine, where re-running by
    // hand with instrumentation is not an option and a deploy is the only way
    // to change the code. A silent refusal here costs a deploy cycle to
    // diagnose. The operator supplied the database path, the packet and the
    // digest; the reason is his own input described back to him.
    console.error(`  reason: ${error?.message ?? error}`)
    if (error?.cause) console.error(`  cause:  ${error.cause?.message ?? error.cause}`)
    if (error?.code) console.error(`  code:   ${error.code}`)
    if (error?.path) console.error(`  path:   ${error.path}`)
    if (error?.stack) console.error(error.stack.split('\n').slice(1, 5).map(line => `  ${line.trim()}`).join('\n'))
    process.exitCode = 1
  }
}
