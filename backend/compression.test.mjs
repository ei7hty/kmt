/**
 * Compressing the catalogue response, and the two ways it goes quietly wrong.
 *
 * The failure this exists for is a post-deploy audit that has been red for days
 * -- `GET /api/catalog compressed transfer stays under 204,800 bytes`, against
 * ~325,000 actual. What is tested here is the mechanism, not that number: the
 * budget is measured against the real deployed site by
 * `.forge/deployed-site-check.mjs`, and a unit test that invented a payload of
 * about the right size would be asserting its own fixture.
 *
 * The two quiet failures, both covered below, are a body a client cannot read
 * (an `Accept-Encoding` header read as a word list rather than parsed, so a
 * `q=0` refusal is answered with the thing it refused) and a shared cache
 * handing one client's brotli body to the next as plain JSON (no `Vary`).
 * Neither shows up in a test that only checks the happy path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { BROTLI_QUALITY, COMPRESS_MIN_BYTES, compressedJson, negotiateEncoding } from './compression.mjs'
import { createCatalogApi } from './api.mjs'
import { Inventory } from './inventory.mjs'

const SIZE = '215/60R16'
const tire = (id, overrides = {}) => ({
  id, name: `Tire ${id}`, size: SIZE, price: 50, inStock: true, category: 'all-season',
  description: 'Touring All Season · 95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, url: 'https://www.giga-tires.com/tires/test' },
  ...overrides,
})

/** Big enough to be compressed at all -- the threshold is a real branch. */
const bigPayload = () => ({ tires: Array.from({ length: 200 }, (_, n) => tire(`giga-${n}`)) })

test('an Accept-Encoding refusal is honoured, which a word-list match gets backwards', () => {
  assert.equal(negotiateEncoding('br, gzip'), 'br', 'brotli is preferred where both are offered')
  assert.equal(negotiateEncoding('gzip'), 'gzip')
  assert.equal(negotiateEncoding('GZIP, BR'), 'br', 'the header is case-insensitive')

  // THE CASE THE PARSER EXISTS FOR. `/\bbr\b/` answers this header with "br"
  // and sends a body the client just said it cannot read.
  assert.equal(negotiateEncoding('gzip, br;q=0'), 'gzip')
  assert.equal(negotiateEncoding('br;q=0, gzip;q=0'), null, 'both refused means send it plain')
  assert.equal(negotiateEncoding('br;q=0.0'), null)

  // A wildcard accepts what it does not name; a named refusal still beats it.
  assert.equal(negotiateEncoding('*'), 'br')
  assert.equal(negotiateEncoding('br;q=0, *'), 'gzip')
  assert.equal(negotiateEncoding('*;q=0'), null)

  assert.equal(negotiateEncoding(''), null)
  assert.equal(negotiateEncoding(undefined), null)
  assert.equal(negotiateEncoding('identity'), null, 'identity is not something to encode with')
})

test('a compressed body decodes back to exactly what went in, by either encoding', async () => {
  const payload = bigPayload()
  for (const [header, encoding, decode] of [
    ['br', 'br', brotliDecompressSync],
    ['gzip', 'gzip', gunzipSync],
  ]) {
    const { body, headers } = await compressedJson(payload, header)
    assert.equal(headers['Content-Encoding'], encoding)
    assert.equal(headers['Content-Length'], String(body.length), 'Content-Length must describe the body actually sent')
    assert.deepEqual(JSON.parse(decode(body).toString()), payload, `${encoding} did not round-trip`)
    assert.ok(body.length < Buffer.byteLength(JSON.stringify(payload)),
      `${encoding} made the body no smaller, so nothing here is measuring compression`)
  }
})

test('Vary rides on every answer, including the uncompressed one', async () => {
  // The route answers `public, max-age=300` whenever no image packet exists.
  // A shared cache keyed without Vary stores one client's brotli body and
  // hands it to the next as plain JSON -- a corrupt catalogue on someone
  // else's phone, hours later, with nothing in our logs. The uncompressed
  // answer needs it just as much: it is the one most likely to be cached
  // first and then replayed to a client that would have taken brotli.
  const plain = await compressedJson(bigPayload(), 'identity')
  assert.equal(plain.headers.Vary, 'Accept-Encoding')
  assert.equal(plain.headers['Content-Encoding'], undefined, 'a refused encoding must not be applied')

  const compressed = await compressedJson(bigPayload(), 'br')
  assert.equal(compressed.headers.Vary, 'Accept-Encoding')
})

test('a body too small to be worth compressing is sent as it is', async () => {
  const small = { ok: true }
  assert.ok(Buffer.byteLength(JSON.stringify(small)) < COMPRESS_MIN_BYTES, 'the fixture has to be under the threshold to test it')
  const { body, headers } = await compressedJson(small, 'br')
  assert.equal(headers['Content-Encoding'], undefined)
  assert.deepEqual(JSON.parse(body.toString()), small)

  // The control: the same call with a body over the threshold IS compressed,
  // so the assertion above is the threshold working and not compression that
  // never happens.
  const { headers: over } = await compressedJson(bigPayload(), 'br')
  assert.equal(over['Content-Encoding'], 'br')
})

test('the quality is the measured one, and it beats what the edge achieves', () => {
  // Named rather than asserted as a number alone: the point is that changing
  // it is a decision with a measurement behind it (see compression.mjs), not
  // a knob to nudge. Quality 1 is what the deployed edge was beaten by.
  assert.ok(Number.isInteger(BROTLI_QUALITY) && BROTLI_QUALITY >= 4 && BROTLI_QUALITY <= 9,
    `brotli quality ${BROTLI_QUALITY} is outside the range that was measured; re-measure before moving it`)
})

test('the real snapshot compresses to a fraction of itself, at this quality', async () => {
  // Real supplier rows, not invented ones: 1,083 of them, the same shape the
  // deployed catalogue is built from. Compression ratio depends entirely on
  // how repetitive the data actually is, so a synthetic fixture would measure
  // the fixture.
  const snapshot = JSON.parse(readFileSync(new URL('../src/data/scraped-tires.json', import.meta.url), 'utf8'))
  assert.ok(snapshot.tires.length > 1000, `the snapshot has only ${snapshot.tires.length} rows; this measurement assumes the real one`)

  const raw = Buffer.byteLength(JSON.stringify(snapshot))
  const { body } = await compressedJson(snapshot, 'br')
  assert.ok(body.length * 8 < raw,
    `brotli q${BROTLI_QUALITY} got ${raw} bytes down to only ${body.length}; the deployed budget depends on far better than 8:1`)
})

/** The route, mounted the way server.mjs mounts it. */
async function catalogServer(t, inventory) {
  const catalog = createCatalogApi(inventory)
  const server = createServer(async (req, res) => {
    if (await catalog(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

/**
 * A raw GET, because fetch() decodes and then hides the encoding it decoded.
 *
 * ON A DEADLINE, and that is not belt-and-braces. A response whose
 * `Content-Length` is larger than the body actually written does not fail a
 * reader -- it hangs one, forever, waiting for bytes nobody is going to send.
 * Mutating `compressedJson` to declare the uncompressed length is exactly that
 * bug, and without this timeout the mutation stopped the suite dead instead of
 * turning it red: no failure, no message, just a test run that never finished.
 * A defect that hangs CI is worse than one that fails it.
 */
function rawGet(url, headers, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, timeout: timeoutMs }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    // `timeout` alone only EMITS the event; the socket stays open unless
    // something destroys it, so the promise would still never settle.
    request.on('timeout', () => {
      request.destroy(new Error(
        `no complete response in ${timeoutMs}ms -- if Content-Length is larger than the body, this is what that looks like`))
    })
    request.on('error', reject)
    request.end()
  })
}

test('GET /api/catalog answers a compressed body, and the same tires, over a real socket', async t => {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  inventory.importSnapshot({
    source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE],
    coverage: { [SIZE]: { limit: 0, pagesRead: 1, totalPages: 1, complete: true, scrapedAt: '2026-09-05T15:00:00Z' } },
    tires: Array.from({ length: 200 }, (_, n) => tire(`giga-${String(n).padStart(4, '0')}`)),
  })
  const base = await catalogServer(t, inventory)

  const compressed = await rawGet(`${base}/api/catalog`, { Accept: 'application/json', 'Accept-Encoding': 'br' })
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers['content-encoding'], 'br')
  assert.equal(compressed.headers.vary, 'Accept-Encoding')
  assert.equal(compressed.headers['content-length'], String(compressed.body.length))
  // The route's own headers must survive the compression headers being merged
  // in beside them -- this is where a careless spread eats Cache-Control.
  assert.match(compressed.headers['cache-control'], /max-age=300|no-store/)
  assert.equal(compressed.headers['content-type'], 'application/json')

  const decoded = JSON.parse(brotliDecompressSync(compressed.body).toString())
  assert.equal(decoded.tires.length, 200, 'every row still arrives; compression is not a cap')

  // A client that cannot decode gets readable JSON, not a brotli body with the
  // header stripped -- the failure mode that looks like a corrupt catalogue.
  const plain = await rawGet(`${base}/api/catalog`, { Accept: 'application/json', 'Accept-Encoding': 'identity' })
  assert.equal(plain.headers['content-encoding'], undefined)
  assert.deepEqual(JSON.parse(plain.body.toString()).tires.length, 200)
  assert.ok(plain.body.length > compressed.body.length,
    'the plain answer is not larger than the compressed one, so the compressed one compressed nothing')
})
