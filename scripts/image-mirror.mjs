import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { sha256Bytes } from '../backend/image-assets.mjs'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_WIDTH = 10_000
const DEFAULT_MAX_HEIGHT = 10_000
const IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const REFUSAL_MARKERS = [
  'access denied', 'request could not be satisfied', 'forbidden', 'too many requests',
  'temporarily blocked', 'captcha', 'verify human', 'robot check', 'robots.txt',
  'disallowed by robots', 'challenge',
]

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

async function responseBytes(response) {
  if (response?.bytes !== undefined) return bytesOf(response.bytes)
  if (response?.body !== undefined && typeof response.body !== 'function') return bytesOf(response.body)
  if (typeof response?.arrayBuffer === 'function') return bytesOf(await response.arrayBuffer())
  throw new ImageMirrorError('The image fetcher returned no response body', 'invalid-body')
}

function selectedCandidates(records) {
  if (!Array.isArray(records)) throw new TypeError('Image mirroring requires an array of records')
  return records.filter(record =>
    record && record.remoteImagePresent === true && typeof record.originalUrl === 'string' &&
    record.originalUrl && record.usageStatus !== 'approved')
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
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new ImageMirrorError(`Image request returned HTTP ${status || 'unknown'}`, 'http-error')
  }
}

function validateContentType(contentType) {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!IMAGE_TYPES.has(mediaType)) {
    throw new ImageMirrorError(`Unsupported image content type: ${contentType || 'missing'}`, 'wrong-content-type')
  }
  return mediaType
}

function validateDimensions(details, { maxWidth, maxHeight }) {
  if (!details || !Number.isInteger(details.width) || !Number.isInteger(details.height) ||
      details.width < 1 || details.height < 1) {
    throw new ImageMirrorError('Image dimensions are missing or invalid', 'invalid-dimensions')
  }
  if (details.width > maxWidth || details.height > maxHeight) {
    throw new ImageMirrorError(`Image dimensions exceed ${maxWidth}x${maxHeight}`, 'dimensions-too-large')
  }
  if (typeof details.format !== 'string' || !details.format.trim()) {
    throw new ImageMirrorError('Image format is missing', 'invalid-format')
  }
  return { width: details.width, height: details.height, format: details.format.toLowerCase() }
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
  delayMs = 1_500,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => new Date().toISOString(),
  provenance = 'supplier-product-page',
} = {}) {
  const candidates = selectedCandidates(records)
  if (dryRun) return { dryRun: true, selected: candidates.map(record => record.id), attempted: 0, stored: 0, deduped: 0, failures: [], stoppedOnRefusal: false }
  if (typeof fetcher !== 'function' || typeof inspectImage !== 'function' ||
      typeof repository?.recordStored !== 'function' || typeof repository?.recordFailure !== 'function' ||
      typeof storage?.findByHash !== 'function' || typeof storage?.put !== 'function') {
    throw new ImageMirrorError('Execution requires injected fetcher, inspector, repository, and storage adapters', 'configuration')
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer')

  const result = { dryRun: false, selected: candidates.map(record => record.id), attempted: 0, stored: 0, deduped: 0, failures: [], stoppedOnRefusal: false }
  for (const [index, record] of candidates.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs)
    result.attempted++
    try {
      const response = await fetcher(record.originalUrl)
      const preview = typeof response?.body === 'string' ? response.body : ''
      assertResponseAllowed(response, preview)
      const contentType = validateContentType(header(response, 'content-type'))
      const bytes = await responseBytes(response)
      if (refusalText(new TextDecoder().decode(bytes.slice(0, 8192)))) {
        throw new ImageMirrorError('Provider refusal or challenge detected; stopping image mirroring', 'provider-refusal', { refusal: true })
      }
      if (bytes.byteLength > maxBytes) throw new ImageMirrorError(`Image is ${bytes.byteLength} bytes; maximum is ${maxBytes}`, 'oversize')
      const details = validateDimensions(await inspectImage(bytes, { contentType, url: record.originalUrl }), { maxWidth, maxHeight })
      const sha256 = sha256Bytes(bytes)
      const existing = await storage.findByHash(sha256)
      let stored = existing
      if (existing) result.deduped++
      else {
        stored = await storage.put({ bytes, contentType, sha256, width: details.width, height: details.height, format: details.format })
        result.stored++
      }
      if (!stored?.storageKey || !stored?.storageUrl) throw new ImageMirrorError('Storage adapter did not return a durable key and URL', 'storage-error')
      const fetchedAt = now()
      repository.recordStored(record.id, {
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
      })
    } catch (error) {
      const failure = failureFor(error)
      repository.recordFailure(record.id, { state: failure.state, message: failure.message, at: now() })
      result.failures.push({ id: record.id, state: failure.state, message: failure.message })
      if (failure.refusal) {
        result.stoppedOnRefusal = true
        break
      }
    }
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
