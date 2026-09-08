import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:https'
import { getDefaultAutoSelectFamily } from 'node:net'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { createSafeImageFetcher, mirrorRemoteImages } from '../scripts/image-mirror.mjs'
import { createHttpsImageTransport } from '../scripts/image-provider.mjs'

const URL = 'https://cdn.example.test/image.png'
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
// Test-only certificate and key generated locally, not credentials for any service.
const cert = readFileSync(new globalThis.URL('./fixtures/image-provider/cert.pem', import.meta.url))
const key = readFileSync(new globalThis.URL('./fixtures/image-provider/key.pem', import.meta.url))

async function fixture(t, handler, settings = {}) {
  const sockets = new Set()
  const hits = []
  const incoming = []
  const lookups = []
  const optionsSeen = []
  const server = createServer({ cert, key }, (req, res) => {
    hits.push({ path: req.url, host: req.headers.host, sni: req.socket.servername })
    handler(req, res, hits.length)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  const requestImpl = (options, callback) => {
    for (const previous of incoming) assert.ok(previous.destroyed, 'previous response must be destroyed before another request')
    optionsSeen.push(options)
    return request({ ...options, port: server.address().port, ca: cert,
      ...(settings.scalar ? { autoSelectFamily: false } : {}),
      // The fixture alone maps already validated public answers to loopback.
      // Node still invokes the real lookup contract and performs real TLS/HTTP.
      lookup(host, lookupOptions, done) {
        options.lookup(host, lookupOptions, (error, addresses, family) => {
          lookups.push({ lookupOptions, addresses, family })
          if (error) return done(error)
          if (lookupOptions.all) {
            assert.ok(Array.isArray(addresses), 'Node all:true must receive an array')
            done(null, addresses.map(entry => ({ address: entry.family === 6 ? '::1' : '127.0.0.1', family: entry.family })))
          } else {
            assert.equal(typeof addresses, 'string')
            assert.equal(family, 4)
            done(null, '127.0.0.1', family)
          }
        })
      },
    }, response => { incoming.push(response); callback(response) })
  }
  const transport = createHttpsImageTransport({ requestImpl, lookupImpl: (_host, _options, done) => done(null, settings.addresses ?? [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]), maxRedirects: settings.transportLimit ?? 3, timeoutMs: 1000, cleanupMs: 100 })
  const fetcher = createSafeImageFetcher(transport, { allowedHosts: ['cdn.example.test'], maxRedirects: settings.wrapperLimit ?? 3 })
  return { fetcher, transport, hits, incoming, lookups, optionsSeen, sockets }
}
const image = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(bytes) }

for (const scalar of [false, true]) test(`Node HTTPS ${scalar ? 'scalar' : 'default autoSelectFamily'} DNS contract retains hostname/SNI/TLS`, async t => {
  if (!scalar) assert.equal(getDefaultAutoSelectFamily(), true)
  const f = await fixture(t, image, { scalar })
  const result = await f.fetcher(URL)
  assert.deepEqual(result.bytes, bytes)
  assert.equal(Boolean(f.lookups[0].lookupOptions.all), !scalar)
  assert.equal(f.hits[0].sni, 'cdn.example.test')
  assert.match(f.hits[0].host, /^cdn\.example\.test:/)
  assert.equal(f.optionsSeen[0].agent, false)
  assert.equal(f.optionsSeen[0].rejectUnauthorized, undefined, 'normal TLS verification remains enabled')
})

test('every DNS answer is checked before any connection, including translated IPv6', async t => {
  for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::']) {
    const f = await fixture(t, image, { addresses: [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] })
    await assert.rejects(() => f.fetcher(URL), error => error.refusal === true)
    assert.equal(f.hits.length, 0)
  }
})

for (const [transportLimit, wrapperLimit, engineLimit] of [[0, 3, 3], [3, 0, 3], [3, 3, 0], [1, 3, 2], [3, 1, 2], [3, 2, 1]]) {
  test(`strictest redirect budget ${transportLimit}/${wrapperLimit}/${engineLimit} stops before prohibited connection`, async t => {
    const f = await fixture(t, (_req, res, n) => {
      res.writeHead(302, { location: `/hop-${n}` }); res.write('unfinished redirect body')
    }, { transportLimit, wrapperLimit })
    await assert.rejects(() => f.fetcher(URL, { maxRedirects: engineLimit }), error => error.refusal === true && /limit/.test(error.message))
    assert.equal(f.hits.length, Math.min(transportLimit, wrapperLimit, engineLimit) + 1)
    for (const response of f.incoming) assert.ok(response.destroyed && response.closed)
  })
}

test('loop detection and forbidden redirect discard oversized unfinished bodies before another connection', async t => {
  for (const location of [URL, 'https://127.0.0.1/secret', 'https://other.example.test/no', 'http://cdn.example.test/no', 'https://cdn.example.test:444/no']) {
    const f = await fixture(t, (_req, res) => { res.writeHead(302, { location, 'content-length': 10000000 }); res.write(Buffer.alloc(32768)) })
    await assert.rejects(() => f.fetcher(URL, { maxBytes: 32 }), error => error.refusal === true)
    assert.equal(f.hits.length, 1)
    assert.ok(f.incoming[0].destroyed && f.incoming[0].closed)
  }
})

test('abort during redirect cleanup prevents a second connection', async t => {
  const controller = new AbortController()
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: '/next' }); res.flushHeaders() })
  const original = f.transport.fetch
  f.transport.fetch = (url, options) => original(url, { ...options, onRedirect: next => { controller.abort(); return options.onRedirect(next) } })
  await assert.rejects(() => f.fetcher(URL, { signal: controller.signal }), /aborted/)
  assert.equal(f.hits.length, 1)
  assert.ok(f.incoming[0].destroyed && f.incoming[0].closed)
})

test('403/429 unfinished and oversized bodies refuse at headers and stop later candidates', async t => {
  for (const status of [403, 429]) {
    const f = await fixture(t, (_req, res) => { res.writeHead(status, { 'content-length': 9999999 }); res.flushHeaders() })
    const failures = []
    const records = [1, 2].map(id => ({ id, supplierId: `supplier-${id}`, supplierSku: `sku-${id}`, candidateRevision: 'r1', originalUrl: URL, remoteImagePresent: true, sourceCurrent: true, usageStatus: 'candidate' }))
    const result = await mirrorRemoteImages(records, { dryRun: false, allowedHosts: ['cdn.example.test'], fetcher: f.fetcher, inspectImage: () => ({ width: 1, height: 1, format: 'png' }), repository: { findByHash: () => null, recordStored() { assert.fail('refusal cannot store') }, recordFailure: (_id, failure) => failures.push(failure) }, storage: { put() { assert.fail('refusal cannot publish') } }, delayMs: 0, timeoutMs: 1000 })
    assert.equal(result.attempted, 1)
    assert.equal(result.stoppedOnRefusal, true)
    assert.equal(f.hits.length, 1)
    assert.equal(failures[0].state, `provider-${status}`)
    assert.ok(f.incoming[0].destroyed)
  }
})

test('bounded challenge prefix refuses without waiting for EOF', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>verify human challenge') })
  await assert.rejects(() => f.fetcher(URL), error => error.refusal === true)
  assert.ok(f.incoming[0].destroyed)
})

test('stream overflow, premature close, timeout and pre-abort close resources', async t => {
  for (const handler of [(_req, res) => { res.writeHead(200); res.write(Buffer.alloc(100)) }, (_req, res) => { res.writeHead(200, { 'content-length': 100 }); res.end('x') }]) {
    const f = await fixture(t, handler)
    await assert.rejects(() => f.fetcher(URL, { maxBytes: 50 }))
    assert.ok(f.incoming[0].destroyed)
  }
  const f = await fixture(t, (_req, res) => { res.writeHead(200); res.flushHeaders() })
  await assert.rejects(() => f.fetcher(URL, { signal: AbortSignal.timeout(30) }), /aborted/)
  assert.ok(f.incoming[0].destroyed)
  const before = f.hits.length
  await assert.rejects(() => f.fetcher(URL, { signal: AbortSignal.abort() }), /aborted/)
  assert.equal(f.hits.length, before)
})

test('invalid redirect policies fail closed before transport invocation', () => {
  for (const maxRedirects of [-1, NaN, 1.5, 11, null]) {
    assert.throws(() => createHttpsImageTransport({ maxRedirects }), /maxRedirects/)
    assert.throws(() => createSafeImageFetcher({ fetch() {} }, { allowedHosts: [], maxRedirects }), /maxRedirects/)
  }
})
