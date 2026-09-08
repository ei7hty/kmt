import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSafeImageFetcher, mirrorRemoteImages } from '../scripts/image-mirror.mjs'
import { createHttpsImageTransport } from '../scripts/image-provider.mjs'

const URL = 'https://cdn.example.test/image.png'

function fakeResponse({ statusCode = 200, headers = { 'content-type': 'image/png' }, body = new Uint8Array([1, 2, 3]) } = {}) {
  const response = new EventEmitter()
  response.statusCode = statusCode
  response.headers = headers
  response.destroyed = false
  response.destroy = () => { response.destroyed = true; response.removeAllListeners() }
  response.body = body
  return response
}

function fakeTransport({ responses, addresses = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }] }) {
  const requests = []
  const lookupCalls = []
  const requestImpl = (options, callback) => {
    const req = new EventEmitter()
    req.destroyed = false
    req.destroy = error => { req.destroyed = true; if (error) req.emit('error', error) }
    req.end = () => {
      options.lookup(options.hostname, { all: true }, (error, answer) => {
        if (error) return req.emit('error', error)
        requests.push({ options, response: responses.shift() })
        const response = requests.at(-1).response
        callback(response)
        if (!response.destroyed && response.statusCode >= 200 && response.statusCode < 300) {
          queueMicrotask(() => { response.emit('data', response.body); response.emit('end') })
        }
        return answer
      })
    }
    return req
  }
  const lookupImpl = (hostname, options, callback) => {
    lookupCalls.push({ hostname, options })
    callback(null, addresses)
  }
  return { requests, lookupCalls, transport: createHttpsImageTransport({ requestImpl, lookupImpl }) }
}

function repository() {
  const failures = []
  return {
    failures,
    findByHash: async () => null,
    recordStored: async () => ({ status: 'stored' }),
    recordFailure: async (id, failure) => { failures.push({ id, failure }); return { status: 'recorded' } },
  }
}

test('real HTTPS transport honors Node all:true callback shape and validates every address', async () => {
  const fake = fakeTransport({ responses: [fakeResponse()] })
  const fetcher = createSafeImageFetcher(fake.transport, { allowedHosts: ['cdn.example.test'] })
  const response = await fetcher(URL, { maxBytes: 10 })
  assert.equal(response.status, 200)
  assert.equal(fake.lookupCalls[0].options.all, true)
  assert.equal(fake.requests.length, 1)
})

test('stricter zero-hop policy and redirect loops stop before another connection', async () => {
  const first = fakeResponse({ statusCode: 302, headers: { location: URL } })
  const fake = fakeTransport({ responses: [first, fakeResponse()] })
  const fetcher = createSafeImageFetcher(fake.transport, { allowedHosts: ['cdn.example.test'], maxRedirects: 2 })
  await assert.rejects(() => fetcher(URL, { maxRedirects: 0 }), /redirect limit/)
  assert.equal(fake.requests.length, 1)
  assert.equal(first.destroyed, true)
})

test('403/429 headers refuse immediately and stop the mirror run', async () => {
  for (const statusCode of [403, 429]) {
    const fake = fakeTransport({ responses: [fakeResponse({ statusCode, body: new Uint8Array([1, 2, 3, 4]) }), fakeResponse()] })
    const fetcher = createSafeImageFetcher(fake.transport, { allowedHosts: ['cdn.example.test'] })
    const repo = repository()
    const records = [1, 2].map(id => ({ id, supplierId: `supplier-${id}`, supplierSku: `sku-${id}`, candidateRevision: 'r1', originalUrl: URL, remoteImagePresent: true, sourceCurrent: true, usageStatus: 'candidate' }))
    const result = await mirrorRemoteImages(records, { dryRun: false, allowedHosts: ['cdn.example.test'], fetcher, inspectImage: () => ({ width: 1, height: 1, format: 'png' }), repository: repo, storage: { put: async () => ({}) }, delayMs: 0, timeoutMs: 1000 })
    assert.equal(result.attempted, 1)
    assert.equal(result.stoppedOnRefusal, true)
    assert.equal(fake.requests.length, 1)
    assert.equal(repo.failures.length, 1)
  }
})
