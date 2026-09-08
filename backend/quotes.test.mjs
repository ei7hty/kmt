import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { FORM_FIELDS, Quotes, REQUEST_NON_PERSONAL_FIELDS, REQUEST_PERSONAL_DATA_KEYS, SHARED_PASSWORD_ACTOR, todayInServiceArea } from './quotes.mjs'
import { readServiceAreaConfig } from './service-area.mjs'
import { createApi, createCatalogApi, createHealthApi, createRequestsApi, isHostAllowed, isKnownApiPath, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'
import { PUBLIC_BODY_LIMIT, RateLimiter } from './limits.mjs'
import { parseRequestUrl } from './site.mjs'
import { calculateDraftQuote } from '../src/pricing.js'
import { loadCatalogForSize } from '../src/data/liveCatalog.js'

const SIZE = '215/60R16'
const KEY = 'a1b2c3d4e5f60718'
const OTHER_KEY = '00112233445566ff'
const ownerDecide = (quotes, id, decision, version, reason = null) =>
  quotes.decide(id, decision, version, reason, SHARED_PASSWORD_ACTOR)
const ownerFinish = (quotes, id, version) => quotes.finish(id, version, SHARED_PASSWORD_ACTOR)
const ownerCancel = (quotes, id, version, reason) => quotes.cancel(id, version, reason, SHARED_PASSWORD_ACTOR)

/** A preferred date that is always ahead of today, so the fixture never goes stale. */
const daysAhead = days => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const SOON = daysAhead(30)

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
  date: SOON,
  locationType: 'home',
  serviceZip: '02149',
  locationNotes: 'Driveway',
  customerName: 'Jamie Rivera',
  customerEmail: 'Jamie@Example.com',
  customerPhone: '(617) 410-8319',
  ...overrides,
})

test('a submit stores the request and its quote, priced exactly as the frontend prices it', async t => {
  const { inventory, quotes } = setup(t)

  const { request, quote } = quotes.submit(form())

  assert.match(request.id, /^[0-9a-f]{32}$/, 'a 128-bit id, not a guessable one')
  assert.equal(request.vehicleInfo, '2021 Honda Civic')
  assert.equal(quote.status, 'draft')

  // The comparison that matters: the server drafts with the same function,
  // the same catalog and the same catalogue lines, so a customer is never
  // quoted one number and shown another.
  const expected = calculateDraftQuote({ ...form(), id: request.id }, quotes.catalog(), inventory.getPricingSettings(), inventory.getCatalogueLines(), [])
  assert.equal(quote.total, expected.total)
  assert.deepEqual(quote.lineItems, expected.lineItems)
  assert.equal(quote.exception, expected.exception)
  assert.deepEqual(quote.exceptionReasons, expected.exceptionReasons)

  // And it is readable back by id alone.
  const found = quotes.get(request.id)
  assert.equal(found.quote.total, quote.total)
})

test('a supplier tire keeps canonical pricing from live catalog through preview and stored quote', t => {
  const { inventory, quotes } = setup(t)
  inventory.saveMarkup({ rate: 2, shippingPerTire: 30 })
  const catalog = quotes.catalog()
  assert.deepEqual(catalog.map(row => row.id), ['giga-a'], 'only a row with real supplier cost is selectable')
  assert.equal(catalog[0].price, 130, '($50 supplier × 2 markup) + $30 internal shipping')
  assert.doesNotMatch(JSON.stringify(catalog), /shipping/i, 'the customer sees only the resulting tire price')

  const selection = form({ quantity: 2 })
  const preview = quotes.preview(selection)
  const stored = quotes.submit(selection)
  const previewTire = preview.lineItems.find(line => line.description === 'Test Touring')
  const storedTire = stored.quote.lineItems.find(line => line.description === 'Test Touring')
  assert.deepEqual(
    { description: previewTire.description, quantity: previewTire.quantity, unitPrice: previewTire.unitPrice },
    storedTire,
    'catalog identity and price survive selection, preview, and persistence unchanged',
  )
  assert.equal(storedTire.unitPrice, 130)
  assert.doesNotMatch(JSON.stringify(preview), /shipping/i)
  assert.doesNotMatch(JSON.stringify(quotes.get(stored.request.id)), /shipping/i)

  assert.throws(() => quotes.preview({ ...selection, tireSelection: 'tire-1' }), /isn't one I offer/,
    'a fixed-price seed with no supplier cost is excluded, not reinterpreted')
})

test('a live browser answer excludes static prices, while an offline demo still has its fallback', async t => {
  const liveTire = { id: 'giga-a', name: 'Test Touring', size: SIZE, price: 130, inStock: true, category: 'all-season', description: '95H BSW' }
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ tires: [liveTire], disposalFee: null }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

  const live = await loadCatalogForSize(SIZE)
  assert.equal(live.source, 'live')
  assert.deepEqual(live.tires, [liveTire], 'successful live data is authoritative and gains no fixed-price rows')

  globalThis.fetch = async () => { throw new Error('offline') }
  const offline = await loadCatalogForSize(SIZE)
  assert.equal(offline.source, 'static')
  assert.ok(offline.tires.some(tire => tire.id === 'tire-1'), 'the local/offline demo fallback remains available')
})

test('global and individual shipping affect the tire price without leaking into customer quote shapes', t => {
  const { inventory, quotes } = setup(t)
  inventory.saveMarkup({ rate: 2, shippingPerTire: 30 })
  inventory.saveOffer('giga-a', {
    priceCents: null, shippingCents: 500, enabled: true, notes: '', version: 0,
  })

  const selection = { tireSelection: 'giga-a', quantity: 4, serviceZip: '02149' }
  const catalog = quotes.catalog()
  assert.equal(catalog.find(item => item.id === 'giga-a').price, 105, '(supplier $50 × 2 markup) + $5 individual shipping')
  assert.doesNotMatch(JSON.stringify(catalog), /shipping/i, 'the public catalog exposes only the final tire price')

  const preview = quotes.preview(selection)
  const submitted = quotes.submit(form(selection))
  assert.equal(preview.lineItems[0].unitPrice, 105)
  assert.deepEqual(
    preview.lineItems.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })),
    submitted.quote.lineItems,
    'the preview and stored quote use the same catalog price',
  )
  assert.doesNotMatch(JSON.stringify(preview), /shipping/i)
  assert.doesNotMatch(JSON.stringify(quotes.get(submitted.request.id)), /shipping/i,
    'the status/customer response does not disclose internal shipping')

  const ownerPrice = inventory.saveOffer('giga-a', {
    priceCents: 9900, shippingCents: 500, enabled: true, notes: '', version: 1,
  })
  assert.equal(ownerPrice.priceCents, 9900)
  assert.equal(quotes.catalog().find(tire => tire.id === 'giga-a').price, 99, 'an explicit owner price still wins outright')
})

test('submit reads the owner\'s catalogue, not a constant, and the customer sees subtotal but not the raw tax gate', async t => {
  const { inventory, quotes } = setup(t)
  // Post-stage-2, the fee's source of truth is the catalogue, seeded once at
  // construction -- savePricingSettings's mobileServiceFee/disposalFee are
  // vestigial once that has happened, so changing what's charged means
  // editing the catalogue entries directly, the same as Ken's screen would.
  inventory.savePricingSettings({ tax: { rate: 0.1, appliesTo: 'all' } })
  const [seededFee] = inventory.getCatalogueLines()
  inventory.saveCatalogueLines([
    { ...seededFee, amountCents: 7500, taxable: true },
    { id: 'disposal', label: 'Old tire disposal', amountCents: 600, basis: 'perTire', mode: 'optional', taxable: true, enabled: true },
  ])

  const { request, quote } = quotes.submit(form({ disposeOldTires: true }))
  assert.ok(quote.lineItems.some(line => line.description === 'Mobile service fee' && line.unitPrice === 75))
  assert.ok(quote.lineItems.some(line => line.description === 'Old tire disposal' && line.unitPrice === 6))
  const tireLine = quote.lineItems.find(line => line.description === 'Test Touring')
  assert.equal(quote.subtotal, tireLine.quantity * tireLine.unitPrice + 75 + 6 * 4, 'four tires at the catalog (marked-up) price, the configured fee, four tires’ worth of disposal')
  assert.deepEqual(quote.tax, { rate: 0.1, appliesTo: 'all', amount: Math.round(quote.subtotal * 0.1 * 100) / 100 })
  assert.equal(quote.total, Math.round((quote.subtotal + quote.tax.amount) * 100) / 100)

  // Both fields are in CUSTOMER_QUOTE_FIELDS (#289): the customer's own read carries them too.
  const customerRead = quotes.get(request.id)
  assert.equal(customerRead.quote.subtotal, quote.subtotal)
  assert.deepEqual(customerRead.quote.tax, quote.tax)
})

test('with tax off (the default everywhere), a request never carries a tax key at all', async t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  assert.equal('tax' in quotes.get(request.id).quote, false)
  assert.equal('tax' in quotes.get(request.id, 'owner').quote, false)
})

test('a preview is customer-safe, stores nothing, and agrees exactly with the submitted draft', t => {
  const { inventory, quotes } = setup(t)
  inventory.savePricingSettings({ tax: { rate: 0.0625, appliesTo: 'all' } })
  const [mobile] = inventory.getCatalogueLines()
  inventory.saveCatalogueLines([
    { ...mobile, amountCents: 6000, taxable: true },
    { id: 'install', label: 'Tire installation', amountCents: 1500, basis: 'perTire', mode: 'automatic', taxable: true, enabled: true,
      amountOverrides: { sizes: { [SIZE]: 2000 }, skus: { a: 2500 } } },
    { id: 'disposal', label: 'Old tire disposal', amountCents: 700, basis: 'perTire', mode: 'optional', taxable: true, enabled: true },
  ])

  const selection = { tireSelection: 'giga-a', quantity: 2, serviceZip: '02149', disposeOldTires: true }
  const before = quotes.listForOwner().length
  const preview = quotes.preview(selection)
  assert.equal(quotes.listForOwner().length, before, 'preview creates neither a request nor a quote')
  assert.deepEqual(Object.keys(preview).sort(), ['lineItems', 'serviceZip', 'subtotal', 'tax', 'total'])
  assert.ok(preview.lineItems.some(line => line.description === 'Tire installation' && line.unitPrice === 25), 'SKU amount wins over size amount')
  assert.ok(preview.lineItems.some(line => line.description === 'Old tire disposal' && line.quantity === 2))
  assert.equal(preview.lineItems.find(line => line.description === 'Mobile service fee').serviceZip, '02149')
  assert.deepEqual(Object.keys(preview.tax).sort(), ['amount', 'rate'], 'the internal tax applicability rule is not public')
  for (const leak of ['supplierPrice', 'shipping', 'markup', 'sku', 'stock', 'exceptionReasons']) {
    assert.equal(JSON.stringify(preview).includes(leak), false, `${leak} is not in the preview`)
  }

  const submitted = quotes.submit(form({ ...selection }))
  assert.deepEqual(preview.lineItems.map(({ description, quantity, unitPrice }) => ({ description, quantity, unitPrice })), submitted.quote.lineItems)
  assert.deepEqual(
    submitted.quote.lineItems.slice(1).map(({ description, quantity }) => ({ description, quantity })),
    [
      { description: 'Mobile service fee', quantity: 1 },
      { description: 'Tire installation', quantity: 2 },
      { description: 'Old tire disposal', quantity: 2 },
    ],
    'preview and submission both distinguish the per-visit fee from per-tire labour',
  )
  assert.equal(preview.subtotal, submitted.quote.subtotal)
  assert.equal(preview.tax.amount, submitted.quote.tax.amount)
  assert.equal(preview.total, submitted.quote.total)
})

test('a stale tire selection cannot produce a preview', t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.preview({ tireSelection: 'giga-gone', quantity: 4, serviceZip: '02149' }), /isn't one I offer right now/)
  assert.equal(quotes.listForOwner().length, 0)
})

test('an owner adjustment changes the current quote and keeps the original draft', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  const lines = [
    { description: 'Four tires', quantity: 4, unitPrice: 62.25 },
    { description: 'Mobile service', quantity: 1, unitPrice: 55 },
  ]

  const adjusted = quotes.adjust(original.request.id, {
    lineItems: lines, note: ' Price includes disposal. ', total: 1, version: original.quote.version,
  })

  assert.deepEqual(adjusted.quote.lineItems, lines)
  assert.equal(adjusted.quote.note, 'Price includes disposal.')
  assert.equal(adjusted.quote.total, 304, 'the server computes the total and ignores the client total')
  assert.deepEqual(adjusted.quote.draftLineItems, original.quote.lineItems)
  assert.equal(adjusted.quote.draftTotal, original.quote.total)
  assert.equal(adjusted.quote.version, original.quote.version + 1)
})

test('an owner adjustment cannot erase the requested tire quantity from the owner list', t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form({ quantity: 4 }))

  // Replace every current line, including the tire line. The owner card must
  // not infer quantity from this mutable list: line zero now says one visit.
  quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Mobile service fee', quantity: 1, unitPrice: 60 }],
    version: original.quote.version,
  })

  const listed = quotes.listForOwner().find(row => row.request.id === original.request.id)
  assert.equal(listed.quote.lineItems[0].quantity, 1, 'the adjusted current line demonstrates the misleading value')
  assert.equal(listed.request.quantity, 4, 'the immutable request remains the owner card authority')
  assert.equal(listed.quote.draftLineItems[0].quantity, 4, 'the original draft remains a fallback for legacy requests')
})

test('finding 1 (scrutiny pass 3): adjusting a taxed quote recomputes subtotal and tax, not just total', async t => {
  const { inventory, quotes } = setup(t)
  inventory.savePricingSettings({ mobileServiceFee: 75, disposalFee: 6, tax: { rate: 0.1, appliesTo: 'all' } })
  const original = quotes.submit(form())
  assert.ok(original.quote.tax, 'the draft itself is taxed, so the bug (stale tax after an adjustment) is reachable')

  const adjusted = quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Complete job, adjusted', quantity: 1, unitPrice: 200 }],
    version: original.quote.version,
  })

  // The whole point: the row must never contradict itself. Before this fix,
  // total moved to 220 (200 + the draft's stale $20 tax) while subtotal and
  // tax.amount stayed at the pre-adjustment numbers -- a customer charged a
  // tax figure that named neither the old subtotal nor the new one.
  assert.equal(adjusted.quote.subtotal, 200)
  assert.deepEqual(adjusted.quote.tax, { rate: 0.1, appliesTo: 'all', amount: 20 })
  assert.equal(adjusted.quote.total, 220)
  assert.equal(
    Math.round((adjusted.quote.subtotal + adjusted.quote.tax.amount) * 100) / 100,
    adjusted.quote.total,
    'total must always equal subtotal + tax.amount on the stored row, adjusted or not',
  )
})

test('#354, per review: a draft carrying catalogue lines still holds the invariant after being adjusted', async t => {
  // The gap the pure-function test in pricing.test.mjs could not reach: that
  // test drives calculateDraftQuote directly, so it only exercises the draft
  // path. #335's bug lived in adjust() -> computeQuoteTotals, and the
  // catalogue makes adjusting routine -- so the untested combination was
  // exactly the one about to become common: a quote carrying catalogue
  // lines, then adjusted. This drives the real Quotes object end to end
  // (submit, then adjust, then read back), the way a customer and an owner
  // actually would, rather than calling either function in isolation.
  const { inventory, quotes } = setup(t)
  inventory.savePricingSettings({ mobileServiceFee: 75, disposalFee: null, tax: { rate: 0.1, appliesTo: 'all' } })
  const [automatic, optional] = inventory.saveCatalogueLines([
    { label: 'Tire installation', amountCents: 1500, basis: 'perTire', mode: 'automatic', taxable: true, enabled: true },
    { label: 'Nitrogen fill', amountCents: 500, basis: 'perJob', mode: 'optional', taxable: false, enabled: true },
  ])
  assert.ok(automatic && optional)

  // The draft itself carries the automatic line (optional lines need a
  // wizard control that does not exist until stage 3, so only automatic
  // ones can appear on a submitted request today).
  const original = quotes.submit(form())
  assert.ok(original.quote.lineItems.some(item => item.description === 'Tire installation'), 'the catalogue line reached the draft')
  const draftInvariant = Math.round((original.quote.subtotal + (original.quote.tax?.amount ?? 0)) * 100) / 100
  assert.equal(draftInvariant, original.quote.total, 'the draft itself holds the invariant before any adjustment')

  // The owner adjusts it -- a hand-typed replacement, the only shape
  // adjust() accepts today; it does not re-read the catalogue by id.
  const adjusted = quotes.adjust(original.request.id, {
    lineItems: [
      { description: 'Four tires, mounted and balanced', quantity: 1, unitPrice: 300 },
      { description: 'Nitrogen fill', quantity: 1, unitPrice: 5 },
    ],
    version: original.quote.version,
  })

  const adjustedInvariant = Math.round((adjusted.quote.subtotal + (adjusted.quote.tax?.amount ?? 0)) * 100) / 100
  assert.equal(adjustedInvariant, adjusted.quote.total, 'the stored row still holds the invariant after adjusting a quote that started with catalogue lines')

  // Read back independently of the return value, the way a reload would --
  // confirms this is what is actually on the row, not just what adjust() happened to return.
  const reread = quotes.get(original.request.id, 'owner')
  assert.equal(Math.round((reread.quote.subtotal + (reread.quote.tax?.amount ?? 0)) * 100) / 100, reread.quote.total)
})

test('finding 1: an adjustment undertaxes rather than misclassifies when tax applies to only one class of line', async t => {
  const { inventory, quotes } = setup(t)
  // 'goods'/'services' is calculateDraftQuote's own bookkeeping over the
  // catalog and is never stored -- an owner-typed line has no class to
  // recover. Excluded from the taxable subset rather than guessed at,
  // per pricing-settings.md's "an absent number is correctable, a wrong
  // one is not".
  inventory.savePricingSettings({ mobileServiceFee: 75, disposalFee: null, tax: { rate: 0.1, appliesTo: 'goods' } })
  const original = quotes.submit(form())
  assert.ok(original.quote.tax.amount > 0, 'the draft is taxed on its tire line')

  const adjusted = quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Complete job, adjusted', quantity: 1, unitPrice: 200 }],
    version: original.quote.version,
  })

  assert.equal(adjusted.quote.subtotal, 200)
  assert.deepEqual(adjusted.quote.tax, { rate: 0.1, appliesTo: 'goods', amount: 0 }, 'an untaggable line matches neither class, so it is taxed at $0 rather than guessed at')
  assert.equal(adjusted.quote.total, 200)
})

test('an adjustment on an untaxed quote (tax off, the default everywhere) still carries no tax key', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  const adjusted = quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Complete job', quantity: 1, unitPrice: 150 }],
    version: original.quote.version,
  })
  assert.equal('tax' in adjusted.quote, false)
  assert.equal(adjusted.quote.subtotal, 150)
  assert.equal(adjusted.quote.total, 150)
})

test('approving after an adjustment sends the adjusted numbers', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  const adjusted = quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Complete job', quantity: 1, unitPrice: 275.5 }],
    note: 'Ready when you are.', version: original.quote.version,
  })
  const sent = ownerDecide(quotes, original.request.id, 'sent', adjusted.quote.version)

  assert.equal(sent.quote.status, 'sent')
  assert.equal(sent.quote.total, 275.5)
  assert.equal(sent.quote.note, 'Ready when you are.')
  assert.equal(sent.quote.draftTotal, original.quote.total)

  // note is in CUSTOMER_QUOTE_FIELDS by design (customer-facing, "Note from Ken:"
  // on /status and /confirmation) -- the customer's own read must carry it too,
  // not just the owner's.
  const customerRead = quotes.get(original.request.id)
  assert.equal(customerRead.quote.note, 'Ready when you are.')
})

test('only a current draft can be adjusted', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  const input = { lineItems: [{ description: 'Job', quantity: 1, unitPrice: 200 }], version: original.quote.version }
  const adjusted = quotes.adjust(original.request.id, input)

  assert.throws(() => quotes.adjust(original.request.id, input), error => error.status === 409 && /changed in another window/.test(error.message))
  const sent = ownerDecide(quotes, original.request.id, 'sent', adjusted.quote.version)
  assert.throws(() => quotes.adjust(original.request.id, { ...input, version: sent.quote.version }), error => error.status === 409 && /already sent/.test(error.message))
  const paid = quotes.pay(original.request.id)
  assert.throws(() => quotes.adjust(original.request.id, { ...input, version: paid.quote.version }), error => error.status === 409 && /already paid/.test(error.message))
})

test('quote adjustment validates every line and the note', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  const adjust = lineItems => quotes.adjust(original.request.id, { lineItems, version: original.quote.version })
  assert.throws(() => adjust([]), /between 1 and 25/)
  assert.throws(() => adjust([{ description: '', quantity: 1, unitPrice: 1 }]), /description/)
  assert.throws(() => adjust([{ description: 'Tire', quantity: 0, unitPrice: 1 }]), /quantity/)
  assert.throws(() => adjust([{ description: 'Tire', quantity: 1, unitPrice: 1.001 }]), /two decimal places/)
  assert.throws(() => quotes.adjust(original.request.id, { lineItems: [{ description: 'Tire', quantity: 1, unitPrice: 1 }], note: 'x'.repeat(1001), version: original.quote.version }), /note is too long/)
})

test('the original draft is an owner-only figure: a customer read never carries draftLineItems or draftTotal', async t => {
  const { quotes } = setup(t)
  const original = quotes.submit(form())
  quotes.adjust(original.request.id, {
    lineItems: [{ description: 'Discounted job', quantity: 1, unitPrice: 40 }],
    version: original.quote.version,
  })

  // The owner's own read still carries both, so the editor can show what changed.
  const ownerRead = quotes.get(original.request.id, 'owner')
  assert.ok(Array.isArray(ownerRead.quote.draftLineItems) && ownerRead.quote.draftLineItems.length > 0)
  assert.equal(typeof ownerRead.quote.draftTotal, 'number')

  // The customer's read -- the default, and what GET /api/requests/:id answers to
  // anyone holding the link (R19) -- must not carry the owner's pre-adjustment
  // figures. Same failure shape #65 fixed for `request`'s contact fields: a field
  // added to the quote payload otherwise reaches a link designed to be shared.
  const customerRead = quotes.get(original.request.id)
  assert.equal('draftLineItems' in customerRead.quote, false, 'draftLineItems must not reach the customer shape')
  assert.equal('draftTotal' in customerRead.quote, false, 'draftTotal must not reach the customer shape')
})

// A stand-in for the seeded mobile-service catalogue entry (#354 stage 2) --
// calculateDraftQuote no longer generates this line itself, so a unit test
// exercising it supplies one explicitly, perJob so it never multiplies.
const mobileFeeLine = { id: 'mobile-service', label: 'Mobile service fee', amountCents: 4999, basis: 'perJob', mode: 'automatic', taxable: false, enabled: true }

test('calculateDraftQuote multiplies the tire line by quantity and leaves the fee alone', () => {
  const catalog = [tire()]
  const quoteOfFour = calculateDraftQuote({ tireSelection: 'giga-a', quantity: 4 }, catalog, undefined, [mobileFeeLine])
  const tireLine = quoteOfFour.lineItems.find(item => item.description !== 'Mobile service fee')
  const feeLine = quoteOfFour.lineItems.find(item => item.description === 'Mobile service fee')
  assert.equal(tireLine.quantity, 4)
  assert.equal(tireLine.unitPrice, 50)
  assert.equal(feeLine.quantity, 1)
  assert.equal(feeLine.unitPrice, 49.99)
  assert.equal(quoteOfFour.total, Math.round((50 * 4 + 49.99) * 100) / 100)

  const quoteOfOne = calculateDraftQuote({ tireSelection: 'giga-a' }, catalog, undefined, [mobileFeeLine])
  assert.equal(quoteOfOne.lineItems[0].quantity, 1, 'no quantity at all still means one tire, not zero and not a full set')
})

test('quantity defaults to 4, an explicit choice is honoured, and the fee never multiplies', async t => {
  const { inventory, quotes } = setup(t)

  const defaulted = quotes.submit(form({ quantity: undefined }))
  const tireLine = defaulted.quote.lineItems.find(item => item.description !== 'Mobile service fee')
  const feeLine = defaulted.quote.lineItems.find(item => item.description === 'Mobile service fee')
  assert.equal(tireLine.quantity, 4, 'a request that says nothing about quantity means a full set')
  assert.equal(feeLine.quantity, 1, 'the mobile-service fee is one line regardless of how many tires')
  const expectedDefault = calculateDraftQuote({ ...form({ quantity: 4 }), id: defaulted.request.id }, quotes.catalog(), inventory.getPricingSettings(), inventory.getCatalogueLines(), [])
  assert.equal(defaulted.quote.total, expectedDefault.total)
  assert.deepEqual(defaulted.quote.lineItems, expectedDefault.lineItems)

  const explicit = quotes.submit(form({ quantity: 2 }))
  const explicitTireLine = explicit.quote.lineItems.find(item => item.description !== 'Mobile service fee')
  assert.equal(explicitTireLine.quantity, 2)
  const expectedExplicit = calculateDraftQuote({ ...form({ quantity: 2 }), id: explicit.request.id }, quotes.catalog(), inventory.getPricingSettings(), inventory.getCatalogueLines(), [])
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
  assert.throws(() => quotes.submit(form({ tireSelection: 'giga-nonexistent' })), /isn't one I offer right now/)
})

test('a request is required to carry the fields a quote needs', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ vehicleInfo: '' })), /vehicleInfo is required/)
  assert.throws(() => quotes.submit(form({ location: '   ' })), /location is required/)
  assert.throws(() => quotes.submit(form({ customerKey: 'not-a-key' })), /customer key/)
  assert.throws(() => quotes.submit(form({ locationNotes: 'x'.repeat(1001) })), /too long/)
})

test('the personal keys a redaction has to find inside requests.payload are named, not guessed at call time', () => {
  assert.deepEqual(
    REQUEST_PERSONAL_DATA_KEYS,
    ['customerName', 'customerEmail', 'customerPhone', 'location', 'locationNotes', 'customerNotes'],
    'update the UPDATE requests statement in docs/operations.md, and check whether this key also reaches outbox.data or inquiries',
  )
})

test('every FORM_FIELDS key is classified as personal or not -- a new intake field cannot silently land in neither', () => {
  const classified = new Set([...REQUEST_PERSONAL_DATA_KEYS, ...REQUEST_NON_PERSONAL_FIELDS])
  const unclassified = FORM_FIELDS.filter(field => !classified.has(field))
  assert.deepEqual(
    unclassified,
    [],
    'a new intake field must be classified as personal or not; if personal, add it to REQUEST_PERSONAL_DATA_KEYS ' +
    'and to the UPDATE requests statement in docs/operations.md',
  )
  // The partition also has to be exact, not just covering: nothing miscounted into both lists,
  // and nothing in either list that FORM_FIELDS does not actually carry -- except customerPhone,
  // the one key that is personal data but never passes through the form-field loop (see the
  // comment on REQUEST_PERSONAL_DATA_KEYS), covered by its own test below.
  const inFormFieldsOrPhone = key => FORM_FIELDS.includes(key) || key === 'customerPhone'
  assert.deepEqual(
    [...REQUEST_PERSONAL_DATA_KEYS].sort(),
    REQUEST_PERSONAL_DATA_KEYS.filter(inFormFieldsOrPhone).sort(),
    'REQUEST_PERSONAL_DATA_KEYS has an entry that is neither in FORM_FIELDS nor customerPhone',
  )
  assert.deepEqual(
    [...REQUEST_NON_PERSONAL_FIELDS].sort(),
    REQUEST_NON_PERSONAL_FIELDS.filter(key => FORM_FIELDS.includes(key)).sort(),
    'REQUEST_NON_PERSONAL_FIELDS has an entry FORM_FIELDS does not carry',
  )
  const overlap = REQUEST_PERSONAL_DATA_KEYS.filter(key => REQUEST_NON_PERSONAL_FIELDS.includes(key))
  assert.deepEqual(overlap, [], 'a field cannot be both personal and non-personal')
})

test('customerPhone is deliberately outside FORM_FIELDS, and outside the partition too', () => {
  assert.ok(!FORM_FIELDS.includes('customerPhone'), 'customerPhone is cleaned separately via cleanCustomerPhone, not through the form-field loop')
  assert.ok(REQUEST_PERSONAL_DATA_KEYS.includes('customerPhone'), 'customerPhone is still personal data and still belongs on the redaction list')
  assert.ok(!REQUEST_NON_PERSONAL_FIELDS.includes('customerPhone'), 'customerPhone is not a FORM_FIELDS entry, so it has no place in the non-personal partition either')
})

/* ------------------------------------------- where and when (t48, #95, #70) */

test('the preferred date is a real calendar day, at least a week out, judged where the van is', async t => {
  const { inventory } = setup(t)
  // Stand at a fixed day so the boundary is exact, whatever today really is.
  const quotes = new Quotes(inventory, { today: () => '2026-09-06' })
  // Ken needs a week's notice (the user's instruction): the earliest bookable
  // day is today + 7, not today + 6. Prove the boundary in both directions.
  assert.throws(() => quotes.submit(form({ date: '2026-09-12' })), /at least a week's notice/, 'today + 6 is refused')
  assert.equal(stored(quotes, quotes.submit(form({ date: '2026-09-13' })).request.id).date, '2026-09-13', 'today + 7 is the earliest accepted day')
  assert.throws(() => quotes.submit(form({ date: '2026-09-06' })), /at least a week's notice/, 'today itself is well inside the old floor and still refused')
  assert.equal(stored(quotes, quotes.submit(form({ date: '2026-12-25' })).request.id).date, '2026-12-25')
  for (const bad of ['June 1', '06/01/2026', '2026-6-1', '2026-06-31', '2026-13-01', '20260601', '']) {
    assert.throws(() => quotes.submit(form({ date: bad })), /YYYY-MM-DD|not on the calendar|date is required/, `${JSON.stringify(bad)} is refused`)
  }
  // The calendar is Massachusetts's: late evening there is not yet tomorrow.
  const lateEvening = new Date('2026-09-07T03:30:00Z') // 11:30pm on the 6th in Boston
  assert.equal(todayInServiceArea(lateEvening), '2026-09-06')
})

test('the ZIP is required and five digits; a ZIP+4 is read as its five', async t => {
  const { quotes } = setup(t)
  assert.throws(() => quotes.submit(form({ serviceZip: '' })), /five-digit ZIP/)
  assert.throws(() => quotes.submit(form({ serviceZip: '2149' })), /five-digit ZIP/)
  assert.throws(() => quotes.submit(form({ serviceZip: 'Everett' })), /five-digit ZIP/)
  assert.equal(stored(quotes, quotes.submit(form({ serviceZip: '02149-1234' })).request.id).serviceZip, '02149')
  assert.equal(stored(quotes, quotes.submit(form({ serviceZip: ' 02149 ' })).request.id).serviceZip, '02149')
})

test('beyond the service area is refused with the distance and the phone number, and nothing is stored', async t => {
  const { quotes } = setup(t)
  // Defaults on: Malden, 100 miles. Bangor is about 200.
  assert.throws(() => quotes.submit(form({ serviceZip: '04401' })), /about 200 miles from Malden, outside the 100 miles I cover\. Text me at \(617\) 410-8319 if you'd like to ask anyway/)
  // A ZIP nobody can place is refused the same way, with the number.
  assert.throws(() => quotes.submit(form({ serviceZip: '99999' })), /ZIP code isn't one I recognize\. Text me at/)
  assert.equal(quotes.listForOwner().length, 0, 'a refused request is not a request')
})

test('inside the radius but past the review distance goes through with the miles as a reason for the owner', async t => {
  const { quotes } = setup(t)
  // Worcester, about 40 miles: accepted, flagged, and the owner sees how far.
  const { request, quote } = quotes.submit(form({ serviceZip: '01608' }))
  assert.equal(quote.exception, true)
  assert.ok(quote.exceptionReasons.some(reason => /Service address is about 40 miles from Malden, beyond the 25 mile review distance/.test(reason)),
    `the reason names the miles: ${quote.exceptionReasons.join(' | ')}`)
  const owner = quotes.listForOwner().find(row => row.request.id === request.id)
  assert.equal(owner.request.serviceMiles, 40, 'the owner row carries the distance for the card')
  assert.equal('serviceMiles' in quotes.get(request.id).request, false, 'the customer shape does not')

  // Close by: no reason added, and a clean tire stays a clean quote.
  const near = quotes.submit(form({ serviceZip: '02149' }))
  assert.equal(near.quote.exception, false)
  assert.equal(quotes.listForOwner().find(row => row.request.id === near.request.id).request.serviceMiles, 2)
})

test('with the check switched off every known ZIP is accepted and the owner still sees the miles', async t => {
  const { inventory } = setup(t)
  const quotes = new Quotes(inventory, { serviceArea: readServiceAreaConfig({ KMT_SERVICE_RADIUS_MILES: 'off' }) })
  const { request, quote } = quotes.submit(form({ serviceZip: '04401' }))
  assert.equal(quote.exception, true, 'still past the review distance, so still flagged')
  assert.ok(quote.exceptionReasons.some(reason => /about 200 miles/.test(reason)))
  assert.equal(quotes.listForOwner().find(row => row.request.id === request.id).request.serviceMiles, 200)
  assert.throws(() => quotes.submit(form({ serviceZip: '99999' })), /ZIP code isn't one I recognize/, 'unknown is still unknown')
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

test('a field added to the quote payload is owner-only until CUSTOMER_QUOTE_FIELDS names it (#65, the quote half)', async t => {
  // The mirror of the test above, for `quote` rather than `request`: nothing
  // reaches the customer shape by default, only by being named in
  // CUSTOMER_QUOTE_FIELDS. There is no public field to submit through yet
  // (that is t35's job), so this writes directly to the stored quote payload
  // -- the same thing any future feature does the moment it adds a key --
  // and proves the allow-list catches it regardless of how it got there.
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  const row = quotes.db.prepare('SELECT payload FROM quotes WHERE request_id=?').get(request.id)
  const payload = { ...JSON.parse(row.payload), marginNote: 'Bought these at cost from a closeout, do not undercut retail.' }
  quotes.db.prepare('UPDATE quotes SET payload=? WHERE request_id=?').run(JSON.stringify(payload), request.id)

  assert.equal(quotes.get(request.id, 'owner').quote.marginNote, payload.marginNote, 'the owner still reads it')
  assert.equal('marginNote' in quotes.get(request.id).quote, false, 'not in the customer shape by id')
  assert.equal('marginNote' in quotes.listForCustomer(KEY)[0].quote, false, 'nor in the customer list')
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
const CUSTOMER_FIELDS = ['id', 'vehicleInfo', 'tireSelection', 'quantity', 'date', 'locationType', 'serviceZip', 'disposeOldTires', 'chosenLineIds', 'createdAt', 'updatedAt']
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
  ownerDecide(quotes, submitted.request.id, 'sent', 1)
  const paid = quotes.pay(submitted.request.id)
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
  const sent = ownerDecide(quotes, request.id, 'sent', 1)
  assert.equal(sent.request.customerEmail, 'jamie@example.com', 'decide answers the owner')
  const cancelled = ownerCancel(quotes, request.id, 2, 'Out of stock')
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

test('customer and owner lists keep insertion chronology when created timestamps tie', t => {
  const { quotes } = setup(t)
  const older = quotes.submit(form({ location: 'First request' }))
  const newer = quotes.submit(form({ location: 'Second request' }))
  const tiedAt = '2026-09-08T12:00:00.000Z'
  quotes.db.prepare('UPDATE requests SET created_at=? WHERE id IN (?, ?)')
    .run(tiedAt, older.request.id, newer.request.id)

  // Make the planner's otherwise-valid tie order oppose insertion order. A
  // query that names only created_at can silently follow either index; the
  // public contract must not depend on which one SQLite happens to choose.
  const olderSortsFirst = older.request.id < newer.request.id
  const idDirection = olderSortsFirst ? 'ASC' : 'DESC'
  quotes.db.exec(`
    DROP INDEX requests_customer;
    CREATE INDEX requests_customer_probe ON requests(customer_key, created_at DESC, id ${idDirection});
    CREATE INDEX requests_created_probe ON requests(created_at DESC, id ${idDirection});
  `)

  const expected = [newer.request.id, older.request.id]
  assert.deepEqual(quotes.listForCustomer(KEY).map(row => row.request.id), expected,
    'the browser sees the later insertion first even at the same millisecond')
  assert.deepEqual(quotes.listForOwner().map(row => row.request.id), expected,
    'the owner sees the same stable chronology')
})

test('paying needs the id alone, and a quote the owner has approved (#284: not the submitting browser\'s key)', async t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())

  // A draft is not payable: that would be paying a price nobody agreed to.
  assert.throws(() => quotes.pay(request.id), /not been approved/)

  // Approve it the way t30's endpoint will, by moving the row.
  quotes.db.prepare('UPDATE quotes SET status=? WHERE request_id=?').run('approved', request.id)

  // The id is the access (R19), the same as reading it -- no key check to route around.
  assert.throws(() => quotes.pay('0'.repeat(32)), /No such request/)

  const paid = quotes.pay(request.id)
  assert.equal(paid.quote.status, 'paid')
  assert.equal(paid.quote.version, 2, 'the version moves, for the optimistic updates t30 needs')

  // Paying twice is the same answer, not an error and not a second charge.
  assert.equal(quotes.pay(request.id).quote.status, 'paid')
})

test('#284: opening the emailed link on a device that never submitted can still pay and cancel', async t => {
  // The exact failure the issue described: a customer submits on their phone
  // (customerKey() writes a key to that browser's localStorage), then opens
  // the same emailed link on a laptop, where customerKey() has nothing
  // stored and generates a brand-new random one -- OTHER_KEY stands in for
  // that freshly-generated key here, never sent by the submitting device and
  // never known to it.
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  ownerDecide(quotes, request.id, 'sent', quote.version)

  // Neither call is told any key at all -- the id from the link is the whole access.
  const paid = quotes.pay(request.id)
  assert.equal(paid.quote.status, 'paid', 'a device that never submitted can still complete the payment')

  const { request: other } = quotes.submit(form({ vehicleInfo: 'to cancel from elsewhere' }))
  const cancelled = quotes.cancelByCustomer(other.id)
  assert.equal(cancelled.quote.status, 'cancelled', 'and cancel the same way')
})

/* --------------------------------------------------- rate limits (t45, #63) */

/** Small windows, so a test can reach them in a handful of calls. */
const smallRules = {
  publicPerIp: { max: 4, windowMs: 60_000 },
  publicPerKey: { max: 2, windowMs: 60_000 },
  previewPerIp: { max: 4, windowMs: 60_000 },
  previewPerKey: { max: 2, windowMs: 60_000 },
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
  assert.match((await byEmail.json()).error, /email address has been used for too many requests today. Text me instead./)
  assert.equal((await post(base, '/api/requests', form({ customerKey: keys[3], customerEmail: 'other@example.com' }))).status, 201, 'the key itself is fine')
})

test('pricing previews have bounded address and browser limits without consuming submission capacity', async t => {
  const { inventory, quotes } = setup(t)
  const limiter = new RateLimiter({ rules: { ...smallRules, publicPerIp: { max: 100, windowMs: 60_000 } }, log: () => {} })
  const base = await serve(t, quotes, inventory, { limiter })
  const body = { customerKey: KEY, tireSelection: 'giga-a', quantity: 4, serviceZip: '02149' }

  assert.equal((await post(base, '/api/requests/preview', body)).status, 200)
  assert.equal((await post(base, '/api/requests/preview', body)).status, 200)
  const refused = await post(base, '/api/requests/preview', body)
  assert.equal(refused.status, 429)
  assert.match((await refused.json()).error, /this browser/)
  assert.equal(quotes.listForOwner().length, 0)
  assert.equal((await post(base, '/api/requests', form())).status, 201,
    'preview refreshes do not consume the submit, pay and cancel buckets')
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
  const ownerApi = createApi(inventory, { start: () => ({}), cancel: () => ({}) }, null, quotes, { auth })

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

  const previewed = await post(base, '/api/requests/preview', {
    customerKey: KEY, tireSelection: 'giga-a', quantity: 4, serviceZip: '02149', disposeOldTires: false,
  })
  assert.equal(previewed.status, 200, 'pricing preview is public without an owner session')
  assert.equal((await previewed.json()).preview.total, quotes.preview(form()).total)
  assert.equal(quotes.listForOwner().length, 0, 'the preview did not submit anything')

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

  // Paying: refused as a draft, accepted once approved, from any device (#284) --
  // no customerKey needed or checked; the id is the access, same as reading it.
  assert.equal((await post(base, `/api/requests/${request.id}/pay`, {})).status, 409)
  quotes.db.prepare('UPDATE quotes SET status=? WHERE request_id=?').run('approved', request.id)
  const paid = await post(base, `/api/requests/${request.id}/pay`, {})
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
  assert.equal(isPublicApiCall('POST', '/api/requests/preview'), true)
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
  assert.equal(isPublicApiCall('GET', '/api/requests/preview'), false)
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

  const decided = ownerDecide(quotes, request.id, 'sent', quote.version)

  assert.equal(decided.quote.status, 'sent')
  assert.equal(decided.quote.version, quote.version + 1, 'the version moves with the decision')
  // The customer's own read, by id, sees the same thing.
  assert.equal(quotes.get(request.id).quote.status, 'sent')
  assert.equal(quotes.listForCustomer(KEY)[0].quote.status, 'sent')
})

test('rejecting moves a draft the same way', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  assert.equal(ownerDecide(quotes, request.id, 'rejected', quote.version).quote.status, 'rejected')
  assert.equal(quotes.get(request.id).quote.status, 'rejected')
})

test('a decline carries the reason Ken typed (#78: decide() used to drop it silently)', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  const decided = ownerDecide(quotes, request.id, 'rejected', quote.version, ' Out of stock by the time I checked ')
  assert.equal(decided.quote.reason, 'Out of stock by the time I checked', 'trimmed, and actually stored')
  assert.equal(quotes.get(request.id).quote.reason, 'Out of stock by the time I checked')

  // Blank is a choice to say nothing, not a gap to fill with a guess.
  const { request: blank, quote: blankQuote } = quotes.submit(form())
  assert.equal(ownerDecide(quotes, blank.id, 'rejected', blankQuote.version, '   ').quote.reason, null)

  // Approving never writes a reason, even if one somehow arrived with it.
  const { request: approved, quote: approvedQuote } = quotes.submit(form())
  assert.equal(ownerDecide(quotes, approved.id, 'sent', approvedQuote.version, 'should never land').quote.reason, null)
})

test('a decline reason over 500 characters is refused -- cleanReason\'s own limit, never exercised through decide()', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  assert.throws(() => ownerDecide(quotes, request.id, 'rejected', quote.version, 'x'.repeat(501)), /reason is too long/)
  assert.equal(quotes.get(request.id).quote.status, 'draft', 'the refused decision left the row untouched')
})

test('a stale version is refused rather than overwriting the newer decision', async t => {
  // Two owner windows, or a phone and a laptop. The second save must not
  // silently undo the first -- the same rule PUT /api/owner/offers/:id makes.
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  ownerDecide(quotes, request.id, 'sent', quote.version)

  assert.throws(
    () => ownerDecide(quotes, request.id, 'rejected', quote.version),
    error => error.status === 409 && /changed in another window/.test(error.message),
  )
  assert.equal(quotes.get(request.id).quote.status, 'sent', 'the first decision stands')
})

test('only a draft can be decided', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  const sent = ownerDecide(quotes, request.id, 'sent', quote.version)

  // Right version, wrong state: already decided, and paid is further still.
  assert.throws(
    () => ownerDecide(quotes, request.id, 'rejected', sent.quote.version),
    error => error.status === 409 && /already sent/.test(error.message),
  )

  quotes.pay(request.id)
  const paid = quotes.get(request.id)
  assert.throws(
    () => ownerDecide(quotes, request.id, 'rejected', paid.quote.version),
    error => error.status === 409 && /already paid/.test(error.message),
  )
})

test('a decision has to be a decision, and carry a version', async t => {
  const { quotes } = setup(t)
  const { request, quote } = quotes.submit(form())

  assert.throws(() => ownerDecide(quotes, request.id, 'maybe', quote.version), /sent to the customer or rejected/)
  assert.throws(() => ownerDecide(quotes, request.id, 'sent', undefined), /version you were shown/)
  assert.throws(() => ownerDecide(quotes, request.id, 'sent', -1), /version you were shown/)
  assert.throws(() => ownerDecide(quotes, '0'.repeat(32), 'sent', 1), /No such request/)
})

test('the owner endpoints need a session, and the customer endpoints are unchanged', async t => {
  const { inventory, quotes } = setup(t)
  const base = await serve(t, quotes, inventory)
  const { request, quote } = quotes.submit(form())

  // Shut without a cookie, exactly like the rest of the owner API.
  assert.equal((await fetch(`${base}/api/owner/requests`)).status, 401)
  assert.equal((await post(base, `/api/owner/quotes/${request.id}/approve`, { version: quote.version })).status, 401)
  assert.equal((await fetch(`${base}/api/owner/quotes/${request.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineItems: quote.lineItems, version: quote.version }) })).status, 401)

  const { cookie } = await signIn(base)
  const headers = { cookie, 'Content-Type': 'application/json' }

  const listed = await (await fetch(`${base}/api/owner/requests`, { headers })).json()
  assert.equal(listed.requests.length, 1)
  assert.equal(listed.requests[0].tire.name, 'Test Touring')

  const edited = await fetch(`${base}/api/owner/quotes/${request.id}`, {
    method: 'PUT', headers, body: JSON.stringify({
      lineItems: [{ description: 'Adjusted job', quantity: 2, unitPrice: 75 }],
      note: 'Customer note', total: 2, version: quote.version,
    }),
  })
  assert.equal(edited.status, 200)
  const editedBody = await edited.json()
  assert.equal(editedBody.quote.total, 150)

  const stale = await fetch(`${base}/api/owner/quotes/${request.id}/approve`, {
    method: 'POST', headers, body: JSON.stringify({ version: editedBody.quote.version + 5 }),
  })
  assert.equal(stale.status, 409, 'a stale version is a 409 over HTTP too')

  const approved = await fetch(`${base}/api/owner/quotes/${request.id}/approve`, {
    method: 'POST', headers, body: JSON.stringify({ version: editedBody.quote.version }),
  })
  assert.equal(approved.status, 200)
  const approvedBody = await approved.json()
  assert.equal(approvedBody.quote.status, 'sent')
  assert.equal(approvedBody.quote.decidedBy, SHARED_PASSWORD_ACTOR,
    'the owner route resolves the password-session marker instead of inventing or dropping an actor')

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
  if (status === 'rejected') return ownerDecide(quotes, request.id, 'rejected', quote.version)
  const sent = ownerDecide(quotes, request.id, 'sent', quote.version)
  if (status === 'sent') return sent
  const paid = quotes.pay(request.id)
  if (status === 'paid') return paid
  if (status === 'done') return ownerFinish(quotes, request.id, paid.quote.version)
  throw new Error(`walkTo does not know how to reach ${status}`)
}

test('a paid request is closed by marking it done, and only from paid', async t => {
  const { quotes } = setup(t)

  const paid = walkTo(quotes, 'paid')
  const done = ownerFinish(quotes, paid.request.id, paid.quote.version)
  assert.equal(done.quote.status, 'done')
  assert.equal(done.quote.version, paid.quote.version + 1, 'the version moves with the transition')
  assert.equal(quotes.get(paid.request.id).quote.status, 'done', 'and the customer reads it too')

  // Twice is not twice as done.
  assert.throws(
    () => ownerFinish(quotes, paid.request.id, done.quote.version),
    error => error.status === 409 && /already closed/.test(error.message),
  )

  for (const status of ['draft', 'sent', 'rejected']) {
    const row = walkTo(quotes, status)
    assert.throws(
      () => ownerFinish(quotes, row.request.id, row.quote.version),
      error => error.status === 409 && /only a paid request/.test(error.message),
      `${status} should not be markable done`,
    )
  }
})

test('marking done takes the same version check as every other transition', async t => {
  const { quotes } = setup(t)
  const paid = walkTo(quotes, 'paid')

  assert.throws(() => ownerFinish(quotes, paid.request.id, paid.quote.version + 5),
    error => error.status === 409 && /changed in another window/.test(error.message))
  assert.throws(() => ownerFinish(quotes, paid.request.id, undefined), /version you were shown/)
  assert.throws(() => ownerFinish(quotes, '0'.repeat(32), 1), error => error.status === 404)
  assert.equal(quotes.get(paid.request.id).quote.status, 'paid', 'and none of that moved it')
})

test('the owner can cancel before payment, with a reason, and not after', async t => {
  const { quotes } = setup(t)

  for (const status of ['draft', 'sent']) {
    const row = walkTo(quotes, status)
    const cancelled = ownerCancel(quotes, row.request.id, row.quote.version, ' out of stock ')
    assert.equal(cancelled.quote.status, 'cancelled', `cancelling from ${status}`)
    assert.equal(cancelled.quote.reason, 'out of stock', 'trimmed, and kept with the row')
    assert.equal(quotes.get(row.request.id).quote.reason, 'out of stock', 'the customer is told why')
  }

  // A reason is optional, and nothing stands in for one.
  const bare = walkTo(quotes, 'draft')
  assert.equal(ownerCancel(quotes, bare.request.id, bare.quote.version).quote.reason, null)
  const blank = walkTo(quotes, 'draft')
  assert.equal(ownerCancel(quotes, blank.request.id, blank.quote.version, '   ').quote.reason, null)

  const paid = walkTo(quotes, 'paid')
  assert.throws(
    () => ownerCancel(quotes, paid.request.id, paid.quote.version),
    error => error.status === 409 && /Mark it done/.test(error.message),
    'money has moved; the way out is done, not cancelled',
  )
  const done = walkTo(quotes, 'done')
  assert.throws(() => ownerCancel(quotes, done.request.id, done.quote.version),
    error => error.status === 409 && /already done/.test(error.message))
})

test('nothing is deleted: a cancelled request is still there to read', async t => {
  const { quotes } = setup(t)
  const row = walkTo(quotes, 'sent')
  ownerCancel(quotes, row.request.id, row.quote.version, 'the van broke down')

  const found = quotes.get(row.request.id)
  assert.equal(found.request.vehicleInfo, '2021 Honda Civic', 'the request it was made from')
  assert.equal(found.quote.total, row.quote.total, 'and the quote it was given')
  assert.equal(quotes.listForCustomer(KEY).length, 1)
  assert.equal(quotes.listForOwner().length, 1)
})

test('a customer can call off their own request, by id alone, from any device (#284)', async t => {
  const { quotes } = setup(t)

  const row = walkTo(quotes, 'sent')
  assert.throws(
    () => quotes.cancelByCustomer('0'.repeat(32)),
    error => error.status === 404 && /No such request/.test(error.message),
    'an id nobody holds is answered as though the request does not exist',
  )
  assert.equal(quotes.get(row.request.id).quote.status, 'sent', 'and nothing moved')

  const cancelled = quotes.cancelByCustomer(row.request.id, 'sold the car')
  assert.equal(cancelled.quote.status, 'cancelled')
  assert.equal(cancelled.quote.reason, 'sold the car')
  // Asking twice is the same answer, not an error: a phone that lost the reply.
  assert.equal(quotes.cancelByCustomer(row.request.id).quote.status, 'cancelled')
})

test('a customer cannot call off what they have already paid for', async t => {
  const { quotes } = setup(t)
  const paid = walkTo(quotes, 'paid')

  assert.throws(
    () => quotes.cancelByCustomer(paid.request.id),
    error => error.status === 409 && /been paid for/.test(error.message),
  )
  assert.equal(quotes.get(paid.request.id).quote.status, 'paid')

  const done = walkTo(quotes, 'done')
  assert.throws(() => quotes.cancelByCustomer(done.request.id),
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

  const paid = quotes.pay(request.id)
  assert.equal(paid.quote.status, 'paid')
  assert.equal(ownerFinish(quotes, request.id, paid.quote.version).quote.status, 'done',
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
  ownerCancel(quotes, toCancel.request.id, toCancel.quote.version, 'no van that day')

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

  // And the customer cancelling their own, with no session at all, by id
  // alone -- from any device, no customerKey needed (#284).
  const mine = walkTo(quotes, 'sent', { vehicleInfo: 'mine to cancel' })
  assert.equal((await post(base, `/api/requests/${'0'.repeat(32)}/cancel`, {})).status, 404)
  const own = await post(base, `/api/requests/${mine.request.id}/cancel`, { reason: 'changed my mind' })
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

/* ------------------------------------------------ who decided (#290, schema) --- */

test('an owner decision records the actor supplied by the authenticated caller', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())

  const sent = ownerDecide(quotes, request.id, 'sent', 1)
  assert.equal(sent.quote.decidedBy, SHARED_PASSWORD_ACTOR)
})

test('a customer paying does not overwrite who sent the quote', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  // Sent through `moveTo` with an explicit actor rather than `decide()`,
  // because `decide()` establishes none and there would be nothing for the
  // payment to preserve -- the test would pass on null either way and prove
  // nothing. Assert on a write, not on a survival of an absence.
  quotes.moveTo(request.id, 1, {
    to: 'sent', from: ['draft'], refused: () => 'no', audience: 'owner',
    actor: 'owner:ken@kensmobiletire.com',
  })

  quotes.pay(request.id)

  // The column holds one value and the lifecycle has several transitions:
  // draft -> sent (owner) -> paid (customer) -> done (owner). If every
  // transition wrote it, payment would erase the approval this exists to
  // record.
  const owned = quotes.get(request.id, 'owner')
  assert.equal(owned.quote.status, 'paid')
  assert.equal(owned.quote.decidedBy, 'owner:ken@kensmobiletire.com',
    'the approval survives the payment that followed it')
})

test('a customer cancelling their own request does not write an owner actor', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())

  quotes.cancelByCustomer(request.id, 'Changed my mind')

  const owned = quotes.get(request.id, 'owner')
  assert.equal(owned.quote.status, 'cancelled')
  assert.equal(owned.quote.decidedBy, null,
    "the customer closed this, and recording them as the deciding owner would be false")
})

test('marking a paid job done preserves the first recorded owner actor', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  ownerDecide(quotes, request.id, 'sent', 1)
  quotes.pay(request.id)

  const done = ownerFinish(quotes, request.id, quotes.get(request.id, 'owner').quote.version)
  assert.equal(done.quote.status, 'done')
  assert.equal(done.quote.decidedBy, SHARED_PASSWORD_ACTOR)
})

test('every owner transition refuses to move without an actor', t => {
  const { quotes } = setup(t)
  const draft = quotes.submit(form())
  assert.throws(() => quotes.decide(draft.request.id, 'sent', draft.quote.version), /requires an authenticated actor/)
  assert.throws(() => quotes.cancel(draft.request.id, draft.quote.version), /requires an authenticated actor/)

  const paid = ownerDecide(quotes, draft.request.id, 'sent', draft.quote.version)
  quotes.pay(draft.request.id)
  assert.throws(() => quotes.finish(draft.request.id, paid.quote.version + 1), /requires an authenticated actor/)
})

test('the quote-action handler refuses a valid session whose stored actor is null', async t => {
  const { inventory, quotes } = setup(t)
  const { request, quote } = quotes.submit(form())
  const api = createApi(inventory, null, null, quotes, { auth: { actorFor: () => null } })
  const server = createServer(async (incoming, response) => {
    if (!(await api(incoming, response))) response.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/owner/quotes/${request.id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: quote.version }),
  })
  assert.equal(response.status, 401)
  assert.match((await response.json()).error, /Sign in again/)
  assert.equal(quotes.get(request.id).quote.status, 'draft', 'the actorless request did not reach storage')
})

/**
 * The seam #290's sign-in half fills.
 *
 * `moveTo` takes an actor so that, once a verified Google identity exists,
 * the decision carries the person rather than the credential. Nothing passes
 * one today, which is why every test above sees the fallback -- but the seam
 * has to work before the sign-in work depends on it.
 */
test('moveTo records a supplied actor instead of the fallback', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())

  quotes.moveTo(request.id, 1, {
    to: 'sent', from: ['draft'], refused: () => 'no', audience: 'owner',
    actor: 'owner:ken@kensmobiletire.com',
  })

  assert.equal(quotes.get(request.id, 'owner').quote.decidedBy, 'owner:ken@kensmobiletire.com')
})

test('who operates the owner screen never reaches the customer shape', t => {
  const { quotes } = setup(t)
  const { request } = quotes.submit(form())
  ownerDecide(quotes, request.id, 'sent', 1)

  // The quote payload is audience-partitioned (CUSTOMER_QUOTE_FIELDS, #246).
  // The columns spread beside it in shapeRow are not: `reason` goes to both
  // audiences on purpose, and anything added in that block follows it to the
  // shareable link unless it says otherwise. decided_by is a column, so it
  // needs its own check, and this asserts it has one.
  const customer = quotes.get(request.id)
  assert.equal('decidedBy' in customer.quote, false, 'not merely null -- absent')
  assert.equal('decidedBy' in quotes.get(request.id, 'owner').quote, true, 'the owner shape carries the field')
})
