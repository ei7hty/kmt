import path from 'node:path'
import { sha256Bytes, imageStorageKey } from './image-assets.mjs'
import { createPrivateImageStorage } from './image-staging.mjs'
import { createIsolatedImageDecoder } from './image-decoder.mjs'
import { IMAGE_DIGEST, parseImagePacket, supplierImageRevision } from './image-manifest.mjs'

const failure = (status = 409) => Object.assign(new Error('Image packet unavailable, stale or invalid'), { status })
export function ensureImagePublicationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_packets (
      digest TEXT PRIMARY KEY, manifest BLOB NOT NULL, profile BLOB NOT NULL,
      snapshot BLOB NOT NULL, imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_packet_assets (
      packet TEXT NOT NULL REFERENCES image_packets(digest), ordinal INTEGER NOT NULL,
      supplier_id TEXT NOT NULL REFERENCES supplier(id), source_hash TEXT NOT NULL,
      metadata TEXT NOT NULL, decoder TEXT NOT NULL,
      PRIMARY KEY(packet, ordinal), UNIQUE(packet, supplier_id)
    );
    CREATE TABLE IF NOT EXISTS image_decisions (
      seq INTEGER PRIMARY KEY, packet TEXT NOT NULL REFERENCES image_packets(digest),
      version INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('imported','approved','revoked')),
      actor TEXT NOT NULL, at TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      UNIQUE(packet, version)
    );
    CREATE TABLE IF NOT EXISTS image_publications (
      supplier_id TEXT PRIMARY KEY REFERENCES supplier(id), packet TEXT NOT NULL REFERENCES image_packets(digest),
      ordinal INTEGER NOT NULL, FOREIGN KEY(packet, ordinal) REFERENCES image_packet_assets(packet, ordinal)
    );
  `)
  for (const table of ['image_packets', 'image_packet_assets', 'image_decisions']) {
    for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable image provenance'); END;`)
  }
}

export function imageDirectoryForDatabase(filename) {
  return path.join(path.dirname(path.resolve(filename)), 'catalog-images-private')
}

function appendDecision(db, digest, action, actor) {
  if (typeof actor !== 'string' || !actor.length || actor.length > 320) throw failure()
  const previous = db.prepare('SELECT seq, hash FROM image_decisions ORDER BY seq DESC LIMIT 1').get()
  const version = db.prepare('SELECT count(*) AS n FROM image_decisions WHERE packet=?').get(digest).n + 1
  const values = [(previous?.seq ?? 0) + 1, digest, version, action, actor, new Date().toISOString(), previous?.hash ?? '0'.repeat(64)]
  const hash = sha256Bytes(JSON.stringify(values))
  db.prepare('INSERT INTO image_decisions VALUES (?,?,?,?,?,?,?,?)').run(...values, hash)
}

export function verifyImageDecisions(db) {
  let previous = '0'.repeat(64), seq = 0
  for (const row of db.prepare('SELECT * FROM image_decisions ORDER BY seq').all()) {
    const values = [row.seq, row.packet, row.version, row.action, row.actor, row.at, row.previous_hash]
    if (row.seq !== ++seq || row.previous_hash !== previous || sha256Bytes(JSON.stringify(values)) !== row.hash) throw failure()
    previous = row.hash
  }
  return { count: seq, hash: previous }
}

// Inventory uses this projection without importing local paths, URLs or SKU
// fields into the customer object. Five candidates make the hash work bounded.
export function approvedImageUrls(db) {
  const result = new Map()
  const rows = db.prepare(`SELECT p.supplier_id, a.source_hash, a.metadata, s.payload, s.active
    FROM image_publications p JOIN image_packet_assets a ON a.packet=p.packet AND a.ordinal=p.ordinal
    JOIN supplier s ON s.id=p.supplier_id
    JOIN image_decisions d ON d.packet=p.packet AND d.action='approved'
    WHERE NOT EXISTS (SELECT 1 FROM image_decisions r WHERE r.packet=p.packet AND r.action='revoked')`).all()
  for (const row of rows) {
    if (!row.active || supplierImageRevision(JSON.parse(row.payload)) !== row.source_hash) continue
    const m = JSON.parse(row.metadata)
    if (IMAGE_DIGEST.test(m.sha256) && ['jpeg', 'png'].includes(m.format)) result.set(row.supplier_id, `/api/images/${m.sha256}.${m.format}`)
  }
  return result
}

export class ImagePublication {
  constructor(inventory, { directory, python = process.env.KMT_IMAGE_DECODER_PYTHON } = {}) {
    this.inventory = inventory
    this.db = inventory.db
    ensureImagePublicationSchema(this.db)
    this.storage = createPrivateImageStorage({ directory })
    this.python = python
  }

  review(digest) {
    if (!IMAGE_DIGEST.test(digest)) throw failure(404)
    const packet = this.db.prepare('SELECT * FROM image_packets WHERE digest=?').get(digest)
    if (!packet) throw failure(404)
    // Rehash the stored raw documents on every review/approval.
    const parsed = parseImagePacket({ manifestBytes: packet.manifest, profileBytes: packet.profile, snapshotBytes: packet.snapshot, expectedManifestDigest: digest })
    const decision = this.db.prepare('SELECT version, action, actor, at FROM image_decisions WHERE packet=? ORDER BY version DESC LIMIT 1').get(digest)
    return { digest, profileDigest: parsed.profile.digest, snapshotDigest: parsed.snapshot.digest,
      candidates: parsed.candidates, assets: parsed.assets, ...decision }
  }

  list() {
    return this.db.prepare('SELECT digest FROM image_packets ORDER BY imported_at DESC LIMIT 100').all().map(row => this.review(row.digest))
  }

  async ingest(input, files) {
    const packet = parseImagePacket(input), digest = packet.manifest.digest
    if (this.db.prepare('SELECT 1 FROM image_packets WHERE digest=?').get(digest)) return this.review(digest)
    if (!(files instanceof Map) || files.size !== new Set(packet.assets.map(a => `${a.sha256}.${a.format}`)).size) throw failure()
    const decode = createIsolatedImageDecoder({ python: this.python })
    const prepared = packet.candidates.map((candidate, i) => {
      const asset = packet.assets[i]
      const source = this.db.prepare('SELECT payload, active FROM supplier WHERE id=?').get(candidate.supplierId)
      if (!source?.active) throw failure()
      const tire = JSON.parse(source.payload)
      if (tire.source?.sku !== candidate.supplierSku || supplierImageRevision(tire) !== candidate.revision ||
          tire.size !== packet.snapshot.value.provenance.observations[i].size ||
          tire.source?.url !== packet.snapshot.value.provenance.observations[i].listingUrl) throw failure()
      const inputBytes = files.get(`${asset.sha256}.${asset.format}`)
      if (!(inputBytes instanceof Uint8Array) || !inputBytes.length || inputBytes.length > packet.profile.policy.maxBytes) throw failure()
      const bytes = Buffer.from(inputBytes)
      if (sha256Bytes(bytes) !== asset.sha256) throw failure()
      return { candidate, asset, bytes }
    })
    for (const item of prepared) {
      item.decoded = await decode(item.bytes)
      if (item.decoded.format !== item.asset.format || item.decoded.width > 10000 || item.decoded.height > 10000) throw failure()
    }
    const records = []
    for (const { candidate, asset, bytes, decoded } of prepared) {
      const metadata = await this.storage.put({ ...asset, bytes, storageKey: imageStorageKey(asset.sha256, asset.format),
        width: decoded.width, height: decoded.height, contentType: `image/${asset.format}`, ifAbsent: true })
      records.push({ supplierId: candidate.supplierId, sourceHash: candidate.revision, metadata, decoded })
    }
    // Files publish before a single all-five DB commit. A failure may leave
    // unreferenced private objects; it cannot expose a partial packet.
    this.inventory.transaction(() => {
      for (const row of records) {
        const source = this.db.prepare('SELECT payload, active FROM supplier WHERE id=?').get(row.supplierId)
        if (!source?.active || supplierImageRevision(JSON.parse(source.payload)) !== row.sourceHash) throw failure()
      }
      this.db.prepare('INSERT INTO image_packets VALUES (?,?,?,?,?)').run(digest, packet.manifest.bytes, packet.profileDocument.bytes, packet.snapshot.bytes, new Date().toISOString())
      const insert = this.db.prepare('INSERT INTO image_packet_assets VALUES (?,?,?,?,?,?)')
      records.forEach((r, i) => insert.run(digest, i, r.supplierId, r.sourceHash, JSON.stringify(r.metadata), JSON.stringify(r.decoded)))
      appendDecision(this.db, digest, 'imported', 'operator:local-import')
    })
    return this.review(digest)
  }

  decide(digest, { action, expectedVersion }, actor) {
    if (!['approved', 'revoked'].includes(action) || !Number.isSafeInteger(expectedVersion)) throw failure(400)
    return this.inventory.transaction(() => {
      verifyImageDecisions(this.db)
      const current = this.review(digest)
      if (current.version !== expectedVersion || (action === 'approved' ? current.action !== 'imported' : current.action !== 'approved')) throw failure()
      const records = this.db.prepare('SELECT * FROM image_packet_assets WHERE packet=? ORDER BY ordinal').all(digest)
      if (!records.length) throw failure()
      if (action === 'approved') {
        const eligible = new Set(this.inventory.catalog().map(row => row.id))
        for (const row of records) {
          if (!eligible.has(row.supplier_id)) throw failure()
          const source = this.db.prepare('SELECT payload, active FROM supplier WHERE id=?').get(row.supplier_id)
          if (!source?.active || supplierImageRevision(JSON.parse(source.payload)) !== row.source_hash) throw failure()
          const metadata = JSON.parse(row.metadata)
          const expected = current.assets[row.ordinal], candidate = current.candidates[row.ordinal]
          if (expected?.supplierId !== row.supplier_id || candidate?.revision !== row.source_hash ||
              metadata.sha256 !== expected.sha256 || metadata.format !== expected.format) throw failure()
          this.storage.read({ ...metadata, byteLength: metadata.bytes })
          this.db.prepare('INSERT INTO image_publications VALUES (?,?,?) ON CONFLICT(supplier_id) DO UPDATE SET packet=excluded.packet, ordinal=excluded.ordinal').run(row.supplier_id, digest, row.ordinal)
        }
      } else this.db.prepare('DELETE FROM image_publications WHERE packet=?').run(digest)
      appendDecision(this.db, digest, action, actor)
      return this.review(digest)
    })
  }

  readPublic(url) {
    // Same customer eligibility as /api/catalog, including disabled offers.
    const tire = this.inventory.catalog().find(row => row.imageUrl === url)
    if (!tire) throw failure(404)
    const row = this.db.prepare(`SELECT a.metadata FROM image_publications p JOIN image_packet_assets a
      ON a.packet=p.packet AND a.ordinal=p.ordinal WHERE p.supplier_id=?`).get(tire.id)
    if (!row) throw failure(404)
    const metadata = JSON.parse(row.metadata)
    return this.storage.read({ ...metadata, byteLength: metadata.bytes })
  }
}
