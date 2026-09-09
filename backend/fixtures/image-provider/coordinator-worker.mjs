import { runOfflineImageStagingFixtures } from '../../image-staging-coordinator.mjs'
import { IMAGE_PILOT_POLICY } from '../../image-provider-profile.mjs'
import { sha256Bytes } from '../../image-assets.mjs'
import { realImageFixtures, decoderPython } from './decoder-fixtures.mjs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bytes = realImageFixtures().png
const candidates = Array.from({ length: 5 }, (_, i) => ({ supplierId: `fixture-${i}`, supplierSku: `sku-${i}`,
  productUrl: `https://cdn.example.test/product/${i}`, originalUrl: `https://cdn.example.test/image/${i}`, revision: 'revision-1' }))
const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, candidates }))
// Exit during the first real decoder await, after durable candidate-start.
// This avoids a parent polling race under a fully concurrent backend suite.
const crash = setInterval(() => {
  const name = readdirSync(process.argv[2]).find(value => value.endsWith('.sqlite'))
  if (!name) return
  const db = new DatabaseSync(join(process.argv[2], name), { readOnly: true })
  let started = false
  try { started = db.prepare("SELECT COUNT(*) AS n FROM image_run_events WHERE type='candidate-start'").get().n > 0 }
  catch { /* schema not committed yet */ }
  finally { db.close() }
  if (started) process.exit(86)
}, 5)
await runOfflineImageStagingFixtures({
  directory: process.argv[2], python: decoderPython, snapshotBytes, expectedSnapshotDigest: sha256Bytes(snapshotBytes),
  profile: { version: 1, providerId: 'offline-fixture', allowedHosts: ['cdn.example.test'], policy: structuredClone(IMAGE_PILOT_POLICY) },
  fixtures: new Map(candidates.map(row => [row.originalUrl, { status: 200, contentType: 'image/png', bytes, redirect: null }])),
})
clearInterval(crash)
