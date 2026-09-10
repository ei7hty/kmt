import { DatabaseSync } from 'node:sqlite'
import { openSync, closeSync, lstatSync, realpathSync, mkdirSync } from 'node:fs'
import { join, isAbsolute, parse, relative, sep, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertAllowedImageUrl, createImageAssetRepository, reconcileImageCandidates, sha256Bytes } from './image-assets.mjs'
import { createImageStagingStorage } from './image-staging.mjs'
import { createIsolatedImageDecoder } from './image-decoder.mjs'
import { compileImageProviderProfile } from './image-provider-profile.mjs'
import { createImageRunProvenance, verifyImageRunProvenance } from './image-run-provenance.mjs'
import { createSafeImageFetcher, mirrorRemoteImages, ImageMirrorError } from '../scripts/image-mirror.mjs'
import { createHttpsImageTransport } from '../scripts/image-provider.mjs'

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
  // The candidate ceiling used to be checked by `assertApprovedImagePlan`, which
  // is gone with the PROJECT MANAGER approval registry. It is not an approval
  // detail: `candidateLimit` is the politeness budget -- at `delayMs` 1500 a run
  // of 250 is about six minutes of traffic against somebody else's server -- and
  // the snapshot byte cap alone would let a snapshot ask for thousands.
  if (!keys(data, ['version', 'candidates']) || data.version !== 1 || !Array.isArray(data.candidates) ||
      !data.candidates.length || data.candidates.length > profile.policy.candidateLimit) throw refused()
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

const interrupted = (label, runId) => `${label} staging run interrupted (${runId}); inspect private provenance`
const wasInterrupted = (label, message) =>
  new RegExp(`^${label} staging run interrupted \\([a-f0-9-]{36}\\); inspect private provenance$`).test(message)

// One run identifier survives a failure -- it names the private provenance
// database to inspect. Everything else about a refusal stays inside.
async function runThroughMode(input, mode) {
  try { return await runStaging({ ...input }, mode) } catch (error) {
    if (wasInterrupted(mode.label, error.message)) throw error
    throw refused()
  }
}

/** The provider run: the real HTTPS transport, the profile's own pacing.
 * There is no approval registry in front of this any more -- the owner ruled
 * that approval lives in the owner screen -- and that is not a gate removed so
 * much as a gate moved to where it can be operated. Staging only ever stores
 * candidates: the `staging_no_approval` trigger installed below makes a staging
 * database structurally unable to approve anything, and `image-publication.mjs`
 * holds the owner's approve/revoke decision. Nothing this function stores can
 * reach a customer until the owner approves it there.
 */
export async function runApprovedImageStaging(input) {
  return runThroughMode(input, PROVIDER_MODE)
}

/** The offline coordinator: a .test-only, byte-fixture harness.
 * It cannot take a transport, database handle/path, repository or network callback.
 * Real profiles never enter this path. Source snapshot bytes remain private.
 */
export async function runOfflineImageStagingFixtures(input) {
  return runThroughMode(input, FIXTURE_MODE)
}

// A real transport is the network, not the provenance log: `createHttpsImageTransport`
// calls `onConnect` and `onRedirect` so the caller can authorize a hop, but it
// appends nothing. Wrap it so a provider run writes the same
// candidate-start/connect/redirect/response trail the fixture transport writes
// by hand. Appending never decides anything: every callback's return value and
// every throw reaches the inner transport unchanged, so the authorization
// `createSafeImageFetcher` performs still bites through this decorator.
//
// One event a fixture run has that a provider run cannot: the fixture transport
// appends a `response` for a 3xx hop because it sees the status. A real redirect
// surfaces only as `onRedirect(location)`, so a provider run marks each hop with
// its `connect`/`redirect` pair and records a `response` for the final one only.
export function provenanceTransport(inner, { advance, append }) {
  if (!inner || typeof inner.fetch !== 'function') throw refused()
  return { fetch: async (originalUrl, options = {}) => {
    const current = advance()
    append('candidate-start', { supplierId: current.supplierId, supplierSku: current.supplierSku,
      revision: current.candidateRevision, sourceUrl: current.productUrl, originalUrl })
    // The hop being left, for the redirect event: `onRedirect` is told where it
    // is going and not where it is coming from.
    let hopUrl = originalUrl
    const response = await inner.fetch(originalUrl, { ...options,
      onConnect: details => {
        hopUrl = details.url
        append('connect', { finalUrl: details.url, address: details.address })
        return options.onConnect?.(details)
      },
      onRedirect: next => {
        append('redirect', { finalUrl: hopUrl, redirectUrl: next })
        return options.onRedirect?.(next)
      },
    })
    append('response', { finalUrl: response.finalUrl, status: response.status,
      sha256: sha256Bytes(response.bytes), bytes: response.bytes.length })
    return response
  } }
}

// The provider mode: real HTTPS, the profile's pacing, and a refusal message
// that names no host. `prepare` refuses fixture input rather than ignoring it --
// a caller who passes a fixture Map believes they are running offline, and this
// mode is the network. The transport is built here, before any filesystem work,
// so a policy the transport will not accept fails before a database exists.
export const PROVIDER_MODE = {
  label: 'Provider',
  delayMs: plan => plan.profile.policy.delayMs,
  failureMessage: 'Image candidate refused',
  prepare(input, plan) {
    if (input.fixtures !== undefined) throw refused()
    const transport = createHttpsImageTransport({
      maxRedirects: plan.profile.policy.maxRedirects,
      timeoutMs: plan.profile.policy.timeoutMs,
    })
    return ({ advance, append }) => provenanceTransport(transport, { advance, append })
  },
}

/**
 * A DISTINCT export, not a parameter on `runApprovedImageStaging` or
 * `PROVIDER_MODE` -- deliberately. `runApprovedImageStaging`'s signature does
 * not change by one character here, so every existing production caller keeps
 * exactly the function it has today, and cannot be handed hooks by some future
 * refactor that looks harmless. A separate, deliberately ugly name is
 * greppable and assertable; an optional parameter on the main export is a
 * thing that slips in quietly.
 *
 * WHAT THIS ACTUALLY ADDS, SAID OUT LOUD: a DNS-rebinding-shaped affordance.
 * `lookupImpl` is told whatever address the caller wants `assertSafeResolvedAddress`
 * (backend/image-assets.mjs) to see, while `requestImpl` is free to route the
 * real socket somewhere else entirely -- structurally identical to what an
 * attacker does with DNS rebinding. This is shipped anyway because the
 * capability is INERT unless a caller supplies both hooks explicitly, no
 * server-reachable code ever does (proven by the boundary test in
 * backend/image-staging-coordinator.test.mjs, not asserted in a comment), and
 * the alternative -- proving the pipeline end to end by patching the safety
 * check itself, or by reimplementing its wiring in a parallel test harness
 * that could silently drift from the real thing -- is worse: one proves the
 * opposite of what it claims, the other is an instrument that can stop
 * meaning anything and never go red.
 *
 * The safety check itself is NEVER bypassed here, and this must never be the
 * change that makes it so: `assertSafeResolvedAddress` still fires on every
 * hop, through the exact same `onConnect` path `requestOnce` (scripts/image-
 * provider.mjs) already wires for the real mode -- it is satisfied honestly
 * by whatever `lookupImpl` reports, never skipped. If `lookupImpl` ever
 * reports a private/loopback/TEST-NET address, the run refuses exactly like
 * a real one would; a dedicated test proves this on the seam itself, not by
 * inspection.
 */
export async function runImageStagingWithInjectedTransport(input, { requestImpl, lookupImpl } = {}) {
  if (typeof requestImpl !== 'function' || typeof lookupImpl !== 'function') {
    throw new TypeError('runImageStagingWithInjectedTransport requires both requestImpl and lookupImpl')
  }
  const mode = {
    label: 'Provider (injected transport)',
    delayMs: plan => plan.profile.policy.delayMs,
    failureMessage: 'Image candidate refused',
    prepare(preparedInput, plan) {
      if (preparedInput.fixtures !== undefined) throw refused()
      const transport = createHttpsImageTransport({
        maxRedirects: plan.profile.policy.maxRedirects,
        timeoutMs: plan.profile.policy.timeoutMs,
        requestImpl,
        lookupImpl,
      })
      return ({ advance, append }) => provenanceTransport(transport, { advance, append })
    },
  }
  return runThroughMode(input, mode)
}

// The byte-fixture transport: the same request/redirect/response shape the real
// provider transport produces, served from a Map the caller supplied. It emits
// the provenance events by hand because it IS the transport layer here.
function offlineFixtureTransport(fixtures) {
  return ({ advance, append }) => ({ fetch: async (originalUrl, options) => {
    const current = advance()
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
  } })
}

// The fixture mode: `.test` hosts only, a bounded byte Map, no pacing, and a
// refusal message that never names a real provider because there was not one.
const FIXTURE_MODE = {
  label: 'Offline',
  delayMs: () => 0,
  failureMessage: 'Offline image candidate refused',
  prepare(input, plan) {
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
    return offlineFixtureTransport(fixtures)
  },
}

async function runStaging(input, mode) {
  const plan = planFrom(input)
  // Validated here rather than trusted: it reaches an append-only log.
  const sourceSnapshotDigest = input.sourceSnapshotDigest
  if (sourceSnapshotDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceSnapshotDigest)) throw refused()
  const buildTransport = mode.prepare(input, plan)
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
    // The snapshot staging verified is not always the snapshot a person
    // approved: a pilot packet carries version 2 and `planFrom` takes version
    // 1, so the caller derives one from the other and passes the original's
    // digest here. Recorded once, on run-start, beside the derived digest every
    // payload already carries -- so the chain reads approved -> converted ->
    // staged without anybody inferring the middle link. Absent when the caller
    // staged a snapshot it did not derive, which is the honest thing to record
    // for a run where no conversion happened.
    log.append('run-start', { policy: plan.profile.policy, selected: plan.ids,
      ...(sourceSnapshotDigest ? { sourceSnapshotDigest } : {}) })
    const candidates = repository.list()
    if (candidates.length !== plan.ids.length || candidates.some(row => row.usageStatus !== 'candidate')) throw refused()
    let current
    const controller = new AbortController()
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    const append = (type, fields) => {
      try { assertRoot(); log.append(type, { candidateId: current?.id, ...fields }) }
      catch (error) { controller.abort(); throw error }
    }
    let cursor = 0
    // Shared URLs are legal; select by the serial candidate cursor.
    const advance = () => { current = candidates[cursor++]; return current }
    const transport = buildTransport({ advance, append })
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
        return repository.recordFailure(id, { ...failure, message: mode.failureMessage }, expected)
      },
    }
    const result = await mirrorRemoteImages(candidates, {
      ...plan.profile.policy, allowedHosts: plan.profile.allowedHosts, dryRun: false, delayMs: mode.delayMs(plan),
      fetcher: createSafeImageFetcher(transport, plan.profile), repository: tracedRepository, storage,
      signal,
      inspectImage: async (bytes, options) => {
        const details = await inspect(bytes, options)
        append('decoded', { sha256: sha256Bytes(bytes), bytes: bytes.length, width: details.width, height: details.height, format: details.format,
          decoder: details.decoder, isolation: details.isolation, validation: details.validation })
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
      selected: plan.ids.length, attempted: result.attempted, stored: result.stored, deduped: result.deduped,
      failed: result.failures.length, stoppedOnRefusal: result.stoppedOnRefusal, integrity, states: Object.freeze(states) })
  } catch {
    try { log?.append('run-interrupted', { outcome: 'failed' }) } catch { /* leave incomplete prefix for review */ }
    throw new Error(interrupted(mode.label, runId))
  } finally { if (!closed) db.close() }
}
