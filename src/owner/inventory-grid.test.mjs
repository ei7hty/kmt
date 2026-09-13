/**
 * The inventory matrix, against a stub of the stage-1 contract.
 *
 * STAGE 1 IS NOT ON MAIN. These tests are the only thing standing behind this
 * screen until it is, so the stub is deliberately strict rather than
 * accommodating: it refuses a pageSize outside the allow-list, refuses a bulk
 * body over 200 rows, refuses a request with no explicit sort/dir, and refuses
 * an offer entry missing any field the contract names. A stub that shrugged at
 * those would pass here and fail against the real endpoint, which is the one
 * failure mode a stub has to be built against.
 *
 * What it cannot prove is that the real server agrees. End-to-end verification
 * is outstanding and is called out on the pull request.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ratio } from '../../.forge/contrast-measure.mjs'
import {
  createInventoryGrid, headerSortState, nextSortRequest, showEmptyState,
  applyBulkResults, bulkNotice, reasonLabel, priceFromFormula, previewPriceChange,
  parseMoney, PAGE_SIZES, BULK_LIMIT, sellingEnabled, neverDecided, ruledPriceCents,
} from './inventory-grid.js'

const SORT_KEYS = ['size', 'name', 'supplierPrice', 'price', 'margin', 'enabled', 'updated']

const makeItem = (n, over = {}) => ({
  id: `sku-${n}`,
  name: `Tire ${n}`,
  size: '205/55R16',
  price: 100 + n,
  inStock: true,
  supplierActive: true,
  category: 'all-season',
  marginCents: 2500 + n,
  source: { sku: `SKU${n}`, stock: 4, url: 'https://www.giga-tires.com/tires/205-55-16' },
  offer: { priceCents: 12500 + n, shippingCents: null, enabled: false, notes: '', version: 1 },
  ...over,
})

/**
 * The contract, as a stub.
 *
 * `echo` lets a test make the server apply a DIFFERENT sort than was asked for,
 * which is exactly what the real endpoint does with an unknown key.
 */
function makeApi({ pool = Array.from({ length: 60 }, (_, i) => makeItem(i + 1)), echo = null, bulk = null, single = null, photo = null } = {}) {
  const calls = []
  const api = async (path, options = {}) => {
    calls.push({ path, options })
    if (path.startsWith('inventory?')) {
      const params = new URLSearchParams(path.slice('inventory?'.length))
      const pageSize = Number(params.get('pageSize'))
      assert.ok(PAGE_SIZES.includes(pageSize), `pageSize ${params.get('pageSize')} is not in the allow-list`)
      const sort = params.get('sort')
      const dir = params.get('dir')
      assert.ok(sort, 'every inventory request must name a sort')
      assert.ok(['asc', 'desc'].includes(dir), `dir ${dir} must be asc or desc`)
      const page = Number(params.get('page'))
      assert.ok(Number.isInteger(page) && page >= 1, 'page must be a positive integer')
      const start = (page - 1) * pageSize
      // An unknown sort falls back to the default order WITHOUT an error, and
      // the response says what was actually applied.
      const applied = echo ?? (SORT_KEYS.includes(sort) ? { sort, dir } : { sort: 'size', dir: 'asc' })
      return {
        items: pool.slice(start, start + pageSize),
        total: pool.length, page, pageSize,
        sort: applied.sort, dir: applied.dir,
        summary: { offeredCount: 0, markup: { rate: 1.4, shippingPerTire: 20 }, sizes: [], brands: [] },
      }
    }
    if (path === 'offers' && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      assert.ok(Array.isArray(body.offers), 'bulk body must carry an offers array')
      assert.ok(body.offers.length <= BULK_LIMIT, `bulk body may not exceed ${BULK_LIMIT} rows`)
      for (const offer of body.offers) {
        for (const field of ['id', 'priceCents', 'shippingCents', 'enabled', 'notes', 'version']) {
          assert.ok(field in offer, `bulk offer is missing ${field}`)
        }
        assert.equal(typeof offer.version, 'number', 'every bulk offer carries the version it expects')
      }
      return bulk ? bulk(body) : { results: body.offers.map(offer => ({ id: offer.id, ok: true, version: offer.version + 1 })) }
    }
    if (path.startsWith('offers/') && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      assert.equal(typeof body.version, 'number', 'a single-row save carries its expected version')
      if (single) return single(path, body)
      return { ...body, version: body.version + 1 }
    }
    if (path.startsWith('images/product/') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      assert.deepEqual(Object.keys(body), ['hidden'], 'the photo route takes exactly { hidden }')
      assert.equal(typeof body.hidden, 'boolean')
      const supplierId = decodeURIComponent(path.slice('images/product/'.length))
      if (photo) return photo(supplierId, body)
      return { supplierId, hidden: body.hidden, packet: 'p1', ordinal: 0 }
    }
    throw new Error(`the stub was asked for an unknown route: ${options.method || 'GET'} ${path}`)
  }
  return { api, calls }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

// ---------------------------------------------------------------- c. the echo

test('the header arrow follows the sort the server echoed, not the one requested', async () => {
  // The server was asked for margin/desc and applied size/asc instead.
  const { api } = makeApi({ echo: { sort: 'size', dir: 'asc' } })
  const grid = createInventoryGrid({ api })
  await grid.sortBy('margin')

  assert.deepEqual(grid.echoed(), { sort: 'size', dir: 'asc' })
  assert.equal(headerSortState(grid.echoed(), 'margin'), null,
    'the requested column must show no arrow when the server ignored it')
  assert.equal(headerSortState(grid.echoed(), 'size'), 'asc',
    'the arrow belongs on the column the server actually ordered by')
})

test('clicking a header again reverses the direction the server reported', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.sortBy('margin')
  assert.equal(headerSortState(grid.echoed(), 'margin'), 'asc')
  await grid.sortBy('margin')
  assert.equal(headerSortState(grid.echoed(), 'margin'), 'desc')
  assert.ok(calls.at(-1).path.includes('sort=margin&dir=desc'))
})

test('nextSortRequest reads the echo, so a rejected sort cannot toggle a direction', () => {
  assert.deepEqual(nextSortRequest({ sort: 'size', dir: 'asc' }, 'margin'), { sort: 'margin', dir: 'asc' })
  assert.deepEqual(nextSortRequest({ sort: 'margin', dir: 'asc' }, 'margin'), { sort: 'margin', dir: 'desc' })
  assert.deepEqual(nextSortRequest({ sort: 'margin', dir: 'desc' }, 'margin'), { sort: 'margin', dir: 'asc' })
  assert.deepEqual(nextSortRequest(null, 'margin'), { sort: 'margin', dir: 'asc' })
})

// ------------------------------------------------------- d. a failed load

test('a failed load does not render the empty state', async () => {
  // Built specifically so `!error` is the ONLY thing suppressing the panel.
  // With rows on screen `items.length === 0` suppresses it; with `data` still
  // null `!data` does; in both of those a missing `!error` clause leaves this
  // test green. Zero rows loaded successfully, THEN a failure, is the one
  // arrangement where the guard is load-bearing -- and it is the real case:
  // an empty filter result followed by a request that does not come back.
  const { api } = makeApi({ pool: [] })
  let fail = false
  const grid = createInventoryGrid({ api: async (...args) => {
    if (fail) throw new Error('The owner backend is not connected.')
    return api(...args)
  } })
  await grid.load()
  assert.equal(showEmptyState(grid.getState()), true,
    'a genuinely empty result does say so -- the guard must not blanket-suppress the panel')

  fail = true
  await grid.reload()
  const state = grid.getState()
  assert.equal(state.error, 'The owner backend is not connected.')
  assert.equal(state.data.items.length, 0)
  assert.equal(showEmptyState(state), false,
    'a failed load must never be reported as an empty inventory')
})

test('a cold load that fails shows no empty state either', async () => {
  const api = async () => { throw new Error('The owner backend is not connected.') }
  const grid = createInventoryGrid({ api })
  await grid.load()
  assert.equal(showEmptyState(grid.getState()), false)
})

test('a failed load keeps the rows already on screen rather than blanking them', async () => {
  const { api } = makeApi({ pool: [makeItem(1)] })
  let fail = false
  const grid = createInventoryGrid({ api: async (...args) => {
    if (fail) throw new Error('The request could not be completed.')
    return api(...args)
  } })
  await grid.load()
  fail = true
  await grid.reload()
  assert.equal(grid.getState().data.items.length, 1)
  assert.equal(showEmptyState(grid.getState()), false)
})

test('a 401 opens the sign-in door rather than reporting an error', async () => {
  const api = async () => { const error = new Error('Sign in to continue.'); error.status = 401; throw error }
  const grid = createInventoryGrid({ api })
  await grid.load()
  assert.equal(grid.getState().needsSignIn, true)
  assert.equal(grid.getState().error, '')
})

// ------------------------------------------------------ b. selection lifecycle

test('selection is dropped on a page change', async () => {
  const { api } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.toggleSelected('sku-1')
  grid.toggleSelected('sku-2')
  assert.deepEqual(grid.getState().selected, ['sku-1', 'sku-2'])

  await grid.goToPage(2)
  assert.deepEqual(grid.getState().selected, [],
    'carrying an invisible selection to another page is how rows nobody looked at get mass-edited')
})

test('a page change drops the selection even when the same rows come back', async () => {
  // Without this case the test above passes for the wrong reason: page 2
  // holds different ids, so `intersectSelection` empties the selection on the
  // way in and the drop-on-page-change guard is never what makes it green.
  // Measured -- removing the guard left the test above passing.
  const pool = Array.from({ length: 60 }, (_, i) => makeItem(i + 1))
  const sticky = async path => {
    if (!path.startsWith('inventory?')) throw new Error('unexpected route')
    const params = new URLSearchParams(path.slice('inventory?'.length))
    return {
      items: pool.slice(0, 24), total: 60, page: Number(params.get('page')), pageSize: 24,
      sort: 'size', dir: 'asc', summary: { offeredCount: 0 },
    }
  }
  const grid = createInventoryGrid({ api: sticky })
  await grid.load()
  grid.toggleSelected('sku-1')
  assert.deepEqual(grid.getState().selected, ['sku-1'])
  await grid.goToPage(2)
  assert.deepEqual(grid.getState().selected, [],
    'the selection is dropped by the page change itself, not by the rows happening to differ')
})

test('selection is dropped on sort, page size and filter changes too', async () => {
  const { api } = makeApi()
  for (const change of [
    grid => grid.sortBy('margin'),
    grid => grid.setPageSize(50),
    grid => grid.setQuery({ filter: 'offered' }),
    grid => grid.setQuery({ search: 'michelin' }),
  ]) {
    const grid = createInventoryGrid({ api })
    await grid.load()
    grid.toggleSelected('sku-1')
    await change(grid)
    assert.deepEqual(grid.getState().selected, [])
  }
})

test('a plain reload keeps the selection but drops ids that are no longer on screen', async () => {
  const pool = Array.from({ length: 30 }, (_, i) => makeItem(i + 1))
  const { api } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.toggleSelected('sku-1')
  grid.toggleSelected('sku-24')
  pool.splice(23, 1) // sku-24 leaves the supplier list
  await grid.reload()
  assert.deepEqual(grid.getState().selected, ['sku-1'])
})

test('page size is refused outside the allow-list, so no request is sent', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  const before = calls.length
  await grid.setPageSize(37)
  assert.equal(calls.length, before)
  assert.equal(grid.getState().pageSize, 24)
})

// ------------------------------------------------ a. partial bulk failure

/**
 * A version-conflicting bulk save, all the way through the retry it invites.
 *
 * The stub is a real server for this one: it refuses an offer whose version is
 * not the one it holds, and advances the version of every row it accepts. That
 * matters because the first version of this test asserted the conflicted row
 * KEPT its stale version (`offer.version, 1`) and stayed selected -- which
 * pinned a defect as if it were the design. Selected plus stale means the
 * retry the selection is inviting rebuilds a byte-identical body and fails
 * identically, forever; the owner sees a Save button that does not work rather
 * than data that moved. So the test now follows the retry through and requires
 * that it can succeed.
 */
test('38 saved and 2 version-conflicts marks exactly those two rows, reloads, and lets the retry succeed', async () => {
  const pool = Array.from({ length: 40 }, (_, i) => makeItem(i + 1))
  const conflicted = ['sku-7', 'sku-19']
  // Rows are REPLACED, never mutated in place: the grid is holding the objects
  // this pool handed it, so mutating one would move the screen's copy along
  // with the server's and there would be no conflict left to test.
  const write = (id, offer) => {
    const index = pool.findIndex(item => item.id === id)
    pool[index] = { ...pool[index], offer: { ...pool[index].offer, ...offer } }
    return pool[index]
  }
  const { api, calls } = makeApi({
    pool,
    bulk: body => ({
      results: body.offers.map(offer => {
        const row = pool.find(item => item.id === offer.id)
        if (offer.version !== row.offer.version) {
          return { id: offer.id, ok: false, reason: 'version-conflict', message: 'This offer changed in another window.' }
        }
        const saved = write(offer.id, { enabled: offer.enabled, version: offer.version + 1 })
        return { id: offer.id, ok: true, version: saved.offer.version }
      }),
    }),
  })
  const grid = createInventoryGrid({ api })
  await grid.setPageSize(50)
  grid.selectAllOnPage(true)
  assert.equal(grid.getState().selected.length, 40)

  // ...and now those two rows move on in another window, after this page has
  // already loaded them at version 1.
  for (const id of conflicted) write(id, { version: 5 })

  const loadsBefore = calls.filter(call => call.path.startsWith('inventory?')).length
  grid.requestBulk('offered', { enabled: true })
  await grid.confirmBulk()
  await settle()

  const { rowStatus, notice, data } = grid.getState()
  const failedIds = Object.keys(rowStatus).filter(id => rowStatus[id].kind === 'error')
  assert.deepEqual(failedIds.sort(), conflicted.slice().sort(), 'exactly the two rejected rows are marked')
  assert.equal(rowStatus['sku-7'].reason, 'version-conflict')
  assert.match(rowStatus['sku-7'].text, /another window/i)
  assert.doesNotMatch(rowStatus['sku-7'].text, /reload before saving/i,
    'the grid re-read the row for him, so the mark must not tell him to do it himself')
  assert.equal(notice.tone, 'error', 'a batch with any failure is never announced as a success')
  assert.match(notice.text, /2 of 40/)
  assert.match(notice.text, /38 saved/)

  // A version-conflict is followed by a reload, because a conflicted row's
  // version on screen is stale by definition.
  assert.equal(calls.filter(call => call.path.startsWith('inventory?')).length, loadsBefore + 1,
    'a version-conflict must be followed by exactly one reload')

  // The 38 that saved carry their new version, and the 2 that failed now carry
  // the server's TRUE version rather than the one it just rejected.
  assert.equal(data.items.find(i => i.id === 'sku-1').offer.version, 2)
  assert.equal(data.items.find(i => i.id === 'sku-1').offer.enabled, true)
  assert.equal(data.items.find(i => i.id === 'sku-7').offer.version, 5,
    'the conflicted row must come back at the version the server actually holds')

  // The failures stay selected, so a retry needs no re-picking -- and because
  // of the reload it is a retry that can work.
  assert.deepEqual(grid.getState().selected.slice().sort(), conflicted.slice().sort())

  const firstAttempt = JSON.parse(calls.findLast(call => call.path === 'offers').options.body)
  grid.requestBulk('offered', { enabled: true })
  await grid.confirmBulk()
  await settle()
  const retry = JSON.parse(calls.findLast(call => call.path === 'offers').options.body)

  const sentFor = (body, id) => body.offers.find(offer => offer.id === id)
  assert.notDeepEqual(sentFor(retry, 'sku-7'), sentFor(firstAttempt, 'sku-7'),
    'the retry must not resend the row the server just refused, byte for byte')
  assert.deepEqual(retry.offers.map(offer => offer.version), [5, 5], 'the retry carries the versions the reload brought back')
  assert.equal(grid.getState().notice.tone, 'success')
  assert.match(grid.getState().notice.text, /2 rows saved/)
  assert.equal(grid.getState().rowStatus['sku-7'].kind, 'saved')
})

test('a bulk failure with no version-conflict in it does not reload', async () => {
  const pool = Array.from({ length: 10 }, (_, i) => makeItem(i + 1))
  const { api, calls } = makeApi({
    pool,
    bulk: body => ({
      results: body.offers.map(offer => offer.id === 'sku-3'
        ? { id: offer.id, ok: false, reason: 'invalid', message: 'a price is required' }
        : { id: offer.id, ok: true, version: offer.version + 1 }),
    }),
  })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  const loadsBefore = calls.filter(call => call.path.startsWith('inventory?')).length

  grid.requestBulk('offered', { enabled: true })
  await grid.confirmBulk()
  await settle()

  assert.equal(calls.filter(call => call.path.startsWith('inventory?')).length, loadsBefore,
    'nothing stale is on screen, so nothing needs re-reading')
  assert.equal(grid.getState().rowStatus['sku-3'].reason, 'invalid')
})

test('every reason code reads differently to the owner', () => {
  // Four, not the three the contract named: stage 1 also emits 'failed'.
  const texts = ['version-conflict', 'not-found', 'invalid', 'failed'].map(reason => reasonLabel(reason, 'a price is required'))
  assert.equal(new Set(texts).size, 4, 'each reason code must say something distinct')
  assert.match(texts[3], /try again/i)
  assert.match(texts[0], /another window/i)
  assert.match(texts[1], /no longer/i)
  assert.match(texts[2], /a price is required/)
})

test('a bulk response is never announced as a success while any row failed', () => {
  assert.equal(bulkNotice({ saved: ['a', 'b'], failed: [] }).tone, 'success')
  assert.equal(bulkNotice({ saved: ['a', 'b'], failed: [{ id: 'c' }] }).tone, 'error')
  assert.equal(bulkNotice({ saved: [], failed: [{ id: 'c' }] }).tone, 'error')
})

test('applyBulkResults leaves rows the response did not mention alone', () => {
  const items = [makeItem(1), makeItem(2), makeItem(3)]
  const { items: next, saved, failed } = applyBulkResults(items, [{ id: 'sku-2', ok: true, version: 9 }], () => ({ enabled: true }))
  assert.deepEqual(saved, ['sku-2'])
  assert.deepEqual(failed, [])
  assert.equal(next[0], items[0])
  assert.equal(next[1].offer.version, 9)
  assert.equal(next[2], items[2])
})

// ------------------------------------------- e. price bulk needs confirming

test('a price bulk apply sends nothing until it is confirmed', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  const before = calls.length

  grid.requestBulk('price', { multiplier: 1.4, addShipping: true, defaultShippingCents: 2000 })
  await settle()
  assert.equal(calls.length, before, 'a price write over the owner’s livelihood must not fire on the first click')

  const { pending } = grid.getState()
  assert.equal(pending.kind, 'price')
  assert.equal(pending.preview.count, 24)
  assert.equal(pending.preview.sample.length, 3, 'the confirmation shows real before/after rows, not just a count')
  assert.equal(pending.preview.sample[0].before, 12501)
  assert.equal(pending.preview.sample[0].after, Math.round(10100 * 1.4) + 2000)

  await grid.confirmBulk()
  await settle()
  assert.equal(calls.length, before + 1)
  assert.equal(calls.at(-1).path, 'offers')
  assert.equal(JSON.parse(calls.at(-1).options.body).offers.length, 24)
})

test('cancelling a staged price change sends nothing and leaves every price alone', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  const before = calls.length
  grid.requestBulk('price', { multiplier: 2 })
  grid.cancelBulk()
  await settle()
  assert.equal(grid.getState().pending, null)
  assert.equal(calls.length, before)
  assert.equal(grid.items()[0].offer.priceCents, 12501)
})

test('offered and shipping bulk applies confirm as well', async () => {
  const { api, calls } = makeApi()
  for (const [kind, params] of [['offered', { enabled: true }], ['shipping', { shipping: '15.00' }]]) {
    const grid = createInventoryGrid({ api })
    await grid.load()
    grid.selectAllOnPage(true)
    const before = calls.length
    grid.requestBulk(kind, params)
    await settle()
    assert.equal(calls.length, before, `${kind} must confirm before it writes`)
    assert.equal(grid.getState().pending.kind, kind)
  }
})

test('a price bulk with no usable multiplier stages nothing', async () => {
  const { api } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  grid.requestBulk('price', { multiplier: 0 })
  assert.equal(grid.getState().pending, null)
  assert.equal(grid.getState().notice.tone, 'error')
})

test('the bulk endpoint cap is respected before a request is built', async () => {
  const { api, calls } = makeApi({ pool: Array.from({ length: 400 }, (_, i) => makeItem(i + 1)) })
  const grid = createInventoryGrid({ api })
  await grid.setPageSize(200)
  grid.selectAllOnPage(true)
  assert.equal(grid.getState().selected.length, 200)
  const before = calls.length
  grid.requestBulk('offered', { enabled: true })
  await grid.confirmBulk()
  await settle()
  assert.equal(calls.length, before + 1, '200 rows is the cap and must go in one request')
})

// ------------------------------------------------------ the price formula

test('the formula is supplier cost times the multiplier, plus shipping when asked', () => {
  const item = makeItem(1) // supplier price 101 -> 10100 cents
  assert.equal(priceFromFormula(item, { multiplier: 2, addShipping: false }), 20200)
  assert.equal(priceFromFormula(item, { multiplier: 2, addShipping: true, defaultShippingCents: 1500 }), 21700)
  const withOverride = makeItem(1, { offer: { ...makeItem(1).offer, shippingCents: 500 } })
  assert.equal(priceFromFormula(withOverride, { multiplier: 2, addShipping: true, defaultShippingCents: 1500 }), 20700,
    'a row’s own shipping override wins over the default, as it does for the customer price')
  assert.equal(priceFromFormula(item, { multiplier: 0 }), null)
})

test('the preview carries every row it will write, not only the sample', () => {
  const items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5)]
  const preview = previewPriceChange(items, { multiplier: 1.5 })
  assert.equal(preview.count, 5)
  assert.equal(preview.sample.length, 3)
  assert.equal(preview.rows.length, 5)
  assert.equal(preview.rows[0].before, 12501)
})

// ------------------------------------------------------- single-row commits

test('an inline edit commits with the version it was based on and takes the new one back', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.editRow('sku-1', { price: '89.99' })
  await grid.commitRow('sku-1')
  const sent = JSON.parse(calls.at(-1).options.body)
  assert.equal(sent.priceCents, 8999)
  assert.equal(sent.version, 1)
  assert.equal(grid.items()[0].offer.version, 2)
  assert.equal(grid.getState().drafts['sku-1'], undefined)
  assert.equal(grid.getState().rowStatus['sku-1'].kind, 'saved')
})

test('a malformed price is refused on the row without a request', async () => {
  const { api, calls } = makeApi()
  const grid = createInventoryGrid({ api })
  await grid.load()
  const before = calls.length
  grid.editRow('sku-1', { price: '89.999' })
  await grid.commitRow('sku-1')
  assert.equal(calls.length, before)
  assert.equal(grid.getState().rowStatus['sku-1'].kind, 'error')
})

test('a 409 on one row is reported on that row as a version conflict', async () => {
  const { api } = makeApi({ single: () => { const error = new Error('This offer changed in another window.'); error.status = 409; throw error } })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.editRow('sku-1', { price: '89.99' })
  await grid.commitRow('sku-1')
  const status = grid.getState().rowStatus['sku-1']
  assert.equal(status.kind, 'error')
  assert.equal(status.reason, 'version-conflict')
})

/**
 * Only a 400 is the owner's input being refused.
 *
 * Everything else used to collapse into `invalid`, so a 500 rendered "Rejected:
 * Something went wrong." and an unreachable backend rendered "Rejected: The
 * owner backend is not connected." -- both telling the owner his entry was
 * refused when it never reached validation. `failed` is the code that exists to
 * say the opposite, and the single-row path was not using it.
 */
test('a single row distinguishes what the owner typed from what the server did', async () => {
  const cases = [
    { label: 'a 400', reason: 'invalid', throw: () => { const e = new Error('a price is required'); e.status = 400; throw e } },
    { label: 'a 500', reason: 'failed', throw: () => { const e = new Error('Something went wrong.'); e.status = 500; throw e } },
    // `api()` throws this one BEFORE it reads a status, so `err.status` is
    // undefined -- the shape a fetch that never landed actually arrives in.
    { label: 'an unreachable backend', reason: 'failed', throw: () => { throw new Error('The owner backend is not connected.') } },
  ]
  for (const testCase of cases) {
    const { api } = makeApi({ single: testCase.throw })
    const grid = createInventoryGrid({ api })
    await grid.load()
    grid.editRow('sku-1', { price: '89.99' })
    await grid.commitRow('sku-1')
    const status = grid.getState().rowStatus['sku-1']
    assert.equal(status.kind, 'error')
    assert.equal(status.reason, testCase.reason, `${testCase.label} must be reported as ${testCase.reason}`)
    if (testCase.reason === 'failed') {
      assert.doesNotMatch(status.text, /rejected/i, `${testCase.label} is not the owner's input being rejected`)
      assert.match(status.text, /try again/i, `${testCase.label} leaves him something to do`)
    }
  }
})

// ------------------------------------- the brand toggle invalidates versions

test('the brand-wide toggle forces a reload, because it bumps versions it does not report', async () => {
  const pool = Array.from({ length: 24 }, (_, i) => makeItem(i + 1))
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.editRow('sku-1', { price: '10.00' })
  grid.toggleSelected('sku-2')

  // What the by-brand endpoint does to the rows on screen: every version moves,
  // and the response says nothing about which rows.
  for (const item of pool) item.offer = { ...item.offer, enabled: true, version: item.offer.version + 1 }

  const before = calls.length
  await grid.afterBrandToggle()
  assert.equal(calls.length, before + 1, 'the grid must re-read rather than save against versions it can no longer trust')
  assert.deepEqual(grid.getState().selected, [])
  assert.deepEqual(grid.getState().drafts, {})
  assert.equal(grid.items()[0].offer.version, 2)
})

test('a reload drops a draft whose row moved on underneath it, and says so', async () => {
  const pool = Array.from({ length: 24 }, (_, i) => makeItem(i + 1))
  const { api } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.editRow('sku-1', { price: '10.00' })
  grid.editRow('sku-2', { price: '11.00' })
  pool[0] = { ...pool[0], offer: { ...pool[0].offer, version: 5 } }
  await grid.reload()
  assert.equal(grid.getState().drafts['sku-1'], undefined)
  assert.equal(grid.getState().rowStatus['sku-1'].kind, 'error')
  assert.equal(grid.getState().drafts['sku-2'].price, '11.00', 'an untouched row keeps its unsaved edit')
})

// ------------------------------------------------------------- money parsing

test('money fields accept what the existing single-row form accepted', () => {
  assert.equal(parseMoney(''), null)
  assert.equal(parseMoney('0'), 0)
  assert.equal(parseMoney('89.99'), 8999)
  assert.ok(Number.isNaN(parseMoney('89.999')))
  assert.ok(Number.isNaN(parseMoney('-1')))
  assert.ok(Number.isNaN(parseMoney('abc')))
})

// -------------------------------------------------- per-product photo control

test('turning a photo off asks the server and takes the row from its answer, not from the request', async () => {
  const pool = [makeItem(1, { photo: { state: 'live', url: '/api/images/aa.jpeg' } })]
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  await grid.setPhotoHidden('sku-1', true)

  const posted = calls.find(call => call.path.startsWith('images/product/'))
  assert.ok(posted, 'a photo toggle must reach the server')
  assert.equal(posted.path, 'images/product/sku-1')
  assert.deepEqual(JSON.parse(posted.options.body), { hidden: true })
  assert.equal(grid.getState().data.items[0].photo.state, 'hidden')
})

test('the row is NOT changed before the server answers', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pool = [makeItem(1, { photo: { state: 'live', url: '/api/images/aa.jpeg' } })]
  const { api } = makeApi({ pool, photo: async (supplierId, body) => { await gate; return { supplierId, hidden: body.hidden } } })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  const inFlight = grid.setPhotoHidden('sku-1', true)
  await settle()
  // A price edit is optimistic because the owner is typing. This is not: it
  // changes what a CUSTOMER sees, and claiming it before the server agreed
  // would leave the screen and the shop disagreeing about a live page.
  assert.equal(grid.getState().data.items[0].photo.state, 'live', 'still live until the server says otherwise')
  assert.equal(grid.isPhotoBusy('sku-1'), true, 'the row shows it is working')

  release(); await inFlight
  assert.equal(grid.getState().data.items[0].photo.state, 'hidden')
  assert.equal(grid.isPhotoBusy('sku-1'), false)
})

test('busy is per row, so toggling one photo does not freeze the others', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pool = [
    makeItem(1, { photo: { state: 'live', url: '/a.jpeg' } }),
    makeItem(2, { photo: { state: 'live', url: '/b.jpeg' } }),
  ]
  const { api } = makeApi({ pool, photo: async (supplierId, body) => { await gate; return { supplierId, hidden: body.hidden } } })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  const first = grid.setPhotoHidden('sku-1', true)
  await settle()
  assert.equal(grid.isPhotoBusy('sku-1'), true)
  assert.equal(grid.isPhotoBusy('sku-2'), false, 'row 2 must stay usable while row 1 is in flight')

  release(); await first
})

test('a failed toggle says so and leaves the row exactly as the server still has it', async () => {
  const pool = [makeItem(1, { photo: { state: 'live', url: '/api/images/aa.jpeg' } })]
  const { api } = makeApi({ pool, photo: () => { throw Object.assign(new Error('nope'), { status: 500 }) } })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  await grid.setPhotoHidden('sku-1', true)

  assert.equal(grid.getState().data.items[0].photo.state, 'live', 'nothing changed, because nothing changed on the server')
  assert.equal(grid.getState().notice.tone, 'error')
  assert.match(grid.getState().notice.text, /Nothing was altered/)
  assert.equal(grid.isPhotoBusy('sku-1'), false, 'the row is usable again after a failure')
})

test('a 404 gets its own words, because it means something different', async () => {
  const pool = [makeItem(1, { photo: { state: 'live', url: '/api/images/aa.jpeg' } })]
  const { api } = makeApi({ pool, photo: () => { throw Object.assign(new Error('gone'), { status: 404 }) } })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  await grid.setPhotoHidden('sku-1', true)
  assert.match(grid.getState().notice.text, /no photo to switch off/)
})

test('a second toggle on a row already in flight is ignored, not queued', async () => {
  let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const pool = [makeItem(1, { photo: { state: 'live', url: '/a.jpeg' } })]
  const { api } = makeApi({ pool, photo: async (supplierId, body) => { calls++; await gate; return { supplierId, hidden: body.hidden } } })
  const grid = createInventoryGrid({ api })
  grid.load(); await settle()

  const first = grid.setPhotoHidden('sku-1', true)
  await grid.setPhotoHidden('sku-1', true)
  release(); await first

  assert.equal(calls, 1, 'a double-click must not send two writes for one row')
})

// ------------------------------------------- h. what a save asserts about sale

/*
 * Every request this store sends carries `enabled`, because both endpoints
 * take the whole offer and not a patch. So `enabled` is asserted by every
 * save, including the ones that are only about a price -- and it used to be
 * read off `item.offer.enabled`, which is `false` for a tire nobody has
 * decided about. The customer catalogue sells exactly those tires, so a price
 * save asserted a deselection Ken never made and took the tire off sale.
 *
 * These drive the store and read the REQUEST BODY, which is the only place
 * the defect was ever visible from this side.
 */

/** A tire nobody has decided about: no offers row, so no version and no price. */
const untouched = (n, over = {}) => makeItem(n, {
  offer: { priceCents: null, shippingCents: null, enabled: false, notes: '', version: 0 },
  selling: { priceCents: 13500 + n, source: 'markup', offered: true },
  ...over,
})

/** A tire Ken switched off himself. Looks identical on `offer`; is not. */
const switchedOff = (n) => makeItem(n, {
  offer: { priceCents: null, shippingCents: null, enabled: false, notes: '', version: 3 },
  selling: { priceCents: null, source: 'markup', offered: false },
})

const bodiesOf = calls => calls.filter(c => c.options?.method === 'PUT').map(c => JSON.parse(c.options.body))

test('typing a price on a tire nobody has decided about does not assert a deselection', async () => {
  const pool = [untouched(1), untouched(2)]
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()

  assert.equal(grid.rowValues(pool[0]).enabled, true,
    'the row seeds from what is actually being sold, not from the raw enabled flag')

  grid.editRow('sku-1', { price: '59.99' })
  await grid.commitRow('sku-1')

  const body = bodiesOf(calls).at(-1)
  assert.equal(body.priceCents, 5999)
  assert.equal(body.enabled, true, 'setting a price leaves the tire on sale')
})

test('a bulk price write leaves every row it prices on sale', async () => {
  const pool = Array.from({ length: 5 }, (_, i) => untouched(i + 1))
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  grid.requestBulk('price', { multiplier: 1.5, addShipping: false })
  await grid.confirmBulk()

  const body = bodiesOf(calls).at(-1)
  assert.equal(body.offers.length, 5)
  assert.deepEqual(body.offers.map(o => o.enabled), [true, true, true, true, true],
    'all five priced and all five still for sale')
  assert.deepEqual(body.offers.map(o => o.priceCents), pool.map(i => Math.round(i.price * 100 * 1.5)))
})

test('a bulk shipping write does not change what is for sale either', async () => {
  const pool = [untouched(1), untouched(2)]
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  grid.requestBulk('shipping', { shipping: '12.50' })
  await grid.confirmBulk()

  const body = bodiesOf(calls).at(-1)
  assert.deepEqual(body.offers.map(o => o.shippingCents), [1250, 1250])
  assert.deepEqual(body.offers.map(o => o.enabled), [true, true])
})

test('a tire the owner switched off is not switched back on by a price write', async () => {
  // The control. Without it, hardcoding `enabled: true` would satisfy every
  // test above while quietly removing Ken's ability to stop selling anything.
  const pool = [switchedOff(1), untouched(2)]
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()

  assert.equal(grid.rowValues(pool[0]).enabled, false, 'a real no survives')

  grid.selectAllOnPage(true)
  grid.requestBulk('price', { multiplier: 1.5, addShipping: false })
  await grid.confirmBulk()

  const body = bodiesOf(calls).at(-1)
  assert.deepEqual(body.offers.map(o => o.enabled), [false, true],
    'the switched-off row stays off; the undecided one stays on')
})

test('the offered action still decides offered, whatever a row was selling at', async () => {
  const pool = [untouched(1), switchedOff(2)]
  const { api, calls } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()
  grid.selectAllOnPage(true)
  grid.requestBulk('offered', { enabled: false })
  await grid.confirmBulk()

  assert.deepEqual(bodiesOf(calls).at(-1).offers.map(o => o.enabled), [false, false],
    'asking to stop offering both stops offering both')

  grid.selectAllOnPage(true)
  grid.requestBulk('offered', { enabled: true })
  await grid.confirmBulk()
  assert.deepEqual(bodiesOf(calls).at(-1).offers.map(o => o.enabled), [true, true])
})

test('sellingEnabled falls back away from the defect, not toward it', () => {
  // An item with no `selling` field at all -- an older response, or a row
  // built by a test. The fallback must not resolve to `offer.enabled`, which
  // is the value whose falseness caused this.
  assert.equal(sellingEnabled({ offer: { enabled: false, version: 0 } }), true,
    'no offers row means nobody has decided, so it is on sale')
  assert.equal(sellingEnabled({ offer: { enabled: false, version: 2 } }), false,
    'a written row with enabled false is a real decision')
  assert.equal(sellingEnabled({ offer: { enabled: true, version: 2 } }), true)
  assert.equal(sellingEnabled({ selling: { offered: false }, offer: { enabled: true, version: 0 } }), false,
    'the server answer wins over the fallback whenever it is present')
  assert.equal(neverDecided({ offer: { version: 0 } }), true)
  assert.equal(neverDecided({ offer: { version: 1 } }), false)
})

test('the rule price clears 4.5:1 on every row background it can land on', () => {
  // The browser audit cannot see this. It measures what the seeded database
  // renders, and a seeded row only shows the rule price where Ken has set no
  // price of his own -- which is every row, so the colour IS rendered, but the
  // audit reads computed styles on elements it knows to look at and this one
  // is new. More to the point, the SELECTED and ERROR row grounds never occur
  // in an audit run at all, because nothing in it selects a row or fails a
  // save. Those are the two darker-shifted backgrounds, so they are exactly
  // the ones a measurement would want.
  //
  // Both ends come out of the real files. Writing #121212 here would be a
  // second copy of a fact the stylesheet owns, and it would keep passing on
  // the day someone restyles the table -- the defect this repo has hit with a
  // colour test that restated hexes instead of reading them.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'OwnerInventory.css'), 'utf8')
  const rgb = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) })

  const colourOf = (selector, prop = 'color') => {
    const rule = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{([^}]*)\\}').exec(css)
    assert.ok(rule, selector + ' not found in OwnerInventory.css -- this test cannot measure what it cannot find')
    const found = new RegExp(prop + ':\\s*(#[0-9a-f]{6})', 'i').exec(rule[1])
    assert.ok(found, selector + ' has no ' + prop + ' -- the value this test measures is no longer stated there')
    return found[1]
  }

  const foreground = colourOf('.oi-g-ruled')
  const grounds = {
    table: colourOf('.oi-g-table', 'background'),
    selected: colourOf('.oi-g-row.is-selected td, .oi-g-row.is-selected th', 'background'),
    error: colourOf('.oi-g-row.has-error td, .oi-g-row.has-error th', 'background'),
  }

  for (const [name, ground] of Object.entries(grounds)) {
    const measured = ratio(rgb(foreground), rgb(ground))
    assert.ok(measured >= 4.5,
      `the rule price is ${measured.toFixed(2)}:1 on the ${name} ground (${foreground} on ${ground}), below the 4.5:1 floor`)
  }

  // The priced-but-not-for-sale warning, same treatment. It sits on a ground
  // of its own rather than the page's, and it is shown only when the count is
  // above zero -- so on a seeded database it never renders and no browser
  // audit this repo runs has ever drawn it.
  const warningGround = colourOf('.oi-priced-off', 'background')
  for (const [name, fg] of [['inherited amber', colourOf('.oi-attention')], ['its heading', colourOf('.oi-priced-off strong')]]) {
    const measured = ratio(rgb(fg), rgb(warningGround))
    assert.ok(measured >= 4.5,
      `the priced-but-not-for-sale warning's ${name} is ${measured.toFixed(2)}:1 (${fg} on ${warningGround}), below the 4.5:1 floor`)
  }
})

test('the rule price stops being shown the moment the owner has a price of his own', async () => {
  // `selling` is the SERVER's answer and the save responses do not carry a new
  // one, so after a save the row on screen still holds the pre-save `selling`
  // -- source 'markup', and the old rule price. Rendering the rule line off
  // `source` alone therefore printed "$135.00 by rule" underneath the $150.00
  // Ken had just set, announcing a price that was no longer in force. That is
  // the same class of defect this whole change exists to remove, so it does
  // not get to ship inside the fix for it.
  //
  // `ruledPriceCents` requires BOTH: the server says the rule is what is in
  // force, AND there is no owner price on the row. The second is kept accurate
  // locally by both save paths, so it is the one that survives a stale
  // `selling`.
  const pool = [untouched(1)]
  const { api } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()

  assert.equal(ruledPriceCents(grid.items()[0]), untouched(1).selling.priceCents,
    'before he prices it, the rule price is what the tire sells for and is shown')

  grid.selectAllOnPage(true)
  grid.requestBulk('price', { multiplier: 1.5, addShipping: false })
  await grid.confirmBulk()

  const row = grid.items()[0]
  assert.equal(row.selling.source, 'markup', 'the stale server answer is still on the row -- this is the trap')
  assert.equal(row.offer.priceCents, Math.round(untouched(1).price * 100 * 1.5), 'and his price is now set')
  assert.equal(ruledPriceCents(row), null,
    'so no rule price is claimed: his price is the one in force')
})

test('a single-row save clears the rule line too, by the same rule', async () => {
  const pool = [untouched(1)]
  const { api } = makeApi({ pool })
  const grid = createInventoryGrid({ api })
  await grid.load()

  grid.editRow('sku-1', { price: '61.00' })
  await grid.commitRow('sku-1')

  assert.equal(ruledPriceCents(grid.items()[0]), null)
})
