import { request } from 'node:https'
import { isIP } from 'node:net'
import { lookup } from 'node:dns'

import { ImageMirrorError } from './image-mirror.mjs'

const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

function headersOf(response) {
  return Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]))
}

function bodyBytes(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    response.on('data', chunk => {
      total += chunk.byteLength
      if (total > maxBytes) {
        response.destroy(new ImageMirrorError(`Image exceeds the ${maxBytes}-byte limit`, 'oversize'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(chunks, total)))
    response.on('error', reject)
  })
}

function requestOnce(url, { signal, maxBytes = DEFAULT_MAX_BYTES, onConnect, timeoutMs = 30_000, requestImpl = request, lookupImpl = lookup }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    let settled = false
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value) } }
    const req = requestImpl({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: { 'user-agent': 'KMT catalog image mirror (owner-authorized staging test)', accept: 'image/gif,image/jpeg,image/png,image/webp' },
      timeout: timeoutMs,
      lookup(hostname, options, callback) {
        lookupImpl(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) return callback(error)
          if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => isIP(entry.address) === 0)) return callback(new Error('Provider hostname returned an invalid address'))
          const first = addresses[0]
          if (!first) return callback(new Error('Provider hostname did not resolve to an IP address'))
          try { for (const entry of addresses) onConnect({ url, address: entry.address }) } catch (validationError) { return callback(validationError) }
          if (options.all) callback(null, addresses)
          else callback(null, first.address, first.family)
        })
      },
    }, response => {
      const headers = headersOf(response)
      if (response.statusCode === 403 || response.statusCode === 429) {
        response.destroy()
        finish(reject, new ImageMirrorError(`Provider refused image request (${response.statusCode})`, `provider-${response.statusCode}`, { refusal: true }))
        return
      }
      if (response.statusCode >= 300 && response.statusCode < 400 && headers.location) {
        response.destroy()
        let location
        try { location = new URL(headers.location, url).toString() } catch (error) {
          response.destroy()
          finish(reject, new ImageMirrorError(`Provider redirect is malformed: ${error.message}`, 'provider-refusal', { refusal: true }))
          return
        }
        finish(resolve, { status: response.statusCode, headers, location, finalUrl: url, bytes: new Uint8Array() })
        return
      }
      bodyBytes(response, maxBytes).then(bytes => finish(resolve, { status: response.statusCode, headers, finalUrl: url, bytes }), error => finish(reject, error))
    })
    req.on('error', error => finish(reject, error))
    req.on('timeout', () => req.destroy(new ImageMirrorError('Provider request timed out', 'timeout')))
    if (signal) {
      if (signal.aborted) req.destroy(new ImageMirrorError('Provider request aborted', 'timeout'))
      else signal.addEventListener('abort', () => req.destroy(new ImageMirrorError('Provider request aborted', 'timeout')), { once: true })
    }
    req.end()
  })
}

/** A provider transport with per-hop DNS resolution and safe-connect hooks. */
export function createHttpsImageTransport({ maxRedirects = DEFAULT_MAX_REDIRECTS, timeoutMs = 30_000, requestImpl = request, lookupImpl = lookup } = {}) {
  return {
      async fetch(url, options = {}) {
      const redirectLimit = Number.isInteger(options.maxRedirects) ? Math.min(maxRedirects, options.maxRedirects) : maxRedirects
      const visited = new Set()
      let current = url
      for (let hop = 0; ; hop++) {
        if (hop > redirectLimit || visited.has(current)) throw new ImageMirrorError('Provider redirect limit or loop exceeded', 'provider-refusal', { refusal: true })
        visited.add(current)
        const response = await requestOnce(current, { ...options, timeoutMs, requestImpl, lookupImpl, onConnect: details => options.onConnect?.(details), maxBytes: options.maxBytes })
        if (!response.location) return response
        if (hop === redirectLimit) throw new ImageMirrorError('Provider redirect limit exceeded', 'provider-refusal', { refusal: true })
        const next = options.onRedirect?.(response.location) ?? response.location
        current = next
      }
    },
  }
}
