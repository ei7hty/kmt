import { createHash } from 'node:crypto'

export const IMAGE_ASSET_USAGE_STATUSES = ['candidate', 'approved', 'rejected']
export const IMAGE_ASSET_PROVENANCE = 'supplier-product-page'

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
    CREATE INDEX IF NOT EXISTS image_assets_supplier ON image_assets(supplier_id);
    CREATE INDEX IF NOT EXISTS image_assets_hash ON image_assets(sha256);
  `)
  return db
}

function stableRow(tire) {
  const supplierId = tire?.id
  const source = tire?.source
  if (typeof supplierId !== 'string' || !supplierId.trim() ||
      typeof source?.sku !== 'string' || !source.sku.trim()) {
    throw new TypeError('Image reconciliation requires a stable supplier id and SKU')
  }
  const productUrl = typeof source.url === 'string' && source.url.trim() ? source.url.trim() : null
  const remoteUrls = [...new Set((Array.isArray(tire.imageUrls) ? tire.imageUrls : [])
    .filter(url => typeof url === 'string' && /^https?:\/\//i.test(url)))]
  const sourceMetadataPresent = Boolean(productUrl && source.sku.trim())
  return {
    supplierId,
    supplierSku: source.sku.trim(),
    productUrl,
    sourceMetadataPresent,
    remoteUrls: remoteUrls.length ? remoteUrls : [null],
  }
}

/**
 * Reconcile enriched rows to durable image candidates. The row is keyed by
 * supplier id plus image URL (or a stable no-image sentinel), not by a title
 * that can change between supplier snapshots.
 */
export function reconcileImageCandidates(inventoryOrDb, tires, { at = now() } = {}) {
  const db = ensureImageAssetSchema(inventoryOrDb)
  if (!Array.isArray(tires)) throw new TypeError('Image reconciliation requires an array of tires')
  const rows = tires.map(stableRow)
  const supplierIds = new Set(db.prepare('SELECT id FROM supplier').all().map(row => row.id))
  for (const row of rows) {
    if (!supplierIds.has(row.supplierId)) throw new Error(`Supplier tire ${row.supplierId} is not in inventory`)
  }

  const upsert = db.prepare(`
    INSERT INTO image_assets (
      supplier_id, supplier_sku, product_url, identity_key, remote_image_url,
      remote_image_present, source_metadata_present, provenance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(supplier_id, identity_key) DO UPDATE SET
      supplier_sku=excluded.supplier_sku,
      product_url=excluded.product_url,
      remote_image_url=excluded.remote_image_url,
      remote_image_present=excluded.remote_image_present,
      source_metadata_present=excluded.source_metadata_present,
      updated_at=excluded.updated_at
  `)
  const write = () => {
    for (const row of rows) {
      for (const remoteImageUrl of row.remoteUrls) {
        const identityKey = remoteImageUrl ?? '__no-remote-image__'
        upsert.run(
          row.supplierId, row.supplierSku, row.productUrl, identityKey, remoteImageUrl,
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
      const row = db.prepare(`SELECT * FROM image_assets
        WHERE sha256=? AND storage_key IS NOT NULL AND storage_url IS NOT NULL
        ORDER BY usage_status='approved' DESC, id LIMIT 1`).get(sha256)
      return row ? candidateFromRow(row) : null
    },
    recordStored: (id, asset) => {
      db.prepare(`UPDATE image_assets SET
        storage_key=?, storage_url=?, sha256=?, bytes=?, width=?, height=?, format=?,
        fetched_at=?, stored_at=?, provenance=?, usage_status=?, failure_state=NULL,
        failure_message=NULL, updated_at=? WHERE id=?`).run(
        asset.storageKey, asset.storageUrl, asset.sha256, asset.bytes, asset.width, asset.height,
        asset.format, asset.fetchedAt ?? null, asset.storedAt ?? null, asset.provenance ?? IMAGE_ASSET_PROVENANCE,
        asset.usageStatus ?? 'candidate', asset.storedAt ?? now(), id,
      )
    },
    recordFailure: (id, failure) => {
      db.prepare(`UPDATE image_assets SET failure_state=?, failure_message=?, updated_at=? WHERE id=?`)
        .run(failure.state, failure.message ?? null, failure.at ?? now(), id)
    },
  }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
