import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { DESCRIPTION_OVERRIDE_LIMIT, Inventory, OVERRIDE_CATEGORIES } from './inventory.mjs'
// The shop's own season facet, and the customer-boundary contract. Both are
// imported rather than restated: the tests below exist to prove the owner's
// corrections agree with them, which a local copy of either could not show.
import { SEASON_LABELS } from '../src/tire-filters.js'
import { catalogRowProblem } from '../.forge/audit-ui.mjs'
import { Refresher } from './refresh.mjs'
import { createApi, createCatalogApi, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, createImportToken, createSessionStore, isMonitorAuthorized, memorySessionStore, MINTED_SESSION_ACTOR, mintSession, PASSWORD_SESSION_ACTOR, readAuthConfig, readMonitorConfig, readSessionSigningConfig, SESSION_COOKIE_NAME, verifyImportToken } from './auth.mjs'
import { LoginThrottle } from './limits.mjs'
import { SHARED_PASSWORD_ACTOR } from './quotes.mjs'
import { PageImporter } from './import.mjs'
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'
// The quote engine, imported because `catalog()` is its input too and a season
// correction therefore reaches it -- see the review-gate test at the bottom.
import { calculateDraftQuote } from '../src/pricing.js'
// The owner grid's own helper, imported rather than reimplemented: the defect
// these tests cover lives in the seam between what list() returns and what the
// screen sends back, so a test that rebuilt the screen's half by hand would
// pass against a screen that still had the bug.
import { sellingEnabled } from '../src/owner/inventory-grid.js'

const SIZE = '215/60R16'
const otherSize = '225/50R17'
const tire = (id = 'giga-a', overrides = {}) => ({ id, name: 'Test Touring', size: SIZE,
  price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' }, ...overrides })
/** A complete read of every size present, unless a test says otherwise. */
const fullRead = { limit: 0, pagesRead: 1, totalPages: 1, complete: true, scrapedAt: '2026-09-05T15:00:00Z' }
const snapshot = (tires, coverage) => ({
  source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE],
  coverage: coverage ?? Object.fromEntries([...new Set(tires.map(t => t.size))].map(size => [size, fullRead])),
  tires,
})

/** Minimal markup matching what parseListingPage looks for. */
const pageHtml = (tires, totalPages = 1) => tires.map(t => `
  <div class="plp-list__item-container">
    <a class="j-override-clipboard" href="/x/y/tirecode/1">${t.name} ${t.size} 95H BSW</a>
    <p class="p-regular-md">All Season</p>
    <a href="/tires/c/passenger">Passenger</a>
    <form data-product-code="${t.id.slice(5).toUpperCase()}"></form>
    <script>window.productPrices.initialData['${t.id.slice(5).toUpperCase()}'] = {
      quantity: '4', priceData: {"initialPricePerTire":${t.price},"stock":${t.source.stock},"strikeThroughPricePerTire":null,"totalCostPerTire":null,"lightningSavings":null} }
    </script>
  </div>`).join('') + (totalPages > 1 ? `<a href="?page=${totalPages}">${totalPages}</a>` : '')

function setup(t) {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([tire()]))
  return db
}
const offer = (extra = {}) => ({ priceCents: 8999, enabled: true, notes: 'Owner choice', version: 0, ...extra })
/** A tire whose URL carries a real brand slug -- brandTire() rather than tire(), since setup()'s fixture URL has no /<brand>-tires/ segment. */
const brandTire = (id, brand, overrides = {}) => tire(id, {
  source: { ...tire().source, url: `https://www.giga-tires.com/215-60-16/${brand}-tires/model/tirecode/${id}` },
  ...overrides,
})

test('snapshot import is partial and idempotent; no tires are automatically offered', t => {
  const db = setup(t)
  db.importSnapshot(snapshot([tire('giga-b')]))
  assert.equal(db.list().total, 1)
  assert.equal(db.summary().offeredCount, 0)
  assert.equal(db.summary().fullSizeCount, 0)
  assert.equal(db.summary().importedSizeCount, 1)
})

test('refresh updates supplier data without overwriting owner price, choice, or notes', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  db.refreshSize(SIZE, [tire('giga-a', { price: 72, inStock: false, source: { ...tire().source, stock: 0 } }), tire('giga-b')])
  const row = db.list().items.find(row => row.id === 'giga-a')
  assert.equal(row.price, 72)
  assert.equal(row.inStock, false)
  assert.deepEqual(row.offer, { ...offer(), shippingCents: null, categoryOverride: null, descriptionOverride: null, version: 1 })
  assert.equal(db.summary().fullSizeCount, 1)
})

test('missing supplier tires stay visible with saved owner choices and become inactive', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  db.refreshSize(SIZE, [tire('giga-b')])
  const row = db.list({ filter: 'offered' }).items[0]
  assert.equal(row.supplierActive, false)
  assert.equal(row.offer.enabled, true)
  assert.equal(db.list({ filter: 'available' }).items.length, 1)
})

test('malformed and empty refreshes preserve all previous rows', t => {
  const db = setup(t)
  assert.throws(() => db.refreshSize(SIZE, [tire('giga-b', { price: -1 })]))
  assert.throws(() => db.refreshSize(SIZE, []))
  assert.equal(db.list().items[0].id, 'giga-a')
  assert.equal(db.list().items[0].supplierActive, true)
})

test('invalid prices and stale owner saves are rejected', t => {
  const db = setup(t)
  for (const priceCents of [0, -1, 0.5, '89.99', 10000001]) {
    assert.throws(() => db.saveOffer('giga-a', offer({ priceCents })))
  }
  db.saveOffer('giga-a', offer())
  assert.throws(() => db.saveOffer('giga-a', offer({ priceCents: 10000 })), { status: 409 })
  assert.equal(db.list().items[0].offer.priceCents, 8999)
  db.saveOffer('giga-a', offer({ enabled: false, version: 1 }))
  assert.equal(db.summary().offeredCount, 0)
})

test('database survives close/reopen without reseeding over saved offers', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-owner-test-'))
  const filename = path.join(folder, 'test.sqlite')
  let db
  try {
    db = new Inventory(filename, [SIZE])
    db.importSnapshot(snapshot([tire()]))
    db.saveOffer('giga-a', offer())
    db.close()
    db = new Inventory(filename, [SIZE])
    db.importSnapshot(snapshot([tire('giga-new')]))
    assert.equal(db.list().items[0].offer.priceCents, 8999)
    assert.equal(db.list().total, 1)
  } finally { db?.close(); rmSync(folder, { recursive: true, force: true }) }
})

// Small HTML fixtures exercise the actual shared Giga parser and pagination.
function html(sku, pages = 2) {
  return `<script>window.productPrices.initialData['${sku}'] = {priceData:{"totalCostPerTire":50,"stock":12}};</script>
    <div class="plp-list__item-container" data-product-code="${sku}">
    <a class="j-override-clipboard" href="/tires/${sku}">Test ${sku} 215/60R16 95H BSW</a>
    <p class="p-regular-md">All Season</p></div><a href="?page=${pages}">Last</a>`
}

test('refresh reads every supplier page and keeps all rows', async t => {
  const db = setup(t), calls = []
  let closed = false
  const refresh = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    fetchSizePage: async (size, page) => { calls.push([size, page]); return { html: html(`P${page}`, 3) } },
    close: async () => { closed = true },
  }) })
  refresh.start([SIZE])
  assert.throws(() => refresh.start([SIZE]), { status: 409 })
  await refresh.done
  assert.deepEqual(calls, [[SIZE, 1], [SIZE, 2], [SIZE, 3]])
  assert.equal(db.summary().job.tiresRead, 3)
  assert.equal(db.summary().job.status, 'completed')
  assert.equal(closed, true)
})

test('the refreshable subset is the sizes the supplier has been asked about, and the summary carries it', t => {
  const db = setup(t)
  // The snapshot covered SIZE only; otherSize is supported but untouched.
  assert.deepEqual(db.summary().sizes, [SIZE, otherSize])
  assert.deepEqual(db.summary().refreshableSizes, [SIZE])
  // A recorded failure is coverage too: the supplier was asked, and the owner
  // needs to be able to retry it from "Refresh all".
  db.recordFailure(otherSize, 'Blocked')
  assert.deepEqual(db.summary().refreshableSizes, [SIZE, otherSize])
})

test('a bulk refresh stays inside the refreshable subset; a single size may be anything supported', async t => {
  const db = setup(t)
  const refresh = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    // One row per size, with an id of its own: supplier ids are unique across sizes.
    fetchSizePage: async size => ({ html: html(`S${size.replace(/\D/g, '')}`, 1).replaceAll(SIZE, size) }), close: async () => {},
  }) })
  // otherSize has no supplier rows and no coverage, so a list that includes it is refused...
  assert.throws(() => refresh.start([SIZE, otherSize]), { status: 400, message: /Refresh all covers only sizes that already have supplier data/ })
  assert.throws(() => refresh.start([SIZE, otherSize]), { message: /225\/50R17 can be refreshed one at a time/ })
  assert.throws(() => refresh.start([SIZE, otherSize]), { message: /scrape-tires -- --from-catalog/ })
  assert.equal(db.summary().job, null, 'a refused refresh leaves no job behind')
  // ...while naming it on its own is the owner asking for that size from the filter.
  refresh.start([otherSize]); await refresh.done
  assert.equal(db.summary().job.status, 'completed', db.summary().job.message)
  assert.deepEqual(db.summary().refreshableSizes, [SIZE, otherSize], 'and once refreshed it joins the subset')
  // The whole subset is exactly what the owner screen sends for "Refresh all".
  refresh.start(db.summary().refreshableSizes); await refresh.done
  assert.equal(db.summary().job.status, 'completed')
  assert.equal(db.summary().job.sizes.length, 2)
})

test('the refresh endpoint refuses a bulk list outside the subset with a reason the owner can act on', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db, { pause: async () => {}, createFetcher: async () => ({ fetchSizePage: async () => ({ html: html('ONE', 1) }), close: async () => {} }) }))
  const server = createServer((req, res) => api(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/owner`
  const post = sizes => fetch(`${base}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sizes }) })
  const refused = await post([SIZE, otherSize])
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).error, /one at a time from the size filter/)
  const inventory = await (await fetch(`${base}/inventory`)).json()
  assert.deepEqual(inventory.summary.refreshableSizes, [SIZE], 'the screen reads the subset off the summary it already loads')
  assert.equal((await post([SIZE])).status, 202, 'and the subset itself is accepted')
})

test('a failed later page does not partially replace a size or continue challenging supplier', async t => {
  const db = setup(t), calls = []
  const refresh = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    fetchSizePage: async (size, page) => { calls.push([size, page]); if (page === 2) throw new Error('Blocked'); return { html: html('NEW') } }, close: async () => {},
  }) })
  // A two-size list is a bulk refresh, which stays inside the sizes the
  // supplier has been asked about; an earlier failed attempt counts.
  db.recordFailure(otherSize, 'Earlier attempt')
  refresh.start([SIZE, otherSize]); await refresh.done
  assert.equal(db.list().total, 1)
  assert.equal(db.list().items[0].supplierActive, true)
  assert.equal(db.summary().job.status, 'failed')
  assert.equal(db.summary().coverage[0].error, 'Blocked')
  assert.equal(calls.length, 2)
})

test('cancelling a refresh discards the incomplete size', async t => {
  const db = setup(t)
  let resolvePage
  const pending = new Promise(resolve => { resolvePage = resolve })
  const refresh = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    fetchSizePage: () => pending, close: async () => {},
  }) })
  refresh.start([SIZE]); await Promise.resolve()
  refresh.cancel(); resolvePage({ html: html('NEW') }); await refresh.done
  assert.equal(db.summary().job.status, 'cancelled')
  assert.equal(db.list().items[0].id, 'giga-a')
})

test('interrupted job becomes visible after server restart', t => {
  const db = setup(t)
  db.setMeta('job', { status: 'running', sizes: [SIZE] })
  new Refresher(db)
  assert.equal(db.summary().job.status, 'interrupted')
})

test('owner HTTP API persists offers, validates input, and refuses foreign origins', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer((req, res) => api(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/owner`
  const send = (value, origin) => fetch(`${base}/offers/giga-a`, { method: 'PUT', headers: {
    'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
  }, body: JSON.stringify(value) })
  assert.equal((await send(offer(), 'https://unrelated.example')).status, 403)
  assert.equal((await send(offer({ priceCents: -1 }))).status, 400)
  const saved = await send(offer({ priceCents: null, shippingCents: 2575 }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).shippingCents, 2575, 'the owner save response round-trips integer cents')
  assert.equal((await send(offer())).status, 409)
  const result = await (await fetch(`${base}/inventory?filter=offered`)).json()
  assert.equal(result.items[0].offer.priceCents, null)
  assert.equal(result.items[0].offer.shippingCents, 2575, 'a fresh owner load returns the individual override')
  assert.equal(result.summary.offeredCount, 1)
})

test('the bulk by-brand route is matched before the single-offer route, over real HTTP', async t => {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([
    brandTire('giga-a', 'hankook'),
    brandTire('giga-b', 'hankook', { size: otherSize }),
  ], { [SIZE]: fullRead, [otherSize]: fullRead }))
  const api = createApi(db, new Refresher(db))
  const server = createServer((req, res) => api(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/owner`
  const call = enabled => fetch(`${base}/offers/by-brand/hankook`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  })

  const response = await call(true)
  assert.equal(response.status, 200, 'not swallowed by the single-offer route reading "by-brand/hankook" as one id')
  assert.deepEqual(await response.json(), { brand: 'hankook', enabled: true, updated: 2, missingPriceCount: 2 })

  const result = await (await fetch(`${base}/inventory?filter=offered`)).json()
  assert.equal(result.total, 2)
  assert.deepEqual(result.summary.brands.find(b => b.brand === 'hankook'), { brand: 'hankook', label: 'Hankook', count: 2, enabledCount: 2, missingPriceCount: 2, sizeCount: 2 })

  assert.equal((await call(false)).status, 200)
  assert.equal((await (await fetch(`${base}/inventory?filter=offered`)).json()).total, 0)

  assert.equal((await fetch(`${base}/offers/by-brand/no-such-brand`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })).status, 404)
})

/** Three tires with known costs, so a margin is arithmetic rather than a guess. */
function priced(t) {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([
    tire('giga-a', { price: 50 }),
    tire('giga-b', { price: 100 }),
    tire('giga-c', { price: 20 }),
  ]))
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))   // margin 8999 - 5000 = 3999
  db.saveOffer('giga-b', offer({ priceCents: 12000 }))  // margin 12000 - 10000 = 2000
  return db                                             // giga-c has no offer at all: margin null
}

test('margin is computed across two different units, and sorts on that value rather than the raw columns', t => {
  const db = priced(t)
  const byId = Object.fromEntries(db.list().items.map(row => [row.id, row.marginCents]))
  assert.deepEqual(byId, { 'giga-a': 3999, 'giga-b': 2000, 'giga-c': null },
    'supplier cost is dollars and the owner price is cents: subtracting them as they come is wrong by 100x')

  const ascending = db.list({ sort: 'margin', dir: 'asc' }).items.map(row => row.id)
  assert.deepEqual(ascending, ['giga-b', 'giga-a', 'giga-c'],
    'thinnest real margin first -- and were the units not converted, giga-a would sort ahead of giga-b')

  const descending = db.list({ sort: 'margin', dir: 'desc' }).items.map(row => row.id)
  assert.deepEqual(descending, ['giga-a', 'giga-b', 'giga-c'],
    'the unpriced tire stays last when the direction reverses, rather than heading a list of margins')
})

test('an unknown sort falls back to the default order instead of erroring or reaching the query', t => {
  const db = priced(t)
  const fallback = db.list({ sort: 'margin; DROP TABLE offers--', dir: 'desc' })
  assert.deepEqual(fallback.items.map(row => row.id), db.list().items.map(row => row.id),
    'an unrecognised sort key is not interpolated and does not blank the screen')
  assert.equal(fallback.sort, null, 'the response says which sort actually ran, not which was asked for')
  assert.equal(db.list({ sort: 'constructor' }).sort, null, 'inherited object properties are not sort keys')
  assert.equal(db.list().total, 3, 'the offers table is still there')

  const applied = db.list({ sort: 'price', dir: 'desc' })
  assert.equal(applied.sort, 'price')
  assert.equal(applied.dir, 'desc', 'an applied sort is echoed so a header cannot show an arrow the server ignored')
})

test('pageSize is an allow-list, not a number the caller picks', t => {
  const db = priced(t)
  assert.equal(db.list().pageSize, 24, 'the default is unchanged for every existing caller')
  assert.equal(db.list({ pageSize: 100 }).pageSize, 100)
  assert.equal(db.list({ pageSize: 7 }).pageSize, 24, 'an off-list size falls back rather than being honoured')
  assert.equal(db.list({ pageSize: 100000 }).pageSize, 24, 'and a caller cannot ask for the whole table')
  assert.equal(db.list({ pageSize: 'lots' }).pageSize, 24)
})

test('a tied sort key is broken by id, so the two pages are a defined window rather than a scan order', t => {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  // Thirty tires, none offered, sorted by a column identical for every one of
  // them -- and INSERTED IN REVERSE, so storage order and id order disagree.
  // That disagreement is the whole test: with the tiebreak, page 1 is the 24
  // lowest ids whatever the rows' physical order; without it, the pages are
  // whatever the scan happens to hand back, which is what makes LIMIT/OFFSET
  // paging over ties unsafe. An assertion that merely counted the union would
  // pass either way -- one query plan is self-consistent even when it is
  // arbitrary -- so it would have been a test that cannot fail.
  const ids = Array.from({ length: 30 }, (unused, i) => 'giga-' + String(i).padStart(2, '0'))
  db.importSnapshot(snapshot([...ids].reverse().map(id => tire(id))))
  const query = { sort: 'enabled', dir: 'asc', pageSize: 24 }
  const first = db.list({ ...query, page: 1 }).items.map(row => row.id)
  const second = db.list({ ...query, page: 2 }).items.map(row => row.id)
  assert.deepEqual(first, ids.slice(0, 24), 'page 1 is the 24 lowest ids, not the 24 rows stored first')
  assert.deepEqual(second, ids.slice(24), 'and page 2 is the remainder, with nothing repeated or skipped')
})

test('a bulk offer save keeps the per-row version check and reports each row on its own', t => {
  const db = priced(t)
  const current = Object.fromEntries(db.list().items.map(row => [row.id, row.offer.version]))
  const { results } = db.saveOffers({ offers: [
    { id: 'giga-a', ...offer({ priceCents: 9500, version: current['giga-a'] }) },
    { id: 'giga-b', ...offer({ priceCents: 9500, version: current['giga-b'] - 1 }) },
    { id: 'giga-nope', ...offer({ priceCents: 9500, version: 0 }) },
    { id: 'giga-c', ...offer({ priceCents: -5, version: 0 }) },
  ] })

  assert.deepEqual(results.map(row => [row.id, row.ok, row.reason]), [
    ['giga-a', true, undefined],
    ['giga-b', false, 'version-conflict'],
    ['giga-nope', false, 'not-found'],
    ['giga-c', false, 'invalid'],
  ], 'a machine code per row, so a screen marks failures without matching on message text')
  assert.equal(results[0].version, current['giga-a'] + 1, 'the bumped version comes back so the grid patches in place')
  assert.ok(results[1].message.length, 'and a human message rides along for the owner')

  const saved = Object.fromEntries(db.list().items.map(row => [row.id, row.offer.priceCents]))
  assert.equal(saved['giga-a'], 9500, 'the row that succeeded stays saved even though three others failed')
  assert.equal(saved['giga-b'], 12000, 'the stale row is untouched rather than silently overwritten')
})

// The three refusals below reject the WHOLE request rather than answering per
// row, and each gets its own test on purpose: sharing one would mean deleting
// either guard reddens the same test, and neither could be shown to be carrying
// its own weight.
test('a failure that is neither bad input nor a stale version reports as failed, without leaking the error', t => {
  const db = priced(t)
  // Not a seam in shipped code: the instance property shadows the prototype
  // method for this test only. What is under test is the MAPPING -- everything
  // that is not an InputError has to land on `failed`, because `failed` is what
  // the grid renders as "this did not save and it was not your fault". Collapse
  // it into `invalid` and the screen tells the owner his input was bad when the
  // disk hiccuped, and he re-types a price that was never wrong.
  db.saveOffer = () => { throw new Error('disk on fire') }
  const { results } = db.saveOffers({ offers: [{ id: 'giga-a', ...offer({ version: 0 }) }] })

  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, 'failed', 'not invalid: nothing about the owner\'s input was wrong')
  assert.equal(results[0].message, 'This tire could not be saved.')
  assert.doesNotMatch(results[0].message, /disk on fire/, 'a raw error never reaches the owner\'s screen')
})

test('a bulk offer save is capped, so one request cannot walk the table', t => {
  const db = priced(t)
  const rows = count => Array.from({ length: count }, (unused, i) => ({ id: 'giga-' + i, ...offer({ version: 0 }) }))
  assert.throws(() => db.saveOffers({ offers: rows(201) }), /at most 200/)
  assert.equal(db.saveOffers({ offers: rows(200) }).results.length, 200, 'the cap itself is allowed')
})

test('a bulk offer save refuses a duplicate tire rather than reporting a mystery conflict', t => {
  const db = priced(t)
  assert.throws(() => db.saveOffers({ offers: [
    { id: 'giga-a', ...offer({ version: 0 }) }, { id: 'giga-a', ...offer({ version: 1 }) },
  ] }), /each tire once/, 'the second write would fail the version the first just bumped')
})

test('a bulk offer save refuses an empty batch', t => {
  const db = priced(t)
  assert.throws(() => db.saveOffers({ offers: [] }), /at least one offer/)
  assert.throws(() => db.saveOffers({}), /at least one offer/)
})

test('the bulk offers route answers 200 with per-row results, over real HTTP', async t => {
  const db = priced(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer((req, res) => api(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port + '/api/owner'

  const response = await fetch(base + '/offers', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offers: [
      { id: 'giga-a', ...offer({ priceCents: 10100, version: 1 }) },
      { id: 'giga-b', ...offer({ priceCents: 10100, version: 99 }) },
    ] }) })
  assert.equal(response.status, 200, 'partial success is the normal case, so it is not an error status')
  const { results } = await response.json()
  assert.deepEqual(results.map(row => row.ok), [true, false],
    'the bare path is not swallowed by the single-offer route, and one stale row does not undo the other')

  const listed = await (await fetch(base + '/inventory?sort=margin&dir=asc&pageSize=50')).json()
  assert.equal(listed.pageSize, 50)
  assert.equal(listed.sort, 'margin')
  assert.equal(listed.items[0].marginCents, 2000, 'the grid reads the same derived value the sort ordered by')
})

test('markup starts as the shared placeholder and survives being saved', t => {
  const db = setup(t)
  const initial = db.getMarkup()
  assert.equal(initial.rate, DEFAULT_MARKUP_SETTINGS.rate, 'default comes from the frontend markup module')
  assert.equal(initial.isPlaceholder, true)
  assert.equal(initial.updatedAt, null)
  assert.equal(db.summary().markup.rate, initial.rate, 'inventory summary carries it for the screen')

  // Both fields decided together, the way OwnerInventory.jsx's one form
  // always sends them: the aggregate flag clears only once neither is a
  // guess (#finding-3 -- see the two tests below for a rate-only save).
  const saved = db.saveMarkup({ rate: 1.6, shippingPerTire: 0 })
  assert.equal(saved.rate, 1.6)
  assert.equal(saved.isPlaceholder, false, 'a saved rate and shipping together are a decision, not a default')
  assert.ok(saved.updatedAt)
  assert.equal(db.getMarkup().rate, 1.6)
  assert.equal(db.summary().markup.isPlaceholder, false)
})

test('a rate-only save decides the rate but leaves shipping exactly as undecided as it was (#finding-3)', t => {
  const db = setup(t)
  // The API's one caller today always sends both fields, but the method
  // itself has always accepted rate alone (every caller before shipping
  // existed did exactly this) -- and used to mark the whole rule decided
  // regardless, silently promoting a never-set shipping default to Ken's own
  // number. It no longer does.
  const saved = db.saveMarkup({ rate: 1.6 })
  assert.equal(saved.rate, 1.6)
  assert.equal(saved.rateIsPlaceholder, false, 'the rate itself was named and validated')
  assert.equal(saved.shippingPerTireIsPlaceholder, true, 'shipping was never named, so it is still a guess')
  assert.equal(saved.isPlaceholder, true, 'the rule as a whole is still not fully decided')
  assert.equal(saved.shippingPerTire, DEFAULT_MARKUP_SETTINGS.shippingPerTire, 'still the default, not invented')

  // Naming shipping later, even at zero, finishes the decision.
  const finished = db.saveMarkup({ rate: 1.6, shippingPerTire: 0 })
  assert.equal(finished.shippingPerTireIsPlaceholder, false)
  assert.equal(finished.isPlaceholder, false)
})

test('a record saved before per-field markup flags existed reads as fully decided or fully placeholder, matching what one flag could say at the time', t => {
  const db = setup(t)
  // setMeta bypasses saveMarkup entirely, standing in for a row this
  // migration found already on disk.
  db.setMeta('markup', { rate: 1.5, shippingPerTire: 5, isPlaceholder: false, updatedAt: '2026-01-01T00:00:00.000Z' })
  const legacy = db.getMarkup()
  assert.equal(legacy.rateIsPlaceholder, false)
  assert.equal(legacy.shippingPerTireIsPlaceholder, false)
  assert.equal(legacy.isPlaceholder, false)
})

test('a record saved before shipping was a field at all -- no key, not a zero -- still reads shipping as undecided (production, #finding-3)', t => {
  const db = setup(t)
  // The actual shape of the production row: Ken saved a rate before #299
  // added shippingPerTire, so the key was never written -- not defaulted,
  // absent. The old combined isPlaceholder: false is honest about the rate
  // and silent about a field that did not exist yet to be silent about.
  db.setMeta('markup', { rate: 1.5, isPlaceholder: false, updatedAt: '2026-09-06T16:16:36.853Z' })
  const legacy = db.getMarkup()
  assert.equal(legacy.rate, 1.5, 'the rate Ken actually chose')
  assert.equal(legacy.rateIsPlaceholder, false, 'and it reads as chosen')
  assert.equal(legacy.shippingPerTire, DEFAULT_MARKUP_SETTINGS.shippingPerTire, 'resolves to the default, same as normalizeMarkupSettings would -- no price moves')
  assert.equal(legacy.shippingPerTireIsPlaceholder, true, 'but is NOT read as a decision -- the key was never there to decide')
  assert.equal(legacy.isPlaceholder, true, 'so the rule as a whole is still not fully decided')

  // The row self-corrects the moment Ken next touches the markup form,
  // which always sends both fields (OwnerInventory.jsx) -- no migration
  // needed, per the OWNER AGENT's ruling: fix the read, not the row.
  const resaved = db.saveMarkup({ rate: 1.5, shippingPerTire: 0 })
  assert.equal(resaved.shippingPerTireIsPlaceholder, false)
  assert.equal(resaved.isPlaceholder, false)
})

test('markup rejects rates that would quote below cost or reprice by typo', t => {
  const db = setup(t)
  for (const rate of [0, 0.9, -2, 11, Number.NaN, Infinity, '1.5', null, undefined]) {
    assert.throws(() => db.saveMarkup({ rate }), /markup between 1 and 10/, `rejected ${String(rate)}`)
  }
  assert.throws(() => db.saveMarkup(null), /markup between 1 and 10/)
  assert.equal(db.getMarkup().isPlaceholder, true, 'nothing was written by the rejected saves')
})

test('shipping per tire is passed through after markup, not marked up itself', t => {
  const db = setup(t)
  assert.equal(db.getMarkup().shippingPerTire, DEFAULT_MARKUP_SETTINGS.shippingPerTire, 'starts at the shared default')

  const saved = db.saveMarkup({ rate: 1.5, shippingPerTire: 8 })
  assert.equal(saved.shippingPerTire, 8)
  assert.equal(saved.isPlaceholder, false)

  // supplierPrice x rate + shipping: freight is an internal cost passed
  // through after the goods margin is calculated.
  assert.equal(quotedPrice({ supplierPrice: 50, offer: null, settings: db.getMarkup() }).price, 83, '(50 x 1.5) + 8')
})

test('omitting shippingPerTire on a save keeps whatever was already stored', t => {
  const db = setup(t)
  db.saveMarkup({ rate: 1.5, shippingPerTire: 8 })
  // A caller that only ever knew about `rate` (every one before this change)
  // must not silently reset shipping back to a guess.
  const saved = db.saveMarkup({ rate: 1.6 })
  assert.equal(saved.shippingPerTire, 8, 'rate-only saves do not touch shipping')
})

test('a rate-only save must not ratify a defaulted shipping figure as a decision (owner-agent scrutiny finding 3, LIVE)', t => {
  // The bug that already fired in production: saveMarkup stamps a single
  // flat isPlaceholder: false across the whole returned object, directly
  // above the fallback (the sibling test above) that substitutes the
  // stored or default shippingPerTire when the caller omits it. A save
  // that only ever meant to change the rate comes back saying shipping
  // was chosen too, when it was defaulted.
  //
  // Asserted against shippingPerTireIsPlaceholder, following the naming
  // already established one function over in savePricingSettings
  // (mobileServiceFeeIsPlaceholder / disposalFeeIsPlaceholder are flat
  // top-level booleans, not nested .isPlaceholder objects) -- not a field
  // that exists on saveMarkup's return value yet, so this fails until
  // BUG FIXER's fix adds per-field tracking. If the actual fix names the
  // field differently, update this assertion to match the real contract;
  // the invariant it protects (a field a save never touched keeps its own
  // placeholder flag) does not change either way.
  // Shipping must never have been touched -- if a prior save had actually
  // chosen 8, carrying that choice forward through a later rate-only save
  // is correct, not the bug (that is the sibling test above). The live
  // defect only exists on shipping's very first defaulted appearance: Ken
  // has never named a figure, and a rate-only save still stamps it decided.
  const db = setup(t)
  const rateOnly = db.saveMarkup({ rate: 1.6 })
  assert.equal(rateOnly.shippingPerTire, DEFAULT_MARKUP_SETTINGS.shippingPerTire, 'never chosen, so still the shared default')
  assert.equal(
    rateOnly.shippingPerTireIsPlaceholder, true,
    'a save that never sent shippingPerTire, and where nobody had chosen one before, must not report it as a ' +
    'decision -- this is the exact shape of the live defect: a defaulted value reading as Ken\'s own choice',
  )
})

test('shipping rejects a negative cost or an unreasonable one', t => {
  const db = setup(t)
  for (const shippingPerTire of [-1, 201, Number.NaN, Infinity, 'eight']) {
    assert.throws(() => db.saveMarkup({ rate: 1.5, shippingPerTire }), /shipping cost between \$0 and \$200/, `rejected ${String(shippingPerTire)}`)
  }
  assert.equal(db.getMarkup().isPlaceholder, true, 'nothing was written by the rejected saves')
})

test('zero shipping is a real, explicit answer -- Ken absorbing the cost -- not a rejected one', t => {
  const db = setup(t)
  const saved = db.saveMarkup({ rate: 1.5, shippingPerTire: 0 })
  assert.equal(saved.shippingPerTire, 0)
  assert.equal(saved.isPlaceholder, false)
})

test('markup never overrides a price the owner set', t => {
  const db = setup(t)
  db.saveMarkup({ rate: 2 })
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))

  // The supplier row is $50, so markup would propose $100. The owner said $89.99.
  const row = db.list().items.find(item => item.id === 'giga-a')
  assert.equal(row.offer.priceCents, 8999, 'the owner price is what is stored')
  assert.equal(db.getMarkup().rate, 2, 'and the rule is still there for tires nobody priced')

  // Resolved the way the customer catalog resolves it.
  assert.equal(quotedPrice({ supplierPrice: 50, offer: row.offer, settings: db.getMarkup() }).source, 'owner')
  assert.equal(quotedPrice({ supplierPrice: 50, offer: null, settings: db.getMarkup() }).price, 100)
})

test('owner markup endpoint saves and validates over HTTP', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer(async (request, response) => { if (!(await api(request, response))) response.writeHead(404).end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (method, body) => fetch(`${base}/api/owner/markup`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  })

  const read = await call('GET')
  assert.equal(read.status, 200)
  assert.equal((await read.json()).isPlaceholder, true)

  const ok = await call('PUT', { rate: 1.45 })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).rate, 1.45)

  const bad = await call('PUT', { rate: 0.5 })
  assert.equal(bad.status, 400)
  assert.equal(db.getMarkup().rate, 1.45, 'the rejected save left the stored rule alone')
})

test('pricing settings start inert, and each field carries its own placeholder flag (#289)', t => {
  const db = setup(t)
  const initial = db.getPricingSettings()
  assert.equal(initial.mobileServiceFee, 49.99, 'the fee already being charged')
  assert.equal(initial.mobileServiceFeeIsPlaceholder, true)
  assert.equal(initial.disposalFee, null, 'off until Ken sets one')
  assert.equal(initial.tax, null, 'absent, not a placeholder')
  assert.equal(db.summary().pricing.mobileServiceFee, 49.99, 'inventory summary carries it for the screen')
})

test('saving pricing settings stores cents and reads back dollars', t => {
  const db = setup(t)
  const saved = db.savePricingSettings({ mobileServiceFee: 55, disposalFee: 6.5, tax: { rate: 0.0625, appliesTo: 'goods' } })
  assert.equal(saved.mobileServiceFee, 55)
  assert.equal(saved.mobileServiceFeeIsPlaceholder, false)
  assert.equal(saved.disposalFee, 6.5)
  assert.deepEqual(saved.tax, { rate: 0.0625, appliesTo: 'goods' })
  assert.ok(saved.updatedAt)
  assert.equal(db.getPricingSettings().mobileServiceFee, 55, 'survives a fresh read')
})

test('turning disposal off is a real save, stored as null, not left as a stale amount', t => {
  const db = setup(t)
  db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: 6.5, tax: null })
  const off = db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: null, tax: null })
  assert.equal(off.disposalFee, null)
  assert.equal(db.getPricingSettings().disposalFee, null)
  // Ken had already priced disposal once (a real fee above), so explicitly
  // turning it back off is still a decision, not a guess reasserting itself.
  assert.equal(off.disposalFeeIsPlaceholder, false)
})

test('setting only the mobile fee does not silently decide disposal (#finding-3)', t => {
  const db = setup(t)
  // The untouched form's disposal toggle defaults to off, so its very first
  // submission -- meant only to set the mobile fee -- sends disposalFee:
  // null the same way it would if Ken had actually looked at disposal and
  // said no. Nothing in that payload tells the two apart; only the fact
  // that disposal has never carried a real number does.
  const saved = db.savePricingSettings({ mobileServiceFee: 55, disposalFee: null, tax: null })
  assert.equal(saved.mobileServiceFeeIsPlaceholder, false, 'the fee itself was named and validated')
  assert.equal(saved.disposalFeeIsPlaceholder, true, 'disposal was never given a real number, so it is still a guess')

  // Naming a real fee later finishes that decision.
  const priced = db.savePricingSettings({ mobileServiceFee: 55, disposalFee: 8, tax: null })
  assert.equal(priced.disposalFeeIsPlaceholder, false)
})

test('pricing settings reject a fee, a disposal amount, or a tax shape that would misprice', t => {
  const db = setup(t)
  assert.throws(() => db.savePricingSettings({ mobileServiceFee: 0 }), /mobile service fee between \$0 and \$1000/)
  assert.throws(() => db.savePricingSettings({ mobileServiceFee: -5 }), /mobile service fee/)
  assert.throws(() => db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: -1 }), /disposal fee between \$0 and \$200/)
  assert.throws(() => db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: null, tax: { rate: 1, appliesTo: 'all' } }), /tax rate between 0 and 25%/)
  assert.throws(() => db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: null, tax: { rate: 0.06, appliesTo: 'nowhere' } }), /which lines the tax applies to/)
  assert.equal(db.getPricingSettings().mobileServiceFeeIsPlaceholder, true, 'nothing was written by the rejected saves')
})

// #354: the owner's own catalogue lines.

const catalogueLine = (overrides = {}) => ({
  label: 'Installation', amountCents: 1500, basis: 'perTire', mode: 'automatic', taxable: false, enabled: true,
  ...overrides,
})

test('the catalogue starts seeded with the mobile-service fee, not empty, and saving assigns each new line a stable id', t => {
  const db = setup(t)
  const seeded = db.getCatalogueLines()
  assert.equal(seeded.length, 1, 'seedCatalogueLines() ran at construction (#354 stage 2)')
  assert.equal(seeded[0].id, 'mobile-service')
  assert.equal(seeded[0].label, 'Mobile service fee', 'the per-visit charge is not described as per-tire installation')
  assert.equal(seeded[0].isPlaceholder, true, 'the default fee is still a placeholder until Ken sets one')

  // saveCatalogueLines replaces the whole list, so keeping the seed while
  // adding a line means sending both back -- the screen's job, not this
  // method's.
  const saved = db.saveCatalogueLines([...seeded, catalogueLine()])
  assert.equal(saved.length, 2)
  const added = saved.find(line => line.id !== 'mobile-service')
  assert.ok(added.id, 'a line with no id is assigned one')
  assert.equal(added.label, 'Installation')
  assert.deepEqual(db.getCatalogueLines(), saved, 'survives a fresh read')
})

test('saving again with an existing id keeps that id; a renamed label does not become a new line', t => {
  const db = setup(t)
  const [first] = db.saveCatalogueLines([catalogueLine()])
  const [resaved] = db.saveCatalogueLines([{ ...first, label: 'Tire installation' }])
  assert.equal(resaved.id, first.id)
  assert.equal(resaved.label, 'Tire installation')
})

test('saveCatalogueLines has no isPlaceholder field, unlike every other pricing setting (#354)', t => {
  const db = setup(t)
  const [saved] = db.saveCatalogueLines([catalogueLine()])
  assert.equal('isPlaceholder' in saved, false)
})

test('disposal seeds only when a fee is actually set; an unset disposal is an absent line, not a placeholder number', t => {
  const db = setup(t)
  assert.equal(db.getCatalogueLines().length, 1, 'mobile-service only, since no disposal fee is set yet')

  db.savePricingSettings({ mobileServiceFee: 49.99, disposalFee: 8 })
  // The constructor's own seed already ran (before this save existed to see),
  // so this reproduces what the seed does when it runs against a database
  // that already has a real disposal fee -- the shape a restore from a
  // backup taken after Ken set one would actually have -- via the same
  // public entry point the constructor itself calls.
  db.setMeta('pricingLines', [])
  db.seedCatalogueLines()

  const lines = db.getCatalogueLines()
  assert.equal(lines.length, 2)
  const disposal = lines.find(line => line.id === 'disposal')
  assert.ok(disposal, 'disposal seeds alongside mobile-service once a fee exists')
  assert.equal(disposal.amountCents, 800)
  assert.equal(disposal.basis, 'perTire')
  assert.equal(disposal.mode, 'optional')
})

test('a seeded line\'s isPlaceholder clears only when its own amount actually changes, not on an unrelated save (#354 amendment)', t => {
  const db = setup(t)
  const [seeded] = db.getCatalogueLines()
  assert.equal(seeded.isPlaceholder, true, 'the default fee, never confirmed by Ken')

  // Saving the whole list back unchanged -- e.g. the owner screen loading and
  // saving without touching this line -- must not launder the flag away.
  const [untouched] = db.saveCatalogueLines([seeded])
  assert.equal(untouched.isPlaceholder, true, 'echoing the same amount back keeps the flag')

  // Ken actually types a new amount: now it is his number.
  const [edited] = db.saveCatalogueLines([{ ...seeded, amountCents: 6000 }])
  assert.equal('isPlaceholder' in edited, false, 'a real edit clears the flag for good')

  // And it stays cleared on a later save that leaves the (now his) amount alone.
  const [resaved] = db.saveCatalogueLines([edited])
  assert.equal('isPlaceholder' in resaved, false)
})

test('saveCatalogueLines validates every field, and a rejected save leaves the stored catalogue alone', t => {
  const db = setup(t)
  db.saveCatalogueLines([catalogueLine({ label: 'Installation' })])

  assert.throws(() => db.saveCatalogueLines('not an array'), /list of lines/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), label: '' }]), /needs a label/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), amountCents: 19.5 }]), /whole-cent amount/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), amountCents: -1 }]), /whole-cent amount/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), basis: 'perWheel' }]), /basis of perTire or perJob/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), mode: 'sometimes' }]), /mode of automatic or optional/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), taxable: 'yes' }]), /taxable to be true or false/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), enabled: 'yes' }]), /enabled to be true or false/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), amountOverrides: { sizes: [] } }]), /sizes overrides must be an object/)
  assert.throws(() => db.saveCatalogueLines([{ ...catalogueLine(), amountOverrides: { skus: { ABC: 19.5 } } }]), /invalid skus override/)
  assert.throws(() => db.saveCatalogueLines([catalogueLine(), catalogueLine()].map(l => ({ ...l, id: 'dup' }))), /repeats an id/)
  assert.throws(() => db.saveCatalogueLines(Array.from({ length: 26 }, () => catalogueLine())), /at most 25 lines/)

  assert.equal(db.getCatalogueLines().length, 1, 'none of the rejected saves touched the stored catalogue')
  assert.equal(db.getCatalogueLines()[0].label, 'Installation')
})

test('catalogue amount overrides round-trip as whole cents for size and SKU targets', t => {
  const db = setup(t)
  const [saved] = db.saveCatalogueLines([catalogueLine({
    amountOverrides: { sizes: { [SIZE]: 2200 }, skus: { ABC123: 2750 } },
  })])
  assert.deepEqual(saved.amountOverrides, { sizes: { [SIZE]: 2200 }, skus: { abc123: 2750 } }, 'SKU keys normalize the same way supplier ids do')
  assert.deepEqual(db.getCatalogueLines()[0].amountOverrides, saved.amountOverrides)
})

test('the seed runs once at construction and never re-runs against an already-populated database', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-catalogue-seed-test-'))
  const filename = path.join(folder, 'test.sqlite')
  let db
  try {
    db = new Inventory(filename, [SIZE])
    const firstOpen = db.getCatalogueLines()
    assert.equal(firstOpen.length, 1, 'seeded on first construction against a fresh file')
    // Ken edits the seeded fee -- exactly the action that would be silently
    // undone if construction re-seeded on every open rather than checking
    // whether the catalogue already holds something.
    db.saveCatalogueLines([{ ...firstOpen[0], label: 'Ken’s call-out', amountCents: 6000 }])
    db.close()

    db = new Inventory(filename, [SIZE])
    const secondOpen = db.getCatalogueLines()
    assert.equal(secondOpen.length, 1, 'still one line -- a re-seed would have duplicated Ken\'s fee onto every quote')
    assert.equal(secondOpen[0].amountCents, 6000, 'his edit survived the reopen; a re-seed would have overwritten it back to the default')
    assert.equal(secondOpen[0].label, 'Ken’s call-out', 'an existing owner-customized label is never rewritten to the new default')
  } finally {
    db?.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('the seed reads a real, pre-existing production row correctly on the first open that ever sees it (#354 stage 2 migration)', () => {
  // The sibling test above proves the seed does not re-run against a
  // database it already seeded. This one proves the seed itself is correct
  // the very first time it runs against a database that predates it -- a
  // real close and reopen of a real file, written the way pre-#388 code
  // would have left it: pricing settings exist, pricingLines never does,
  // because the code that writes it did not exist yet. That combination --
  // real file, genuine reopen, pre-existing non-default settings -- was
  // reviewed by hand and not previously pinned by any test here.
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-catalogue-migration-test-'))
  const filename = path.join(folder, 'test.sqlite')
  let db
  try {
    // Case 1: Ken already set real, decided fees before this code existed.
    db = new Inventory(filename, [SIZE])
    db.db.exec(`DELETE FROM metadata WHERE key='pricingLines'`) // the old code's shape: this key never existed
    db.savePricingSettings({ mobileServiceFee: 65, disposalFee: 12 })
    db.close()

    db = new Inventory(filename, [SIZE]) // first-ever open with #388's code
    const lines = db.getCatalogueLines()
    const mobile = lines.find(line => line.id === 'mobile-service')
    const disposal = lines.find(line => line.id === 'disposal')
    assert.equal(mobile.amountCents, 6500, 'the real fee Ken set, not a default')
    assert.equal('isPlaceholder' in mobile, false, 'a real, decided fee reads as not-a-placeholder -- absent, the same convention used everywhere else in pricing')
    assert.equal(disposal.amountCents, 1200)
    assert.equal('isPlaceholder' in disposal, false)
  } finally {
    db?.close()
    rmSync(folder, { recursive: true, force: true })
  }

  // Case 2: the other real production shape -- Ken never touched pricing at
  // all, still the shared default, disposal never set. A separate file: the
  // constructor's own seed already ran once in case 1 and must not be asked
  // to run a second time against the same database.
  const folder2 = mkdtempSync(path.join(tmpdir(), 'kmt-catalogue-migration-test-untouched-'))
  const filename2 = path.join(folder2, 'test.sqlite')
  let db2
  try {
    db2 = new Inventory(filename2, [SIZE])
    db2.db.exec(`DELETE FROM metadata WHERE key='pricingLines'`)
    db2.close()

    db2 = new Inventory(filename2, [SIZE])
    const lines = db2.getCatalogueLines()
    assert.equal(lines.length, 1, 'mobile-service only -- disposal was never set, so it is an absent line, not a placeholder number')
    assert.equal(lines[0].id, 'mobile-service')
    assert.equal(lines[0].amountCents, 4999, 'the shared default fee')
    assert.equal(lines[0].isPlaceholder, true, 'never confirmed by Ken, so it reads as a placeholder')
  } finally {
    db2?.close()
    rmSync(folder2, { recursive: true, force: true })
  }
})

test('disabling a line rather than removing it from the list is a normal save', t => {
  const db = setup(t)
  const [saved] = db.saveCatalogueLines([catalogueLine()])
  const [disabled] = db.saveCatalogueLines([{ ...saved, enabled: false }])
  assert.equal(disabled.id, saved.id, 'still the same line')
  assert.equal(disabled.enabled, false)
})

test('the owner pricing-lines endpoint saves and validates over HTTP, session-gated like every other owner route', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer(async (request, response) => { if (!(await api(request, response))) response.writeHead(404).end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (method, body) => fetch(`${base}/api/owner/pricing-lines`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  })

  const seeded = await call('GET')
  assert.equal(seeded.status, 200)
  const seededLines = (await seeded.json()).lines
  assert.equal(seededLines.length, 1, 'seeded with mobile-service at construction')

  const ok = await call('PUT', { lines: [...seededLines, catalogueLine()] })
  assert.equal(ok.status, 200)
  const saved = (await ok.json()).lines
  assert.equal(saved.length, 2)
  assert.ok(saved.some(line => line.label === 'Installation'))

  const bad = await call('PUT', { lines: [{ ...catalogueLine(), basis: 'nowhere' }] })
  assert.equal(bad.status, 400)
  assert.equal(db.getCatalogueLines().length, 2, 'the rejected save left the stored catalogue alone')
})

test('owner pricing endpoint saves and validates over HTTP', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer(async (request, response) => { if (!(await api(request, response))) response.writeHead(404).end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (method, body) => fetch(`${base}/api/owner/pricing`, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  })

  const read = await call('GET')
  assert.equal(read.status, 200)
  assert.equal((await read.json()).mobileServiceFeeIsPlaceholder, true)

  const ok = await call('PUT', { mobileServiceFee: 60, disposalFee: null, tax: null })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).mobileServiceFee, 60)

  const bad = await call('PUT', { mobileServiceFee: -1 })
  assert.equal(bad.status, 400)
  assert.equal(db.getPricingSettings().mobileServiceFee, 60, 'the rejected save left the stored settings alone')
})

test('auth refuses to start without a usable password', () => {
  assert.throws(() => readAuthConfig({}), /KMT_OWNER_PASSWORD is not set/)
  assert.throws(() => readAuthConfig({ KMT_OWNER_PASSWORD: 'short' }), /at least 12 characters/)
  const config = readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' })
  assert.equal(config.generatedSecret, true, 'a missing secret is generated rather than fatal')
})

test('a session lifetime that is not a positive number of hours refuses to boot', () => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password' }
  for (const bad of ['abc', '0', '-1', 'NaN', 'Infinity']) {
    assert.throws(() => readAuthConfig({ ...env, KMT_SESSION_HOURS: bad }), /KMT_SESSION_HOURS must be a positive number/,
      `KMT_SESSION_HOURS=${bad} must refuse`)
  }
  assert.equal(readAuthConfig(env).ttlMs, 12 * 3600_000, 'unset keeps the default of 12 hours')
  assert.equal(readAuthConfig({ ...env, KMT_SESSION_HOURS: '' }).ttlMs, 12 * 3600_000, 'empty is unset')
  assert.equal(readAuthConfig({ ...env, KMT_SESSION_HOURS: '6' }).ttlMs, 6 * 3600_000)
  assert.equal(readAuthConfig({ ...env, KMT_SESSION_HOURS: '0.5' }).ttlMs, 30 * 60_000, 'fractions of an hour are hours too')
})

test('a malformed login body is refused with a JSON error, not a stack trace', async t => {
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }))
  const logged = []
  const { error: originalError } = console
  console.error = (...args) => logged.push(args)
  t.after(() => { console.error = originalError })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body, headers = {}) => fetch(`${base}/api/owner/login`, { method: 'POST', headers, body })

  // Measured on production: a body of "x" with no content type answered 500
  // with a stack trace. Each refusal is the status the body reader assigns.
  const noType = await post('x')
  assert.equal(noType.status, 415)
  assert.equal(noType.headers.get('content-type'), 'application/json')
  const noTypeBody = await noType.text()
  assert.deepEqual(JSON.parse(noTypeBody), { error: 'Expected JSON' })
  assert.doesNotMatch(noTypeBody, /at .*\.mjs/, 'no stack frame reaches the response')

  const malformed = await post('{not json', { 'content-type': 'application/json' })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON' })

  const oversized = await post(JSON.stringify({ password: 'x'.repeat(40_000) }), { 'content-type': 'application/json' })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await oversized.json(), { error: 'Request is too large' })

  assert.deepEqual(logged, [], 'input errors are not logged as faults')

  // And a well-formed body still gets the real answer.
  const wrong = await post(JSON.stringify({ password: 'wrong-but-long-enough' }), { 'content-type': 'application/json' })
  assert.equal(wrong.status, 401)
  const right = await post(JSON.stringify({ password: 'a-long-enough-password' }), { 'content-type': 'application/json' })
  assert.equal(right.status, 200)
})

test('sessions are signed, expire, and cannot be forged', async t => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }
  // One store shared by every instance below, so what each refusal proves is
  // the signature or the expiry, never merely a session the other never saw.
  const sessions = memorySessionStore()
  const auth = createAuth(readAuthConfig(env), { sessions })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    response.writeHead(auth.isAuthenticated(request) ? 200 : 401).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const login = password => fetch(`${base}/api/owner/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  })

  assert.equal((await login('wrong-but-long-enough')).status, 401)
  assert.equal((await fetch(`${base}/anything`)).status, 401, 'no cookie means no access')

  const ok = await login('a-long-enough-password')
  assert.equal(ok.status, 200)
  const cookie = ok.headers.getSetCookie()[0]
  assert.match(cookie, /HttpOnly/)
  // t47 (#89): Lax so a link in a notification email carries the session on
  // a top-level navigation; Strict must be gone, not merely joined by Lax.
  assert.match(cookie, /SameSite=Lax/)
  assert.doesNotMatch(cookie, /SameSite=Strict/)
  assert.equal((cookie.match(/SameSite=/g) || []).length, 1, 'exactly one SameSite attribute')

  const token = cookie.split(';')[0]
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: token } })).status, 200)

  // A cookie signed with a different secret is not accepted.
  const other = createAuth(readAuthConfig({ ...env, KMT_SESSION_SECRET: 'secret-two' }), { sessions })
  assert.equal(other.isAuthenticated({ headers: { cookie: token }, socket: {} }), false)

  // Neither is a tampered payload.
  const tampered = token.replace(/=(.*)\./, `=${Buffer.from(String(Date.now() + 9e9)).toString('base64url')}.`)
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: tampered } })).status, 401)

  // An expired session is refused even though its signature is valid. A
  // negative lifetime no longer boots, so this issues with a tiny positive
  // one and waits it out. The lifetime affects issuing, not existing tokens:
  // the long-lived one above is still good on this instance.
  const brief = createAuth(readAuthConfig({ ...env, KMT_SESSION_HOURS: String(1 / 3600_000) }), { sessions })
  assert.equal(brief.isAuthenticated({ headers: { cookie: token }, socket: {} }), true, 'ttl affects issuing, not this token')
  const sent = {}
  await brief.handle(
    { method: 'POST', headers: {}, socket: {} },
    { writeHead: (status, headers) => { sent.status = status; sent.cookie = headers['Set-Cookie'] }, end: () => {} },
    new URL('http://localhost/api/owner/login'),
    async () => ({ password: 'a-long-enough-password' }),
  )
  assert.equal(sent.status, 200)
  const staleToken = sent.cookie.split(';')[0]
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: staleToken } })).status, 401, 'a signed but expired cookie is refused')
})

/** An auth server the way server.mjs mounts it, with the pieces under test passed in. */
async function authServer(t, options) {
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }), options)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    response.writeHead(auth.isAuthenticated(request) ? 200 : 401).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const login = (password, headers = {}) => fetch(`${base}/api/owner/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ password }),
  })
  return { base, login }
}

test('logging out forgets the session on the server, so a copied cookie is dead too', async t => {
  // Before this, a session was a signed timestamp and logout only cleared the
  // browser's copy: a cookie copied off a shared device stayed good for its
  // whole twelve hours (#66).
  const { base, login } = await authServer(t, { sessions: memorySessionStore() })
  const ok = await login('a-long-enough-password')
  const token = ok.headers.getSetCookie()[0].split(';')[0]
  const copy = token
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: copy } })).status, 200, 'the copy works while the session lives')

  const out = await fetch(`${base}/api/owner/logout`, { method: 'POST', headers: { cookie: token } })
  assert.equal(out.status, 200)
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/, 'the browser is told to drop it')
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: copy } })).status, 401, 'and the copy is refused, whatever its signature says')
  assert.equal((await (await fetch(`${base}/api/owner/session`, { headers: { cookie: copy } })).json()).authenticated, false)

  // A second login is a new session, unaffected by the old one's end.
  const again = await login('a-long-enough-password')
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: again.headers.getSetCookie()[0].split(';')[0] } })).status, 200)
})

test('sessions kept in the database survive a new auth instance, the way a deploy restarts the process', async t => {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'kept-across-restarts' }

  const first = createAuth(readAuthConfig(env), { sessions: createSessionStore(inventory.db) })
  const sent = {}
  await first.handle({ method: 'POST', headers: {}, socket: {} },
    { writeHead: (status, headers) => { sent.cookie = headers['Set-Cookie'] }, end: () => {} },
    new URL('http://localhost/api/owner/login'), async () => ({ password: 'a-long-enough-password' }))
  const token = sent.cookie.split(';')[0]

  // The same database opened by a fresh process: the table already exists,
  // the row is there, and the owner is still signed in.
  const second = createAuth(readAuthConfig(env), { sessions: createSessionStore(inventory.db) })
  assert.equal(second.isAuthenticated({ headers: { cookie: token }, socket: {} }), true)

  // Logging out on the new instance forgets it for both.
  await second.handle({ method: 'POST', headers: { cookie: token }, socket: {} },
    { writeHead: () => {}, end: () => {} }, new URL('http://localhost/api/owner/logout'), readJsonBody)
  assert.equal(first.isAuthenticated({ headers: { cookie: token }, socket: {} }), false)
  assert.equal(inventory.db.prepare('SELECT COUNT(*) AS n FROM owner_sessions').get().n, 0, 'nothing left behind')
})

test('a minted session authenticates exactly like a password-issued one, and logs out the same way (scripts/mint-session.mjs)', async t => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'mint-secret' }
  const config = readAuthConfig(env)
  const sessions = memorySessionStore()
  const auth = createAuth(config, { sessions })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    response.writeHead(auth.isAuthenticated(request) ? 200 : 401).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  // No password was ever sent anywhere -- this is the whole point.
  const minted = mintSession(config, sessions)
  assert.equal(minted.name, SESSION_COOKIE_NAME)
  const cookie = `${minted.name}=${minted.value}`

  assert.equal((await fetch(`${base}/anything`)).status, 401, 'no cookie is still no access')
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie } })).status, 200, 'the minted cookie authenticates')
  assert.equal(
    (await (await fetch(`${base}/api/owner/session`, { headers: { cookie } })).json()).authenticated,
    true,
  )

  // It logs out the same way a password-issued session does: the server
  // forgets the row, not just the browser's copy (#66).
  const out = await fetch(`${base}/api/owner/logout`, { method: 'POST', headers: { cookie } })
  assert.equal(out.status, 200)
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie } })).status, 401, 'dead after logout, like any other session')
})

test('a minted session respects its own ttl and the store it was minted into', async t => {
  const config = readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'mint-secret-2' })
  const sessions = memorySessionStore()

  // Default ttl comes from config, the same one the server would issue.
  // The clock is read once, before minting, and compared against that fixed
  // value rather than a fresh Date.now() at assert time -- re-reading it here
  // makes the assertion "less than a second has passed since minting", which
  // a suite that spawns real servers can occasionally lose (TECHNICAL
  // ARCHITECT's diagnosis of a flake reported against this test).
  const before = Date.now()
  const defaultTtl = mintSession(config, sessions)
  assert.ok(defaultTtl.expiresAt > before + config.ttlMs - 1000)

  // An explicit ttl overrides the default -- the CLI's --hours flag. A
  // second, independent race turned up empirically while fixing the one
  // above: `mintSession(config, sessions, 1)` immediately followed by
  // `isAuthenticatedWith(...) === true` shares its whole 1ms budget with
  // real call overhead (HMAC signing, a Map write), so "still valid" could
  // itself already be false by the time the assertion runs -- the same
  // underlying defect, one order of margin smaller. A wider ttl would only
  // make that less likely, which is the wrong shape (an intermittent red
  // trains people to dismiss it, including the time it is real); the fix is
  // to stop asking a live clock at all for a fact that mintSession already
  // computed. Checked the same arithmetic way the default-ttl case above
  // is, not through a real-time isAuthenticatedWith call.
  const beforeOverride = Date.now()
  const overridden = mintSession(config, sessions, 60_000)
  assert.ok(
    overridden.expiresAt >= beforeOverride + 60_000 && overridden.expiresAt < beforeOverride + 60_000 + 1000,
    'the explicit ttl reaches expiresAt untouched, not the config default, within a generous allowance for the mint call itself',
  )

  // Expiry itself needs a genuinely short ttl, minted separately so it
  // cannot be confused with the override check above.
  const brief = mintSession(config, sessions, 1)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(isAuthenticatedWith(config, sessions, brief), false, 'a 1ms session expires')

  // It is the same store a real Inventory database would give -- surviving a
  // restart is createSessionStore's job, already proven above; this proves
  // mintSession writes through whatever store it is handed, not its own.
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  const dbBacked = mintSession(config, createSessionStore(inventory.db))
  assert.equal(inventory.db.prepare('SELECT COUNT(*) AS n FROM owner_sessions').get().n, 1)
  assert.equal(isAuthenticatedWith(config, createSessionStore(inventory.db), dbBacked), true, 'a fresh store over the same db sees the row')

  function isAuthenticatedWith(cfg, store, minted) {
    return createAuth(cfg, { sessions: store }).isAuthenticated({
      headers: { cookie: `${minted.name}=${minted.value}` }, socket: {},
    })
  }
})

test('minting works with KMT_OWNER_PASSWORD unset -- the one scenario the tool exists for', () => {
  // Once Google-only sign-in replaces the password form, the server no
  // longer sets (or needs) KMT_OWNER_PASSWORD at all. mintSession itself
  // never reads config.password -- only config.secret and config.ttlMs --
  // so requiring one here would be an incidental dependency inherited from
  // readAuthConfig's login-time guard, not a real one. A config reader for
  // minting must not carry that guard, or the tool throws at exactly the
  // moment it exists to survive.
  const config = readSessionSigningConfig({ KMT_SESSION_SECRET: 'mint-secret-3' })
  const sessions = memorySessionStore()
  const minted = mintSession(config, sessions)
  assert.equal(
    createAuth({ ...config, password: 'unused' }, { sessions }).isAuthenticated({
      headers: { cookie: `${minted.name}=${minted.value}` }, socket: {},
    }),
    true,
  )
})

test('minting refuses rather than mint a dead cookie when KMT_SESSION_SECRET is unset', () => {
  // readAuthConfig generates a random per-boot secret when none is set,
  // which is safe there because the same process signs and later verifies
  // its own tokens. Minting happens in a separate process from the one
  // that will check the cookie: a generated secret here would sign with a
  // value the running server never sees, producing a token that looks
  // real and authenticates nothing. That is the worst failure shape for a
  // recovery tool, so this refuses instead of silently generating one.
  assert.throws(() => readSessionSigningConfig({}), /KMT_SESSION_SECRET is not set/)
})

// #362 follow-up: a session records who -- or what -- created it, so a
// decision made under it (backend/quotes.mjs's decided_by, once #290 wires a
// real identity into moveTo's actor) never falsely records a minted session
// as a person, and never silently collapses it into the shared-password
// marker either.

test('mintSession never produces a session with no actor -- the one case that would defeat the marker', () => {
  const config = readSessionSigningConfig({ KMT_SESSION_SECRET: 'actor-secret-1' })
  const sessions = memorySessionStore()
  const minted = mintSession(config, sessions)
  const id = extractSessionId(minted.value)
  assert.equal(sessions.actorFor(id), MINTED_SESSION_ACTOR)
})

test('a password-issued session records the shared-password actor, not a minted one', async t => {
  const config = readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'actor-secret-2' })
  const sessions = memorySessionStore()
  const auth = createAuth(config, { sessions })
  const server = createServer(async (request, response) => { await auth.handle(request, response, new URL(request.url, 'http://localhost'), readJsonBody) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const login = await fetch(`${base}/api/owner/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-enough-password' }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const id = extractSessionId(cookie.split('=')[1])
  assert.equal(sessions.actorFor(id), 'owner:shared-password')
})

test('memorySessionStore and the SQLite store agree on the actor contract -- one parallel implementation, not two', t => {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  const dbSessions = createSessionStore(inventory.db)
  const memSessions = memorySessionStore()

  for (const sessions of [dbSessions, memSessions]) {
    const withActor = sessions.create(Date.now() + 60_000, MINTED_SESSION_ACTOR)
    assert.equal(sessions.actorFor(withActor), MINTED_SESSION_ACTOR)

    const withoutActor = sessions.create(Date.now() + 60_000)
    assert.equal(sessions.actorFor(withoutActor), null, 'no actor argument reads back as null, not undefined or a default')
    assert.notEqual(
      sessions.actorFor(withActor), sessions.actorFor(withoutActor),
      'a minted session and a no-actor session must read as distinct -- if mintSession ever passed no actor, ' +
      'a minted session would read null and collapse straight into the shared-password marker downstream',
    )

    assert.equal(sessions.actorFor('no-such-session-id'), null, 'an unknown id reads as null too, not a thrown error')
  }
})

test('a database whose owner_sessions predates the actor column still signs sessions in, and the old row reads no actor', t => {
  // The state every already-deployed database is in today: a table with no
  // actor column at all, not merely one full of nulls. createSessionStore
  // must ALTER it in place rather than assume the column exists.
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  inventory.db.exec('DROP TABLE IF EXISTS owner_sessions')
  inventory.db.exec('CREATE TABLE owner_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)')
  inventory.db.prepare('INSERT INTO owner_sessions (id, expires_at) VALUES (?, ?)').run('pre-column-session', Date.now() + 60_000)

  const columnsBefore = inventory.db.prepare("PRAGMA table_info(owner_sessions)").all().map(c => c.name)
  assert.ok(!columnsBefore.includes('actor'), 'the fixture must predate the column, or this test proves nothing')

  const sessions = createSessionStore(inventory.db)
  assert.equal(sessions.has('pre-column-session'), true, 'a session from before the column existed still authenticates')
  assert.equal(sessions.actorFor('pre-column-session'), null, 'and honestly reports that nothing was recorded, rather than guessing')

  const columnsAfter = inventory.db.prepare("PRAGMA table_info(owner_sessions)").all().map(c => c.name)
  assert.ok(columnsAfter.includes('actor'), 'opening the store adds the column')

  // Reopening a second time must not fail on "duplicate column".
  assert.doesNotThrow(() => createSessionStore(inventory.db))
})

test('auth.mjs and quotes.mjs agree on the password-era actor string -- pinned, not assumed', () => {
  // Two independent literals for the same fact (TECHNICAL ARCHITECT's read of
  // #374): auth.mjs writes PASSWORD_SESSION_ACTOR onto a login session,
  // quotes.mjs's moveTo falls back to SHARED_PASSWORD_ACTOR when no actor was
  // recorded. They are not the same export -- reconciling that is left for
  // whoever lands #290's identity resolution, since moving the constant now
  // would fight #349 over one export -- so nothing stops them drifting apart
  // silently. If they ever do, a password-era decision resolves to one value
  // through actorFor and defaults to the other through moveTo, and the three
  // eras quietly become four with no test failing except this one.
  assert.equal(
    PASSWORD_SESSION_ACTOR, SHARED_PASSWORD_ACTOR,
    'the password era has one name; auth writes it on the session and quotes falls back to it',
  )
})

function extractSessionId(tokenValue) {
  const [payload] = tokenValue.split('.')
  const [, , id] = Buffer.from(payload, 'base64url').toString().split(':')
  return id
}

test('wrong passwords from one address are slowed, per address, and never lock the owner out', async t => {
  let now = 5_000_000
  const throttle = new LoginThrottle({
    rule: { free: 2, windowMs: 60_000, baseDelayMs: 2_000, maxDelayMs: 60_000 }, now: () => now, log: () => {},
  })
  const { login } = await authServer(t, { throttle })

  assert.equal((await login('wrong-but-long-enough')).status, 401)
  assert.equal((await login('wrong-but-long-enough')).status, 401, 'the free failures still answer 401')
  assert.equal((await login('wrong-but-long-enough')).status, 401, 'the third is counted and starts the delay')

  const slowed = await login('a-long-enough-password')
  assert.equal(slowed.status, 429, 'even the right password waits, because the guess is not read during the delay')
  assert.equal(slowed.headers.get('retry-after'), '2')
  assert.match((await slowed.json()).error, /Try again in 2 seconds/)

  // Another address is not slowed by this one's failures: a stranger cannot
  // lock the owner out by guessing wrong from elsewhere.
  const elsewhere = await login('a-long-enough-password', { 'fly-client-ip': '203.0.113.9' })
  assert.equal(elsewhere.status, 200)

  now += 2_000
  const ok = await login('a-long-enough-password')
  assert.equal(ok.status, 200, 'after the wait the right password is read')
  assert.equal((await login('wrong-but-long-enough')).status, 401, 'and the success cleared the count: this is a free failure again')
  assert.equal((await login('a-long-enough-password')).status, 200)
})

test('the API origin check follows the request scheme', async t => {
  const db = setup(t)
  const api = createApi(db, new Refresher(db))
  const server = createServer(async (request, response) => { if (!(await api(request, response))) response.writeHead(404).end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  // node:http rather than fetch: Host is a forbidden header for fetch, which
  // silently drops it, and Host is precisely what this check reads.
  const call = headers => new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/owner/markup', method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    request.on('error', reject)
    request.end(JSON.stringify({ rate: 1.5 }))
  })

  // Behind TLS the browser sends https://host while the socket is plain http.
  // Assuming http here rejected every save the owner made in production.
  assert.equal(await call({ origin: 'https://kmt.example', host: 'kmt.example', 'x-forwarded-proto': 'https' }), 200)
  assert.equal(await call({ origin: 'https://evil.example', host: 'kmt.example', 'x-forwarded-proto': 'https' }), 403)
  assert.equal(await call({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }), 200, 'plain http still works locally')
  assert.equal(await call({}), 200, 'a request with no Origin at all is allowed')
})

test('page import applies a size only when every page has arrived', t => {
  const db = setup(t)
  const importer = new PageImporter(db)
  const page = (n, tires) => ({ sessionId: 'imp-abcdef12', size: SIZE, page: n, totalPages: 2,
    html: pageHtml(tires) })

  const first = importer.addPage(page(1, [tire('giga-p1')]))
  assert.equal(first.complete, false)
  assert.equal(first.received, 1)
  assert.equal(db.list().total, 1, 'nothing is written until the size is complete')

  const second = importer.addPage(page(2, [tire('giga-p2')]))
  assert.equal(second.complete, true)
  assert.equal(second.tires, 2)
  const rows = db.list().items
  const active = rows.filter(r => r.supplierActive).map(r => r.id).sort()
  assert.deepEqual(active, ['giga-p1', 'giga-p2'], 'both pages landed and are the live listing')
  // The seeded row is kept but marked inactive rather than deleted, which is
  // what preserves an owner price on a tire the supplier stopped listing.
  assert.deepEqual(rows.filter(r => !r.supplierActive).map(r => r.id), ['giga-a'])
})

test('page import refuses input that would corrupt a size', t => {
  const db = setup(t)
  const importer = new PageImporter(db)
  const base = { sessionId: 'imp-abcdef12', size: SIZE, page: 1, totalPages: 1, html: pageHtml([tire()]) }

  assert.throws(() => importer.addPage({ ...base, sessionId: 'no' }), /Invalid import session/)
  assert.throws(() => importer.addPage({ ...base, size: '999/99R99' }), /not a size KMT supports/)
  assert.throws(() => importer.addPage({ ...base, page: 3 }), /Invalid page numbering/)
  assert.throws(() => importer.addPage({ ...base, totalPages: 0 }), /Invalid page numbering/)
  assert.throws(() => importer.addPage({ ...base, html: '' }), /Empty page/)
  // A WAF challenge is a real response with no tires in it.
  assert.throws(() => importer.addPage({ ...base, html: '<html><body>challenge</body></html>' }), /No tires found/)
  assert.equal(db.list().total, 1, 'the seeded row is untouched by every rejection')
})

test('page import will not mix two different reads of a listing', t => {
  const db = setup(t)
  const importer = new PageImporter(db)
  importer.addPage({ sessionId: 'imp-abcdef12', size: SIZE, page: 1, totalPages: 3, html: pageHtml([tire('giga-p1')]) })
  // The listing gained or lost a page between requests.
  assert.throws(() => importer.addPage({ sessionId: 'imp-abcdef12', size: SIZE, page: 2, totalPages: 4,
    html: pageHtml([tire('giga-p2')]) }), /listing changed while importing/)
  // The half-finished session was discarded, not left to be completed: sending
  // page 1 again starts from one received page, not two.
  const restarted = importer.addPage({ sessionId: 'imp-abcdef12', size: SIZE, page: 1, totalPages: 3,
    html: pageHtml([tire('giga-p1')]) })
  assert.equal(restarted.received, 1)
  assert.equal(restarted.complete, false)
  assert.equal(db.list().total, 1, 'and nothing reached the database meanwhile')
})

test('import tokens cannot be swapped for session tokens', () => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }
  const config = readAuthConfig(env)
  const auth = createAuth(config)
  const importToken = createImportToken(config)

  assert.equal(verifyImportToken(config, importToken), true)
  // The import token must not unlock the workspace...
  assert.equal(auth.isAuthenticated({ headers: { cookie: `kmt_owner=${importToken}` }, socket: {} }), false)
  // ...and it must not be accepted by a different secret.
  assert.equal(verifyImportToken(readAuthConfig({ ...env, KMT_SESSION_SECRET: 'secret-two' }), importToken), false)
  assert.equal(auth.isImportAuthorized({ headers: { authorization: `Bearer ${importToken}` } }), true)
  assert.equal(auth.isImportAuthorized({ headers: { authorization: 'Bearer nonsense' } }), false)
  assert.equal(auth.isImportAuthorized({ headers: {} }), false)
})

test('a session-derived token is not accepted as a mail-status monitor token', () => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }
  const config = readAuthConfig(env)
  const importToken = createImportToken(config)
  const monitorConfig = readMonitorConfig({ KMT_MONITOR_TOKEN: 'a-real-monitor-token' })

  // A signed, purpose-scoped token minted from KMT_SESSION_SECRET -- of any
  // purpose, import included -- must not unlock the monitor route: the
  // monitor token is a standalone shared secret, not verified against that
  // signature at all, the same separation import tokens and session tokens
  // get above.
  assert.equal(
    isMonitorAuthorized(monitorConfig, { headers: { authorization: `Bearer ${importToken}` } }),
    false,
  )
  assert.equal(
    isMonitorAuthorized(monitorConfig, { headers: { authorization: 'Bearer a-real-monitor-token' } }),
    true,
  )
  assert.equal(isMonitorAuthorized(monitorConfig, { headers: { authorization: 'Bearer nonsense' } }), false)
  assert.equal(isMonitorAuthorized(monitorConfig, { headers: {} }), false)
  // No token configured: nobody is ever authorized, which is what keeps the
  // route 404 rather than open until KMT_MONITOR_TOKEN is set.
  const unconfigured = readMonitorConfig({})
  assert.equal(isMonitorAuthorized(unconfigured, { headers: { authorization: 'Bearer anything' } }), false)
})

/* ------------------------------------------------------------------ catalog */

/**
 * Two tires in one snapshot. Not setup(t) plus a second import: importSnapshot
 * returns early once the database is seeded, so a later import is a silent
 * no-op and the second tire would never exist.
 */
function twoTires(t) {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([tire('giga-a'), tire('giga-b', { name: 'Second Tire' })]))
  return db
}

test('the customer catalog quotes the owner price, and markup only where he has not set one', async t => {
  const db = twoTires(t)
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))
  db.saveMarkup({ rate: 1.4 })

  const rows = db.catalog()
  const owned = rows.find(row => row.id === 'giga-a')
  const marked = rows.find(row => row.id === 'giga-b')

  assert.equal(owned.price, 89.99, 'the price the owner set is the price the customer sees')
  assert.equal(marked.price, 70, 'and a tire he has not priced is marked up from supplier cost')
  // Not a second implementation of the rule: the same function the owner
  // screen prices with, so the two can never disagree.
  assert.equal(marked.price, quotedPrice({
    supplierPrice: 50, offer: undefined, tire: tire('giga-b'), settings: db.getMarkup(),
  }).price)
})

test('the owner price wins over any rate, including one saved afterwards', async t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))
  db.saveMarkup({ rate: 4 })

  assert.equal(db.catalog()[0].price, 89.99, 'a decision outranks a rule')
})

test('a tire the owner switched off, or that has no usable price, is not in the catalog', async t => {
  const db = twoTires(t)
  db.saveMarkup({ rate: 1.4 })
  db.saveOffer('giga-a', offer({ priceCents: null, enabled: false }))

  const ids = db.catalog().map(row => row.id)
  assert.ok(!ids.includes('giga-a'), 'a deliberate no stays a no')
  assert.ok(ids.includes('giga-b'), 'and it does not take the rest of the catalog with it')

  // And a tire whose cost is no longer usable. validateTire refuses to import
  // one, so the only way to hold this state is the way a bad refresh would
  // leave it: a stored row whose price has gone. Markup invents nothing from
  // it, and the customer is not quoted a tire nobody can price.
  db.db.prepare("UPDATE supplier SET payload=json_set(payload,'$.price',null) WHERE id=?").run('giga-b')
  assert.deepEqual(db.catalog(), [], 'no usable cost means no row')
})

test('a catalog row is shaped exactly like a buildCatalog row, and carries nothing else', async t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))

  const [row] = db.catalog()
  // `specPoints` joins the seven: the supplier's spec codes, decoded into
  // English by backend/tire-spec.mjs. Derived from the description that
  // already crosses, so nothing NEW about the tire is exposed -- and approved
  // by name in CATALOG_OPTIONAL_FIELDS, which backend/catalog-boundary.test.mjs
  // holds against what catalog() can actually emit. The leak assertions below
  // are untouched and are the reason this test exists.
  const expected = ['id', 'name', 'size', 'price', 'inStock', 'category', 'description', 'specPoints']

  assert.deepEqual(Object.keys(row).sort(), [...expected].sort(), 'field for field')
  // The supplier's own numbers are the thing the customer must never see.
  assert.equal(row.source, undefined, 'no supplier block')
  for (const leak of ['sku', 'listPrice', 'stock', 'notes', 'offer', 'supplierPrice', 'lastSeen']) {
    assert.equal(row[leak], undefined, `no ${leak}`)
  }
  assert.deepEqual(row, {
    id: 'giga-a', name: 'Test Touring', size: SIZE, price: 89.99,
    inStock: true, category: 'all-season', description: '95H BSW',
    specPoints: ['Carries up to 1,521 lb per tire (load index 95).', 'Rated to 130 mph (speed rating H).', 'Black sidewall.'],
  })
})

test('the catalog answers a customer with no session, while the owner API still does not', async t => {
  // The gate refuses everything under /api/ without a session. This is the one
  // exemption a customer needs, and it must not become a hole in the rest.
  const db = setup(t)
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' }))
  const api = createApi(db, new Refresher(db))
  const catalogApi = createCatalogApi(db)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (url.pathname.startsWith('/api/')) {
      if (!isPublicApiCall(request.method, url.pathname) && !auth.isAuthenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
        return
      }
      if (await catalogApi(request, response)) return
      if (await api(request, response)) return
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  const answer = await fetch(`${base}/api/catalog`)
  assert.equal(answer.status, 200, 'a customer is not signed in and still gets a catalog')
  assert.match(answer.headers.get('content-type'), /application\/json/)
  const body = await answer.json()
  assert.equal(body.tires.length, 1)
  assert.equal(body.tires[0].price, 89.99)
  assert.equal(body.tires[0].source, undefined, 'not even over the wire')

  assert.equal((await fetch(`${base}/api/owner/inventory`)).status, 401, 'the owner API is still shut')
  assert.equal((await fetch(`${base}/api/owner/markup`)).status, 401)
  assert.equal(
    (await fetch(`${base}/api/catalog`, { method: 'POST' })).status, 401,
    'the exemption is for reading the catalog, not for the path',
  )
})

test('the public catalog returns plain descriptions without changing tire identity or price', async t => {
  const db = new Inventory(':memory:', [SIZE])
  t.after(() => db.close())
  db.importSnapshot(snapshot([tire('giga-a', {
    description: 'score&lt;sup&gt;®&lt;/sup&gt; &amp; touring<script>alert(1)</script>',
  })]))
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))
  assert.equal(db.list().items[0].description, 'score® & touring', 'future imports persist normalized copy')
  // Simulate a row written before ingress normalization existed. The read
  // boundary must protect customers without a production backfill.
  db.db.prepare("UPDATE supplier SET payload=json_set(payload,'$.description',?) WHERE id=?")
    .run('score&lt;sup&gt;®&lt;/sup&gt; &amp; touring<script>alert(1)</script> \ud800', 'giga-a')

  const catalogApi = createCatalogApi(db)
  const server = createServer(async (request, response) => {
    if (await catalogApi(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const answer = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog`)
  const raw = await answer.text()
  assert.equal(answer.status, 200)
  assert.doesNotMatch(raw, /&lt;|&gt;|<\/?(?:sup|script)\b/i, 'no encoded or literal supplier markup crosses the API')
  const [row] = JSON.parse(raw).tires
  assert.deepEqual(
    { id: row.id, name: row.name, size: row.size, price: row.price, description: row.description },
    { id: 'giga-a', name: 'Test Touring', size: SIZE, price: 89.99, description: 'score® & touring �' },
  )
})

test('a deeply nested historical supplier description cannot take down the public catalog', async t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))
  const historical = '&lt;b&gt;'.repeat(5000) + 'Grip' + '&lt;/b&gt;'.repeat(5000)
  db.db.prepare("UPDATE supplier SET payload=json_set(payload,'$.description',?) WHERE id=?")
    .run(historical, 'giga-a')

  const [row] = db.catalog()
  assert.deepEqual(
    { id: row.id, name: row.name, size: row.size, price: row.price, description: row.description },
    { id: 'giga-a', name: 'Test Touring', size: SIZE, price: 89.99, description: 'Grip' },
  )
})

test('a tire the supplier has delisted stays in the catalog, out of stock, however it was priced', async t => {
  // Both ways a row can reach the catalog, because the flag has to win in
  // each: the owner set a price, and markup proposed one for a tire he never
  // touched. There is no third state -- saveOffer refuses an enabled offer
  // with no price, so "marked up" and "untouched" are the same row here.
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([
    tire('giga-a'),
    tire('giga-b', { name: 'Second Tire' }),
  ]))
  db.saveMarkup({ rate: 1.4 })
  db.saveOffer('giga-a', offer({ priceCents: 8999 }))

  const before = Object.fromEntries(db.catalog().map(row => [row.id, row]))
  assert.deepEqual(
    ['giga-a', 'giga-b'].map(id => before[id].inStock), [true, true],
    'both are sellable while the supplier still lists them',
  )

  // The supplier's next page no longer carries them. That is what delisting
  // looks like from here -- nothing is deleted, the rows just go inactive.
  db.refreshSize(SIZE, [tire('giga-z', { name: 'Replacement' })])

  const after = Object.fromEntries(db.catalog().map(row => [row.id, row]))
  for (const id of ['giga-a', 'giga-b']) {
    assert.ok(after[id], `${id} is still in the catalog rather than vanishing mid-request`)
    assert.equal(after[id].inStock, false, `${id} is out of stock once delisted`)
  }
  assert.equal(after['giga-a'].price, 89.99, 'and the owner price it carried is untouched')
  assert.equal(after['giga-b'].price, 70, 'as is the marked-up one')
  assert.equal(after['giga-z'].inStock, true, 'while what the supplier does list is still in stock')
})

test('an enabled tire may use markup pricing with an individual shipping override', t => {
  const db = setup(t)
  db.saveMarkup({ rate: 1.5, shippingPerTire: 8 })
  db.saveOffer('giga-a', offer({ priceCents: null, shippingCents: 1200 }))

  const owner = db.list().items[0]
  assert.deepEqual(owner.offer, {
    priceCents: null, shippingCents: 1200, enabled: true, notes: 'Owner choice',
    categoryOverride: null, descriptionOverride: null, version: 1,
  }, 'the owner round trip keeps cents and distinguishes an override from the global value')

  const [customer] = db.catalog()
  assert.equal(customer.price, 87, '(50 × 1.5) + the $12 individual override')
  assert.deepEqual(Object.keys(customer).sort(), ['category', 'description', 'id', 'inStock', 'name', 'price', 'size', 'specPoints'])
  assert.doesNotMatch(JSON.stringify(customer), /shipping/i, 'shipping remains internal to the final tire price')

  db.saveOffer('giga-a', { ...owner.offer, shippingCents: 0 })
  assert.equal(db.catalog()[0].price, 75, 'explicit zero overrides global shipping; zero is not unset')

  const zero = db.list().items[0].offer
  db.saveOffer('giga-a', { ...zero, shippingCents: null })
  assert.equal(db.catalog()[0].price, 83, 'null clears the override and returns to $8 global shipping')
})

test('an existing offers table gains nullable shipping cents without changing owner prices', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-shipping-migration-test-'))
  const filename = path.join(folder, 'test.sqlite')
  let db
  try {
    db = new Inventory(filename, [SIZE])
    db.importSnapshot(snapshot([tire()]))
    db.saveOffer('giga-a', offer())

    // Rebuild only the fixture to the exact pre-override schema. Opening it
    // again must take Inventory's additive column path, like production.
    db.db.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE offers_old (
        id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        CHECK(price_cents IS NULL OR price_cents > 0)
      );
      INSERT INTO offers_old SELECT id, price_cents, enabled, notes, version, updated_at FROM offers;
      DROP TABLE offers;
      ALTER TABLE offers_old RENAME TO offers;
      PRAGMA foreign_keys=ON;
    `)
    db.close()

    db = new Inventory(filename, [SIZE])
    const columns = db.db.prepare('PRAGMA table_info(offers)').all().map(column => column.name)
    // Every column added to `offers` after it first shipped, not just the one
    // this test was written for. The fixture above rebuilds the table to the
    // ORIGINAL schema, so each of these is genuinely absent when the database
    // is reopened -- an assertion that could not fail is worth nothing, and
    // this one is the only thing standing between a new column and a
    // production database that never runs the CREATE statement.
    for (const column of ['shipping_cents', 'category_override', 'description_override']) {
      assert.ok(columns.includes(column), `reopening an old database did not add ${column}`)
    }
    assert.deepEqual(db.list().items[0].offer, {
      ...offer(), shippingCents: null, categoryOverride: null, descriptionOverride: null, version: 1,
    }, 'the old owner decision survives and the new override starts unset')
  } finally {
    db?.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('brandSummary groups supplier rows by brand, most tires first, with per-brand price and enabled counts', t => {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([
    brandTire('giga-a', 'hankook'),
    brandTire('giga-b', 'hankook', { size: otherSize }),
    brandTire('giga-c', 'nokian'),
  ], { [SIZE]: fullRead, [otherSize]: fullRead }))
  db.saveOffer('giga-a', offer({ priceCents: 8999, version: 0 }))

  const brands = db.brandSummary()
  assert.deepEqual(brands.map(b => b.brand), ['hankook', 'nokian'], 'more tires first')
  const hankook = brands.find(b => b.brand === 'hankook')
  assert.equal(hankook.label, 'Hankook')
  assert.equal(hankook.count, 2)
  assert.equal(hankook.sizeCount, 2, 'across both sizes it was imported under')
  assert.equal(hankook.enabledCount, 1, 'only giga-a has an offer, and it is enabled')
  assert.equal(hankook.missingPriceCount, 1, 'giga-b has never been priced')
  const nokian = brands.find(b => b.brand === 'nokian')
  assert.equal(nokian.count, 1)
  assert.equal(nokian.enabledCount, 0)
  assert.equal(nokian.missingPriceCount, 1)
})

test('setBrandEnabled enables every row for a brand in one call, creating an offer for a tire that never had one', t => {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([
    brandTire('giga-a', 'hankook'),
    brandTire('giga-b', 'hankook', { size: otherSize }),
    brandTire('giga-c', 'nokian'),
  ], { [SIZE]: fullRead, [otherSize]: fullRead }))

  const result = db.setBrandEnabled('hankook', true)
  assert.deepEqual(result, { brand: 'hankook', enabled: true, updated: 2, missingPriceCount: 2 })

  const rows = Object.fromEntries(db.list({ filter: 'all' }).items.map(t => [t.id, t]))
  assert.equal(rows['giga-a'].offer.enabled, true)
  assert.equal(rows['giga-a'].offer.priceCents, null, 'enabling with no price does not invent one -- this is the confirmed-by-the-owner exception to saveOffer\'s rule above')
  assert.equal(rows['giga-b'].offer.enabled, true)
  assert.equal(rows['giga-c'].offer.enabled, false, 'a different brand is untouched')
})

test('setBrandEnabled leaves an existing price and notes alone, and bumps version rather than resetting it', t => {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([brandTire('giga-a', 'hankook')]))
  db.saveOffer('giga-a', offer({ priceCents: 8999, notes: 'Ken’s pick', version: 0 }))

  db.setBrandEnabled('hankook', false)
  const disabled = db.list().items.find(t => t.id === 'giga-a')
  assert.equal(disabled.offer.enabled, false)
  assert.equal(disabled.offer.priceCents, 8999, 'price survives a bulk toggle')
  assert.equal(disabled.offer.notes, 'Ken’s pick', 'notes survive a bulk toggle')
  assert.equal(disabled.offer.version, 2, 'bumped from the version saveOffer left it at (1), not reset to 1')

  db.setBrandEnabled('hankook', true)
  const reenabled = db.list().items.find(t => t.id === 'giga-a')
  assert.equal(reenabled.offer.enabled, true)
  assert.equal(reenabled.offer.priceCents, 8999)
  assert.equal(reenabled.offer.version, 3)
})

test('setBrandEnabled on a brand with no matching rows refuses rather than silently updating nothing', t => {
  const db = setup(t)
  assert.throws(() => db.setBrandEnabled('no-such-brand', true), /No supplier tires found/)
})

test('setBrandEnabled rejects a non-boolean enabled value', t => {
  const db = new Inventory(':memory:', [SIZE])
  t.after(() => db.close())
  db.importSnapshot(snapshot([brandTire('giga-a', 'hankook')]))
  assert.throws(() => db.setBrandEnabled('hankook', 'yes'), /enabled must be true or false/)
})

test('summary().brands matches brandSummary(), so the owner screen gets it in the same round trip as the inventory list', t => {
  const db = new Inventory(':memory:', [SIZE])
  t.after(() => db.close())
  db.importSnapshot(snapshot([brandTire('giga-a', 'hankook')]))
  assert.deepEqual(db.summary().brands, db.brandSummary())
})

test('a snapshot applied to a live database upserts rows and leaves offers and unlisted tires alone', t => {
  // The default import is a partial view: the scraper keeps the cheapest few
  // per size, so a tire it did not mention is not a tire the supplier dropped.
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  const result = db.applySnapshot(snapshot([
    tire('giga-a', { price: 72 }),
    tire('giga-b'),
    tire('giga-c', { size: otherSize }),
  ]))
  assert.deepEqual(result.sizes, [
    { size: SIZE, tires: 2, added: 1, changed: 1, unchanged: 0, retired: 0 },
    { size: otherSize, tires: 1, added: 1, changed: 0, unchanged: 0, retired: 0 },
  ])
  assert.equal(result.dryRun, false)
  const rows = Object.fromEntries(db.list().items.map(row => [row.id, row]))
  assert.equal(rows['giga-a'].price, 72, 'supplier data moved')
  assert.deepEqual(rows['giga-a'].offer, { ...offer(), shippingCents: null, categoryOverride: null, descriptionOverride: null, version: 1 }, 'the owner price and choice did not')
  assert.equal(rows['giga-b'].supplierActive, true)
  assert.equal(db.summary().importedSizeCount, 2, 'a partial import is labelled as such')
  assert.equal(db.summary().job.status, 'completed', 'and /owner is told')
  assert.equal(db.summary().job.tiresRead, 3)

  // Applying the same file again changes nothing and says so.
  const again = db.applySnapshot(snapshot([tire('giga-a', { price: 72 }), tire('giga-b'), tire('giga-c', { size: otherSize })]))
  assert.deepEqual(again.sizes.map(s => [s.added, s.changed, s.unchanged]), [[0, 0, 2], [0, 0, 1]])
})

test('a complete snapshot retires what it does not list, exactly as a refresh would', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  const dry = db.applySnapshot(snapshot([tire('giga-b')]), { complete: true, dryRun: true })
  assert.deepEqual(dry.sizes, [{ size: SIZE, tires: 1, added: 1, changed: 0, unchanged: 0, retired: 1 }])
  assert.equal(db.list().total, 1, 'a dry run wrote nothing')
  assert.equal(db.list().items[0].id, 'giga-a')
  assert.equal(db.summary().job, null)

  db.applySnapshot(snapshot([tire('giga-b')]), { complete: true })
  const rows = Object.fromEntries(db.list().items.map(row => [row.id, row]))
  assert.equal(rows['giga-a'].supplierActive, false, 'delisted, not deleted')
  assert.equal(rows['giga-a'].offer.enabled, true, 'with the owner offer intact')
  assert.equal(rows['giga-b'].supplierActive, true)
  assert.equal(db.summary().fullSizeCount, 1)
  // A relisted tire counts as a change, not as unchanged.
  const back = db.applySnapshot(snapshot([tire('giga-a'), tire('giga-b')]), { complete: true, dryRun: true })
  assert.deepEqual(back.sizes[0], { size: SIZE, tires: 2, added: 0, changed: 1, unchanged: 1, retired: 0 })
})

test('a snapshot that would corrupt the database is refused whole', t => {
  const db = setup(t)
  const bad = [
    null,
    { source: 'somewhere-else', scrapedAt: '2026-09-05T15:00:00Z', tires: [tire()] },
    { ...snapshot([tire()]), scrapedAt: 'yesterday' },
    snapshot([]),
    snapshot([tire('giga-b'), tire('giga-b')]),
    snapshot([tire('giga-b', { size: '999/99R99' })]),
    snapshot([tire('giga-b', { price: 0 })]),
    snapshot([tire('giga-b'), { id: 'not-giga', name: 'x', size: SIZE, price: 1, inStock: true, category: 'a', source: { sku: 'x' } }]),
  ]
  for (const input of bad) assert.throws(() => db.applySnapshot(input), { status: 400 })
  assert.equal(db.list().total, 1, 'nothing landed from any of them')
  assert.equal(db.summary().job, null)
})

/** The hosted server's gate, reduced to what the import route needs. */
function gatedServer(t, db, refresher = new Refresher(db)) {
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' }))
  const api = createApi(db, refresher)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (url.pathname.startsWith('/api/') && !auth.isAuthenticated(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
      return
    }
    if (await api(request, response)) return
    response.writeHead(404).end()
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise(done => server.close(done)))
    resolve({ base: `http://127.0.0.1:${server.address().port}`, refresher })
  }))
}

test('the snapshot route needs the owner session and waits for a refresh to finish', async t => {
  const db = setup(t)
  let release
  const refresher = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    fetchSizePage: () => new Promise((_, reject) => { release = reject }), close: async () => {},
  }) })
  const { base } = await gatedServer(t, db, refresher)
  const post = (body, cookie) => fetch(`${base}/api/owner/import-snapshot`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
  }, body: JSON.stringify(body) })

  assert.equal((await post({ snapshot: snapshot([tire('giga-b')]) })).status, 401)
  const login = await fetch(`${base}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'a-long-enough-password' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]

  refresher.start([SIZE])
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  const busy = await post({ snapshot: snapshot([tire('giga-b')]) }, cookie)
  assert.equal(busy.status, 409)
  release(new Error('stop')); await refresher.done

  assert.equal((await post({ snapshot: { source: 'nope' } }, cookie)).status, 400)
  const ok = await post({ snapshot: snapshot([tire('giga-b')]), dryRun: true }, cookie)
  assert.equal(ok.status, 200)
  assert.deepEqual((await ok.json()).sizes[0], { size: SIZE, tires: 1, added: 1, changed: 0, unchanged: 0, retired: 0 })
  assert.equal(db.list().total, 1, 'the dry run wrote nothing')
  assert.equal((await post({ snapshot: snapshot([tire('giga-b')]) }, cookie)).status, 200)
  assert.equal(db.list().total, 2)
})

test('scripts/import-tires.mjs pushes a snapshot file into a password-gated server', async t => {
  const { execFile } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  const { base } = await gatedServer(t, db)

  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-import-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'scrape.json')
  writeFileSync(file, JSON.stringify(snapshot([tire('giga-a', { price: 72 }), tire('giga-b'), tire('giga-c', { size: otherSize })])))

  const script = path.resolve(import.meta.dirname, '../scripts/import-tires.mjs')
  const run = (args, env = {}) => new Promise(resolve => execFile(process.execPath, [script, file, '--to', base, ...args],
    { env: { ...process.env, KMT_OWNER_PASSWORD: '', ...env } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))

  const refused = await run([])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /KMT_OWNER_PASSWORD/, 'tells you what is missing')
  assert.equal(db.list().total, 1)

  const wrong = await run([], { KMT_OWNER_PASSWORD: 'not-the-password' })
  assert.equal(wrong.code, 1)
  assert.match(wrong.stderr, /Sign-in refused/)

  const dry = await run(['--dry-run', '--sizes', '215-60-16'], { KMT_OWNER_PASSWORD: 'a-long-enough-password' })
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /Would import 2 tires across 1 size/)
  assert.match(dry.stdout, /1 new, 1 changed, 0 unchanged/)
  assert.equal(db.list().total, 1)

  const done = await run([], { KMT_OWNER_PASSWORD: 'a-long-enough-password' })
  assert.equal(done.code, 0, done.stderr)
  assert.match(done.stdout, /Imported 3 tires across 2 sizes/)
  const rows = Object.fromEntries(db.list().items.map(row => [row.id, row]))
  assert.equal(rows['giga-a'].price, 72)
  assert.equal(rows['giga-a'].offer.priceCents, 8999, 'the owner price survived the import')
  assert.equal(rows['giga-c'].size, otherSize)
})

test('scripts/import-tires.mjs accepts a minted session, checked before the password, and needs no password at all', async t => {
  // The scenario the cutover exists for: KMT_OWNER_PASSWORD unset entirely,
  // the way a server looks once Google-only sign-in has retired it.
  const { execFile } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const db = setup(t)
  db.saveOffer('giga-a', offer())

  const config = readSessionSigningConfig({ KMT_SESSION_SECRET: 'import-tires-mint-secret' })
  const sessions = memorySessionStore()
  const auth = createAuth({ ...config, password: 'unused' }, { sessions })
  const api = createApi(db, new Refresher(db))
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (url.pathname.startsWith('/api/') && !auth.isAuthenticated(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
      return
    }
    if (await api(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(done => server.close(done)))
  const base = `http://127.0.0.1:${server.address().port}`

  const minted = mintSession(config, sessions)
  const cookie = `${minted.name}=${minted.value}`

  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-import-mint-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'scrape.json')
  writeFileSync(file, JSON.stringify(snapshot([tire('giga-a', { price: 72 })])))

  const script = path.resolve(import.meta.dirname, '../scripts/import-tires.mjs')
  const run = (env = {}) => new Promise(resolve => execFile(process.execPath, [script, file, '--to', base],
    { env: { ...process.env, KMT_OWNER_PASSWORD: '', KMT_OWNER_SESSION_COOKIE: '', ...env } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))

  // A wrong minted cookie must not fall back to the (unset) password and
  // succeed anyway -- it should fail the same way a wrong password does.
  // On its own this cannot tell "sent the bad cookie and was refused" apart
  // from "ignored the cookie, sent nothing, was refused the same way" --
  // both produce exit 1 here. It is the positive assertion right below,
  // proving a *correct* minted cookie succeeds, that rules the second
  // reading out: if the cookie were never being sent, that call would fail
  // too. Keep both together -- weakening the one below silently empties
  // this one of what it proves.
  const wrongMint = await run({ KMT_OWNER_SESSION_COOKIE: 'kmt_owner=not-a-real-session' })
  assert.equal(wrongMint.code, 1)
  assert.match(wrongMint.stderr, /wants a credential/)

  const result = await run({ KMT_OWNER_SESSION_COOKIE: cookie })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Imported 1 tire across 1 size/)
  assert.equal(db.list().items.find(row => row.id === 'giga-a').price, 72)
})

test('scripts/import-tires.mjs refuses a malformed KMT_OWNER_SESSION_COOKIE before ever asking the server', async t => {
  const { execFile } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-import-badmint-test-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'scrape.json')
  writeFileSync(file, JSON.stringify(snapshot([tire('giga-a')])))

  const script = path.resolve(import.meta.dirname, '../scripts/import-tires.mjs')
  // Port 1 is refused instantly by the OS -- if the script reached the
  // network at all this would fail with a connection error, not the format
  // message, which is how this proves the check runs before any request.
  const run = (env) => new Promise(resolve => execFile(process.execPath, [script, file, '--to', 'http://127.0.0.1:1'],
    { env: { ...process.env, KMT_OWNER_PASSWORD: '', ...env } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))

  const result = await run({ KMT_OWNER_SESSION_COOKIE: 'no-equals-sign' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /KMT_OWNER_SESSION_COOKIE must be "name=value"/)
})

test('a complete import is refused for a size the scraper did not read in full', t => {
  // The tires a trimmed scrape does not mention are ones it did not fetch, not
  // ones the supplier dropped. Retiring them would take tires off Ken's list.
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  const trimmed = snapshot([tire('giga-b')], { [SIZE]: { limit: 8, pagesRead: 1, totalPages: 3, complete: false } })
  assert.throws(() => db.applySnapshot(trimmed, { complete: true }), { status: 400, message: /215\/60R16/ })
  const unrecorded = { ...snapshot([tire('giga-b')]), coverage: undefined }
  assert.throws(() => db.applySnapshot(unrecorded, { complete: true }), { status: 400, message: /215\/60R16/ })
  assert.throws(() => db.applySnapshot({ ...snapshot([tire('giga-b')]), coverage: [] }), { status: 400 })
  assert.equal(db.list().total, 1, 'nothing landed')
  assert.equal(db.list().items[0].supplierActive, true, 'and nothing was retired')

  // The same file is welcome as the partial view it is.
  db.applySnapshot(trimmed)
  assert.equal(db.list().total, 2)
  assert.equal(db.list().items.every(row => row.supplierActive), true)
})

test('the scraper records what it read, and only a full read counts as complete', async t => {
  const { buildSnapshot, sizeCoverage } = await import('../scripts/scrape-tires.mjs')
  t.diagnostic('importing the scraper module must not start a scrape')

  assert.equal(sizeCoverage({ limit: 0, pagesRead: 7, totalPages: 7 }).complete, true)
  assert.equal(sizeCoverage({ limit: 8, pagesRead: 7, totalPages: 7 }).complete, false, 'a limit trims the list')
  assert.equal(sizeCoverage({ limit: 0, pagesRead: 1, totalPages: 7 }).complete, false, 'so does stopping early')

  const previous = snapshot([tire('giga-old', { size: otherSize })])
  const { snapshot: next, carried } = buildSnapshot({
    previous, tires: [tire('giga-b')], replace: false, scrapedAt: '2026-09-06T00:00:00Z',
    coverage: { [SIZE]: sizeCoverage({ limit: 8, pagesRead: 1, totalPages: 3, scrapedAt: '2026-09-06T00:00:00Z' }) },
  })
  assert.deepEqual(next.sizes, [SIZE, otherSize])
  assert.equal(next.coverage[SIZE].complete, false)
  assert.deepEqual(next.coverage[otherSize], fullRead, 'a size this run did not touch keeps its record')
  assert.equal(carried.length, 1)
  assert.equal(next.tires.length, 2)

  const replaced = buildSnapshot({ previous, tires: [tire('giga-b')], replace: true, coverage: { [SIZE]: fullRead } }).snapshot
  assert.deepEqual(Object.keys(replaced.coverage), [SIZE], '--replace drops the untouched size and its record')
})

test('a confirmed-empty size keeps its record on a run that does not touch it', async () => {
  // A genuinely empty size (read in full, nothing there) has no tire to ride
  // along on. Keying the carry-forward off carried tires, as an earlier
  // version did, silently dropped every such size's record the moment a
  // later run did not re-scrape it -- the exact loss #81 exists to prevent,
  // just one run later.
  const { buildSnapshot } = await import('../scripts/scrape-tires.mjs')
  const emptySize = '165/70R15'
  const previous = {
    ...snapshot([tire('giga-old', { size: otherSize })]),
    coverage: {
      [otherSize]: fullRead,
      [emptySize]: { limit: 0, pagesRead: 1, totalPages: 1, complete: true, scrapedAt: '2026-09-05T15:00:00Z' },
    },
  }

  const { snapshot: next } = buildSnapshot({
    previous, tires: [tire('giga-b')], replace: false, scrapedAt: '2026-09-06T00:00:00Z',
    coverage: { [SIZE]: fullRead },
  })

  assert.deepEqual(next.coverage[emptySize], previous.coverage[emptySize], 'the empty size\'s record survives untouched')
  assert.ok(next.sizes.includes(emptySize), 'and it still counts as a covered size')
  assert.equal(next.tires.some(t => t.size === emptySize), false, 'with no tires manufactured for it')
})

test('the minimum interval between sizes holds on a run of empties, not just hits', async () => {
  // The trap this guards against: before #129, an empty size took ~20s to
  // conclude, which paced requests as a side effect. #129 made empties fast,
  // and removed that pacing on exactly the runs that are mostly empty. If
  // the interval below can be shrunk by a fast result, we have rebuilt the
  // same trap in a new shape -- so this proves the spacing on a run where
  // every single size returns instantly empty, the worst case for it.
  const { scrapeAll } = await import('../scripts/scrape-tires.mjs')
  const sizes = ['165/70R15', '165/75R15', '175/70R15', '185/50R15']
  const starts = []
  const fetcher = async () => {
    starts.push(Date.now())
    return { html: '<html><body>no results here</body></html>' }
  }

  const result = await scrapeAll(sizes, { pages: 1, limit: 0, delay: 0, minInterval: 150 }, fetcher)

  assert.equal(result.tires.length, 0, 'every size was genuinely empty')
  assert.equal(Object.keys(result.coverage).length, 4, 'all four recorded as read, not skipped')
  assert.equal(starts.length, 4)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1]
    assert.ok(gap >= 140, `gap before size ${i} was ${gap}ms; expected the ~150ms floor to hold even though the fetch itself was instant`)
  }
})

test('a 429 stops the whole run immediately, not a per-size failure to log and continue', async () => {
  const { scrapeAll } = await import('../scripts/scrape-tires.mjs')
  const { RateLimitedError } = await import('../scripts/browser-fetch.mjs')
  const sizes = ['165/70R15', '165/75R15', '175/70R15']
  let calls = 0
  const fetcher = async () => {
    calls++
    if (calls === 2) throw new RateLimitedError('429 from a test fixture', '30')
    return { html: '<html><body>no results here</body></html>' }
  }

  const result = await scrapeAll(sizes, { pages: 1, limit: 0, delay: 0, minInterval: 1 }, fetcher)

  assert.equal(calls, 2, 'the third size was never attempted')
  assert.deepEqual(result.stoppedOnRateLimit, { size: '165/75R15', retryAfter: '30' })
  assert.equal(result.failures.length, 0, 'a 429 is not a failure entry -- it is a stop')
  assert.equal(Object.keys(result.coverage).length, 1, 'only the size read before the 429 is recorded')
})

test('scripts/import-tires.mjs refuses --complete for a size that was not read in full', async t => {
  const { execFile } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const db = setup(t)
  db.saveOffer('giga-a', offer())
  const { base } = await gatedServer(t, db)
  const folder = mkdtempSync(path.join(tmpdir(), 'kmt-import-complete-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const script = path.resolve(import.meta.dirname, '../scripts/import-tires.mjs')
  const run = (file, args) => new Promise(resolve => execFile(process.execPath, [script, file, '--to', base, ...args],
    { env: { ...process.env, KMT_OWNER_PASSWORD: 'a-long-enough-password' } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))

  const trimmed = path.join(folder, 'trimmed.json')
  writeFileSync(trimmed, JSON.stringify(snapshot([tire('giga-b')], { [SIZE]: { limit: 8, pagesRead: 1, totalPages: 3, complete: false } })))
  const refused = await run(trimmed, ['--complete'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /Refusing --complete: 215\/60R16 was scraped with --limit 8 over 1 of 3 pages/)
  assert.equal(db.list().total, 1, 'nothing was sent')

  const unrecorded = path.join(folder, 'old.json')
  writeFileSync(unrecorded, JSON.stringify({ ...snapshot([tire('giga-b')]), coverage: undefined }))
  const noRecord = await run(unrecorded, ['--complete'])
  assert.equal(noRecord.code, 1)
  assert.match(noRecord.stderr, /215\/60R16 has no coverage record/)

  const full = path.join(folder, 'full.json')
  writeFileSync(full, JSON.stringify(snapshot([tire('giga-b')])))
  const done = await run(full, ['--complete'])
  assert.equal(done.code, 0, done.stderr)
  assert.match(done.stdout, /1 no longer listed/)
  const rows = Object.fromEntries(db.list().items.map(row => [row.id, row]))
  assert.equal(rows['giga-a'].supplierActive, false, 'a full read may retire')
  assert.equal(rows['giga-a'].offer.enabled, true, 'with the owner offer kept')
})

/*
 * Saving a tire must not take it off sale.
 *
 * These three tests span BOTH halves of the defect deliberately, and that is
 * the point of them. `list()` collapsed "nobody has decided" into "the owner
 * said no" -- `offer.enabled` is `!!row.enabled` over a LEFT JOIN, so a tire
 * with no offers row arrives as `enabled: false` -- and the owner grid then
 * sent that false straight back as part of the next thing Ken saved. Either
 * half alone is enough to put a selling tire out of the customer catalogue,
 * so a test that only inspected `selling.offered` would pass against a
 * correct `list()` bolted to a grid that still sent a stale false.
 *
 * So they import `sellingEnabled` from the owner grid and build the request
 * body the way the screen builds it, then assert on `catalog()` -- the thing
 * a customer actually sees. Reverting either half turns them red.
 *
 * `catalog()` is the assertion rather than any field on `list()` because
 * `catalog()` is the only place the consequence is real. Everything else is
 * a description of it.
 */

/** The body OwnerInventoryGrid commits when only the price field was edited. */
const priceEdit = (item, priceCents) => ({
  priceCents,
  shippingCents: item.offer.shippingCents,
  enabled: sellingEnabled(item),
  notes: item.offer.notes ?? '',
  version: item.offer.version,
})

const sellingIds = db => new Set(db.catalog().map(t => t.id))

test('typing a price into a tire the owner has never touched leaves it on sale', t => {
  const db = setup(t)
  const item = db.list().items.find(row => row.id === 'giga-a')

  assert.equal(item.offer.version, 0, 'the fixture has no offers row, which is the case that broke')
  assert.equal(item.offer.enabled, false, 'and its raw enabled flag is false, which is what misled the grid')
  assert.equal(item.selling.offered, true, 'while the tire is in fact for sale')
  assert.equal(item.selling.source, 'markup', 'at the rule\u2019s price, because nobody has set one')
  assert.ok(sellingIds(db).has('giga-a'), 'the customer catalogue sells it before the save')

  db.saveOffer('giga-a', priceEdit(item, 5999))

  assert.ok(sellingIds(db).has('giga-a'),
    'and still sells it after the owner sets a price \u2014 pricing a tire is not a decision to stop selling it')
  assert.equal(db.catalog().find(t => t.id === 'giga-a').price, 59.99, 'now at the price he set')
})

test('a bulk price write leaves every row it prices on sale', t => {
  const db = setup(t)
  db.importSnapshot(snapshot([tire('giga-a'), tire('giga-b'), tire('giga-c')]))
  db.applySnapshot(snapshot([tire('giga-a'), tire('giga-b'), tire('giga-c')]), { complete: true })
  const items = db.list().items
  assert.equal(items.length, 3)
  assert.equal(sellingIds(db).size, 3, 'all three are for sale before the write')

  // confirmBulk()'s request body: every field carried forward except the one
  // the tool is changing, which is why `enabled` being read from the wrong
  // place did this 200 rows at a time.
  const result = db.saveOffers({ offers: items.map(item => ({ id: item.id, ...priceEdit(item, 7500) })) })
  assert.equal(result.results.filter(r => r.ok).length, 3, 'all three saved')

  assert.equal(sellingIds(db).size, 3, 'and all three are still for sale')
  assert.deepEqual(db.catalog().map(t => t.price), [75, 75, 75])
})

test('a tire the owner switched off stays off when he later edits its price', t => {
  const db = setup(t)

  // The control for the two tests above, and it has to bite on the same
  // helper they do or it controls nothing. An earlier version of this test
  // passed `enabled: false` by hand, which meant `sellingEnabled` could have
  // returned a hardcoded `true` and every test here would still have been
  // green -- verified by doing exactly that: 109/109 passed. So the
  // deselection here is made ONCE, explicitly, and everything after it goes
  // through the same `priceEdit` path the two tests above use.
  const item = db.list().items.find(row => row.id === 'giga-a')
  db.saveOffer('giga-a', { ...priceEdit(item, 5999), enabled: false })
  assert.equal(sellingIds(db).has('giga-a'), false, 'a deliberate no is honoured')

  const off = db.list().items.find(row => row.id === 'giga-a')
  assert.equal(off.selling.offered, false, 'and the screen reports it as not for sale')
  assert.equal(off.offer.version, 1, 'the row now carries a decision')

  // Ken changes his mind about the PRICE of a tire he has switched off. The
  // fix must not read that as switching it back on: `sellingEnabled` has to
  // preserve a real `false`, not merely stop inventing one.
  db.saveOffer('giga-a', priceEdit(off, 6499))
  assert.equal(sellingIds(db).has('giga-a'), false,
    'editing the price of a switched-off tire does not put it back on sale')

  // ...and switching it back on is still a thing he can do.
  const stillOff = db.list().items.find(row => row.id === 'giga-a')
  db.saveOffer('giga-a', { ...priceEdit(stillOff, 6499), enabled: true })
  assert.ok(sellingIds(db).has('giga-a'), 'switching it back on sells it again')
})

test('list() reports the price a customer pays now, by the same rule catalog() uses', t => {
  const db = setup(t)
  const item = db.list().items.find(row => row.id === 'giga-a')

  // Not restated as a literal: the assertion reads BOTH sides out of the code
  // under test, so a change to the markup rule cannot leave this passing
  // against a stale hardcoded number, and a second copy of the rule inside
  // list() would fail it.
  const fromCatalog = db.catalog().find(t => t.id === 'giga-a').price
  assert.equal(item.selling.priceCents, Math.round(fromCatalog * 100),
    'the grid and the customer catalogue name the same price')

  const expected = quotedPrice({ supplierPrice: item.price, offer: undefined, tire: item, settings: db.getMarkup() })
  assert.equal(item.selling.priceCents, Math.round(expected.price * 100))
  assert.equal(item.selling.source, 'markup')

  // Once he prices it, the source flips and the number follows his decision.
  db.saveOffer('giga-a', priceEdit(item, 4200))
  const priced = db.list().items.find(row => row.id === 'giga-a')
  assert.equal(priced.selling.priceCents, 4200)
  assert.equal(priced.selling.source, 'owner', 'his price is a decision, not a suggestion')
})

test('a priced tire that is not for sale is counted and reachable, and nothing repairs it', t => {
  const db = setup(t)
  db.applySnapshot(snapshot([tire('giga-a'), tire('giga-b'), tire('giga-c')]), { complete: true })
  const items = Object.fromEntries(db.list().items.map(row => [row.id, row]))

  assert.equal(db.summary().pricedNotOfferedCount, 0, 'a database nobody has touched has none')

  // The exact state the defect left behind: a price, and not for sale.
  db.saveOffer('giga-a', { ...priceEdit(items['giga-a'], 5999), enabled: false })
  // And the state that is NOT it: switched off with no price, which is an
  // ordinary "I do not carry this" and must not be counted as damage.
  db.saveOffer('giga-b', { ...priceEdit(items['giga-b'], null), enabled: false })

  assert.equal(db.summary().pricedNotOfferedCount, 1,
    'only the priced one counts \u2014 a tire switched off without a price is a normal decision')

  const filtered = db.list({ filter: 'priced-not-offered' })
  assert.deepEqual(filtered.items.map(row => row.id), ['giga-a'],
    'and the filter reaches exactly that row, which is what makes the count actionable')
  assert.equal(filtered.total, 1)

  // The count REPORTS. Reading it, listing it, or reading the row back must
  // not quietly put the tire on sale: the damaged rows are the record of what
  // happened and Ken repairs them deliberately, later.
  db.summary(); db.list({ filter: 'priced-not-offered' }); db.list()
  assert.equal(sellingIds(db).has('giga-a'), false, 'still not for sale after being read three ways')
  assert.equal(db.summary().pricedNotOfferedCount, 1, 'and still counted')
  assert.equal(db.list().items.find(r => r.id === 'giga-a').offer.version, 1,
    'the row was not rewritten by any read')
})

// ---------------------------------------------------------------------------
// The owner's corrections to the supplier's own record.
//
// Two things the supplier gets wrong about tires it sells, neither of which a
// re-scrape can fix, because the supplier's record is what is wrong:
//
//   - the CATEGORY. Measured on the live site 2026-09-13, every row filed
//     `off-road` in 225/50R17 is a road tire -- Bridgestone Turanza EverDrive,
//     Pegasus HPX SPORT AS, Radar Dimax AS-9 -- so the shop was telling
//     customers a touring tire is "built for dirt, gravel and mud", and filing
//     it under a season facet no buyer of it would press.
//   - the DESCRIPTION. Seven rows of 1,083 carry the supplier's own
//     advertising where the description belongs.
// ---------------------------------------------------------------------------

/**
 * The supplier's advertising, copied from the live Armstrong Blu-Trac HP3 row.
 *
 * Not paraphrased and not shortened: its length is the point of one assertion
 * below, and its trailing spec codes are the point of another.
 */
const SUPPLIER_ADVERT = 'Compare tires at a glance using our easy test score® system. Our proprietary algorithm factors in performance, expert insights, user reviews, and Uniform Tire Quality Grading (UTQG) scores. · XL 98Y BSW'

test('the seasons an owner may choose are the shop’s own facet, not a second list of five strings', () => {
  assert.deepEqual([...OVERRIDE_CATEGORIES], Object.keys(SEASON_LABELS),
    'the owner may file a tire under a season the shop cannot draw, or not under one it can')
  assert.ok(OVERRIDE_CATEGORIES.length > 0, 'an empty list would make every assertion about it vacuous')

  // The deepEqual above cannot catch a hand-written copy on the day it is
  // written -- it would agree with itself until someone changed SEASON_LABELS
  // alone, which is exactly how the CATALOG_FIELDS and EXPECTED_CHECKS pairs
  // drifted here. So the derivation itself is asserted, at the source.
  const source = readFileSync(new URL('./inventory.mjs', import.meta.url), 'utf8')
  const declaration = source.slice(source.indexOf('export const OVERRIDE_CATEGORIES'))
    .slice(0, source.slice(source.indexOf('export const OVERRIDE_CATEGORIES')).indexOf('\n'))
  assert.match(declaration, /SEASON_LABELS/,
    `OVERRIDE_CATEGORIES stopped being derived from the shop's facet: ${declaration}`)
  for (const season of Object.keys(SEASON_LABELS)) {
    assert.doesNotMatch(declaration, new RegExp(`['"]${season}['"]`),
      `"${season}" is written out again beside the map it should be read from`)
  }
})

test('an owner season correction moves the tire for a customer, and clearing it gives the supplier back', t => {
  const db = setup(t)
  assert.equal(db.catalog()[0].category, 'all-season', "the fixture starts on the supplier's own filing")

  db.saveOffer('giga-a', offer({ categoryOverride: 'winter' }))
  assert.equal(db.catalog()[0].category, 'winter', 'the customer is shown the correction')

  const held = db.list().items[0].offer
  assert.equal(held.categoryOverride, 'winter', 'and the owner screen reads back what it saved')

  db.saveOffer('giga-a', { ...held, categoryOverride: null })
  assert.equal(db.catalog()[0].category, 'all-season',
    'null means "use the supplier\'s", which is not the same as "no season"')
  assert.equal(db.list().items[0].offer.categoryOverride, null)
})

test('an owner description correction reaches the card, the heading and the decoded spec together', t => {
  // Seeded straight rather than through setup(), which has already imported a
  // giga-a: `importSnapshot` adds rows and does not rewrite one it already
  // holds, so importing over it left the fixture's own '95H BSW' in place and
  // this test measured a tire it had not built. Caught by the assertion below
  // failing, which is the only reason it is worth writing them this way round.
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([tire('giga-a', { description: SUPPLIER_ADVERT })]))

  const before = db.catalog()[0]
  assert.equal(before.description, SUPPLIER_ADVERT,
    "nothing removes the supplier's advertising on the way to a customer; cleanCatalogDescription is an HTML sanitiser and this carries no markup")
  assert.ok(before.description.length > DESCRIPTION_OVERRIDE_LIMIT,
    'the row this exists for is longer than any correction may be, which is how it was found')
  assert.equal(before.specCategory, undefined,
    'and it parses as no category at all, so the panel heads the tire with nothing')

  db.saveOffer('giga-a', offer({ descriptionOverride: 'High Performance All Season · XL 98Y BSW' }))

  const after = db.catalog()[0]
  assert.equal(after.description, 'High Performance All Season · XL 98Y BSW', 'the card line is the owner\'s')
  assert.equal(after.specCategory, 'High Performance All Season',
    'and so is the heading -- one edit, not a second control that could disagree with the first')
  assert.deepEqual(after.specPoints, before.specPoints,
    'while the decoded spec, which was never wrong, is untouched: the codes were always at the end of that string')
  assert.ok(after.specPoints.length > 0, 'a spec that decoded to nothing would make the line above vacuous')
})

test('a save that never mentions the corrections keeps them, which is every bulk write and every older client', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ categoryOverride: 'winter', descriptionOverride: 'Winter / snow · 95H BSW' }))
  const held = db.list().items[0].offer

  // Exactly the body the bulk price path builds -- no override keys at all.
  // Reading their absence as null would wipe every correction on up to 200
  // rows per request, silently, on the way to changing a price.
  db.saveOffers({ offers: [{
    id: 'giga-a', priceCents: 7500, shippingCents: null,
    enabled: held.enabled, notes: held.notes, version: held.version,
  }] })

  const after = db.list().items[0]
  assert.equal(after.offer.priceCents, 7500, 'the field it did send moved')
  assert.equal(after.offer.categoryOverride, 'winter', 'the correction it did not send survived')
  assert.equal(after.offer.descriptionOverride, 'Winter / snow · 95H BSW')
  assert.equal(db.catalog()[0].category, 'winter', 'and the customer still sees it')
})

test('a correction the shop could not draw is refused, by name, and writes nothing', t => {
  const db = setup(t)
  const tooLong = 'x'.repeat(DESCRIPTION_OVERRIDE_LIMIT + 1)
  assert.throws(() => db.saveOffer('giga-a', offer({ categoryOverride: 'mud-and-snow' })), /Choose a season/,
    'a season the facet has no bucket for would hide the tire from every filter')
  assert.throws(() => db.saveOffer('giga-a', offer({ categoryOverride: 'All-season' })), /Choose a season/,
    "the label is not the key; 'All-season' is what the shop prints, 'all-season' is what it files under")
  assert.throws(() => db.saveOffer('giga-a', offer({ descriptionOverride: '   ' })),
    new RegExp(`up to ${DESCRIPTION_OVERRIDE_LIMIT} characters`),
    'a blank correction would publish a tire with no description, which nobody means to do')
  assert.throws(() => db.saveOffer('giga-a', offer({ descriptionOverride: tooLong })),
    new RegExp(`up to ${DESCRIPTION_OVERRIDE_LIMIT} characters`))
  assert.equal(db.list().items[0].offer.version, 0, 'and not one of the four wrote a row')

  // THE CONTROL. Without it the four refusals above are equally consistent with
  // a save path that refuses everything it is given.
  db.saveOffer('giga-a', offer({
    categoryOverride: 'off-road', descriptionOverride: tooLong.slice(0, DESCRIPTION_OVERRIDE_LIMIT),
  }))
  const saved = db.list().items[0].offer
  assert.equal(saved.categoryOverride, 'off-road')
  assert.equal(saved.descriptionOverride.length, DESCRIPTION_OVERRIDE_LIMIT, 'the limit itself is allowed, not one short of it')
})

test('a supplier refresh moves the supplier’s record and leaves the owner’s correction standing', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ categoryOverride: 'winter', descriptionOverride: 'Winter / snow · 95H BSW' }))
  db.refreshSize(SIZE, [tire('giga-a', { category: 'performance', description: 'Summer · 95H BSW' })])

  const row = db.list().items[0]
  assert.equal(row.category, 'performance', "the owner screen shows what the supplier now says")
  assert.equal(row.description, 'Summer · 95H BSW', 'both of them, so a correction that has gone stale is visible where it was made')
  assert.equal(row.offer.categoryOverride, 'winter', 'beside what the owner said')
  assert.equal(db.catalog()[0].category, 'winter', 'and the customer sees the owner')
  assert.equal(db.catalog()[0].description, 'Winter / snow · 95H BSW')
})

test('a correction changes what a customer reads, never which fields reach them', t => {
  const db = setup(t)
  db.saveOffer('giga-a', offer({ categoryOverride: 'winter', descriptionOverride: 'Winter / snow · 95H BSW' }))
  const [customer] = db.catalog()

  // `category` and `description` are already required customer fields, so this
  // whole feature adds nothing to the boundary -- which is the reason it was
  // built on those two fields rather than on a pair of new ones.
  assert.equal(catalogRowProblem(customer), null, 'a corrected row is still exactly the contract')
  assert.doesNotMatch(JSON.stringify(customer), /override/i,
    'the correction reaches a customer as the tire\'s own category and description, not as a correction')
})

test('a season correction also moves the owner-review gate, which is the point and is not obvious', t => {
  // FOUND IN REVIEW, not in writing this. `catalog()` is not only what a
  // customer reads: `QuoteStore.catalog()` returns it verbatim and hands it to
  // `calculateDraftQuote`, which holds a quote for the owner when
  // `tire.category === 'off-road'` (src/pricing.js). So a control labelled
  // "Season a customer filters by" also decides which quotes land in Ken's
  // review queue, and nothing said so.
  //
  // The coupling is CORRECT and worth keeping. The gate exists so a person
  // looks before an off-road tire is sold, and the three rows this feature was
  // built for -- Bridgestone Turanza EverDrive, Pegasus HPX SPORT AS, Radar
  // Dimax AS-9, every one a road tire the supplier filed `off-road` -- are
  // holding quotes today for a reason that is not true. Correcting them stops
  // a false hold; filing something as off-road starts a real one.
  //
  // It is pinned here so the next person to change either side finds the other.
  const db = setup(t)
  const draft = () => calculateDraftQuote({ tireSelection: 'giga-a', quantity: 4 }, db.catalog())
  const heldForOffRoad = () => draft().exceptionReasons.some(reason => /off-road/i.test(reason))

  assert.equal(db.catalog()[0].category, 'all-season')
  assert.equal(heldForOffRoad(), false, 'the fixture is a road tire and is not held')

  db.saveOffer('giga-a', offer({ categoryOverride: 'off-road' }))
  assert.equal(heldForOffRoad(), true, 'filing a tire as off-road sends its quotes to the owner')

  const held = db.list().items[0].offer
  db.saveOffer('giga-a', { ...held, categoryOverride: 'all-season' })
  assert.equal(heldForOffRoad(), false, 'and correcting a mis-filed one stops a hold that was never true')

  // The control this most needs: the gate must still fire on the SUPPLIER's
  // own filing, with no override at all. Otherwise the three assertions above
  // are equally consistent with a quote engine that stopped reading category.
  const other = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => other.close())
  other.importSnapshot(snapshot([tire('giga-a', { category: 'off-road' })]))
  assert.equal(
    calculateDraftQuote({ tireSelection: 'giga-a', quantity: 4 }, other.catalog())
      .exceptionReasons.some(reason => /off-road/i.test(reason)),
    true,
    'a tire the supplier itself calls off-road is still held, override or no override')
})
