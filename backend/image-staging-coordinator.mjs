import { DatabaseSync } from 'node:sqlite'
import { openSync, closeSync, lstatSync, realpathSync, mkdirSync } from 'node:fs'
import { join, isAbsolute, parse, relative, sep, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertAllowedImageUrl, createImageAssetRepository, reconcileImageCandidates, sha256Bytes } from './image-assets.mjs'
import { createImageStagingStorage } from './image-staging.mjs'
import { createIsolatedImageDecoder } from './image-decoder.mjs'
import { compileImageProviderProfile, assertApprovedImagePlan, IMAGE_EXECUTION_ENABLED } from './image-provider-profile.mjs'
import { createImageRunProvenance, verifyImageRunProvenance } from './image-run-provenance.mjs'
import { createSafeImageFetcher, mirrorRemoteImages, ImageMirrorError } from '../scripts/image-mirror.mjs'

const refused = () => new Error('Image staging plan refused')
const outcome = value => typeof value === 'string' && /^[a-z-]{1,64}$/.test(value) ? value : 'failed'
const keys = (value, expected) => value && Object.keys(value).sort().join(',') === expected.sort().join(',')

function privateDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw refused()
  const root = resolve(directory)
  const protectedParts = new Set(['public', 'dist', 'data', 'deploy', 'production'])
  if (root.split(sep).some(part => protectedParts.has(part.toLowerCase()))) throw refused()
  let current = parse(root).root
  for (const part of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw refused() }
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused()
    if (realpathSync(current).split(sep).some(piece => protectedParts.has(piece.toLowerCase()))) throw refused()
  }
  return realpathSync(root)
}

function planFrom({ profile: rawProfile, snapshotBytes, expectedSnapshotDigest }) {
  const profile = compileImageProviderProfile(rawProfile)
  if (!(snapshotBytes instanceof Uint8Array) || !snapshotBytes.length || snapshotBytes.length > 1024 * 1024) throw refused()
  const snapshot = Buffer.from(snapshotBytes)
  const snapshotDigest = sha256Bytes(snapshot)
  if (snapshotDigest !== expectedSnapshotDigest) throw refused()
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot))
  if (!keys(data, ['version', 'candidates']) || data.version !== 1 || !Array.isArray(data.candidates) || data.candidates.length !== 5) throw refused()
  const ids = new Set()
  for (const item of data.candidates) {
    if (!keys(item, ['supplierId', 'supplierSku', 'productUrl', 'originalUrl', 'revision'])) throw refused()
    for (const field of ['supplierId', 'supplierSku', 'revision']) {
      if (typeof item[field] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item[field])) throw refused()
    }
    if (ids.has(item.supplierId)) throw refused()
    ids.add(item.supplierId)
    for (const field of ['productUrl', 'originalUrl']) {
      if (typeof item[field] !== 'string' || item[field].length > 4096 || new URL(item[field]).hash ||
          assertAllowedImageUrl(item[field], profile.allowedHosts) !== item[field]) throw refused()
    }
    Object.freeze(item)
  }
  return Object.freeze({ profile, snapshotDigest, snapshot, candidates: Object.freeze(data.candidates), ids: Object.freeze([...ids]) })
}

/** Production activation deliberately has no executable path in this revision. */
export function prepareApprovedImageStagingRun(input) {
  let plan
  try { plan = planFrom(input) } catch { throw refused() }
  assertApprovedImagePlan(plan.profile, plan.snapshotDigest, plan.ids)
  if (!IMAGE_EXECUTION_ENABLED) throw new Error('Image execution disabled pending independent review')
  throw new Error('Provider execution wiring requires a separately reviewed activation change')
}

/** The sole executable coordinator is a .test-only, byte-fixture harness.
 * It cannot take a transport, database handle/path, repository or network callback.
 * Real profiles never enter this path. Source snapshot bytes remain private.
 */
export async function runOfflineImageStagingFixtures(input) {
  try { return await runFixtures({ ...input }) } catch (error) {
    if (/^Offline staging run interrupted \([a-f0-9-]{36}\); inspect private provenance$/.test(error.message)) throw error
    throw refused()
  }
}

async function runFixtures(input) {
  const plan = planFrom(input)
  if (!plan.profile.allowedHosts.every(host => host.endsWith('.test'))) throw refused()
  if (!(input.fixtures instanceof Map) || input.fixtures.size > 25) throw refused()
  const fixtures = new Map()
  for (const [url, fixture] of input.fixtures) {
    assertAllowedImageUrl(url, plan.profile.allowedHosts)
    if (!fixture || !keys(fixture, ['status', 'contentType', 'bytes', 'redirect']) ||
        !Number.isInteger(fixture.status) || fixture.status < 100 || fixture.status > 599 ||
        typeof fixture.contentType !== 'string' || fixture.contentType.length > 128 ||
        !(fixture.bytes instanceof Uint8Array) || fixture.bytes.length > plan.profile.policy.maxBytes + 1 ||
        fixture.redirect !== null && (typeof fixture.redirect !== 'string' || fixture.redirect.length > 4096)) throw refused()
    fixtures.set(url, Object.freeze({ ...fixture, bytes: Buffer.from(fixture.bytes) }))
  }
  const inspect = createIsolatedImageDecoder({ python: input.python, memoryBytes: plan.profile.policy.memoryBytes })
  const runId = randomUUID()
  // Walk and validate every ancestor before creating descendants; storage is lazy.
  // The caller must supply an operator-controlled private directory/Windows ACL.
  const storage = createImageStagingStorage({ directory: input.directory, storeId: 'offline-image-pilot' })
  const root = privateDirectory(input.directory, true), identity = lstatSync(root)
  const assertRoot = () => {
    const stat = lstatSync(input.directory)
    if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino || privateDirectory(input.directory) !== root) throw refused()
  }
  assertRoot()
  const databasePath = join(root, `${runId}.sqlite`)
  closeSync(openSync(databasePath, 'wx', 0o600))
  assertRoot()
  const db = new DatabaseSync(databasePath)
  let log, closed = false
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
    db.exec(`CREATE TABLE supplier (id TEXT PRIMARY KEY);
      CREATE TABLE image_snapshot (digest TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE TRIGGER snapshot_no_update BEFORE UPDATE ON image_snapshot BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
      CREATE TRIGGER snapshot_no_delete BEFORE DELETE ON image_snapshot BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;`)
    db.prepare('INSERT INTO image_snapshot VALUES (?, ?)').run(plan.snapshotDigest, plan.snapshot)
    for (const item of plan.candidates) db.prepare('INSERT INTO supplier VALUES (?)').run(item.supplierId)
    reconcileImageCandidates(db, plan.candidates.map(item => ({ id: item.supplierId,
      source: { sku: item.supplierSku, url: item.productUrl, fetchedAt: item.revision }, imageUrls: [item.originalUrl],
    })), { allowedHosts: plan.profile.allowedHosts })
    const repository = createImageAssetRepository(db)
    db.exec(`CREATE TRIGGER staging_no_approval BEFORE UPDATE OF usage_status ON image_assets
      WHEN NEW.usage_status <> 'candidate' BEGIN SELECT RAISE(ABORT, 'staging never approves'); END;`)
    log = createImageRunProvenance(db, { runId, profileDigest: plan.profile.digest, snapshotDigest: plan.snapshotDigest })
    log.append('run-start', { policy: plan.profile.policy, selected: plan.ids })
    const candidates = repository.list()
    if (candidates.length !== 5 || candidates.some(row => row.usageStatus !== 'candidate')) throw refused()
    let current
    const controller = new AbortController()
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    const append = (type, fields) => {
      try { assertRoot(); log.append(type, { candidateId: current?.id, ...fields }) }
      catch (error) { controller.abort(); throw error }
    }
    const transport = { fetch: async (originalUrl, options) => {
      // Shared URLs are legal; select by the serial candidate cursor below.
      current = candidates[cursor++]
      append('candidate-start', { supplierId: current.supplierId, supplierSku: current.supplierSku,
        revision: current.candidateRevision, sourceUrl: current.productUrl, originalUrl })
      let url = originalUrl
      const visited = new Set()
      for (;;) {
        options.signal?.throwIfAborted()
        if (visited.has(url)) throw new ImageMirrorError('Offline redirect loop', 'provider-refusal', { refusal: true })
        visited.add(url)
        append('connect', { finalUrl: url, address: '93.184.216.34' })
        // Synthetic public DNS assertion only. No socket or resolver is created.
        options.onConnect({ url, address: '93.184.216.34' })
        const fixture = fixtures.get(url)
        if (!fixture) throw new Error('Offline fixture missing')
        append('response', { finalUrl: url, status: fixture.status, sha256: sha256Bytes(fixture.bytes), bytes: fixture.bytes.length })
        if (fixture.status >= 300 && fixture.status < 400 && fixture.redirect) {
          const next = new URL(fixture.redirect, url).href
          append('redirect', { finalUrl: url, redirectUrl: next })
          options.onRedirect(next)
          url = next
          continue
        }
        return { status: fixture.status, headers: { 'content-type': fixture.contentType }, finalUrl: url, bytes: fixture.bytes }
      }
    } }
    let cursor = 0
    const tracedRepository = {
      findByHash: repository.findByHash,
      recordStored: (id, asset, expected) => {
        append('commit-intent', { sha256: asset.sha256 })
        const result = repository.recordStored(id, asset, expected)
        append('commit-result', { sha256: asset.sha256, outcome: result.status })
        return result
      },
      recordFailure: (id, failure, expected) => {
        append('candidate-failure', { outcome: outcome(failure.state) })
        return repository.recordFailure(id, { ...failure, message: 'Offline image candidate refused' }, expected)
      },
    }
    const result = await mirrorRemoteImages(candidates, {
      ...plan.profile.policy, allowedHosts: plan.profile.allowedHosts, dryRun: false, delayMs: 0,
      fetcher: createSafeImageFetcher(transport, plan.profile), repository: tracedRepository, storage,
      signal,
      inspectImage: async (bytes, options) => {
        const details = await inspect(bytes, options)
        append('decoded', { sha256: sha256Bytes(bytes), bytes: bytes.length, width: details.width, height: details.height, format: details.format })
        return details
      },
    })
    if (controller.signal.aborted) throw refused()
    // Reconcile SQL truth even if acknowledgment failed after COMMIT. Read-only.
    const states = repository.list().map(row => Object.freeze({ candidateId: row.id, supplierId: row.supplierId,
      sha256: row.sha256, usageStatus: row.usageStatus, outcome: row.sha256 ? 'stored' : outcome(row.failureState ?? 'not-attempted') }))
    log.append('run-end', { outcome: result.stoppedOnRefusal ? 'provider-refusal' : input.signal?.aborted ? 'aborted' : 'completed', selected: states })
    const integrity = verifyImageRunProvenance(db)
    db.close(); closed = true
    // No source URLs, storage locators, raw errors or private database path leave this API.
    return Object.freeze({ runId, profileDigest: plan.profile.digest, snapshotDigest: plan.snapshotDigest,
      selected: 5, attempted: result.attempted, stored: result.stored, deduped: result.deduped,
      failed: result.failures.length, stoppedOnRefusal: result.stoppedOnRefusal, integrity, states: Object.freeze(states) })
  } catch {
    try { log?.append('run-interrupted', { outcome: 'failed' }) } catch { /* leave incomplete prefix for review */ }
    throw new Error(`Offline staging run interrupted (${runId}); inspect private provenance`)
  } finally { if (!closed) db.close() }
}
