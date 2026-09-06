import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { createApi, createCatalogApi, createHealthApi, createRequestsApi, isHostAllowed, isKnownApiPath, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'
import { PUBLIC_BODY_LIMIT, RateLimiter } from './limits.mjs'
import { parseRequestUrl } from './site.mjs'
import { calculateDraftQuote } from '../src/pricing.js'

const SIZE = '215/60R16'
const KEY = 'a1b2c3d4e5f60718'
const OTHER_KEY = '00112233445566ff'

const tire = (id = 'giga-a', overrides = {}) => ({
  id, name: 'Test Touring', size: SIZE, price: 50, inStock: true,
  category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' },
  ...overrides,
})
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })

/** An inventory with one owner-priced tire, and the quotes store over it. */
function setup(t, { tires = [tire()] } = {}) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  inventory.importSnapshot(snapshot(tires))
  inventory.saveMarkup({ rate: 1.4 })
  const quotes = new Quotes(inventory)
  return { inventory, quotes }
}

const form = (overrides = {}) => ({
  customerKey: KEY,
  vehicleInfo: '2021 Honda Civic',
  tireSelection: 'giga-a',
  quantity: 4,
  location: '456 Demo Ave',
  date: '2026-09-10',
  locationType: 'home',
  serviceZip: '02149',
  locationNotes: 'Driveway',
  customerName: 'Jamie Rivera',
  customerEmail: 'Jamie@Example.com',
  customerPhone: '(617) 410-8319',
  ...overrides,
})

test('a submit stores the request and its quote, priced exactly as the frontend prices it', async t => {
  const { quotes } = setup(t)

  const { request, quote } = quotes.submit(form())

  assert.match(request.id, /^[0-9a-f]{32}$/, 'a 128-bit id, not a guessable one')
  assert.equal(request.vehicleInfo, '2021 Honda Civic')
  assert.equal(quote.status, 'draft')

  // The comparison that matters: the server drafts with the same function over
  // the same catalog, so a customer is never quoted one number and shown another.
  const expected = calculateDraftQuote({ ...form(), id: request.id }, quotes.catalog())
  assert.equal(quote.total, expected.total)
  assert.deepEqual(quote.lineItems, expected.lineItems)
  assert.equal(quote.exception, expected.exception)
  assert.deepEqual(quote.exceptionReasons, expected.exceptionReasons)

  // And it is readable back by id alone.
  const found = quotes.get(request.id)
  assert.equal(found.quote.total, quote.total)
})

test('calculateDraftQuote multiplies the tire line by quantity and leaves the fee alone', () => {
  const catalog = [tire()]
  const quoteOfFour = calculateDraftQuote({ tireSelection: 'giga-a', quantity: 4 }, catalog)
  const tireLine = quoteOfFour.lineItems.find(item => item.description !== 'Mobile installation service')
  const feeLine = quoteOfFour.lineItems.find(item => item.description === 'Mobile installation service')
  assert.equal(tireLine.quantity, 4)
  assert.equal(tireLine.unitPrice, 50)
  assert.equal(feeLine.quantity, 1)
  assert.equal(feeLine.unitPrice, 49.99)
  assert.equal(quoteOfFour.total, Math.round((50 * 4 + 49.99) * 100) / 100)

  const quoteOfOne = calculateDraftQuote({ tireSelection: 'giga-a' }, catalog)
  assert.equal(quoteOfOne.lineItems[0].quantity, 1, 'no quantity at all still means one tire, not zero and not a full set')
})

test('quantity defaults to 4, an explicit choice is honoured, and the fee never multiplies', async t => {
  const { quotes } = setup(t)

  const defaulted = quotes.submit(form({ quantity: undefined }))
  const tireLine = defaulted.quote.lineItems.find(item => item.description !== 'Mobile installation service')
  const feeLine = defaulted.quote.lineItems.find(item => item.description === 'Mobile installation service')
  assert.equal(tireLine.quantity, 4, 'a request that says nothing about quantity means a full set')
  assert.equal(feeLine.quantity, 1, 'the mobile-service fee is one line regardless of how many tires')
  const expectedDefault = calculateDraftQuote({ ...form({ quantity: 4 }), id: defaulted.request.id }, quotes.catalog())
  assert.equal(defaulted.quote.total, expectedDefault.total)
  assert.deepEqual(defaulted.quote.lineItems, expectedDefault.lineItems)

  const explicit = quotes.submit(form({ quantity: 2 }))
  const explicitTireLine = explicit.quote.lineItems.find(item => item.description !== 'Mobile installation service')
  assert.equal(explicitTireLine.quantity, 2)
  const expectedExplicit = calculateDraftQuote({ ...form({ quantity: 2 }), id: explicit.request.id }, quotes.catalog())
  assert.equal(explicit.quote.total, expectedExplicit.total)
})

test('a quantity outside the offered choices is refused', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ quantity: 3 })), /quantity must be one of/)
  assert.throws(() => quotes.submit(form({ quantity: 0 })), /quantity must be one of/)
  assert.throws(() => quotes.submit(form({ quantity: -1 })), /quantity must be one of/)
  assert.throws(() => quotes.submit(form({ quantity: 'a lot' })), /quantity must be one of/)
})

test('an out-of-stock tire and a truck both raise the exception the existing rules raise', async t => {
  const { quotes } = setup(t, { tires: [tire('giga-a'), tire('giga-b', { name: 'Second', inStock: false })] })

  const outOfStock = quotes.submit(form({ tireSelection: 'giga-b' }))
  assert.equal(outOfStock.quote.exception, true)
  assert.ok(outOfStock.quote.exceptionReasons.some(reason => /out of stock/i.test(reason)))

  const truck = quotes.submit(form({ vehicleInfo: '2019 Ford F-150 Pickup' }))
  assert.equal(truck.quote.exception, true)
  assert.ok(truck.quote.exceptionReasons.some(reason => /review|truck|pickup/i.test(reason)))
})

test('a tire we do not offer is refused rather than quoted', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ tireSelection: 'giga-nonexistent' })), /not one we currently offer/)
})

test('a request is required to carry the fields a quote needs', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ vehicleInfo: '' })), /vehicleInfo is required/)
  assert.throws(() => quotes.submit(form({ location: '   ' })), /location is required/)
  assert.throws(() => quotes.submit(form({ customerKey: 'not-a-key' })), /customer key/)
  assert.throws(() => quotes.submit(form({ locationNotes: 'x'.repeat(1001) })), /too long/)
})

test('special instructions are stored for the owner, capped, optional, and never in the customer shape', async t => {
  // t64: "Anything else I should know?". The first field added since t44
  // made the customer shape a positive list, and the test of whether that
  // held: nothing in CUSTOMER_REQUEST_FIELDS was edited to exclude it.
  const { quotes } = setup(t)
  const { request } = quotes.submit(form({ customerNotes: '  Gate code 4411, call when you arrive  ' }))
  assert.equal(stored(quotes, request.id).customerNotes, 'Gate code 4411, call when you arrive', 'trimmed, on the owner row')
  assert.equal('customerNotes' in quotes.get(request.id).request, false, 'not in the customer shape by id')
  assert.equal('customerNotes' in quotes.listForCustomer(KEY)[0].request, false, 'nor in the customer list')

  assert.equal(stored(quotes, quotes.submit(form()).request.id).customerNotes, '', 'optional: absent reads as empty')
  assert.equal(stored(quotes, quotes.submit(form({ customerNotes: 'x'.repeat(500) })).request.id).customerNotes.length, 500, 'five hundred is allowed')
  assert.throws(() => quotes.submit(form({ customerNotes: 'x'.repeat(501) })), /customerNotes is too long/)
  assert.throws(() => quotes.submit(form({ customerNotes: 42 })), /customerNotes must be text/)
})

test('a name and email are required; the email is stored lower-cased and trimmed', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ customerName: '' })), /customerName is required/)
  assert.throws(() => quotes.submit(form({ customerName: '   ' })), /customerName is required/)
  assert.throws(() => quotes.submit(form({ customerEmail: '' })), /customerEmail is required/)
  assert.throws(() => quotes.submit(form({ customerEmail: 'not-an-email' })), /valid email/)
  assert.throws(() => quotes.submit(form({ customerEmail: 'missing-domain@' })), /valid email/)

  // What was stored is read the way the owner reads it: a submit answers the
  // customer shape, which carries no email.
  const { request } = quotes.submit(form({ customerEmail: '  Jamie@Example.COM  ' }))
  assert.equal(stored(quotes, request.id).customerEmail, 'jamie@example.com')
})

/** The full stored request, as the owner's list carries it. */
const stored = (quotes, id) => quotes.listForOwner().find(row => row.request.id === id).request

test('a phone is optional, and a US number typed any of the usual ways is stored E.164', async t => {
  const { quotes } = setup(t)

  const noPhone = stored(quotes, quotes.submit(form({ customerPhone: '' })).request.id)
  assert.equal(noPhone.customerPhone, '', 'missing phone is fine')

  const typed = stored(quotes, quotes.submit(form({ customerPhone: '(617) 410-8319' })).request.id)
  assert.equal(typed.customerPhone, '+16174108319')

  const withCountryCode = stored(quotes, quotes.submit(form({ customerPhone: '1-617-410-8319' })).request.id)
  assert.equal(withCountryCode.customerPhone, '+16174108319')

  assert.throws(() => quotes.submit(form({ customerPhone: '12345' })), /US phone number/)
})

test('a request stored before contact fields existed renders without error, contact simply absent', async t => {
  // Production has exactly this: a request written before this field set
  // existed. Simulated by writing a payload shaped the old way (no
  // customerName/Email/Phone) straight into the table, bypassing cleanRequest
  // -- the only way a live database still holds one.
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  const legacyPayload = JSON.stringify({
    vehicleInfo: request.vehicleInfo, tireSelection: request.tireSelection,
    location: request.location, date: request.date, locationType: request.locationType,
    serviceZip: request.serviceZip, locationNotes: request.locationNotes,
  })
  quotes.db.prepare('UPDATE requests SET payload=? WHERE id=?').run(legacyPayload, request.id)

  const byId = quotes.get(request.id)
  assert.equal(byId.request.customerName, undefined)
  assert.equal(byId.request.customerEmail, undefined)
  assert.equal(byId.request.customerPhone, undefined)
  assert.equal(byId.request.vehicleInfo, request.vehicleInfo, 'the rest of the row is unaffected')

  const owner = quotes.listForOwner().find(row => row.request.id === request.id)
  assert.equal(owner.request.customerEmail, undefined, 'the owner list renders the same row without throwing')
})

/* ------------------------------------------------- who reads what (t44, #65) */

/** The fields a customer read may carry, and the ones it never may. */
const CUSTOMER_FIELDS = ['id', 'vehicleInfo', 'tireSelection', 'quantity', 'date', 'locationType', 'serviceZip', 'createdAt', 'updatedAt']
const OWNER_ONLY = ['customerName', 'customerEmail', 'customerPhone', 'location', 'locationNotes']

test('a request read by id is the customer shape: no name, email, phone or location notes', async t => {
  // The id is the access and the status link is meant to be shared (R19), so
  // whoever holds it must not learn who the customer is (R23). Measured on
  // production before this: all three contact fields present.
  const { quotes } = setup(t)
  const submitted = quotes.submit(form({ locationNotes: 'Key under the mat, gate code 4411' }))

  const byId = quotes.get(submitted.request.id).request
  assert.deepEqual(Object.keys(byId).sort(), [...CUSTOMER_FIELDS].sort(), 'a list of fields, not the payload minus a few')
  for (const field of OWNER_ONLY) assert.equal(byId[field], undefined, `${field} does not travel with the link`)
  assert.equal(byId.vehicleInfo, '2021 Honda Civic')
  assert.equal(byId.quantity, 4)

  // Every customer-facing write answers the same shape: it all reads through get().
  for (const field of OWNER_ONLY) assert.equal(submitted.request[field], undefined, `submit: ${field}`)
  quotes.decide(submitted.request.id, 'sent', 1)
  const paid = quotes.pay(submitted.request.id, KEY)
  for (const field of OWNER_ONLY) assert.equal(paid.request[field], undefined, `pay: ${field}`)
})

test("a browser's own list is the customer shape too", async t => {
  const { quotes } = setup(t)
  quotes.submit(form())
  quotes.submit(form({ vehicleInfo: '2018 Subaru Outback' }))

  const mine = quotes.listForCustomer(KEY)
  assert.equal(mine.length, 2)
  for (const { request } of mine) {
    assert.deepEqual(Object.keys(request).sort(), [...CUSTOMER_FIELDS].sort())
    for (const field of OWNER_ONLY) assert.equal(request[field], undefined, `list: ${field}`)
  }
  assert.ok(mine.every(row => row.quote?.total > 0), 'the quote still travels with each request')
})

test('the owner keeps the full row: contact and notes, on the list and after every action', async t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form({ locationNotes: 'Key under the mat, gate code 4411' }))

  const listed = stored(quotes, request.id)
  assert.equal(listed.customerName, 'Jamie Rivera')
  assert.equal(listed.customerEmail, 'jamie@example.com')
  assert.equal(listed.customerPhone, '+16174108319')
  assert.equal(listed.locationNotes, 'Key under the mat, gate code 4411')

  // The owner's actions answer the owner's shape.
  const sent = quotes.decide(request.id, 'sent', 1)
  assert.equal(sent.request.customerEmail, 'jamie@example.com', 'decide answers the owner')
  const cancelled = quotes.cancel(request.id, 2, 'Out of stock')
  assert.equal(cancelled.request.locationNotes, 'Key under the mat, gate code 4411', 'cancel answers the owner')
})

test('a browser sees its own requests and nobody else', async t => {
  const { quotes } = setup(t)
  const mine = quotes.submit(form())
  quotes.submit(form({ customerKey: OTHER_KEY, location: 'Somewhere else' }))

  const listed = quotes.listForCustomer(KEY)
  assert.equal(listed.length, 1, 'one browser, one request')
  assert.equal(listed[0].request.id, mine.request.id)

  const theirs = quotes.listForCustomer(OTHER_KEY)
  assert.equal(theirs.length, 1)
  assert.notEqual(theirs[0].request.id, mine.request.id)
})

test('paying needs the key that submitted, and a quote the owner has approved', async t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())

  // A draft is not payable: that would be paying a price nobody agreed to.
  assert.throws(() => quotes.pay(request.id, KEY), /not been approved/)

  // Approve it the way t30's endpoint will, by moving the row.
  quotes.db.prepare('UPDATE quotes SET status=? WHERE request_id=?').run('approved', request.id)

  // Someone else's key is answered as though the request does not exist.
  assert.throws(() => quotes.pay(request.id, OTHER_KEY), /No such request/)
  assert.throws(() => quotes.pay('0'.repeat(32), KEY), /No such request/)

  const paid = quotes.pay(request.id, KEY)
  assert.equal(paid.quote.status, 'paid')
  assert.equal(paid.quote.version, 2, 'the version moves, for the optimistic updates t30 needs')

  // Paying twice is the same answer, not an error and not a second charge.
  assert.equal(quotes.pay(request.id, KEY).quote.status, 'paid')
})

/* --------------------------------------------------- rate limits (t45, #63) */

/** Small windows, so a test can reach them in a handful of calls. */
const smallRules = {
  publicPerIp: { max: 4, windowMs: 60_000 },
  publicPerKey: { max: 2, windowMs: 60_000 },
  submitPerEmail: { max: 3, windowMs: 60_000 },
}

test('public writes from one address are refused past the limit, with the wait named, and reads are not', async t => {
  const { inventory, quotes } = setup(t)
  const logged = []
  const limiter = new RateLimiter({ rules: smallRules, log: line => logged.push(line) })
  const base = await serve(t, quotes, inventory, { limiter })

  // Four allowed: each with its own key and email, so only the address counts.
  for (let i = 0; i < 4; i++) {
    const created = await post(base, '/api/requests', form({ customerKey: `0000000000000${String(i).padStart(3, '0')}`, customerEmail: `c${i}@example.com` }))
    assert.equal(created.status, 201, `submission ${i + 1} is under the limit`)
  }
  const fifth = await post(base, '/api/requests', form({ customerKey: '00000000000000ff', customerEmail: 'c9@example.com' }))
  assert.equal(fifth.status, 429)
  assert.equal(fifth.headers.get('retry-after'), '60')
  assert.match((await fifth.json()).error, /Too many requests from this connection/)
  assert.equal(quotes.listForOwner().length, 4, 'the refused one was never stored')
  assert.ok(logged.some(line => /publicPerIp refused/.test(line)), 'the refusal is logged')

  // Pay and cancel share the address window: both are refused now too.
  const id = quotes.listForOwner()[0].request.id
  assert.equal((await post(base, `/api/requests/${id}/pay`, { customerKey: KEY })).status, 429)
  assert.equal((await post(base, `/api/requests/${id}/cancel`, { customerKey: KEY })).status, 429)

  // Reads are not counted: the status screen keeps working for everyone.
  assert.equal((await fetch(`${base}/api/requests/${id}`)).status, 200)
  assert.equal((await fetch(`${base}/api/requests?customer=${KEY}`)).status, 200)
  assert.equal((await fetch(`${base}/api/catalog`)).status, 200)
})

test('one browser key and one email address have limits of their own', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory, { limiter: new RateLimiter({ rules: { ...smallRules, publicPerIp: { max: 100, windowMs: 60_000 } }, log: () => {} }) })

  // Two from one key, then the third from that key is refused while a different key still gets through.
  assert.equal((await post(base, '/api/requests', form({ customerEmail: 'a@example.com' }))).status, 201)
  assert.equal((await post(base, '/api/requests', form({ customerEmail: 'b@example.com' }))).status, 201)
  const byKey = await post(base, '/api/requests', form({ customerEmail: 'c@example.com' }))
  assert.equal(byKey.status, 429)
  assert.match((await byKey.json()).error, /this browser/)
  assert.equal((await post(base, '/api/requests', form({ customerKey: OTHER_KEY, customerEmail: 'd@example.com' }))).status, 201)

  // Three naming one address, then the fourth is refused whichever key sends it.
  const keys = ['0000000000000001', '0000000000000002', '0000000000000003', '0000000000000004']
  for (const key of keys.slice(0, 3)) {
    assert.equal((await post(base, '/api/requests', form({ customerKey: key, customerEmail: 'Same@Example.com' }))).status, 201)
  }
  const byEmail = await post(base, '/api/requests', form({ customerKey: keys[3], customerEmail: 'same@example.com' }))
  assert.equal(byEmail.status, 429)
  assert.match((await byEmail.json()).error, /email address/)
  assert.equal((await post(base, '/api/requests', form({ customerKey: keys[3], customerEmail: 'other@example.com' }))).status, 201, 'the key itself is fine')
})

test('a public body past the ceiling is refused before it is parsed, and the health check is never counted', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory, { limiter: new RateLimiter({ rules: smallRules, log: () => {} }) })

  const oversized = await post(base, '/api/requests', form({ locationNotes: 'x'.repeat(PUBLIC_BODY_LIMIT) }))
  assert.equal(oversized.status, 413)
  assert.equal(quotes.listForOwner().length, 0)

  // Fly reads /api/health every fifteen seconds; a limiter that counted it
  // would mark the machine unhealthy. Many more than any window allows, all 200.
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${base}/api/health`)).status, 200)
})

test('an id that does not exist reads as nothing, not as someone else', async t => {
  const { quotes } = setup(t)
  assert.equal(quotes.get('0'.repeat(32)), null)
  assert.equal(quotes.get(''), null)
})

/* ------------------------------------------------------------------- HTTP */

/** A server shaped like server.mjs: the same gate, the same handlers. */
function serve(t, quotes, inventory, { limiter = null } = {}) {
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' }))
  const requestsApi = createRequestsApi(quotes, { limiter })
  const catalogApi = createCatalogApi(inventory)
  const healthApi = createHealthApi(inventory)
  const ownerApi = createApi(inventory, { start: () => ({}), cancel: () => ({}) }, null, quotes)

  const server = createServer(async (request, response) => {
    // As server.mjs does: the collapsed path is the one every handler sees.
    const { url } = parseRequestUrl(request.url)
    request.url = url.pathname + url.search
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (url.pathname.startsWith('/api/')) {
      if (!isKnownApiPath(url.pathname)) {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'No such endpoint.' }))
        return
      }
      if (!isPublicApiCall(request.method, url.pathname) && !auth.isAuthenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
        return
      }
      // Mounted in the order server.mjs mounts them, so a handler that
      // answers a route belonging to another one shows up here.
      if (await healthApi(request, response)) return
      if (await catalogApi(request, response)) return
      if (await requestsApi(request, response)) return
      if (await ownerApi(request, response)) return
    }
    response.writeHead(404).end()
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close())
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('a customer with no session can submit, read and pay; the owner API still cannot be reached', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)

  const created = await post(base, '/api/requests', form())
  assert.equal(created.status, 201, 'no cookie, and the customer is still served')
  const { request, quote } = await created.json()
  assert.equal(quote.status, 'draft')

  const listed = await (await fetch(`${base}/api/requests?customer=${KEY}`)).json()
  assert.equal(listed.requests.length, 1)

  const one = await fetch(`${base}/api/requests/${request.id}`)
  assert.equal(one.status, 200, 'the id alone opens it, on any device')
  // And what it opens is the customer shape, on the wire and not only in the store.
  const opened = (await one.json()).request
  for (const field of OWNER_ONLY) assert.equal(opened[field], undefined, `GET by id: ${field}`)
  for (const field of OWNER_ONLY) assert.equal(listed.requests[0].request[field], undefined, `GET by key: ${field}`)
  assert.equal(opened.vehicleInfo, '2021 Honda Civic')

  // Not another browser's, and not a listing without a key.
  const other = await (await fetch(`${base}/api/requests?customer=${OTHER_KEY}`)).json()
  assert.equal(other.requests.length, 0)
  assert.equal((await fetch(`${base}/api/requests`)).status, 400, 'no key, no listing')
  assert.equal((await fetch(`${base}/api/requests/${'0'.repeat(32)}`)).status, 404)

  // Paying: refused as a draft, refused with the wrong key, accepted once approved.
  assert.equal((await post(base, `/api/requests/${request.id}/pay`, { customerKey: KEY })).status, 409)
  quotes.db.prepare('UPDATE quotes SET status=? WHERE request_id=?').run('approved', request.id)
  assert.equal((await post(base, `/api/requests/${request.id}/pay`, { customerKey: OTHER_KEY })).status, 404)
  const paid = await post(base, `/api/requests/${request.id}/pay`, { customerKey: KEY })
  assert.equal(paid.status, 200)
  assert.equal((await paid.json()).quote.status, 'paid')

  // The owner's own endpoints are exactly as shut as they were.
  assert.equal((await fetch(`${base}/api/owner/inventory`)).status, 401)
  assert.equal((await fetch(`${base}/api/owner/markup`)).status, 401)
})

test('the public rule opens the customer paths and nothing else', async () => {
  // The allow-list is a prefix, so this pins what the prefix does and does not
  // reach -- a route added under it later stays behind the session by default.
  assert.equal(isPublicApiCall('GET', '/api/catalog'), true)
  assert.equal(isPublicApiCall('GET', '/api/health'), true)
  assert.equal(isPublicApiCall('POST', '/api/requests'), true)
  assert.equal(isPublicApiCall('GET', '/api/requests'), true)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc123'), true)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123/pay'), true)

  assert.equal(isPublicApiCall('POST', '/api/catalog'), false)
  assert.equal(isPublicApiCall('POST', '/api/health'), false)
  assert.equal(isPublicApiCall('HEAD', '/api/health'), true, 'uptime tools HEAD the health check')
  assert.equal(isPublicApiCall('HEAD', '/api/catalog'), false, 'nothing HEADs a JSON data endpoint; left GET-only on purpose')
  assert.equal(isPublicApiCall('HEAD', '/api/requests'), false)
  assert.equal(isPublicApiCall('GET', '/api/owner/health'), false)
  assert.equal(isPublicApiCall('DELETE', '/api/requests/abc123'), false)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123'), false)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123/approve'), false)
  assert.equal(isPublicApiCall('GET', '/api/owner/inventory'), false)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc/pay'), false)
})

test('a path no handler knows is 404, not an invitation to sign in', async t => {
  // Every unmatched /api/* path answered 401 with the owner sign-in message:
  // a customer with a slip in a link was told to sign in to a workspace they
  // do not have. Known areas: the public calls and the owner's; nothing else.
  assert.equal(isKnownApiPath('/api/catalog'), true)
  assert.equal(isKnownApiPath('/api/health'), true)
  assert.equal(isKnownApiPath('/api/requests'), true)
  assert.equal(isKnownApiPath('/api/requests/abc/pay'), true)
  assert.equal(isKnownApiPath('/api/owner/inventory'), true)
  assert.equal(isKnownApiPath('/api/owner/nonsense'), true, 'the owner area is known even where the route is not; which routes exist is the owner\'s business')
  assert.equal(isKnownApiPath('/api/nonsense'), false)
  assert.equal(isKnownApiPath('/api/api/catalog'), false)
  assert.equal(isKnownApiPath('/api/requestsx'), false, 'a prefix match is on the segment, not the string')
  assert.equal(isKnownApiPath('/api/owner'), false, 'the owner area is under /api/owner/, not the bare name')

  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)
  const nonsense = await fetch(`${base}/api/nonsense`)
  assert.equal(nonsense.status, 404)
  assert.deepEqual(await nonsense.json(), { error: 'No such endpoint.' })
  const owner = await fetch(`${base}/api/owner/inventory`)
  assert.equal(owner.status, 401, 'a real owner route without a session is still the sign-in answer')
  assert.equal((await fetch(`${base}/api/owner/nonsense`)).status, 401)
  assert.equal((await fetch(`${base}/api/catalog`)).status, 200)
  // A doubled slash reaches the handler as the path it meant, end to end:
  // the collapse has to be written back onto the request, because every
  // handler parses request.url for itself.
  const slipped = await fetch(`${base}/api//catalog`)
  assert.equal(slipped.status, 200, 'the catalog, not a sign-in message and not a 404')
  assert.ok(Array.isArray((await slipped.json()).tires))
  assert.equal((await fetch(`${base}/api/api//catalog`)).status, 404)
})

test('the catalog handler answers the catalog and nothing else', async t => {
  // It used to guard on "is this a public path", which is a different question
  // from "is this my route". The moment a second public path existed, a POST to
  // /api/requests came back as a list of tires -- 200, valid JSON, wrong.
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)

  const created = await post(base, '/api/requests', form())
  assert.equal(created.status, 201)
  const body = await created.json()
  assert.equal(body.tires, undefined, 'not the catalog')
  assert.ok(body.request?.id, 'the request that was asked for')

  const catalog = await (await fetch(base + '/api/catalog')).json()
  assert.ok(Array.isArray(catalog.tires), 'and the catalog still answers its own path')
})

test('the catalog is cached for five minutes, and ?size narrows it to one size', async t => {
  const OTHER_SIZE = '225/50R17'
  const inventory = new Inventory(':memory:', [SIZE, OTHER_SIZE])
  t.after(() => inventory.close())
  inventory.importSnapshot({
    source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE, OTHER_SIZE],
    tires: [tire('giga-a', { size: SIZE }), tire('giga-b', { size: OTHER_SIZE, name: 'Second' })],
  })
  inventory.saveMarkup({ rate: 1.4 })
  const quotes = new Quotes(inventory)
  const base = await serve(t, quotes, inventory)

  const whole = await fetch(base + '/api/catalog')
  assert.equal(whole.headers.get('cache-control'), 'public, max-age=300')
  const wholeSizes = (await whole.json()).tires.map(t => t.size).sort()
  assert.deepEqual(wholeSizes, [OTHER_SIZE, SIZE].sort(), 'no size param answers every size')

  const narrowed = await fetch(base + `/api/catalog?size=${encodeURIComponent(SIZE)}`)
  assert.equal(narrowed.headers.get('cache-control'), 'public, max-age=300')
  const narrowedTires = (await narrowed.json()).tires
  assert.equal(narrowedTires.length, 1)
  assert.equal(narrowedTires[0].size, SIZE)
  assert.equal(narrowedTires[0].id, 'giga-a')

  const unsupported = await (await fetch(base + '/api/catalog?size=999/99R99')).json()
  assert.deepEqual(unsupported.tires, [], 'a size nothing matches answers empty, not an error')
})

/* ------------------------------------------------------- owner review (t30) */

/** Sign in the way the owner screen does, and return the cookie header. */
async function signIn(base) {
  const answer = await post(base, '/api/owner/login', { password: 'a-long-enough-password' })
  assert.equal(answer.status, 200, 'the harness password is the one auth was built with')
  return { cookie: answer.headers.getSetCookie()[0] }
}

test('the owner sees every request with the tire it was quoted for', async t => {
  const { quotes } = setup(t)
  const first = quotes.submit(form())
  quotes.submit(form({ customerKey: OTHER_KEY, vehicleInfo: '2018 Subaru Outback' }))

  const listed = quotes.listForOwner()

  assert.equal(listed.length, 2, "every request, not one browser's")
  assert.equal(listed[0].request.id, quotes.listForOwner()[0].request.id)
  const mine = listed.find(row => row.request.id === first.request.id)
  assert.equal(mine.tire.name, 'Test Touring', 'the tire resolved from the catalog it was drafted against')
  assert.equal(mine.tire.size, SIZE)
  assert.equal(mine.quote.status, 'draft')
  assert.ok(Array.isArray(mine.quote.exceptionReasons))
  assert.equal(mine.request.customerName, 'Jamie Rivera', 'the owner sees who to contact')
  assert.equal(mine.request.customerEmail, 'jamie@example.com')
  assert.equal(mine.request.customerPhone, '+16174108319')
})

test("the owner's row carries the supplier's stock and when it was last seen; the customer's carries no tire at all", async t => {
  // Approval is the one human gate in the flow, and refreshes are monthly.
  // The customer catalog strips stock and lastSeen by design (R16), so the
  // owner was deciding against a tire it could not see the state of (#105).
  const { inventory, quotes } = setup(t)
  const { request } = quotes.submit(form())

  const listed = quotes.listForOwner().find(row => row.request.id === request.id)
  assert.equal(listed.tire.supplierStock, 12, 'the count the supplier last showed')
  assert.equal(listed.tire.supplierLastSeen, '2026-09-05T15:00:00Z', 'when the supplier last showed it')
  assert.equal(listed.tire.supplierActive, true)
  assert.equal(listed.tire.price, 70, 'the quoted price is still the marked-up customer price, not the supplier cost')

  // A complete refresh that no longer lists the tire retires it: stock is what
  // it last was, and the row says the supplier has stopped listing it.
  inventory.refreshSize(SIZE, [tire('giga-b', { name: 'Replacement' })])
  const retired = quotes.listForOwner().find(row => row.request.id === request.id)
  assert.equal(retired.tire.supplierActive, false)
  assert.equal(retired.tire.supplierStock, 12)
  assert.equal(retired.tire.name, 'Test Touring', 'the tire that was quoted is still named')

  // A supplier that shows none in stock says so, as a number the card can warn on.
  inventory.refreshSize(SIZE, [tire('giga-a', { inStock: false, source: { ...tire().source, stock: 0 } })])
  assert.equal(quotes.listForOwner().find(row => row.request.id === request.id).tire.supplierStock, 0)

  // The customer's shapes carry no tire object, so nothing here can leak that way.
  assert.equal('tire' in quotes.get(request.id), false)
  assert.equal('tire' in quotes.listForCustomer(KEY)[0], false)
  // Nor does the owner row's tire carry the supplier's URL, SKU or list price.
  assert.deepEqual(Object.keys(listed.tire).sort(), ['id', 'name', 'price', 'size', 'supplierActive', 'supplierLastSeen', 'supplierStock'])
})

test('a tire that has since left the catalog still shows what was quoted', async t => {
  // The owner is reviewing a decision made earlier. A blank where the tire was
  // hides the one fact that explains the row.
  const { inventory, quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  inventory.saveOffer('giga-a', { priceCents: null, enabled: false, notes: '', version: 0 })

  const row = quotes.listForOwner().find(item => item.request.id === request.id)
  assert.equal(row.tire.id, 'giga-a', 'the id is still there to look up')
  assert.equal(row.tire.name, null, 'and it is honest that the catalog no longer carries it')
  // Compared against what was quoted, not a number written down here: the
  // point is that the catalog moving does not reprice a quote already given.
  assert.equal(row.quote.total, quote.total)
  assert.deepEqual(row.quote.lineItems, quote.lineItems)
})

test('approving moves a draft, and the customer sees it from their own device', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  const decided = quotes.decide(request.id, 'sent', quote.version)

  assert.equal(decided.quote.status, 'sent')
  assert.equal(decided.quote.version, quote.version + 1, 'the version moves with the decision')
  // The customer's own read, by id, sees the same thing.
  assert.equal(quotes.get(request.id).quote.status, 'sent')
  assert.equal(quotes.listForCustomer(KEY)[0].quote.status, 'sent')
})

test('rejecting moves a draft the same way', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  assert.equal(quotes.decide(request.id, 'rejected', quote.version).quote.status, 'rejected')
  assert.equal(quotes.get(request.id).quote.status, 'rejected')
})

test('a stale version is refused rather than overwriting the newer decision', async t => {
  // Two owner windows, or a phone and a laptop. The second save must not
  // silently undo the first -- the same rule PUT /api/owner/offers/:id makes.
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  quotes.decide(request.id, 'sent', quote.version)

  assert.throws(
    () => quotes.decide(request.id, 'rejected', quote.version),
    error => error.status === 409 && /changed in another window/.test(error.message),
  )
  assert.equal(quotes.get(request.id).quote.status, 'sent', 'the first decision stands')
})

test('only a draft can be decided', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  const sent = quotes.decide(request.id, 'sent', quote.version)

  // Right version, wrong state: already decided, and paid is further still.
  assert.throws(
    () => quotes.decide(request.id, 'rejected', sent.quote.version),
    error => error.status === 409 && /already sent/.test(error.message),
  )

  quotes.pay(request.id, KEY)
  const paid = quotes.get(request.id)
  assert.throws(
    () => quotes.decide(request.id, 'rejected', paid.quote.version),
    error => error.status === 409 && /already paid/.test(error.message),
  )
})

test('a decision has to be a decision, and carry a version', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  assert.throws(() => quotes.decide(request.id, 'maybe', quote.version), /sent to the customer or rejected/)
  assert.throws(() => quotes.decide(request.id, 'sent', undefined), /version you were shown/)
  assert.throws(() => quotes.decide(request.id, 'sent', -1), /version you were shown/)
  assert.throws(() => quotes.decide('0'.repeat(32), 'sent', 1), /No such request/)
})

test('the owner endpoints need a session, and the customer endpoints are unchanged', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)
  const { request, quote } = quotes.submit(form())

  // Shut without a cookie, exactly like the rest of the owner API.
  assert.equal((await fetch(`${base}/api/owner/requests`)).status, 401)
  assert.equal((await post(base, `/api/owner/quotes/${request.id}/approve`, { version: quote.version })).status, 401)

  const { cookie } = await signIn(base)
  const headers = { cookie, 'Content-Type': 'application/json' }

  const listed = await (await fetch(`${base}/api/owner/requests`, { headers })).json()
  assert.equal(listed.requests.length, 1)
  assert.equal(listed.requests[0].tire.name, 'Test Touring')

  const stale = await fetch(`${base}/api/owner/quotes/${request.id}/approve`, {
    method: 'POST', headers, body: JSON.stringify({ version: quote.version + 5 }),
  })
  assert.equal(stale.status, 409, 'a stale version is a 409 over HTTP too')

  const approved = await fetch(`${base}/api/owner/quotes/${request.id}/approve`, {
    method: 'POST', headers, body: JSON.stringify({ version: quote.version }),
  })
  assert.equal(approved.status, 200)
  assert.equal((await approved.json()).quote.status, 'sent')

  // t29's endpoints, from a customer with no session, still behave.
  const seen = await (await fetch(`${base}/api/requests/${request.id}`)).json()
  assert.equal(seen.quote.status, 'sent', 'the customer sees the decision from their own device')
  const paid = await post(base, `/api/requests/${request.id}/pay`, { customerKey: KEY })
  assert.equal(paid.status, 200)
  assert.equal((await paid.json()).quote.status, 'paid')
})

/* ----------------------------------------------------- the lifecycle (t36) */

/** Walk a fresh request to a status, the way the two sides actually reach it. */
function walkTo(quotes, status, overrides = {}) {
  const { request, quote } = quotes.submit(form(overrides))
  if (status === 'draft') return quotes.get(request.id)
  if (status === 'rejected') return quotes.decide(request.id, 'rejected', quote.version)
  const sent = quotes.decide(request.id, 'sent', quote.version)
  if (status === 'sent') return sent
  const paid = quotes.pay(request.id, overrides.customerKey ?? KEY)
  if (status === 'paid') return paid
  if (status === 'done') return quotes.finish(request.id, paid.quote.version)
  throw new Error(`walkTo does not know how to reach ${status}`)
}

test('a paid request is closed by marking it done, and only from paid', async t => {
  const { quotes } = setup(t)

  const paid = walkTo(quotes, 'paid')
  const done = quotes.finish(paid.request.id, paid.quote.version)
  assert.equal(done.quote.status, 'done')
  assert.equal(done.quote.version, paid.quote.version + 1, 'the version moves with the transition')
  assert.equal(quotes.get(paid.request.id).quote.status, 'done', 'and the customer reads it too')

  // Twice is not twice as done.
  assert.throws(
    () => quotes.finish(paid.request.id, done.quote.version),
    error => error.status === 409 && /already closed/.test(error.message),
  )

  for (const status of ['draft', 'sent', 'rejected']) {
    const row = walkTo(quotes, status)
    assert.throws(
      () => quotes.finish(row.request.id, row.quote.version),
      error => error.status === 409 && /only a paid request/.test(error.message),
      `${status} should not be markable done`,
    )
  }
})

test('marking done takes the same version check as every other transition', async t => {
  const { quotes } = setup(t)
  const paid = walkTo(quotes, 'paid')

  assert.throws(() => quotes.finish(paid.request.id, paid.quote.version + 5),
    error => error.status === 409 && /changed in another window/.test(error.message))
  assert.throws(() => quotes.finish(paid.request.id, undefined), /version you were shown/)
  assert.throws(() => quotes.finish('0'.repeat(32), 1), error => error.status === 404)
  assert.equal(quotes.get(paid.request.id).quote.status, 'paid', 'and none of that moved it')
})

test('the owner can cancel before payment, with a reason, and not after', async t => {
  const { quotes } = setup(t)

  for (const status of ['draft', 'sent']) {
    const row = walkTo(quotes, status)
    const cancelled = quotes.cancel(row.request.id, row.quote.version, ' out of stock ')
    assert.equal(cancelled.quote.status, 'cancelled', `cancelling from ${status}`)
    assert.equal(cancelled.quote.reason, 'out of stock', 'trimmed, and kept with the row')
    assert.equal(quotes.get(row.request.id).quote.reason, 'out of stock', 'the customer is told why')
  }

  // A reason is optional, and nothing stands in for one.
  const bare = walkTo(quotes, 'draft')
  assert.equal(quotes.cancel(bare.request.id, bare.quote.version).quote.reason, null)
  const blank = walkTo(quotes, 'draft')
  assert.equal(quotes.cancel(blank.request.id, blank.quote.version, '   ').quote.reason, null)

  const paid = walkTo(quotes, 'paid')
  assert.throws(
    () => quotes.cancel(paid.request.id, paid.quote.version),
    error => error.status === 409 && /Mark it done/.test(error.message),
    'money has moved; the way out is done, not cancelled',
  )
  const done = walkTo(quotes, 'done')
  assert.throws(() => quotes.cancel(done.request.id, done.quote.version),
    error => error.status === 409 && /already done/.test(error.message))
})

test('nothing is deleted: a cancelled request is still there to read', async t => {
  const { quotes } = setup(t)
  const row = walkTo(quotes, 'sent')
  quotes.cancel(row.request.id, row.quote.version, 'the van broke down')

  const found = quotes.get(row.request.id)
  assert.equal(found.request.vehicleInfo, '2021 Honda Civic', 'the request it was made from')
  assert.equal(found.quote.total, row.quote.total, 'and the quote it was given')
  assert.equal(quotes.listForCustomer(KEY).length, 1)
  assert.equal(quotes.listForOwner().length, 1)
})

test('a customer can call off their own request, and only their own', async t => {
  const { quotes } = setup(t)

  const row = walkTo(quotes, 'sent')
  assert.throws(
    () => quotes.cancelByCustomer(row.request.id, OTHER_KEY),
    error => error.status === 404 && /No such request/.test(error.message),
    'a wrong key is answered as though the request does not exist',
  )
  assert.equal(quotes.get(row.request.id).quote.status, 'sent', 'and nothing moved')

  const cancelled = quotes.cancelByCustomer(row.request.id, KEY, 'sold the car')
  assert.equal(cancelled.quote.status, 'cancelled')
  assert.equal(cancelled.quote.reason, 'sold the car')
  // Asking twice is the same answer, not an error: a phone that lost the reply.
  assert.equal(quotes.cancelByCustomer(row.request.id, KEY).quote.status, 'cancelled')
})

test('a customer cannot call off what they have already paid for', async t => {
  const { quotes } = setup(t)
  const paid = walkTo(quotes, 'paid')

  assert.throws(
    () => quotes.cancelByCustomer(paid.request.id, KEY),
    error => error.status === 409 && /been paid for/.test(error.message),
  )
  assert.equal(quotes.get(paid.request.id).quote.status, 'paid')

  const done = walkTo(quotes, 'done')
  assert.throws(() => quotes.cancelByCustomer(done.request.id, KEY),
    error => error.status === 409 && /been paid for/.test(error.message))
})

test('a quote approved before this change is still payable and still readable', async t => {
  // The deployed database holds one of these: the t33 proof row, approved on
  // the owner device before the decision was named `sent`. It has to keep
  // behaving, which is why `approved` was not renamed out of existence.
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  quotes.db.prepare('UPDATE quotes SET status=? WHERE request_id=?').run('approved', request.id)

  const stored = quotes.get(request.id)
  assert.equal(stored.quote.status, 'approved')
  assert.equal(quotes.viewForOwner('awaiting').requests.length, 1, 'it waits with the sent ones')
  assert.equal(quotes.viewForOwner('open').requests.length, 1, 'and it is open, not closed')

  const paid = quotes.pay(request.id, KEY)
  assert.equal(paid.quote.status, 'paid')
  assert.equal(quotes.finish(request.id, paid.quote.version).quote.status, 'done',
    'and it can be closed the day this lands')
})

test('the owner list is filtered by view, and every view is counted', async t => {
  const { quotes } = setup(t)
  walkTo(quotes, 'draft')
  walkTo(quotes, 'sent', { vehicleInfo: 'sent one' })
  walkTo(quotes, 'paid', { vehicleInfo: 'paid one' })
  walkTo(quotes, 'done', { vehicleInfo: 'done one' })
  walkTo(quotes, 'rejected', { vehicleInfo: 'rejected one' })
  const toCancel = walkTo(quotes, 'draft', { vehicleInfo: 'cancelled one' })
  quotes.cancel(toCancel.request.id, toCancel.quote.version, 'no van that day')

  const open = quotes.viewForOwner()
  assert.equal(open.view, 'open', 'no view asked for is the open one')
  assert.deepEqual(open.counts, { open: 3, attention: 1, awaiting: 1, paid: 1, closed: 3 },
    'every view is counted, not only the one being shown')
  assert.equal(open.requests.length, 3)

  assert.deepEqual(quotes.viewForOwner('attention').requests.map(row => row.quote.status), ['draft'])
  assert.deepEqual(quotes.viewForOwner('awaiting').requests.map(row => row.quote.status), ['sent'])
  assert.deepEqual(quotes.viewForOwner('paid').requests.map(row => row.quote.status), ['paid'])
  assert.deepEqual(
    quotes.viewForOwner('closed').requests.map(row => row.quote.status).sort(),
    ['cancelled', 'done', 'rejected'],
  )

  // Newest first, the order the whole list already keeps.
  const closed = quotes.viewForOwner('closed').requests
  assert.deepEqual(closed.map(row => row.request.vehicleInfo),
    ['cancelled one', 'rejected one', 'done one'])

  // A bookmark from before these views existed still shows something useful.
  assert.equal(quotes.viewForOwner('everything').view, 'open')
  assert.equal(quotes.viewForOwner(null).view, 'open')
})

test('the lifecycle over HTTP: the owner acts with a session, the customer with a key', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)
  const { cookie } = await signIn(base)
  const headers = { cookie, 'Content-Type': 'application/json' }
  const asOwner = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })

  const paid = walkTo(quotes, 'paid')
  // Shut without a cookie, exactly like every other owner route.
  assert.equal((await post(base, `/api/owner/quotes/${paid.request.id}/done`,
    { version: paid.quote.version })).status, 401)
  assert.equal((await post(base, `/api/owner/quotes/${paid.request.id}/cancel`,
    { version: paid.quote.version })).status, 401)

  const done = await asOwner(`/api/owner/quotes/${paid.request.id}/done`, { version: paid.quote.version })
  assert.equal(done.status, 200)
  assert.equal((await done.json()).quote.status, 'done')

  const sent = walkTo(quotes, 'sent', { vehicleInfo: 'to cancel' })
  const cancelled = await asOwner(`/api/owner/quotes/${sent.request.id}/cancel`,
    { version: sent.quote.version, reason: 'no van that day' })
  assert.equal(cancelled.status, 200)
  const body = await cancelled.json()
  assert.equal(body.quote.status, 'cancelled')
  assert.equal(body.quote.reason, 'no van that day')

  // The view the screen asks for, over the wire, with its counts.
  const view = await (await fetch(`${base}/api/owner/requests?view=closed`, { headers })).json()
  assert.equal(view.view, 'closed')
  assert.equal(view.requests.length, 2)
  assert.equal(view.counts.closed, 2)

  // And the customer cancelling their own, with no session at all.
  const mine = walkTo(quotes, 'sent', { vehicleInfo: 'mine to cancel' })
  assert.equal((await post(base, `/api/requests/${mine.request.id}/cancel`,
    { customerKey: OTHER_KEY })).status, 404)
  const own = await post(base, `/api/requests/${mine.request.id}/cancel`,
    { customerKey: KEY, reason: 'changed my mind' })
  assert.equal(own.status, 200)
  assert.equal((await own.json()).quote.reason, 'changed my mind')
})

test('cancel is public by name, and only as a POST', async () => {
  // The allow-list is the whole protection here: a route under /api/requests
  // is reachable without a session only because it is written down.
  assert.equal(isPublicApiCall('POST', '/api/requests/abc/cancel'), true)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc/cancel'), false,
    'an action is not something a GET performs')
  assert.equal(isPublicApiCall('POST', '/api/requests/abc/done'), false,
    'the owner closes a request, and that is not a public call')
  assert.equal(isPublicApiCall('POST', '/api/owner/quotes/abc/cancel'), false)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc'), true, 'reading one still works')
})

/* ------------------------------------------------------------ health (#88) */

test('health answers a machine with no session, and nothing else does', async t => {
  // The platform check arrives with no cookie. Behind the session gate this
  // answers 401, the check never passes, and Fly marks the only machine
  // unhealthy for as long as it runs -- so "reachable without a session" is
  // the property under test, not an incidental one.
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)

  const answer = await fetch(`${base}/api/health`)
  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('cache-control'), 'no-store', 'a cached health check is not a health check')
  assert.deepEqual(await answer.json(), { ok: true })

  // HEAD is what uptime tools send: the same status, no body. The baseline
  // recorded it as 401, which reads a healthy machine as refusing.
  const head = await fetch(`${base}/api/health`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('cache-control'), 'no-store')
  assert.equal(await head.text(), '', 'no body on a HEAD')

  // GET and HEAD only, and the session gate is what refuses the rest: the
  // allow-list opens this path for those alone, so a POST is 401 before the
  // handler is reached. That is the right layer for it -- the handler is not
  // the thing standing between the public and a write.
  const posted = await post(base, '/api/health', {})
  assert.equal(posted.status, 401, 'refused by the gate, not by the handler')

  // And the gate it sits beside is unchanged.
  assert.equal((await fetch(`${base}/api/owner/inventory`)).status, 401)
})

test('health asks the database rather than answering a constant', async t => {
  // A process that is listening but cannot read its database is exactly the
  // failure worth restarting for. If this endpoint returned a literal, it would
  // report healthy through a missing volume mount.
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)

  const broken = new Error('unable to open database file')
  const realPrepare = inventory.db.prepare.bind(inventory.db)
  inventory.db.prepare = statement => {
    if (statement.includes('sqlite_master')) throw broken
    return realPrepare(statement)
  }
  t.after(() => { inventory.db.prepare = realPrepare })

  const answer = await fetch(`${base}/api/health`)
  assert.equal(answer.status, 503, 'a database that cannot be read is not healthy')
  assert.deepEqual(await answer.json(), { ok: false })
})

test('the health handler answers its own path and nothing else', async t => {
  // The mistake createCatalogApi made once: guarding on "is this public"
  // instead of "is this my route".
  const { inventory } = setup(t)
  const healthApi = createHealthApi(inventory)
  const answered = await healthApi(
    { method: 'GET', url: '/api/catalog', headers: {} },
    { writeHead: () => {}, end: () => {} },
  )
  assert.equal(answered, false, 'it must decline a path that is not its own')

  // Its own path with the wrong method is 405, not a fall-through. Unreachable
  // behind server.mjs's gate, which answers 401 first, but backend/dev.mjs
  // mounts the same handler with no gate at all.
  let status = 0
  await healthApi(
    { method: 'POST', url: '/api/health', headers: {} },
    { writeHead: code => { status = code }, end: () => {} },
  )
  assert.equal(status, 405)
})

test('the Host guard refuses a strange host, and never the health check', async () => {
  // KMT_ALLOWED_HOSTS is set in production, and the platform check arrives on
  // the internal network with a Host header that is not the public hostname. A
  // 403 there reads as an unhealthy machine in monitoring even though the check
  // can no longer take the site out of the proxy.
  const allowed = ['kmt.fly.dev']

  assert.equal(isHostAllowed('kmt.fly.dev', '/', allowed), true)
  assert.equal(isHostAllowed('KMT.Fly.Dev', '/', allowed), true, 'hostnames are case-insensitive, as the redirect already treats them')
  assert.equal(isHostAllowed('kensmobiletire.com', '/', ['KensMobileTire.com']), true, 'in the allow-list too')
  assert.equal(isHostAllowed('evil.example.com', '/', allowed), false)
  assert.equal(isHostAllowed('evil.example.com', '/api/catalog', allowed), false,
    'the exemption is for the health path alone')

  assert.equal(isHostAllowed('kmt.internal', '/api/health', allowed), true)
  assert.equal(isHostAllowed('[fdaa:0:1::3]', '/api/health', allowed), true)
  assert.equal(isHostAllowed('', '/api/health', allowed), true, 'no Host header at all is still the check')

  // Unset means accept anything, which is what a local run does.
  assert.equal(isHostAllowed('anything', '/', []), true)
})
