import { DatabaseSync } from 'node:sqlite'

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

const now = () => new Date().toISOString()

export function validateTire(tire, size) {
  if (!tire || typeof tire.id !== 'string' || !tire.id.startsWith('giga-') ||
      typeof tire.name !== 'string' || !tire.name.trim() || tire.size !== size ||
      !Number.isFinite(tire.price) || tire.price <= 0 || tire.price > 100000 ||
      typeof tire.inStock !== 'boolean' || typeof tire.category !== 'string' ||
      typeof tire.source?.sku !== 'string') {
    throw new InputError(`Invalid supplier row for ${size}; previous inventory kept.`)
  }
  if (tire.source.stock !== null && tire.source.stock !== undefined &&
      (!Number.isInteger(tire.source.stock) || tire.source.stock < 0)) {
    throw new InputError(`Invalid stock count for ${tire.id}`)
  }
  return tire
}

export class Inventory {
  constructor(filename, supportedSizes) {
    this.sizes = [...new Set(supportedSizes)].sort()
    this.db = new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS supplier (
        id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL,
        last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS supplier_size ON supplier(size);
      CREATE TABLE IF NOT EXISTS offers (
        id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        CHECK(price_cents IS NULL OR price_cents > 0)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL,
        error TEXT, attempted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)
    return row ? JSON.parse(row.value) : null
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  importSnapshot(snapshot) {
    if (this.getMeta('seeded')) return
    if (snapshot.source !== 'giga-tires.com' || !Array.isArray(snapshot.tires) ||
        !Number.isFinite(Date.parse(snapshot.scrapedAt))) throw new InputError('Invalid supplier snapshot')
    const sizes = [...new Set(snapshot.tires.map(tire => tire.size))]
    for (const tire of snapshot.tires) validateTire(tire, tire.size)
    if (sizes.some(size => !this.sizes.includes(size))) throw new InputError('Snapshot contains unsupported sizes')
    this.transaction(() => {
      for (const size of sizes) this.writeSize(size, snapshot.tires.filter(t => t.size === size), snapshot.scrapedAt, false)
      this.setMeta('seeded', { at: now(), snapshotAt: snapshot.scrapedAt })
    })
  }

  // Only a complete, validated size refresh may retire missing supplier rows.
  writeSize(size, tires, timestamp, complete) {
    if (complete) this.db.prepare('UPDATE supplier SET active=0 WHERE size=?').run(size)
    const insert = this.db.prepare(`INSERT INTO supplier VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, last_seen=excluded.last_seen, active=1`)
    for (const tire of tires) {
      const old = this.db.prepare('SELECT size FROM supplier WHERE id=?').get(tire.id)
      if (old && old.size !== size) throw new InputError('Supplier SKU changed size; refresh rejected')
      insert.run(tire.id, size, JSON.stringify(tire), timestamp)
    }
    this.db.prepare(`INSERT INTO coverage VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(size) DO UPDATE SET last_success=excluded.last_success,
        completeness=excluded.completeness, error=NULL, attempted_at=excluded.attempted_at`)
      .run(size, timestamp, complete ? 'full' : 'snapshot', timestamp)
  }

  refreshSize(size, tires) {
    if (!this.sizes.includes(size)) throw new InputError('Unsupported tire size')
    if (!tires.length) throw new InputError('No priced tires returned; previous inventory kept')
    tires.forEach(tire => validateTire(tire, size))
    if (new Set(tires.map(t => t.id)).size !== tires.length) throw new InputError('Duplicate supplier IDs')
    this.transaction(() => this.writeSize(size, tires, now(), true))
  }

  recordFailure(size, error) {
    this.db.prepare(`INSERT INTO coverage VALUES (?, NULL, 'none', ?, ?)
      ON CONFLICT(size) DO UPDATE SET error=excluded.error, attempted_at=excluded.attempted_at`)
      .run(size, error, now())
  }

  list({ search = '', size = '', filter = 'all', page = 1 } = {}) {
    const conditions = [], args = []
    if (size) { conditions.push('s.size=?'); args.push(size) }
    if (search) {
      conditions.push("(lower(json_extract(s.payload,'$.name')) LIKE ? OR lower(s.id) LIKE ?)")
      args.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`)
    }
    if (filter === 'offered') conditions.push('o.enabled=1')
    if (filter === 'unselected') conditions.push('COALESCE(o.enabled,0)=0')
    if (filter === 'available') conditions.push("s.active=1 AND json_extract(s.payload,'$.inStock')=1 AND json_extract(s.payload,'$.source.stock')>0")
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const from = `FROM supplier s LEFT JOIN offers o ON o.id=s.id ${where}`
    const total = this.db.prepare(`SELECT count(*) AS n ${from}`).get(...args).n
    const pageSize = 24
    const currentPage = Math.max(1, Math.min(Math.floor(Number(page)) || 1, Math.max(1, Math.ceil(total / pageSize))))
    const rows = this.db.prepare(`SELECT s.*, o.price_cents, o.enabled, o.notes, o.version ${from}
      ORDER BY s.size, json_extract(s.payload,'$.name'), s.id LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (currentPage - 1) * pageSize)
    return { items: rows.map(row => ({
      ...JSON.parse(row.payload), lastSeen: row.last_seen, supplierActive: !!row.active,
      offer: { priceCents: row.price_cents ?? null, enabled: !!row.enabled,
        notes: row.notes ?? '', version: row.version ?? 0 },
    })), total, page: currentPage, pageSize }
  }

  saveOffer(id, input) {
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.version) || input.version < 0 ||
        typeof input.notes !== 'string' || input.notes.length > 2000 ||
        (input.priceCents !== null && (!Number.isInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 10000000)) ||
        (input.enabled && input.priceCents === null)) {
      throw new InputError('Enter a positive KMT price before offering a tire; use at most two decimal places.')
    }
    return this.transaction(() => {
      if (!this.db.prepare('SELECT id FROM supplier WHERE id=?').get(id)) throw new InputError('Tire not found', 404)
      const current = this.db.prepare('SELECT version FROM offers WHERE id=?').get(id)
      if ((current?.version ?? 0) !== input.version) throw new InputError('This offer changed in another window. Reload inventory before saving.', 409)
      this.db.prepare(`INSERT INTO offers VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET price_cents=excluded.price_cents, enabled=excluded.enabled,
          notes=excluded.notes, version=excluded.version, updated_at=excluded.updated_at`)
        .run(id, input.priceCents, Number(input.enabled), input.notes, input.version + 1, now())
      return { ...input, version: input.version + 1 }
    })
  }

  summary() {
    const coverage = this.db.prepare('SELECT * FROM coverage ORDER BY size').all()
    return {
      sizes: this.sizes, coverage,
      supplierCount: this.db.prepare('SELECT count(*) AS n FROM supplier').get().n,
      offeredCount: this.db.prepare('SELECT count(*) AS n FROM offers WHERE enabled=1').get().n,
      fullSizeCount: coverage.filter(c => c.completeness === 'full').length,
      importedSizeCount: coverage.filter(c => c.completeness === 'snapshot').length,
      job: this.getMeta('job'),
    }
  }

  close() { this.db.close() }
}
