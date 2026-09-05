import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { createApi, createCatalogApi, createRequestsApi, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'
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
  location: '456 Demo Ave',
  date: '2026-09-10',
  locationType: 'home',
  serviceZip: '02149',
  locationNotes: 'Driveway',
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

test('an id that does not exist reads as nothing, not as someone else', async t => {
  const { quotes } = setup(t)
  assert.equal(quotes.get('0'.repeat(32)), null)
  assert.equal(quotes.get(''), null)
})

/* ------------------------------------------------------------------- HTTP */

/** A server shaped like server.mjs: the same gate, the same handlers. */
function serve(t, quotes, inventory) {
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password' }))
  const requestsApi = createRequestsApi(quotes)
  const catalogApi = createCatalogApi(inventory)
  const ownerApi = createApi(inventory, { start: () => ({}), cancel: () => ({}) }, null, quotes)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (url.pathname.startsWith('/api/')) {
      if (!isPublicApiCall(request.method, url.pathname) && !auth.isAuthenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
        return
      }
      // Mounted in the order server.mjs mounts them, so a handler that
      // answers a route belonging to another one shows up here.
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

test('the public rule opens the customer paths and nothing else', async t => {
  // The allow-list is a prefix, so this pins what the prefix does and does not
  // reach -- a route added under it later stays behind the session by default.
  assert.equal(isPublicApiCall('GET', '/api/catalog'), true)
  assert.equal(isPublicApiCall('POST', '/api/requests'), true)
  assert.equal(isPublicApiCall('GET', '/api/requests'), true)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc123'), true)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123/pay'), true)

  assert.equal(isPublicApiCall('POST', '/api/catalog'), false)
  assert.equal(isPublicApiCall('DELETE', '/api/requests/abc123'), false)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123'), false)
  assert.equal(isPublicApiCall('POST', '/api/requests/abc123/approve'), false)
  assert.equal(isPublicApiCall('GET', '/api/owner/inventory'), false)
  assert.equal(isPublicApiCall('GET', '/api/requests/abc/pay'), false)
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

  const decided = quotes.decide(request.id, 'approved', quote.version)

  assert.equal(decided.quote.status, 'approved')
  assert.equal(decided.quote.version, quote.version + 1, 'the version moves with the decision')
  // The customer's own read, by id, sees the same thing.
  assert.equal(quotes.get(request.id).quote.status, 'approved')
  assert.equal(quotes.listForCustomer(KEY)[0].quote.status, 'approved')
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

  quotes.decide(request.id, 'approved', quote.version)

  assert.throws(
    () => quotes.decide(request.id, 'rejected', quote.version),
    error => error.status === 409 && /changed in another window/.test(error.message),
  )
  assert.equal(quotes.get(request.id).quote.status, 'approved', 'the first decision stands')
})

test('only a draft can be decided', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  const approved = quotes.decide(request.id, 'approved', quote.version)

  // Right version, wrong state: already decided, and paid is further still.
  assert.throws(
    () => quotes.decide(request.id, 'rejected', approved.quote.version),
    error => error.status === 409 && /already approved/.test(error.message),
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

  assert.throws(() => quotes.decide(request.id, 'maybe', quote.version), /approved or rejected/)
  assert.throws(() => quotes.decide(request.id, 'approved', undefined), /version you were shown/)
  assert.throws(() => quotes.decide(request.id, 'approved', -1), /version you were shown/)
  assert.throws(() => quotes.decide('0'.repeat(32), 'approved', 1), /No such request/)
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
  assert.equal((await approved.json()).quote.status, 'approved')

  // t29's endpoints, from a customer with no session, still behave.
  const seen = await (await fetch(`${base}/api/requests/${request.id}`)).json()
  assert.equal(seen.quote.status, 'approved', 'the customer sees the decision from their own device')
  const paid = await post(base, `/api/requests/${request.id}/pay`, { customerKey: KEY })
  assert.equal(paid.status, 200)
  assert.equal((await paid.json()).quote.status, 'paid')
})
