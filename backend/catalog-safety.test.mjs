import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertProviderResponse,
  fetchProductPage,
  fetchSizePage,
  ProviderRefusalError,
  productUrl,
  USER_AGENT,
} from '../scripts/giga-tires.mjs'
import { createValidationOptions, enrichRows, MAX_VALIDATION_COUNT, parseArgs, scrapeAll, selectValidationUrls } from '../scripts/scrape-tires.mjs'

const URL = productUrl('https://www.giga-tires.com/tires/example/roadmaster/tirecode/SKU123')
const response = (status, body = '') => ({
  status,
  statusText: status === 200 ? 'OK' : 'Denied',
  ok: status >= 200 && status < 300,
  headers: new Map(),
  text: async () => body,
})

const refusal = error => error instanceof ProviderRefusalError

test('plain fetch turns HTTP 403 and 429 into provider refusals before returning HTML', async () => {
  for (const status of [403, 429]) {
    await assert.rejects(
      fetchProductPage(URL, { fetchImpl: async (_url, init) => {
        assert.equal(init.headers['User-Agent'], USER_AGENT)
        return response(status)
      } }),
      error => refusal(error) && error.status === status,
    )
    await assert.rejects(
      fetchSizePage('215/60R16', 1, { fetchImpl: async () => response(status) }),
      error => refusal(error) && error.status === status,
    )
  }
})

test('plain fetch turns an equivalent denial body into a provider refusal', async () => {
  await assert.rejects(
    fetchProductPage(URL, { fetchImpl: async () => response(200, '<title>Request could not be satisfied</title>') }),
    error => refusal(error) && error.reason === 'request could not be satisfied',
  )
  await assert.rejects(
    fetchSizePage('215/60R16', 1, { fetchImpl: async () => response(200, '<p>Disallowed by robots.txt</p>') }),
    error => refusal(error) && error.reason === 'disallowed by robots',
  )
  await assert.rejects(
    fetchProductPage(URL, { fetchImpl: async () => response(200, '<html><body>provider challenge</body></html>') }),
    error => refusal(error) && error.reason === 'unexpected-provider-page',
  )
})

test('browser-shaped responses use the same fail-closed refusal guard', () => {
  for (const status of [403, 429]) {
    assert.throws(
      () => assertProviderResponse(URL, { status: () => status, headers: () => ({}) }, '<html>'),
      error => refusal(error) && error.status === status,
    )
  }
  assert.throws(
    () => assertProviderResponse(URL, { status: () => 200, headers: () => ({}) }, '<title>Access Denied</title>'),
    error => refusal(error) && error.reason === 'access denied',
  )
})

test('a listing refusal stops scrapeAll globally without recording coverage or continuing', async () => {
  const calls = []
  const result = await scrapeAll(
    ['215/60R16', '225/50R17'],
    { pages: 1, limit: 8, delay: 0, minInterval: 0 },
    async size => {
      calls.push(size)
      throw new ProviderRefusalError('403 from supplier', { status: 403, reason: 'forbidden' })
    },
  )
  assert.deepEqual(calls, ['215/60R16'])
  assert.deepEqual(result.coverage, {})
  assert.equal(result.stoppedOnRefusal.status, 403)
})

test('an immediate product refusal stops a concurrent queue before other workers reserve pages', async () => {
  const calls = []
  const urls = Array.from({ length: 5 }, (_, index) => URL.replace('SKU123', `SKU${index}`))
  await assert.rejects(
    enrichRows([], urls, { enrichLimit: 5, concurrency: 4, productDelay: 0 }, async url => {
      calls.push(url)
      throw new ProviderRefusalError('429 from supplier', { status: 429, reason: 'rate-limit' })
    }),
    error => refusal(error) && error.status === 429,
  )
  assert.equal(calls.length, 1)
})

test('validation selection honours the count, is reproducible, and fails closed', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    source: { url: URL.replace('SKU123', `SKU${index}`) },
  }))
  // The count the CLI defaults to (parseArgs.validationCount, 5) selects five,
  // reproducibly -- byte-identical to before this flag existed.
  const five = selectValidationUrls(rows, 20260907, 5)
  assert.equal(five.length, 5)
  assert.deepEqual(five, selectValidationUrls(rows, 20260907, 5))
  // A larger count selects that many; the same seed keeps the ordering stable,
  // and five is its prefix -- one shuffle, sliced to the count.
  const thirtySeven = selectValidationUrls(rows, 20260907, 37)
  assert.equal(thirtySeven.length, 37)
  assert.deepEqual(five, thirtySeven.slice(0, 5))
  // The shortfall message names the count asked for, not a literal 5.
  assert.throws(() => selectValidationUrls(rows.slice(0, 4), 20260907, 8), /needs 8 valid product URLs/)
  // No count, or a bad one, fails closed rather than silently selecting everything.
  assert.throws(() => selectValidationUrls(rows, 20260907), /positive integer count/)
  assert.throws(() => selectValidationUrls(rows, 20260907, 0), /positive integer count/)
})

const validationBase = {
  sizes: [], fromCatalog: false, enrichProducts: false, productUrls: [], replace: false,
  validationSeed: 20260907, validationJitterMin: 2000, validationJitterMax: 5000,
}

test('validation options thread the count into enrichLimit, force serial work and seeded jitter', () => {
  // enrichLimit follows the count, not a hardcoded 5 -- enrichRows slices to it,
  // so a run of N that left this at 5 would select N and process only five.
  assert.equal(createValidationOptions({ ...validationBase, validationCount: 5 }).enrichLimit, 5)
  assert.equal(createValidationOptions({ ...validationBase, validationCount: 37 }).enrichLimit, 37)
  const options = createValidationOptions({ ...validationBase, validationCount: 5 })
  assert.equal(options.concurrency, 1)
  const jitter = Array.from({ length: 5 }, () => options.delayForNext())
  assert.ok(jitter.every(value => value >= 2000 && value <= 5000))
  assert.notDeepEqual(jitter, Array(5).fill(jitter[0]))
})

test('parseArgs defaults validation-count to 5 and accepts an override', () => {
  assert.equal(parseArgs([]).validationCount, 5)
  assert.equal(parseArgs(['--validation-count', '37']).validationCount, 37)
})

test('validation-count is refused above the packet ceiling and below one', () => {
  // Refuse early: the cap keeps a run from building a snapshot.json the importer
  // rejects at its 65536-byte limit. Bound referenced from the module, not re-typed.
  assert.equal(createValidationOptions({ ...validationBase, validationCount: MAX_VALIDATION_COUNT }).enrichLimit, MAX_VALIDATION_COUNT)
  assert.throws(() => createValidationOptions({ ...validationBase, validationCount: MAX_VALIDATION_COUNT + 1 }), new RegExp(`exceeds the ${MAX_VALIDATION_COUNT}-page cap`))
  assert.throws(() => createValidationOptions({ ...validationBase, validationCount: 0 }), /must be a positive integer/)
})
