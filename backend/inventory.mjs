import { DatabaseSync } from 'node:sqlite'

// The frontend's markup module owns the default rate and the shape of the
// rule. Importing it rather than restating 1.35 here means the two cannot
// drift into disagreeing about what an unconfigured catalog costs.
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'

const DEFAULT_MARKUP_RATE = DEFAULT_MARKUP_SETTINGS.rate

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

  /**
   * The markup rule, which proposes a price for tires the owner has not priced.
   *
   * It never overrides one. An offer's price_cents still wins wherever it is
   * set; this only fills the gap so a tire nobody has reached still has a
   * number, because there are hundreds of supported sizes (910 as of the
   * fitment-range change) and pricing every tire by hand is not something
   * anyone finishes.
   *
   * `isPlaceholder` stays true until someone saves a rate, so the customer
   * catalog can mark those prices provisional instead of presenting a default
   * as a decision that was made.
   */
  getMarkup() {
    return this.getMeta('markup') ?? { rate: DEFAULT_MARKUP_RATE, isPlaceholder: true, updatedAt: null }
  }

  saveMarkup(input) {
    // Below 1 would quote under what we pay the supplier. The upper bound is
    // not a pricing opinion, just a guard against a typo repricing everything.
    if (!input || !Number.isFinite(input.rate) || input.rate < 1 || input.rate > 10) {
      throw new InputError('Enter a markup between 1 and 10 times the supplier price.')
    }
    const markup = { rate: Math.round(input.rate * 10000) / 10000, isPlaceholder: false, updatedAt: now() }
    this.setMeta('markup', markup)
    return markup
  }

  /**
   * Check a snapshot in the shape scripts/scrape-tires.mjs writes, and group
   * its rows by size. Throws before anything is written, so a bad row cannot
   * leave half a snapshot in the database.
   */
  validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== 'giga-tires.com' ||
        !Array.isArray(snapshot.tires) || !Number.isFinite(Date.parse(snapshot.scrapedAt))) {
      throw new InputError('Invalid supplier snapshot')
    }
    // Per-size coverage is what the scraper writes since it started recording
    // what it read; older files have none and are treated as partial.
    if (snapshot.coverage !== undefined &&
        (typeof snapshot.coverage !== 'object' || snapshot.coverage === null || Array.isArray(snapshot.coverage))) {
      throw new InputError('Invalid supplier snapshot')
    }
    const bySize = new Map()
    for (const tire of snapshot.tires) {
      validateTire(tire, tire?.size)
      if (!bySize.has(tire.size)) bySize.set(tire.size, [])
      bySize.get(tire.size).push(tire)
    }
    for (const size of bySize.keys()) {
      if (!this.sizes.includes(size)) throw new InputError('Snapshot contains unsupported sizes')
    }
    if (new Set(snapshot.tires.map(t => t.id)).size !== snapshot.tires.length) throw new InputError('Duplicate supplier IDs')
    return bySize
  }

  importSnapshot(snapshot) {
    if (this.getMeta('seeded')) return
    const bySize = this.validateSnapshot(snapshot)
    this.transaction(() => {
      for (const [size, tires] of bySize) this.writeSize(size, tires, snapshot.scrapedAt, false)
      this.setMeta('seeded', { at: now(), snapshotAt: snapshot.scrapedAt })
    })
  }

  /**
   * Apply a snapshot to a database that already has one.
   *
   * importSnapshot seeds an empty database once and then steps aside, which
   * is right for the tracked file but leaves no way to get a scrape run on
   * someone's own machine into a server that is already up. This is that
   * way. It writes through the same writeSize a refresh uses, so owner
   * offers and prices are untouched and a row is never deleted.
   *
   * By default a size is treated as a *partial* view -- the scraper keeps the
   * cheapest few per size -- so rows the snapshot does not mention stay
   * active. `complete` says the snapshot is the supplier's whole listing for
   * each size it covers, and retires the rest as a refresh would. A dry run
   * reports what would change and writes nothing.
   */
  applySnapshot(snapshot, { complete = false, dryRun = false } = {}) {
    const bySize = this.validateSnapshot(snapshot)
    if (!bySize.size) throw new InputError('The snapshot holds no tires; nothing to import')
    // Retiring what a size does not list is only right when the scraper read
    // the whole size: no limit, every page. The file says whether it did. The
    // CLI refuses this first with a fuller message; this is the door itself.
    if (complete) {
      for (const size of bySize.keys()) {
        if (snapshot.coverage?.[size]?.complete !== true) {
          throw new InputError(`${size} was not scraped completely (every page, no limit), so its missing tires cannot be retired. Import it without complete, or scrape it again with --limit 0.`)
        }
      }
    }

    const report = []
    for (const [size, tires] of bySize) {
      const existing = new Map(this.db.prepare('SELECT id, payload, active FROM supplier WHERE size=?').all(size)
        .map(row => [row.id, row]))
      const counts = { size, tires: tires.length, added: 0, changed: 0, unchanged: 0, retired: 0 }
      for (const tire of tires) {
        const old = existing.get(tire.id)
        if (!old) counts.added++
        else if (!old.active || old.payload !== JSON.stringify(tire)) counts.changed++
        else counts.unchanged++
      }
      if (complete) {
        const incoming = new Set(tires.map(t => t.id))
        counts.retired = [...existing.values()].filter(row => row.active && !incoming.has(row.id)).length
      }
      report.push(counts)
    }

    if (!dryRun) {
      // One transaction for the whole file: a snapshot either lands or it does
      // not. Validation has already run, so the only failure left is a SKU
      // that changed size, and half a file is not a useful answer to that.
      this.transaction(() => {
        for (const [size, tires] of bySize) this.writeSize(size, tires, snapshot.scrapedAt, complete)
      })
      const at = now()
      this.setMeta('job', {
        id: `snapshot-${at}`, status: 'completed', sizes: [...bySize.keys()], completed: bySize.size, failed: [],
        tiresRead: snapshot.tires.length, pagesRead: 0, currentSize: null, startedAt: at, finishedAt: at,
        message: `Imported ${snapshot.tires.length} tires across ${bySize.size} size${bySize.size === 1 ? '' : 's'} from a snapshot scraped ${snapshot.scrapedAt}.`,
      })
    }

    return { dryRun, complete, scrapedAt: snapshot.scrapedAt, tires: snapshot.tires.length, sizes: report }
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

  /**
   * What a customer may be shown: every tire that is offered and has a price.
   *
   * The same rows the owner curates, reduced to what a quote needs. Unpaginated
   * on purpose -- list() pages because a person scrolls a screen, and this
   * answers a program that needs the whole catalog to price a request.
   *
   * The mapping deliberately mirrors scrapedTiresFor() in src/data/catalog.js,
   * field for field, because the customer flow already runs on rows of that
   * shape and a second, subtly different shape is the kind of thing that only
   * shows up as a wrong price. Anything the supplier told us -- SKU, list
   * price, stock count, the URL we scraped -- stops here: the customer sees
   * KMT's price and nothing behind it.
   *
   * A tire the supplier has stopped listing is kept and marked out of stock
   * rather than dropped. Dropping it would quietly shrink the catalog under a
   * customer mid-request; leaving it in stock would sell something nobody can
   * source. Out of stock is the honest answer, and the pricing rules already
   * route an out-of-stock choice to the owner instead of quoting it outright.
   */
  catalog() {
    const settings = this.getMarkup()
    const rows = this.db.prepare(`SELECT s.payload, s.active, o.id AS offer_id, o.price_cents, o.enabled
      FROM supplier s LEFT JOIN offers o ON o.id=s.id
      ORDER BY s.size, json_extract(s.payload,'$.name'), s.id`).all()

    const tires = []
    for (const row of rows) {
      const tire = JSON.parse(row.payload)
      // A missing offers row is not the same as a disabled one: a tire the
      // owner has never touched is still for sale at the marked-up price,
      // while one he switched off is a deliberate no.
      const offer = row.offer_id === null || row.offer_id === undefined
        ? undefined
        : { priceCents: row.price_cents ?? null, enabled: !!row.enabled }

      const { price, offered } = quotedPrice({
        supplierPrice: tire.price, offer, tire, settings,
      })
      if (price === null || !offered) continue

      tires.push({
        id: tire.id,
        name: tire.name,
        size: tire.size,
        price,
        // Delisted at the supplier is out of stock here, whatever the last
        // snapshot said about it, and whether or not the owner priced it.
        inStock: !!row.active && tire.inStock,
        category: tire.category,
        description: tire.description,
      })
    }
    return tires
  }

  /**
   * The sizes a bulk refresh may cover: those the supplier has already been
   * asked about, meaning they hold supplier rows or a coverage row (full,
   * snapshot, or a recorded failure). Everything else in `sizes` is a size the
   * customer selector can build, and there are 910 of those. Walking all of
   * them from the hosted machine is 910 page loads at a 1.5-second pause from
   * a datacenter address the supplier's firewall already dislikes, so the full
   * walk is a deliberate local action -- `npm run scrape-tires -- --from-catalog`
   * on a home connection, then `npm run import-tires` -- and the owner screen's
   * "Refresh all" stays inside this subset. Any single size can still be
   * refreshed on its own from the size filter; see Refresher.start.
   */
  refreshableSizes() {
    const known = new Set(this.db.prepare('SELECT size FROM supplier UNION SELECT size FROM coverage').all().map(row => row.size))
    return this.sizes.filter(size => known.has(size))
  }

  summary() {
    const coverage = this.db.prepare('SELECT * FROM coverage ORDER BY size').all()
    return {
      sizes: this.sizes, coverage,
      refreshableSizes: this.refreshableSizes(),
      supplierCount: this.db.prepare('SELECT count(*) AS n FROM supplier').get().n,
      offeredCount: this.db.prepare('SELECT count(*) AS n FROM offers WHERE enabled=1').get().n,
      fullSizeCount: coverage.filter(c => c.completeness === 'full').length,
      importedSizeCount: coverage.filter(c => c.completeness === 'snapshot').length,
      job: this.getMeta('job'),
      // Carried on the inventory response so the screen can show the rule and
      // each tire's suggested price without a second round trip.
      markup: this.getMarkup(),
    }
  }

  close() { this.db.close() }
}
