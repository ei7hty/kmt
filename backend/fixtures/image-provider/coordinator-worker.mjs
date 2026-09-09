import { runOfflineImageStagingFixtures } from '../../image-staging-coordinator.mjs'
import { IMAGE_PILOT_POLICY } from '../../image-provider-profile.mjs'
import { sha256Bytes } from '../../image-assets.mjs'
import { realImageFixtures, decoderPython } from './decoder-fixtures.mjs'

const bytes = realImageFixtures().png
const candidates = Array.from({ length: 5 }, (_, i) => ({ supplierId: `fixture-${i}`, supplierSku: `sku-${i}`,
  productUrl: `https://cdn.example.test/product/${i}`, originalUrl: `https://cdn.example.test/image/${i}`, revision: 'revision-1' }))
const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, candidates }))
await runOfflineImageStagingFixtures({
  directory: process.argv[2], python: decoderPython, snapshotBytes, expectedSnapshotDigest: sha256Bytes(snapshotBytes),
  profile: { version: 1, providerId: 'offline-fixture', allowedHosts: ['cdn.example.test'], policy: structuredClone(IMAGE_PILOT_POLICY) },
  fixtures: new Map(candidates.map(row => [row.originalUrl, { status: 200, contentType: 'image/png', bytes, redirect: null }])),
})
