#!/usr/bin/env node
import { openSync, closeSync, writeFileSync, fsyncSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPrivateImageInput } from './import-images.mjs'
import { sha256Bytes } from '../backend/image-assets.mjs'
import { compileImageProviderProfile } from '../backend/image-provider-profile.mjs'
import { parseImagePacket } from '../backend/image-manifest.mjs'

// Owner-supplied local files are an attestation, not HTTP acquisition evidence.
export function sealImagePacket(directory, bindingsFile) {
  const snapshotBytes = readPrivateImageInput(path.join(directory, 'snapshot.json'), 65536)
  const profileBytes = readPrivateImageInput(path.join(directory, 'profile.json'), 65536)
  const snapshot = JSON.parse(snapshotBytes), profile = compileImageProviderProfile(JSON.parse(profileBytes))
  const bindings = JSON.parse(readPrivateImageInput(bindingsFile, 65536))
  if (!Array.isArray(bindings) || !bindings.length || snapshot.candidates?.length !== bindings.length) throw new Error('Bindings must match the snapshot candidate count')
  const files = new Map()
  const assets = bindings.map((binding, i) => {
    if (Object.keys(binding).sort().join(',') !== 'format,path,supplierId' || binding.supplierId !== snapshot.candidates[i].supplierId || !['png', 'jpeg'].includes(binding.format)) throw new Error('Ordered bindings refused')
    const bytes = readPrivateImageInput(binding.path, 5 * 1024 * 1024), sha256 = sha256Bytes(bytes)
    files.set(`${sha256}.${binding.format}`, bytes)
    return { supplierId: binding.supplierId, sha256, format: binding.format }
  })
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, profileDigest: profile.digest, snapshotDigest: sha256Bytes(snapshotBytes), assets }))
  const digest = sha256Bytes(manifestBytes)
  parseImagePacket({ manifestBytes, profileBytes, snapshotBytes, expectedManifestDigest: digest })
  const write = (name, bytes) => {
    const file = path.join(directory, name)
    if (existsSync(file)) {
      if (!readPrivateImageInput(file, 5 * 1024 * 1024).equals(bytes)) throw new Error('Immutable packet collision')
      return
    }
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  }
  for (const [name, bytes] of files) write(name, bytes)
  write('manifest.json', manifestBytes) // completeness marker published last
  if (process.platform !== 'win32') { const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  return { manifestDigest: digest, count: assets.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Arguments required')
    console.log(JSON.stringify(sealImagePacket(process.argv[2], process.argv[3])))
  } catch {
    console.error('Packet sealing refused. Use: node scripts/seal-image-packet.mjs ABS_PRIVATE_PACKET ABS_BINDINGS_JSON. No network or approval action is performed.')
    process.exitCode = 1
  }
}
