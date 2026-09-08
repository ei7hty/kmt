import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assertAllowedImageUrl, assertSafeResolvedAddress, IMAGE_ASSET_FORMATS, IMAGE_ASSET_MIME_FORMATS, imageStorageKey, sha256Bytes } from '../backend/image-assets.mjs'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_WIDTH = 10_000
const DEFAULT_MAX_HEIGHT = 10_000
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const REFUSAL_MARKERS = [
  'access denied', 'request could not be satisfied', 'forbidden', 'too many requests',
  'temporarily blocked', 'captcha', 'verify human', 'robot check', 'robots.txt',
  'disallowed by robots', 'challenge',
]
const DEFAULT_MAX_REDIRECTS = 3

export class ImageMirrorError extends Error {
  constructor(message, state = 'mirror-error', { refusal = false } = {}) {
    super(message)
    this.name = 'ImageMirrorError'
    this.state = state
    this.refusal = refusal
  }
}

function header(response, name) {
  const headers = response?.headers
  if (!headers) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  return value === undefined ? '' : String(value)
}

function statusOf(response) {
  const status = typeof response?.status === 'function' ? response.status() : response?.status
  return Number(status)
}

function refusalText(value) {
  if (typeof value !== 'string') return false
  const lower = value.toLowerCase()
  return REFUSAL_MARKERS.some(marker => lower.includes(marker))
}

function bytesOf(body) {
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new ImageMirrorError('The image fetcher returned no byte array', 'invalid-body')
}

function oversize(size, maxBytes) {
  return new ImageMirrorError(`Image exceeds the ${maxBytes}-byte limit`, 'oversize')
}

/**
 * Wrap a low-level transport so every redirect and resolved address is
 * authorized before the transport is allowed to connect. The transport must
 * call onRedirect before following a hop and onConnect after DNS resolution
 * but before opening the socket.
 */
export function createSafeImageFetcher(transport, { allowedHosts, allowedPorts = [443], maxRedirects = DEFAULT_MAX_REDIRECTS } = {}) {
  if (!transport || typeof transport.fetch !== 'function') throw new TypeError('A transport with fetch() is required')
  const safe = async (url, options = {}) => {
    const effectiveMaxRedirects = Number.isInteger(options.maxRedirects)
      ? Math.min(maxRedirects, options.maxRedirects) : maxRedirects
    const authorizeUrl = nextUrl => {
      try { return assertAllowedImageUrl(nextUrl, allowedHosts, { allowedPorts }) }
      catch (error) { throw new ImageMirrorError(`Image transport destination refused: ${error.message}`, 'provider-refusal', { refusal: true }) }
    }
    authorizeUrl(url)
    return transport.fetch(url, {
      ...options,
      maxRedirects: effectiveMaxRedirects,
      onRedirect: nextUrl => authorizeUrl(nextUrl),
      onConnect: ({ url: connectedUrl, address }) => {
        authorizeUrl(connectedUrl)
        try { return assertSafeResolvedAddress(address) }
        catch (error) { throw new ImageMirrorError(`Image transport address refused: ${error.message}`, 'provider-refusal', { refusal: true }) }
      },
    })
  }
  safe.safeTransport = true
  return safe
}

function waitWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value)
  if (signal.aborted) return Promise.reject(new ImageMirrorError('Image mirror deadline exceeded', 'timeout'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ImageMirrorError('Image mirror deadline exceeded', 'timeout'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function responseBytes(response, maxBytes, signal) {
  if (response?.bytes !== undefined) {
    const bytes = bytesOf(response.bytes)
    if (bytes.byteLength > maxBytes) throw oversize(bytes.byteLength, maxBytes)
    return bytes
  }
  const body = response?.body
  if (typeof body === 'string') {
    const bytes = new TextEncoder().encode(body)
    if (bytes.byteLength > maxBytes) throw oversize(bytes.byteLength, maxBytes)
    return bytes
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const part = await waitWithAbort(reader.read(), signal)
        if (part.done) break
        const bytes = bytesOf(part.value)
        total += bytes.byteLength
        if (total > maxBytes) {
          await reader.cancel('image exceeds configured byte limit')
          throw oversize(total, maxBytes)
        }
        chunks.push(bytes)
      }
    } catch (error) {
      if (signal?.aborted) await reader.cancel('image mirror deadline exceeded').catch(() => {})
      throw error
    } finally { reader.releaseLock?.() }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let total = 0
    const iterator = body[Symbol.asyncIterator]()
    let completed = false
    try {
      while (true) {
        const part = await waitWithAbort(iterator.next(), signal)
        if (part.done) { completed = true; break }
        const bytes = bytesOf(part.value)
        if (bytes.byteLength === 0) continue
        total += bytes.byteLength
        if (total > maxBytes) throw oversize(total, maxBytes)
        chunks.push(bytes)
      }
    } finally {
      if (!completed) {
        try { void iterator.return?.() } catch { /* best-effort cancellation */ }
      }
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  }
  if (typeof response?.arrayBuffer === 'function') {
    // A bare arrayBuffer response cannot be bounded while reading. Its
    // adapter must prove the declared length first and pass the cap at fetch.
    throw new ImageMirrorError('The image fetcher must expose a bounded byte array or stream', 'unbounded-body')
  }
  throw new ImageMirrorError('The image fetcher returned no response body', 'invalid-body')
}

function selectedCandidates(records) {
  if (!Array.isArray(records)) throw new TypeError('Image mirroring requires an array of records')
  return records.filter(record =>
    record && record.remoteImagePresent === true && typeof record.originalUrl === 'string' &&
    record.originalUrl && record.usageStatus === 'candidate' && record.sourceCurrent !== false)
}

function finalUrl(response) {
  const value = response?.finalUrl ?? response?.url
  if (typeof value !== 'string' || !value) throw new ImageMirrorError('The image fetcher must expose its final URL', 'missing-final-url')
  return value
}

function failureFor(error) {
  if (error instanceof ImageMirrorError) return error
  return new ImageMirrorError(error?.message || 'Image fetch failed', 'fetch-error')
}

function assertResponseAllowed(response, bodyPreview = '') {
  const status = statusOf(response)
  if (status === 403 || status === 429) {
    throw new ImageMirrorError(`Provider refused image request (${status})`, `provider-${status}`, { refusal: true })
  }
  if (response?.refused === true || response?.robotsRefused === true ||
      refusalText(response?.refusalReason) || refusalText(bodyPreview)) {
    throw new ImageMirrorError('Provider refusal or challenge detected; stopping image mirroring', 'provider-refusal', { refusal: true })
  }
  const encoding = header(response, 'content-encoding').trim().toLowerCase()
  if (encoding && encoding !== 'identity') throw new ImageMirrorError(`Unsupported image content encoding: ${encoding}`, 'wrong-content-encoding')
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new ImageMirrorError(`Image request returned HTTP ${status || 'unknown'}`, 'http-error')
  }
}

function validateContentType(contentType) {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!IMAGE_TYPES.has(mediaType)) {
    throw new ImageMirrorError(`Unsupported image content type: ${contentType || 'missing'}`, 'wrong-content-type')
  }
  return { mediaType, format: IMAGE_ASSET_MIME_FORMATS[mediaType] }
}

function validateDimensions(details, { maxWidth, maxHeight, maxPixels }) {
  if (!details || !Number.isInteger(details.width) || !Number.isInteger(details.height) ||
      details.width < 1 || details.height < 1) {
    throw new ImageMirrorError('Image dimensions are missing or invalid', 'invalid-dimensions')
  }
  if (details.width > maxWidth || details.height > maxHeight) {
    throw new ImageMirrorError(`Image dimensions exceed ${maxWidth}x${maxHeight}`, 'dimensions-too-large')
  }
  if (details.width * details.height > maxPixels) {
    throw new ImageMirrorError(`Image pixel count exceeds ${maxPixels}`, 'dimensions-too-large')
  }
  if (typeof details.format !== 'string' || !details.format.trim()) {
    throw new ImageMirrorError('Image format is missing', 'invalid-format')
  }
  const format = details.format.toLowerCase().trim().replace(/^image\//, '')
  if (!IMAGE_ASSET_FORMATS.includes(format) || /[\\/:.]/.test(format)) {
    throw new ImageMirrorError(`Image format is not canonical: ${details.format}`, 'invalid-format')
  }
  return { width: details.width, height: details.height, format }
}

/**
 * Mirror remote candidates one at a time. No network implementation is
 * provided here on purpose: callers must inject a fetcher, image inspector,
 * repository, and durable storage adapter. The default is an offline dry run.
 */
export async function mirrorRemoteImages(records, {
  fetcher,
  inspectImage,
  repository,
  storage,
  dryRun = true,
  maxBytes = DEFAULT_MAX_BYTES,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
  maxPixels = DEFAULT_MAX_WIDTH * DEFAULT_MAX_HEIGHT,
  maxFrames = 1,
  maxDecodeMs = 5_000,
  delayMs = 1_500,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(),
  provenance = 'supplier-product-page',
  allowedHosts = [],
  allowedPorts = [443],
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = 30_000,
} = {}) {
  const candidates = selectedCandidates(records)
  if (dryRun) return { dryRun: true, selected: candidates.map(record => record.id), attempted: 0, stored: 0, deduped: 0, conflicts: 0, stale: 0, failures: [], stoppedOnRefusal: false }
  if (typeof fetcher !== 'function' || typeof inspectImage !== 'function' ||
      fetcher.safeTransport !== true ||
      typeof repository?.findByHash !== 'function' || typeof repository?.recordStored !== 'function' ||
      typeof repository?.recordFailure !== 'function' || typeof storage?.put !== 'function') {
    throw new ImageMirrorError('Execution requires injected fetcher, inspector, repository, and storage adapters', 'configuration')
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer')
  if (!Number.isInteger(maxWidth) || maxWidth < 1 || !Number.isInteger(maxHeight) || maxHeight < 1 ||
      !Number.isInteger(maxPixels) || maxPixels < 1) throw new TypeError('Image dimensions and pixel limits must be positive integers')
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new TypeError('maxFrames must be a positive integer')
  if (!Number.isInteger(maxDecodeMs) || maxDecodeMs < 1) throw new TypeError('maxDecodeMs must be a positive integer')
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw new TypeError('maxRedirects must be an integer from 0 through 10')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer')

  const result = { dryRun: false, selected: candidates.map(record => record.id), attempted: 0, stored: 0, deduped: 0, conflicts: 0, stale: 0, failures: [], stoppedOnRefusal: false }
  for (const [index, record] of candidates.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs)
    result.attempted++
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let originalUrl
      try { originalUrl = assertAllowedImageUrl(record.originalUrl, allowedHosts, { allowedPorts }) }
      catch (error) { throw new ImageMirrorError(error.message, 'invalid-destination') }
      const authorizeTransportUrl = nextUrl => {
        try { return assertAllowedImageUrl(nextUrl, allowedHosts, { allowedPorts }) }
        catch (error) { throw new ImageMirrorError(`Image transport destination refused: ${error.message}`, 'provider-refusal', { refusal: true }) }
      }
      const authorizeTransportAddress = ({ url, address }) => {
        authorizeTransportUrl(url)
        try { return assertSafeResolvedAddress(address) }
        catch (error) { throw new ImageMirrorError(`Image transport address refused: ${error.message}`, 'provider-refusal', { refusal: true }) }
      }
      const response = await waitWithAbort(fetcher(originalUrl, {
        maxBytes, maxRedirects, signal: controller.signal, onRedirect: authorizeTransportUrl, onConnect: authorizeTransportAddress,
      }), controller.signal)
      const preview = typeof response?.body === 'string' ? response.body : ''
      assertResponseAllowed(response, preview)
      const resolvedUrl = finalUrl(response)
      try { assertAllowedImageUrl(resolvedUrl, allowedHosts, { allowedPorts }) } catch (error) {
        throw new ImageMirrorError(`Provider redirect refused: ${error.message}`, 'provider-refusal', { refusal: true })
      }
      const declaredLength = Number(header(response, 'content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw oversize(declaredLength, maxBytes)
      const bytes = await responseBytes(response, maxBytes, controller.signal)
      if (refusalText(new TextDecoder().decode(bytes.slice(0, 8192)))) {
        throw new ImageMirrorError('Provider refusal or challenge detected; stopping image mirroring', 'provider-refusal', { refusal: true })
      }
      if (bytes.byteLength > maxBytes) throw new ImageMirrorError(`Image is ${bytes.byteLength} bytes; maximum is ${maxBytes}`, 'oversize')
      const { mediaType, format: mimeFormat } = validateContentType(header(response, 'content-type'))
      const details = validateDimensions(await waitWithAbort(inspectImage(bytes, {
        contentType: mediaType, url: resolvedUrl, signal: controller.signal, maxPixels, maxFrames, maxDecodeMs,
      }), controller.signal), { maxWidth, maxHeight, maxPixels })
      if (details.format !== mimeFormat) throw new ImageMirrorError(`MIME ${mediaType} does not match decoded ${details.format}`, 'format-mismatch')
      const sha256 = sha256Bytes(bytes)
      const existing = await waitWithAbort(repository.findByHash(sha256), controller.signal)
      let stored = existing
      if (!existing) {
        const storageKey = imageStorageKey(sha256, details.format)
        stored = await waitWithAbort(storage.put({ bytes, contentType: mediaType, sha256, width: details.width, height: details.height, format: details.format, storageKey, ifAbsent: true, signal: controller.signal }), controller.signal)
      }
      if (typeof stored?.storageKey !== 'string' || typeof stored?.storageUrl !== 'string' ||
          stored.storageKey !== imageStorageKey(sha256, details.format) ||
          stored.sha256 !== sha256 || stored.format !== details.format) {
        throw new ImageMirrorError('Storage adapter returned untrusted content-addressed metadata', 'storage-error')
      }
      const fetchedAt = now()
      const commit = await waitWithAbort(repository.recordStored(record.id, {
        originalUrl: record.originalUrl,
        storageKey: stored.storageKey,
        storageUrl: stored.storageUrl,
        sha256,
        bytes: bytes.byteLength,
        width: details.width,
        height: details.height,
        format: details.format,
        fetchedAt,
        storedAt: now(),
        provenance,
        usageStatus: 'candidate',
      }, {
        supplierId: record.supplierId, supplierSku: record.supplierSku,
        originalUrl: record.originalUrl, revision: record.candidateRevision,
      }), controller.signal)
      if (commit?.status === 'approved-conflict') { result.conflicts = (result.conflicts ?? 0) + 1; continue }
      if (commit?.status === 'stale-conflict') { result.stale = (result.stale ?? 0) + 1; continue }
      if (commit?.status !== 'stored') throw new ImageMirrorError('Repository did not confirm the stored asset', 'repository-error')
      if (existing) result.deduped++
      else result.stored++
    } catch (error) {
      const failure = failureFor(error)
      await waitWithAbort(repository.recordFailure(record.id, { state: failure.state, message: failure.message, at: now() }, {
        supplierId: record.supplierId, supplierSku: record.supplierSku,
        originalUrl: record.originalUrl, revision: record.candidateRevision,
      }), controller.signal).catch(() => {})
      result.failures.push({ id: record.id, state: failure.state, message: failure.message })
      if (failure.refusal) {
        result.stoppedOnRefusal = true
        break
      }
    } finally { clearTimeout(deadline) }
  }
  return result
}

export async function runOfflineMirrorFile(file, options = {}) {
  const records = JSON.parse(await readFile(file, 'utf8'))
  return mirrorRemoteImages(records, options)
}

function cliOptions(argv) {
  const inputIndex = argv.indexOf('--input')
  const file = inputIndex >= 0 ? argv[inputIndex + 1] : null
  return { file, execute: argv.includes('--execute') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { file, execute } = cliOptions(process.argv.slice(2))
  if (!file) {
    console.log('Image mirroring is disabled by default. Pass --input <local-json> for an offline dry run.')
  } else if (execute) {
    console.error('Execution is unavailable from the CLI until a provider fetcher and durable storage adapter are explicitly wired.')
    process.exitCode = 2
  } else {
    const result = await runOfflineMirrorFile(file)
    console.log(JSON.stringify(result))
  }
}
