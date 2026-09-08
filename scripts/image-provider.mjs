import { request } from 'node:https'
import { isIP } from 'node:net'
import { lookup } from 'node:dns'
import { ImageMirrorError, redirectBudget, refusalText } from './image-mirror.mjs'

const abortError = () => new ImageMirrorError('Provider request aborted', 'timeout')

// Never drain a redirect. No subsequent connection until destruction completes.
function closeResponse(response, cleanupMs) {
  return new Promise((resolve, reject) => {
    if (response.closed) return resolve()
    const timer = setTimeout(() => {
      response.removeListener('close', closed)
      reject(new ImageMirrorError('Provider response cleanup timed out', 'provider-refusal', { refusal: true }))
    }, cleanupMs)
    function closed() { clearTimeout(timer); resolve() }
    response.once('close', closed)
    response.destroy()
  })
}

function requestOnce(url, { signal, maxBytes, onConnect, timeoutMs, cleanupMs, requestImpl, lookupImpl }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    let settled = false
    let response
    let req
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) { response?.destroy(); req?.destroy(); reject(error) }
      else resolve(value)
    }
    const abort = () => finish(abortError())
    try {
      if (isIP(hostname)) onConnect({ url, address: hostname })
      req = requestImpl({
        protocol: parsed.protocol, hostname, port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`, method: 'GET', agent: false,
        // Original hostname retains Host, certificate verification and SNI.
        ...(isIP(hostname) ? {} : { servername: hostname }),
        headers: { 'user-agent': 'KMT catalog image mirror (owner-authorized staging test)', accept: 'image/gif,image/jpeg,image/png,image/webp' },
        lookup(host, options, callback) {
          lookupImpl(host, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error)
            if (signal?.aborted || settled) return callback(abortError())
            if (!Array.isArray(addresses) || !addresses.length || addresses.some(entry => !isIP(entry.address) || isIP(entry.address) !== entry.family)) return callback(new ImageMirrorError('Provider hostname returned an invalid address', 'provider-refusal', { refusal: true }))
            const pinned = addresses.map(({ address, family }) => ({ address, family }))
            try { for (const entry of pinned) onConnect({ url, address: entry.address }) } catch (validationError) { return callback(validationError) }
            if (options?.all) callback(null, pinned)
            else callback(null, pinned[0].address, pinned[0].family)
          })
        },
      }, incoming => {
        response = incoming
        response.on('error', error => finish(error))
        if (settled || signal?.aborted) { response.destroy(); return }
        const status = response.statusCode
        const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? '')]))
        if (status === 403 || status === 429) {
          const refusal = new ImageMirrorError(`Provider refused image request (${status})`, `provider-${status}`, { refusal: true })
          response.destroy()
          finish(refusal)
          return
        }
        if (status >= 300 && status < 400) {
          closeResponse(response, cleanupMs).then(() => {
            if (!headers.location) throw new ImageMirrorError('Provider redirect has no location', 'provider-refusal', { refusal: true })
            let location
            try { location = new URL(headers.location, url).toString() }
            catch { throw new ImageMirrorError('Provider redirect is malformed', 'provider-refusal', { refusal: true }) }
            finish(null, { status, headers, location, finalUrl: url, bytes: new Uint8Array() })
          }).catch(error => finish(error))
          return
        }
        const declared = Number(headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) { finish(new ImageMirrorError('Image declared length exceeds byte limit', 'oversize')); return }
        const chunks = []
        let total = 0
        let preview = Buffer.alloc(0)
        response.on('data', chunk => {
          if (settled) return
          if (preview.length < 8192) preview = Buffer.concat([preview, chunk.subarray(0, 8192 - preview.length)])
          if (refusalText(preview.toString('utf8'))) { finish(new ImageMirrorError('Provider refusal or challenge detected', 'provider-refusal', { refusal: true })); return }
          total += chunk.byteLength
          if (total > maxBytes) { finish(new ImageMirrorError(`Image exceeds the ${maxBytes}-byte limit`, 'oversize')); return }
          chunks.push(chunk)
        })
        response.on('end', () => { if (!settled) finish(null, { status, headers, finalUrl: url, bytes: Buffer.concat(chunks, total) }) })
        response.on('close', () => { if (!response.complete) finish(new ImageMirrorError('Provider response ended prematurely', 'invalid-body')) })
      })
      req.on('error', error => finish(error))
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(new ImageMirrorError('Provider request timed out', 'timeout')), timeoutMs)
      if (signal?.aborted) abort()
      else req.end()
    } catch (error) { finish(error) }
  })
}

/** Per-hop DNS pinning, with no connection reuse across authorization checks. */
export function createHttpsImageTransport({ maxRedirects = 3, timeoutMs = 30_000, cleanupMs = 250, requestImpl = request, lookupImpl = lookup } = {}) {
  redirectBudget(maxRedirects)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(cleanupMs) || cleanupMs < 1) throw new TypeError('Transport timeouts must be positive integers')
  return {
    async fetch(url, options = {}) {
      const redirectLimit = redirectBudget(maxRedirects, options.maxRedirects)
      const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
      if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer')
      const visited = new Set()
      let current = url
      for (let hop = 0; ; hop++) {
        if (options.signal?.aborted) throw abortError()
        if (visited.has(current)) throw new ImageMirrorError('Provider redirect loop exceeded', 'provider-refusal', { refusal: true })
        visited.add(current)
        const response = await requestOnce(current, { ...options, timeoutMs, cleanupMs, requestImpl, lookupImpl, onConnect: details => options.onConnect?.(details), maxBytes })
        if (!response.location) return response
        if (hop === redirectLimit) throw new ImageMirrorError('Provider redirect limit exceeded', 'provider-refusal', { refusal: true })
        current = options.onRedirect?.(response.location) ?? response.location
      }
    },
  }
}
