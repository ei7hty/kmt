import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Inventory } from './inventory.mjs'
import { parseProductPage } from '../scripts/giga-tires.mjs'
import { enrichRows } from '../scripts/scrape-tires.mjs'

const SIZE = '215/60R16'
const URL = 'https://www.giga-tires.com/tires/example/roadmaster/tirecode/SKU123'
const fixture = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fixtures', 'giga-product.html'), 'utf8')

test('product fixture yields durable details and preserves unknown structured source data', () => {
  const row = parseProductPage(fixture, { url: URL, fetchedAt: '2026-09-07T12:00:00.000Z' })
  assert.equal(row.id, 'giga-sku123')
  assert.equal(row.size, SIZE)
  assert.equal(row.price, 82.49)
  assert.equal(row.brand, 'Example')
  assert.equal(row.model, 'RoadMaster Touring')
  assert.deepEqual([row.loadIndex, row.speedRating, row.sidewall, row.utqg, row.warranty], ['95', 'H', 'BSW', '600 A A', '65000 miles'])
  assert.equal(row.runFlat, false, 'an explicit false survives instead of collapsing into absent')
  assert.equal(row.imageUrls.length, 2)
  assert.equal(row.source.productId, 'giga-product-123')
  assert.equal(row.source.fetchedAt, '2026-09-07T12:00:00.000Z')
  assert.equal(row.source.raw.additionalProperty.at(-1).value, 'keep-me')
})

test('an absent run-flat field stays absent rather than becoming false', () => {
  const html = fixture.replace('{ "@type": "PropertyValue", "name": "Run Flat", "value": "No" },', '')
  const row = parseProductPage(html, { url: URL })
  assert.equal(Object.hasOwn(row, 'runFlat'), false)
})

test('labels inside malformed script end tags cannot masquerade as product specs', () => {
  for (const closing of ['</script >', '</script\t\n bar>']) {
    const html = `<script>document.write("Run Flat: Yes")${closing}<h1>Plain product</h1>`
    const row = parseProductPage(html, { url: URL, fallback: {
      id: 'giga-sku123', name: 'Plain product', size: SIZE, price: 80, inStock: true,
      category: 'all-season', description: 'Plain', source: { sku: 'SKU123', url: URL },
    } })
    assert.equal(Object.hasOwn(row, 'runFlat'), false)
  }
})

test('product enrichment obeys its batch limit and concurrency bound', async () => {
  const urls = Array.from({ length: 6 }, (_, index) => URL.replace('SKU123', `SKU${index}`))
  let active = 0, peak = 0
  const fetcher = async url => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    const sku = url.split('/').at(-1)
    return { url, html: fixture.replaceAll('SKU123', sku).replaceAll('sku123', sku.toLowerCase()) }
  }
  const result = await enrichRows([], urls, { enrichLimit: 4, concurrency: 2, productDelay: 0 }, fetcher)
  assert.equal(result.attempted, 4)
  assert.equal(result.rows.length, 4)
  assert.ok(peak <= 2)
})

test('an existing SQLite inventory imports and round-trips enrichment without a table rebuild', t => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-enrichment-'))
  const filename = path.join(folder, 'inventory.sqlite')
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const seed = new DatabaseSync(filename)
  seed.exec(`CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX supplier_size ON supplier(size);
    CREATE TABLE offers (id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER, enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, CHECK(price_cents IS NULL OR price_cents > 0));
    CREATE TABLE coverage (size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL, error TEXT, attempted_at TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  seed.prepare('INSERT INTO supplier VALUES (?, ?, ?, ?, 1)').run('giga-sku123', SIZE, JSON.stringify({
    id: 'giga-sku123', name: 'Legacy row', size: SIZE, price: 80, inStock: true, category: 'all-season',
    source: { sku: 'SKU123', url: URL },
  }), '2026-09-01T00:00:00.000Z')
  const supplierSql = seed.prepare("SELECT sql FROM sqlite_master WHERE name='supplier'").get().sql
  seed.close()

  let inventory = new Inventory(filename, [SIZE])
  const enriched = parseProductPage(fixture, { url: URL, fetchedAt: '2026-09-07T12:00:00.000Z' })
  inventory.applySnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-07T12:00:00.000Z', sizes: [SIZE], tires: [enriched] })
  inventory.close()
  inventory = new Inventory(filename, [SIZE])
  const row = inventory.list().items[0]
  assert.equal(row.runFlat, false)
  assert.equal(row.source.raw.additionalProperty.at(-1).value, 'keep-me')
  assert.equal(inventory.db.prepare("SELECT sql FROM sqlite_master WHERE name='supplier'").get().sql, supplierSql)
  inventory.close()
})
