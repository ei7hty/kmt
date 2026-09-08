import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export const IMAGE_ASSET_USAGE_STATUSES = ['candidate', 'approved', 'rejected']
export const IMAGE_ASSET_PROVENANCE = 'supplier-product-page'
export const IMAGE_ASSET_FORMATS = ['gif', 'jpeg', 'png', 'webp']
export const IMAGE_ASSET_MIME_FORMATS = Object.freeze({
  'image/gif': 'gif', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp',
})

export class ImageAssetStorageConflictError extends Error {
  constructor(message) { super(message); this.name = 'ImageAssetStorageConflictError'; this.state = 'storage-conflict' }
}

export function imageStorageKey(sha256, format) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !IMAGE_ASSET_FORMATS.includes(format)) {
    throw new ImageAssetStorageConflictError('Content-addressed storage keys require a SHA-256 hash and canonical format')
  }
  return `images/${sha256}.${format}`
}

const now = () => new Date().toISOString()

function databaseOf(inventoryOrDb) {
  const db = inventoryOrDb?.db ?? inventoryOrDb
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('An Inventory or node:sqlite database is required')
  }
  return db
}

/**
 * The image table is deliberately separate from supplier.payload. A future
 * storage provider can evolve without rewriting the supplier snapshot, and
 * an approved asset is never replaced by a later candidate reconciliation.
 */
export function ensureImageAssetSchema(inventoryOrDb) {
  const db = databaseOf(inventoryOrDb)
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id TEXT NOT NULL REFERENCES supplier(id),
      supplier_sku TEXT NOT NULL,
      product_url TEXT,
      identity_key TEXT NOT NULL,
      candidate_revision TEXT NOT NULL DEFAULT '',
      source_current INTEGER NOT NULL DEFAULT 1 CHECK(source_current IN (0, 1)),
      remote_image_url TEXT,
      remote_image_present INTEGER NOT NULL DEFAULT 0 CHECK(remote_image_present IN (0, 1)),
      source_metadata_present INTEGER NOT NULL DEFAULT 0 CHECK(source_metadata_present IN (0, 1)),
      storage_key TEXT,
      storage_url TEXT,
      sha256 TEXT,
      bytes INTEGER,
      width INTEGER,
      height INTEGER,
      format TEXT,
      fetched_at TEXT,
      stored_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'supplier-product-page',
      usage_status TEXT NOT NULL DEFAULT 'candidate' CHECK(usage_status IN ('candidate', 'approved', 'rejected')),
      failure_state TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(supplier_id, identity_key)
    );
    CREATE TABLE IF NOT EXISTS image_storage (
      storage_key TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      storage_url TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('gif', 'jpeg', 'png', 'webp')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_assets_supplier ON image_assets(supplier_id);
    CREATE INDEX IF NOT EXISTS image_assets_hash ON image_assets(sha256);
  `)
  const columns = new Set(db.prepare('PRAGMA table_info(image_assets)').all().map(row => row.name))
  if (!columns.has('candidate_revision')) db.exec("ALTER TABLE image_assets ADD COLUMN candidate_revision TEXT NOT NULL DEFAULT ''")
  if (!columns.has('source_current')) db.exec("ALTER TABLE image_assets ADD COLUMN source_current INTEGER NOT NULL DEFAULT 1 CHECK(source_current IN (0, 1))")
  return db
}

function normalizedHosts(allowedHosts) {
  if (!Array.isArray(allowedHosts)) throw new TypeError('allowedHosts must be an explicit hostname allowlist')
  return new Set(allowedHosts.map(host => String(host).trim().toLowerCase()).filter(Boolean))
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const version = isIP(host)
  if (version === 4) {
    const octets = host.split('.').map(Number)
    const first = octets[0], second = octets[1]
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      first === 100 && second >= 64 && second <= 127 ||
      first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 ||
      first === 192 && (second === 0 || second === 168) ||
      first === 192 && second === 0 && octets[2] === 2 ||
      first === 198 && (second === 18 || second === 19 || second === 51) ||
      first === 203 && second === 0 && octets[2] === 113
  }
  if (version !== 6) return false
  const bytes = ipv6Bytes(host)
  if (!bytes) return true
  const first = bytes[0], second = bytes[1]
  const mapped = bytes.slice(0, 12).every((byte, index) => index < 10 ? byte === 0 : byte === 0xff)
  if (mapped) return isPrivateHost(bytes.slice(12).join('.'))
  if (first === 0 && bytes.slice(0, 12).every(byte => byte === 0) ||
      first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b ||
      first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01 ||
      first === 0x20 && second === 0x02 ||
      first === 0x20 && second === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00 ||
      first >= 0xfc && first <= 0xff || first === 0xfe && (second & 0xc0) === 0x80 ||
      first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true
  return false
}

function ipv6Bytes(host) {
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parse = part => part ? part.split(':').flatMap(section => {
    if (section.includes('.')) {
      const octets = section.split('.').map(Number)
      if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return [null]
      return [octets[0] << 8 | octets[1], octets[2] << 8 | octets[3]]
    }
    if (!/^[0-9a-f]{1,4}$/i.test(section)) return [null]
    return [parseInt(section, 16)]
  }) : []
  const left = parse(halves[0]), right = halves.length === 2 ? parse(halves[1]) : []
  if (left.some(part => part === null) || right.some(part => part === null) ||
      (halves.length === 1 && left.length !== 8) || (halves.length === 2 && left.length + right.length >= 8)) return null
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left
  if (words.length !== 8) return null
  return words.flatMap(word => [word >> 8, word & 0xff])
}

export function assertAllowedImageUrl(value, allowedHosts, { allowedPorts = [443] } = {}) {
  const hosts = normalizedHosts(allowedHosts)
  if (!Array.isArray(allowedPorts) || allowedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new TypeError('allowedPorts must be an explicit list of TCP ports')
  }
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Image URL is required')
  let parsed
  try { parsed = new URL(value) } catch { throw new TypeError('Image URL is malformed') }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (parsed.protocol !== 'https:') throw new TypeError('Image URL must use HTTPS')
  if (parsed.port && !allowedPorts.includes(Number(parsed.port))) throw new TypeError(`Image URL port ${parsed.port} is not allowed`)
  if (parsed.username || parsed.password) throw new TypeError('Image URL cannot contain credentials')
  if (isPrivateHost(hostname)) throw new TypeError('Image URL points to a private or local destination')
  if (!hosts.has(hostname)) throw new TypeError(`Image URL host ${hostname} is not allowlisted`)
  return parsed.toString()
}

/** Validate the address returned by an injected resolver before a connection. */
export function assertSafeResolvedAddress(address) {
  if (typeof address !== 'string') throw new TypeError('Resolved image address must be an IP literal')
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(normalized) === 0 || isPrivateHost(normalized)) throw new TypeError('Resolved image address is private, local, link-local, or otherwise non-public')
  return normalized
}

function stableRow(tire, allowedHosts, allowedPorts) {
  const supplierId = tire?.id
  const source = tire?.source
  if (typeof supplierId !== 'string' || !supplierId.trim() ||
      typeof source?.sku !== 'string' || !source.sku.trim()) {
    throw new TypeError('Image reconciliation requires a stable supplier id and SKU')
  }
  const productUrl = typeof source.url === 'string' && source.url.trim()
    ? assertAllowedImageUrl(source.url, allowedHosts, { allowedPorts }) : null
  const remoteUrls = [...new Set((Array.isArray(tire.imageUrls) ? tire.imageUrls : [])
    .filter(url => typeof url === 'string' && url.trim())
    .map(url => assertAllowedImageUrl(url, allowedHosts, { allowedPorts })))]
  const sourceMetadataPresent = Boolean(productUrl && source.sku.trim())
  return {
    supplierId,
    supplierSku: source.sku.trim(),
    productUrl,
    sourceMetadataPresent,
    candidateRevision: typeof source.fetchedAt === 'string' && source.fetchedAt ? source.fetchedAt : '',
    remoteUrls: remoteUrls.length ? remoteUrls : [null],
  }
}

/**
 * Reconcile enriched rows to durable image candidates. The row is keyed by
 * supplier id plus image URL (or a stable no-image sentinel), not by a title
 * that can change between supplier snapshots.
 */
export function reconcileImageCandidates(inventoryOrDb, tires, { at = now(), allowedHosts = [], allowedPorts = [443] } = {}) {
  const db = ensureImageAssetSchema(inventoryOrDb)
  if (!Array.isArray(tires)) throw new TypeError('Image reconciliation requires an array of tires')
  const rows = tires.map(tire => stableRow(tire, allowedHosts, allowedPorts))
  const supplierIds = new Set(db.prepare('SELECT id FROM supplier').all().map(row => row.id))
  for (const row of rows) {
    if (!supplierIds.has(row.supplierId)) throw new Error(`Supplier tire ${row.supplierId} is not in inventory`)
  }

  const upsert = db.prepare(`
    INSERT INTO image_assets (
      supplier_id, supplier_sku, product_url, identity_key, candidate_revision, source_current, remote_image_url,
      remote_image_present, source_metadata_present, provenance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(supplier_id, identity_key) DO UPDATE SET
      supplier_sku=excluded.supplier_sku,
      product_url=excluded.product_url,
      candidate_revision=excluded.candidate_revision,
      source_current=1,
      remote_image_url=excluded.remote_image_url,
      remote_image_present=excluded.remote_image_present,
      source_metadata_present=excluded.source_metadata_present,
      updated_at=excluded.updated_at
  `)
  const write = () => {
    for (const supplierId of new Set(rows.map(row => row.supplierId))) {
      db.prepare("UPDATE image_assets SET source_current=0, updated_at=? WHERE supplier_id=? AND usage_status <> 'approved'").run(at, supplierId)
    }
    for (const row of rows) {
      for (const remoteImageUrl of row.remoteUrls) {
        const identityKey = remoteImageUrl ?? '__no-remote-image__'
        upsert.run(
          row.supplierId, row.supplierSku, row.productUrl, identityKey, row.candidateRevision, 1, remoteImageUrl,
          Number(Boolean(remoteImageUrl)), Number(row.sourceMetadataPresent),
          IMAGE_ASSET_PROVENANCE, at, at,
        )
      }
    }
  }
  if (typeof inventoryOrDb?.transaction === 'function') inventoryOrDb.transaction(write)
  else { db.exec('BEGIN IMMEDIATE'); try { write(); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error } }
  return { reconciled: rows.reduce((count, row) => count + row.remoteUrls.length, 0), suppliers: rows.length }
}

function candidateFromRow(row) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierSku: row.supplier_sku,
    productUrl: row.product_url,
    candidateRevision: row.candidate_revision,
    sourceCurrent: Boolean(row.source_current),
    originalUrl: row.remote_image_url,
    remoteImagePresent: Boolean(row.remote_image_present),
    sourceMetadataPresent: Boolean(row.source_metadata_present),
    storageKey: row.storage_key,
    storageUrl: row.storage_url,
    sha256: row.sha256,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    format: row.format,
    fetchedAt: row.fetched_at,
    storedAt: row.stored_at,
    provenance: row.provenance,
    usageStatus: row.usage_status,
    failureState: row.failure_state,
    failureMessage: row.failure_message,
  }
}

export function listImageCandidates(inventoryOrDb) {
  const db = ensureImageAssetSchema(inventoryOrDb)
  return db.prepare('SELECT * FROM image_assets ORDER BY id').all().map(candidateFromRow)
}

export function createImageAssetRepository(inventoryOrDb) {
  const db = ensureImageAssetSchema(inventoryOrDb)
  return {
    list: () => listImageCandidates(db),
    findByHash: sha256 => {
      const row = db.prepare(`SELECT s.storage_key, s.storage_url, s.sha256, s.format
        FROM image_storage s WHERE s.sha256=? LIMIT 1`).get(sha256)
      return row ? { storageKey: row.storage_key, storageUrl: row.storage_url, sha256: row.sha256, format: row.format } : null
    },
    recordStored: (id, asset, expected = {}) => {
      ensureImageAssetSchema(db)
      const expectedKey = imageStorageKey(asset.sha256, asset.format)
      if (asset.storageKey !== expectedKey) throw new ImageAssetStorageConflictError(`Storage key must be ${expectedKey}`)
      if (typeof expected.supplierId !== 'string' || typeof expected.supplierSku !== 'string' ||
          typeof expected.originalUrl !== 'string' || typeof expected.revision !== 'string') return { status: 'stale-conflict' }
      db.exec('BEGIN IMMEDIATE')
      try {
        const target = db.prepare('SELECT usage_status, source_current, supplier_id, supplier_sku, remote_image_url, candidate_revision FROM image_assets WHERE id=?').get(id)
        if (!target) throw new Error(`Image asset ${id} was not found`)
        if (target.usage_status === 'approved') {
          db.exec('COMMIT')
          return { status: 'approved-conflict' }
        }
        if (!target.source_current || target.supplier_id !== expected.supplierId || target.supplier_sku !== expected.supplierSku ||
            target.remote_image_url !== expected.originalUrl || target.candidate_revision !== expected.revision) {
          db.exec('COMMIT')
          return { status: 'stale-conflict' }
        }
        const existing = db.prepare('SELECT sha256, storage_url, format FROM image_storage WHERE storage_key=?').get(asset.storageKey)
        if (existing && (existing.sha256 !== asset.sha256 || existing.format !== asset.format)) throw new ImageAssetStorageConflictError(`Storage key ${asset.storageKey} already maps to another hash or format`)
        const storedAt = asset.storedAt ?? now()
        if (!existing) db.prepare('INSERT INTO image_storage(storage_key, sha256, storage_url, format, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(asset.storageKey, asset.sha256, asset.storageUrl, asset.format, storedAt)
        const storageUrl = existing?.storage_url ?? asset.storageUrl
        const changed = db.prepare(`UPDATE image_assets SET
          storage_key=?, storage_url=?, sha256=?, bytes=?, width=?, height=?, format=?,
          fetched_at=?, stored_at=?, provenance=?, usage_status=?, failure_state=NULL,
          failure_message=NULL, updated_at=? WHERE id=? AND usage_status='candidate' AND source_current=1 AND supplier_id=? AND supplier_sku=? AND remote_image_url=? AND candidate_revision=?`).run(
          asset.storageKey, storageUrl, asset.sha256, asset.bytes, asset.width, asset.height,
          asset.format, asset.fetchedAt ?? null, storedAt, asset.provenance ?? IMAGE_ASSET_PROVENANCE,
          asset.usageStatus ?? 'candidate', storedAt, id, expected.supplierId, expected.supplierSku, expected.originalUrl, expected.revision,
        )
        if (changed.changes !== 1) {
          db.exec('ROLLBACK')
          return { status: 'approved-conflict' }
        }
        db.exec('COMMIT')
        return { status: 'stored', storageKey: asset.storageKey, storageUrl }
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* transaction already closed */ }
        throw error
      }
    },
    recordFailure: (id, failure, expected = {}) => {
      const hasIdentity = typeof expected.supplierId === 'string' && typeof expected.supplierSku === 'string' &&
        typeof expected.originalUrl === 'string' && typeof expected.revision === 'string'
      const where = hasIdentity
        ? 'AND source_current=1 AND supplier_id=? AND supplier_sku=? AND remote_image_url=? AND candidate_revision=?'
        : typeof expected.originalUrl === 'string' && typeof expected.revision === 'string'
          ? 'AND remote_image_url=? AND candidate_revision=?' : ''
      const args = [failure.state, failure.message ?? null, failure.at ?? now(), id]
      if (hasIdentity) args.push(expected.supplierId, expected.supplierSku, expected.originalUrl, expected.revision)
      else if (where) args.push(expected.originalUrl, expected.revision)
      const changed = db.prepare(`UPDATE image_assets SET failure_state=?, failure_message=?, updated_at=? WHERE id=? AND usage_status='candidate' ${where}`)
        .run(...args)
      return changed.changes === 1 ? { status: 'recorded' } : { status: 'approved-conflict' }
    },
  }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
