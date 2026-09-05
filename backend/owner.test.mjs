import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { createApi } from './api.mjs'
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'

const SIZE = '215/60R16'
const otherSize = '225/50R17'
const tire = (id = 'giga-a', overrides = {}) => ({ id, name: 'Test Touring', size: SIZE,
  price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' }, ...overrides })
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })
function setup(t) {
  const db = new Inventory(':memory:', [SIZE, otherSize])
  t.after(() => db.close())
  db.importSnapshot(snapshot([tire()]))
  return db
}
const offer = (extra = {}) => ({ priceCents: 8999, enabled: true, notes: 'Owner choice', version: 0, ...extra })

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
  assert.deepEqual(row.offer, { ...offer(), version: 1 })
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
  for (const priceCents of [null, 0, -1, 0.5, '89.99', 10000001]) {
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

test('a failed later page does not partially replace a size or continue challenging supplier', async t => {
  const db = setup(t), calls = []
  const refresh = new Refresher(db, { pause: async () => {}, createFetcher: async () => ({
    fetchSizePage: async (size, page) => { calls.push([size, page]); if (page === 2) throw new Error('Blocked'); return { html: html('NEW') } }, close: async () => {},
  }) })
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
  assert.equal((await send(offer())).status, 200)
  assert.equal((await send(offer())).status, 409)
  const result = await (await fetch(`${base}/inventory?filter=offered`)).json()
  assert.equal(result.items[0].offer.priceCents, 8999)
  assert.equal(result.summary.offeredCount, 1)
})

test('markup starts as the shared placeholder and survives being saved', t => {
  const db = setup(t)
  const initial = db.getMarkup()
  assert.equal(initial.rate, DEFAULT_MARKUP_SETTINGS.rate, 'default comes from the frontend markup module')
  assert.equal(initial.isPlaceholder, true)
  assert.equal(initial.updatedAt, null)
  assert.equal(db.summary().markup.rate, initial.rate, 'inventory summary carries it for the screen')

  const saved = db.saveMarkup({ rate: 1.6 })
  assert.equal(saved.rate, 1.6)
  assert.equal(saved.isPlaceholder, false, 'a saved rate is a decision, not a default')
  assert.ok(saved.updatedAt)
  assert.equal(db.getMarkup().rate, 1.6)
  assert.equal(db.summary().markup.isPlaceholder, false)
})

test('markup rejects rates that would quote below cost or reprice by typo', t => {
  const db = setup(t)
  for (const rate of [0, 0.9, -2, 11, Number.NaN, Infinity, '1.5', null, undefined]) {
    assert.throws(() => db.saveMarkup({ rate }), /markup between 1 and 10/, `rejected ${String(rate)}`)
  }
  assert.throws(() => db.saveMarkup(null), /markup between 1 and 10/)
  assert.equal(db.getMarkup().isPlaceholder, true, 'nothing was written by the rejected saves')
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
