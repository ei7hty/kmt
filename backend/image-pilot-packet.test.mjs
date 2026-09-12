import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { prepareImagePilot, collectImagePilot, writeImagePilotPacket } from '../scripts/image-pilot-packet.mjs'
import { productDocumentPolicy, routeProductDocument } from '../scripts/browser-fetch.mjs'
import { selectValidationUrls } from '../scripts/scrape-tires.mjs'
import { sha256Bytes } from './image-assets.mjs'
import { supplierImageRevision } from './image-manifest.mjs'

function pilot() {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `giga-fixture-${i}`, name: 'Fixture', size: '215/60R16', price: 80,
    inStock: true, category: 'All Season', description: '<p>Fixture</p>', source: { sku: `FIXTURE-${i}`, url: 'https://www.giga-tires.com/tires/215-60-16' } }))
  const inputBytes = Buffer.from(JSON.stringify({ tires: rows }))
  const mapping = { version: 1, inputDigest: sha256Bytes(inputBytes), candidates: rows.map(row => ({ supplierId: row.id,
    // The tirecode segment IS what the product page reports as its sku. That is
    // how this supplier works -- measured 2026-09-12 on three real pages
    // (/tirecode/20000533 -> page sku "20000533", and so on) -- and the pilot's
    // identity check now ties those two together. The fixture used
    // `/tirecode/${i}` while the page served `FIXTURE-${i}`, which encoded the
    // old assumption that a page's sku matches the LISTING's sku; measured on 8
    // real candidates, those disagreed 8 times out of 8. Only the fixture's data
    // changes here -- every assertion below is untouched.
    supplierSku: row.source.sku, revision: supplierImageRevision(row), productUrl: `https://www.giga-tires.com/tires/fixture/tirecode/${row.source.sku}` })) }
  const mappingBytes = Buffer.from(JSON.stringify(mapping)), plan = prepareImagePilot(inputBytes, mappingBytes)
  const urls = selectValidationUrls(mapping.candidates.map(c => ({ source: { url: c.productUrl } })), 20260907, 5)
  const html = sku => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', sku,
    name: 'Fixture 215/60R16', image: 'https://images.fixture.test/photo.png', offers: { price: 80 } })}</script>`
  return { inputBytes, mappingBytes, mapping, plan, urls, html }
}

test('explicit owner mapping is required, digest-bound and never invents product URLs', () => {
  const f = pilot()
  assert.equal(f.plan.baseline.size, 5)
  assert.throws(() => prepareImagePilot(Buffer.concat([f.inputBytes, Buffer.from(' ')]), f.mappingBytes))
  for (const change of [m => m.candidates[0].productUrl = 'https://www.giga-tires.com/tires/listing',
    m => m.candidates[0].supplierSku = 'OTHER', m => m.candidates[0].revision = 'supplier-payload-v1:' + '0'.repeat(64),
    m => m.candidates[0] = m.candidates[1], m => m.candidates.length = 0]) {
    const mapping = structuredClone(f.mapping); change(mapping)
    assert.throws(() => prepareImagePilot(f.inputBytes, Buffer.from(JSON.stringify(mapping))))
  }
})

// `m.candidates.pop()` used to belong in the list above, because the packet size
// was fixed at five and a short mapping could only mean a truncated one. It is
// now a legitimate four-image run, so the assertion moved rather than its
// expected value: a shorter mapping is ACCEPTED and yields a smaller baseline.
// What still protects a truncated file is unchanged and is not the count --
// `inputDigest` pins the scraped input, every candidate must resolve to exactly
// one real input row with a matching sku and revision, `mappingDigest` is bound
// by the sealing step, and the manifest later requires every parallel array to
// agree on one count. An empty mapping is still refused: a run of nothing is a
// mistake, not a smaller run.
test('a shorter owner mapping is a smaller run, not a truncated one', () => {
  const f = pilot()
  const mapping = structuredClone(f.mapping)
  mapping.candidates.pop()
  const plan = prepareImagePilot(f.inputBytes, Buffer.from(JSON.stringify(mapping)))
  assert.equal(plan.baseline.size, 4)
  assert.equal(plan.inputDigest, f.plan.inputDigest)
})

test('five actual response identities produce ordered immutable provenance with serial pacing and no image fetch', async t => {
  const f = pilot(), calls = [], starts = [], waits = []
  let clock = 1
  const options = { codeSha: 'a'.repeat(40), seed: 20260907, delayForNext: () => 2500,
    now: () => clock, sleep: async ms => { waits.push(ms); clock += ms } }
  const packet = await collectImagePilot(f.plan, f.urls, options, async url => {
    calls.push(url); starts.push(clock)
    return { url, html: f.html(f.plan.baseline.get(url).mapping.supplierSku) }
  })
  assert.deepEqual(calls, f.urls); assert.deepEqual(waits, [2500, 2500, 2500, 2500])
  assert.deepEqual(starts, [1, 2501, 5001, 7501, 10001])
  assert.deepEqual(packet.orderedIds, f.urls.map(url => f.plan.baseline.get(url).mapping.supplierId))
  assert.deepEqual(packet.imageHosts, ['images.fixture.test'])
  assert.deepEqual(packet.productHosts, ['www.giga-tires.com'])
  assert.equal(packet.snapshotDigest, sha256Bytes(packet.snapshotBytes))
  const snapshot = JSON.parse(packet.snapshotBytes)
  assert.equal(snapshot.enrichedRows.length, 5)
  assert.equal(snapshot.provenance.inputDigest, sha256Bytes(f.inputBytes))
  assert.equal(snapshot.provenance.mappingDigest, sha256Bytes(f.mappingBytes))
  const temp = await mkdtemp(path.join(tmpdir(), 'kmt-pilot-packet-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const output = path.join(temp, 'packet')
  writeImagePilotPacket(output, packet, process.cwd())
  assert.deepEqual(await readFile(path.join(output, 'snapshot.json')), packet.snapshotBytes)
  assert.throws(() => writeImagePilotPacket(output, packet, process.cwd()))
  assert.throws(() => writeImagePilotPacket(path.join(process.cwd(), 'private'), packet, process.cwd()))
})

for (const scenario of ['refused', 'missing-sku', 'wrong-sku', 'wrong-size', 'no-image', 'redirect']) {
  test(`pilot stops globally without packet on ${scenario}`, async () => {
    const f = pilot(); let calls = 0
    await assert.rejects(collectImagePilot(f.plan, f.urls, { codeSha: 'a'.repeat(40), seed: 1, delayForNext: () => 2000, sleep: async () => {} }, async url => {
      calls++
      if (scenario === 'refused') throw new Error('Fixture provider refusal')
      let html = f.html(f.plan.baseline.get(url).mapping.supplierSku)
      if (scenario === 'missing-sku') html = html.replace(/"sku":"[^"]+",/, '')
      if (scenario === 'wrong-sku') html = f.html('OTHER')
      if (scenario === 'wrong-size') html = html.replace('215/60R16', '225/50R17')
      if (scenario === 'no-image') html = html.replace(/"image":"[^"]+",/, '')
      return { url: scenario === 'redirect' ? url + '/different' : url, html }
    }))
    assert.equal(calls, 1)
  })
}

test('product document policy permits only the one selected main navigation', () => {
  const url = 'https://provider.test/product', page = { mainFrame: () => frame }, frame = { page: () => page }
  const request = overrides => ({ isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame, url: () => url, ...overrides })
  const allow = productDocumentPolicy(url)
  for (const type of ['image', 'font', 'media', 'script', 'xhr', 'fetch', 'stylesheet', 'websocket']) assert.equal(allow(request({ resourceType: () => type })), false)
  assert.equal(allow(request({ url: () => 'https://outside.test/' })), false)
  assert.equal(allow(request({ frame: () => ({ page: () => page }) })), false)
  assert.equal(allow(request({})), true)
  assert.equal(allow(request({})), false)
})

test('metadata document transport refuses redirects without following or retrying them', async () => {
  let aborted = 0, fetched = 0, fulfilled = 0
  const route = { request: () => ({}), abort: async () => { aborted++ }, fulfill: async () => { fulfilled++ },
    fetch: async options => {
      fetched++; assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0, timeout: 30000 })
      return { status: () => 302, headers: () => ({ location: 'https://outside.test/' }) }
    } }
  await assert.rejects(routeProductDocument(route, () => true))
  assert.equal(fetched, 1); assert.equal(aborted, 1); assert.equal(fulfilled, 0)
  await routeProductDocument(route, () => false)
  assert.equal(fetched, 1); assert.equal(aborted, 2)
})
