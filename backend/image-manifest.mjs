import { assertAllowedImageUrl, sha256Bytes } from './image-assets.mjs'
import { compileImageProviderProfile } from './image-provider-profile.mjs'
import { cleanCatalogDescription } from './catalog-description.mjs'

export const IMAGE_DIGEST = /^[a-f0-9]{64}$/
export const IMAGE_PUBLIC_PATH = /^\/api\/images\/([a-f0-9]{64})\.(jpeg|png)$/

// A packet declares its own size. Five was the pilot's batch, compiled into
// twelve refusals across validation, sealing and the scripts -- so the pipeline
// refused four images and six alike. What the manifest actually needs is that
// every parallel array agrees on one count, and that the count is bounded so a
// malformed packet cannot claim an unbounded run. The bound is a sanity limit,
// not a business one: the catalog is ~1,250 distinct models.
export const MAX_IMAGE_PACKET_ASSETS = 500
export const IMAGE_SELECTION_TAG = 'owner-mapped-seeded-v2'
export function supplierImageRevision(tire) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const normalized = { ...tire, description: cleanCatalogDescription(tire.description) }
  return `supplier-payload-v1:${sha256Bytes(JSON.stringify(canonical(normalized)))}`
}
const refuse = () => { throw new Error('Image packet refused') }
const keys = (value, expected) => {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) refuse()
}
function document(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536) refuse()
  const copy = Buffer.from(bytes)
  return { bytes: copy, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)), digest: sha256Bytes(copy) }
}

// No URLs are fetched. Profile and source addresses are private provenance.
// The manifest hashes the exact snapshot bytes and the canonical profile.
export function parseImagePacket({ manifestBytes, profileBytes, snapshotBytes, expectedManifestDigest }) {
  const manifest = document(manifestBytes), profileDocument = document(profileBytes), snapshot = document(snapshotBytes)
  if (!IMAGE_DIGEST.test(expectedManifestDigest) || manifest.digest !== expectedManifestDigest) refuse()
  const profile = compileImageProviderProfile(profileDocument.value)
  const m = manifest.value, s = snapshot.value
  keys(m, ['version', 'profileDigest', 'snapshotDigest', 'assets'])
  keys(s, ['version', 'candidates', 'provenance', 'enrichedRows'])
  if (m.version !== 1 || s.version !== 2 || m.profileDigest !== profile.digest || m.snapshotDigest !== snapshot.digest ||
      !Array.isArray(m.assets) || !Array.isArray(s.candidates) || !Array.isArray(s.enrichedRows)) refuse()
  const count = m.assets.length
  if (count < 1 || count > MAX_IMAGE_PACKET_ASSETS || s.candidates.length !== count || s.enrichedRows.length !== count) refuse()
  keys(s.provenance, ['codeSha', 'seed', 'inputDigest', 'mappingDigest', 'selection', 'productHosts', 'imageHosts', 'observations'])
  const p = s.provenance
  if (!/^[a-f0-9]{40}$/.test(p.codeSha) || !Number.isSafeInteger(p.seed) || !IMAGE_DIGEST.test(p.inputDigest) ||
      !IMAGE_DIGEST.test(p.mappingDigest) || p.selection !== IMAGE_SELECTION_TAG ||
      !Array.isArray(p.observations) || p.observations.length !== count) refuse()
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const candidate = s.candidates[i], asset = m.assets[i]
    keys(candidate, ['supplierId', 'supplierSku', 'productUrl', 'originalUrl', 'revision'])
    keys(asset, ['supplierId', 'sha256', 'format'])
    for (const field of ['supplierId', 'supplierSku', 'revision']) {
      if (typeof candidate[field] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(candidate[field])) refuse()
    }
    if (seen.has(candidate.supplierId) || asset.supplierId !== candidate.supplierId || !IMAGE_DIGEST.test(asset.sha256) || !['jpeg', 'png'].includes(asset.format)) refuse()
    seen.add(candidate.supplierId)
    if (!/^supplier-payload-v1:[a-f0-9]{64}$/.test(candidate.revision)) refuse()
    const observed = p.observations[i], row = s.enrichedRows[i]
    keys(observed, ['supplierId', 'requestedUrl', 'finalUrl', 'sku', 'size', 'listingUrl'])
    if (observed.supplierId !== candidate.supplierId || observed.finalUrl !== candidate.productUrl || observed.sku !== candidate.supplierSku ||
        row?.source?.sku !== candidate.supplierSku || row?.source?.url !== candidate.productUrl || row?.size !== observed.size ||
        !Array.isArray(row.imageUrls) || !row.imageUrls.includes(candidate.originalUrl)) refuse()
    for (const field of ['productUrl', 'originalUrl']) {
      const value = candidate[field]
      if (typeof value !== 'string' || value.length > 4096 || new URL(value).hash || assertAllowedImageUrl(value, profile.allowedHosts) !== value) refuse()
    }
    for (const value of [observed.requestedUrl, observed.listingUrl]) {
      if (typeof value !== 'string' || value.length > 4096 || assertAllowedImageUrl(value, profile.allowedHosts) !== value) refuse()
    }
  }
  const hosts = values => [...new Set(values.map(value => new URL(value).hostname))].sort()
  const products = hosts(p.observations.flatMap(row => [row.requestedUrl, row.finalUrl, row.listingUrl]))
  const images = hosts(s.candidates.map(row => row.originalUrl))
  if (JSON.stringify(p.productHosts) !== JSON.stringify(products) || JSON.stringify(p.imageHosts) !== JSON.stringify(images) ||
      JSON.stringify([...new Set([...products, ...images])].sort()) !== JSON.stringify(profile.allowedHosts)) refuse()
  return { manifest, profileDocument, profile, snapshot, candidates: s.candidates, assets: m.assets }
}
