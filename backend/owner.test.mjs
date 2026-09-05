import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { createApi, createCatalogApi, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, createImportToken, readAuthConfig, verifyImportToken } from './auth.mjs'
import { PageImporter } from './import.mjs'
import { DEFAULT_MARKUP_SETTINGS, quotedPrice } from '../src/markup.js'

const SIZE = '215/60R16'
const otherSize = '225/50R17'
const tire = (id = 'giga-a', overrides = {}) => ({ id, name: 'Test Touring', size: SIZE,
  price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' }, ...overrides })
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })

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

test('auth refuses to start without a usable password', () => {
  assert.throws(() => readAuthConfig({}), /KMT_OWNER_PASSWORD is not set/)
  assert.throws(() => readAuthConfig({ KMT_OWNER_PASSWORD: 'short' }), /at least 12 characters/)
  const config = readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' })
  assert.equal(config.generatedSecret, true, 'a missing secret is generated rather than fatal')
})

test('sessions are signed, expire, and cannot be forged', async t => {
  const env = { KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'secret-one' }
  const auth = createAuth(readAuthConfig(env))
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
  assert.match(cookie, /SameSite=Strict/)

  const token = cookie.split(';')[0]
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: token } })).status, 200)

  // A cookie signed with a different secret is not accepted.
  const other = createAuth(readAuthConfig({ ...env, KMT_SESSION_SECRET: 'secret-two' }))
  assert.equal(other.isAuthenticated({ headers: { cookie: token }, socket: {} }), false)

  // Neither is a tampered payload.
  const tampered = token.replace(/=(.*)\./, `=${Buffer.from(String(Date.now() + 9e9)).toString('base64url')}.`)
  assert.equal((await fetch(`${base}/anything`, { headers: { cookie: tampered } })).status, 401)

  // An expired session is refused even though its signature is valid.
  const expired = createAuth(readAuthConfig({ ...env, KMT_SESSION_HOURS: '-1' }))
  const stale = await fetch(`${base}/api/owner/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'a-long-enough-password' }),
  })
  assert.equal(stale.status, 200)
  assert.equal(expired.isAuthenticated({ headers: { cookie: token }, socket: {} }), true, 'ttl affects issuing, not this token')
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

test('import tokens cannot be swapped for session tokens', t => {
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
  const expected = ['id', 'name', 'size', 'price', 'inStock', 'category', 'description']

  assert.deepEqual(Object.keys(row).sort(), [...expected].sort(), 'field for field')
  // The supplier's own numbers are the thing the customer must never see.
  assert.equal(row.source, undefined, 'no supplier block')
  for (const leak of ['sku', 'listPrice', 'stock', 'notes', 'offer', 'supplierPrice', 'lastSeen']) {
    assert.equal(row[leak], undefined, `no ${leak}`)
  }
  assert.deepEqual(row, {
    id: 'giga-a', name: 'Test Touring', size: SIZE, price: 89.99,
    inStock: true, category: 'all-season', description: '95H BSW',
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

test('an offer cannot be enabled without a price, which is why there are only two states', async t => {
  // Pinning the reason the test above covers two cases and not three: an
  // enabled offer with no price is refused, so the only rows a customer can
  // see are owner-priced ones and ones markup priced on their own.
  const db = setup(t)
  assert.throws(() => db.saveOffer('giga-a', offer({ priceCents: null })), /positive KMT price/)
})
