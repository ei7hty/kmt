import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { Inventory } from './inventory.mjs'
import { ImagePublication, imageDirectoryForDatabase, verifyImageDecisions } from './image-publication.mjs'
import { sha256Bytes, imageStorageKey } from './image-assets.mjs'
import { IMAGE_PILOT_POLICY } from './image-provider-profile.mjs'
import { runImageStagingWithInjectedTransport } from './image-staging-coordinator.mjs'
import { createImageApi } from './image-api.mjs'
import { createCatalogApi, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'
import { decoderPython, realImageFixtures } from './fixtures/image-provider/decoder-fixtures.mjs'
import { IMAGE_SELECTION_TAG, supplierImageRevision } from './image-manifest.mjs'
import { importProductImages } from '../scripts/import-product-images.mjs'
import { importImageFiles } from '../scripts/import-images.mjs'
import { sealImagePacket } from '../scripts/seal-image-packet.mjs'

/**
 * The first genuine end-to-end proof of the image acquisition pipeline:
 * real bytes, over a real TLS connection to a real local fixture server,
 * decoded by the real isolated Python subprocess, staged content-addressed
 * with hash-chained provenance, sealed and imported into a real
 * Inventory-backed database, approved through the owner's own decision
 * function, and served back out over a real HTTP connection -- compared
 * byte-for-byte against what the fixture server actually sent.
 *
 * Every piece here was already unit-tested in isolation. None of them had
 * ever run together, against real bytes, before this file. FIXTURES ONLY --
 * the server below is a local, self-signed, loopback-only stand-in; nothing
 * here or anywhere in this repository contacts a real host.
 */

const images = realImageFixtures()
// Test-only certificate and key generated locally, not credentials for any service.
const cert = readFileSync(new URL('./fixtures/image-provider/cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/image-provider/key.pem', import.meta.url))

// cert.pem's own SAN is DNS:cdn.example.test only -- TLS hostname
// verification fails against any other name, found by running this, not by
// reading the fixture: a first draft used a made-up hostname and got
// ERR_TLS_CERT_ALTNAME_INVALID. Using the name the cert actually names.
const HOST = 'cdn.example.test'
const PRODUCT_HOST = 'fixture-shop.test'

/**
 * A real local HTTPS server, and the dual-lookup wiring
 * backend/image-provider.test.mjs already established as correct for
 * exercising real TLS over loopback: `lookupImpl` reports a fake PUBLIC
 * address so `assertSafeResolvedAddress` is satisfied honestly, while
 * `requestImpl` wraps the real `https.request` and privately routes the
 * actual socket to the fixture server's real loopback address. Neither
 * hook lies to the caller about what it is doing -- the safety check sees
 * exactly what `lookupImpl` reports, and the socket goes exactly where
 * `requestImpl` sends it, same as production; only the SOURCE of those two
 * facts is test-controlled.
 */
async function fixtureServer(t, handler) {
  const requests = []
  const server = createHttpsServer({ cert, key }, (req, res) => { requests.push(req.url); handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))

  const requestImpl = (options, callback) => httpsRequest({ ...options, port: server.address().port, ca: cert,
    lookup(host, lookupOptions, done) {
      options.lookup(host, lookupOptions, (error, addresses, family) => {
        if (error) return done(error)
        if (lookupOptions.all) return done(null, addresses.map(entry => ({ address: entry.family === 6 ? '::1' : '127.0.0.1', family: entry.family })))
        done(null, '127.0.0.1', family)
      })
    },
  }, callback)
  const lookupImpl = (_host, _options, done) => done(null, [{ address: '8.8.8.8', family: 4 }])

  return { requestImpl, lookupImpl, requests, port: server.address().port }
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'kmt-pipeline-e2e-'))
  t.after(async () => {
    // A sqlite WAL-mode database's file handle is not always released the
    // instant .close() returns on Windows -- found running this file, not a
    // hypothetical: the pipeline itself ran and passed every assertion,
    // then rm() alone hit EBUSY on the very next tick. A short retry is the
    // honest fix (the lock really does clear almost immediately); silently
    // swallowing the error would risk masking a real leak instead.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { await rm(root, { recursive: true, force: true }); return }
      catch (error) { if (attempt === 5 || error.code !== 'EBUSY') throw error; await new Promise(resolve => setTimeout(resolve, 100 * attempt)) }
    }
  })
  return root
}

/**
 * The one tire row this packet is for -- shaped exactly like a real catalog
 * row, since `supplierImageRevision` hashes the row canonically and
 * `parseImagePacket` (backend/image-manifest.mjs) checks that hash against
 * the candidate's own `revision` field. A first draft used a bare literal
 * ('revision-1') and `parseImagePacket` refused it outright: this field is
 * not free text, it is a derived digest of the row it describes.
 */
// Inventory.validateTire requires the id to start with 'giga-' -- found by
// running it, not by reading the schema in advance.
const TIRE_ROW = { id: 'giga-fixture-0', name: 'Fixture Tire', size: '215/60R16', price: 80, inStock: true,
  category: 'All Season', description: '<p>Fixture</p>', source: { sku: 'sku-0', url: `https://${PRODUCT_HOST}/product/0` } }

/**
 * The full v2 pilot-packet shape parseImagePacket actually validates --
 * matching backend/image-publication.test.mjs's own packetFor() helper,
 * which already gets this right. A first, simpler hand-rolled snapshot
 * (a bare revision string, empty observations, a sparse enrichedRows) built
 * fine and staged fine -- deriveStagingSnapshot only needs the five
 * candidate fields -- but failed at sealing, where the full shape is
 * checked. Staging and sealing check different things; passing the first
 * does not mean the second will.
 */
function writePacket(directory, { host = HOST, path: imagePath = '/photo/fixture-0' } = {}) {
  const productUrl = TIRE_ROW.source.url
  const originalUrl = `https://${host}${imagePath}`
  const candidate = { supplierId: TIRE_ROW.id, supplierSku: TIRE_ROW.source.sku, productUrl, originalUrl, revision: supplierImageRevision(TIRE_ROW) }
  const snapshot = {
    version: 2,
    candidates: [candidate],
    provenance: { codeSha: 'a'.repeat(40), seed: 1, inputDigest: 'b'.repeat(64), mappingDigest: 'c'.repeat(64),
      selection: IMAGE_SELECTION_TAG, productHosts: [PRODUCT_HOST], imageHosts: [host],
      observations: [{ supplierId: candidate.supplierId, requestedUrl: productUrl, finalUrl: productUrl, sku: candidate.supplierSku, size: TIRE_ROW.size, listingUrl: productUrl }] },
    enrichedRows: [{ ...TIRE_ROW, source: { sku: candidate.supplierSku, url: productUrl }, imageUrls: [originalUrl] }],
  }
  const profile = { version: 1, providerId: 'offline-fixture', allowedHosts: [host, PRODUCT_HOST].sort(), policy: structuredClone(IMAGE_PILOT_POLICY) }
  return Promise.all([
    writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot)),
    writeFile(path.join(directory, 'profile.json'), JSON.stringify(profile)),
  ])
}

/**
 * The owner's screen, wired the same way backend/server.mjs actually mounts
 * it. Returns its own `close()` rather than registering a `t.after` for it:
 * a Windows sqlite WAL sidecar file was found (by running this, not by
 * anticipating it) to stay locked well past a `t.after` cleanup's implicit
 * ordering, and closing the server that HOLDS the database reference
 * explicitly, before the test body ends, is the actual fix -- an ordering
 * assumption about multiple t.after callbacks is not.
 */
async function ownerServer(t, images, inventory) {
  const password = 'fixture-e2e-owner-password'
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: password }))
  const handler = createImageApi(images, auth), catalog = createCatalogApi(inventory)
  const server = createHttpServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, 'http://localhost'), readJsonBody)) return
    if (await handler(req, res) || await catalog(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const close = () => new Promise(resolve => server.close(resolve))
  t.after(close) // best-effort safety net if the test throws before the explicit call
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  return { base, cookie: login.headers.get('set-cookie').split(';')[0], close }
}

/**
 * Fetch, decode, stage and seal one real image -- the first half of the
 * pipeline, shared by the happy path and every mutation test below so each
 * one starts from a genuinely staged-and-sealed packet rather than a
 * shortcut that only looks like one. Returns the sealed packet directory
 * and digest, plus the fixture server (still running, so a mutation test
 * can assert on how many requests it actually received) and the extracted,
 * already-proven-byte-identical bytes.
 */
async function stageAndSeal(t, { confirmHosts } = {}) {
  const server = await fixtureServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(images.png)
  })

  const packetDirectory = await workspace(t)
  await writePacket(packetDirectory)
  const stagingDirectory = await workspace(t)

  const staged = await importProductImages(
    { packetDirectory, stagingDirectory, confirmHosts: confirmHosts ?? [HOST, PRODUCT_HOST], python: decoderPython },
    { run: input => runImageStagingWithInjectedTransport(input, { requestImpl: server.requestImpl, lookupImpl: server.lookupImpl }) },
  )

  const stagedCandidate = staged.states[0]
  assert.equal(stagedCandidate.sha256, sha256Bytes(images.png), 'the staged content address is the real fixture bytes\' own hash')
  const stagedFile = path.join(stagingDirectory, imageStorageKey(stagedCandidate.sha256, 'png'))
  // The staged object is a container, not raw bytes -- a 4-byte big-endian
  // metadata length, that many bytes of canonical JSON metadata, then the
  // image bytes (backend/image-staging.mjs's put()). A first draft compared
  // the raw file against images.png directly and failed on the metadata
  // prefix; parsing the container the same way verify() does is the actual
  // proof, not a workaround for a format I hadn't accounted for.
  const container = await readFile(stagedFile)
  const metadataLength = container.readUInt32BE(0)
  const stagedBytes = container.subarray(4 + metadataLength)
  assert.deepEqual(stagedBytes, images.png, 'the bytes on disk after staging are byte-identical to what the fixture server sent -- checked before trusting them as input to anything else')

  // sealImagePacket reads its binding path as a RAW file and hashes it
  // directly (scripts/seal-image-packet.mjs) -- it knows nothing about the
  // staging container format, by design (it seals owner-supplied local
  // files too, which are never containers). Pointing it at the staged
  // container file itself would hash the container, not the image, and
  // mismatch the sha256 this binding declares. The extracted bytes -- the
  // exact ones already proven byte-identical to the fixture above -- go to
  // their own plain file instead.
  const extractedFile = path.join(stagingDirectory, 'extracted.png')
  await writeFile(extractedFile, stagedBytes)
  const bindingsFile = path.join(packetDirectory, 'bindings.json')
  await writeFile(bindingsFile, JSON.stringify([{ supplierId: TIRE_ROW.id, format: 'png', path: extractedFile }]))
  const sealed = sealImagePacket(packetDirectory, bindingsFile)

  return { server, packetDirectory, stagingDirectory, staged, sealed, stagedBytes }
}

test('a real image travels the whole pipeline: fetch, decode, stage, seal, import, approve, serve -- byte-identical throughout', async t => {
  const { server, packetDirectory, sealed } = await stageAndSeal(t)
  assert.equal(server.requests.length, 1, 'exactly one real HTTP request reached the fixture server')
  assert.equal(sealed.count, 1)

  const inventoryDirectory = await workspace(t)
  const database = path.join(inventoryDirectory, 'owner.sqlite')
  const inventory = new Inventory(database, ['215/60R16'])
  // Inventory.validateSnapshot requires this literal source string -- not
  // arbitrary text -- confirmed by running it, not by guessing at the schema.
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-10T00:00:00Z', tires: [TIRE_ROW] })
  // Closed explicitly at the end of this test, in order, not via t.after --
  // see ownerServer's own comment on why.
  t.after(() => { try { inventory.close() } catch { /* already closed */ } })

  const imported = await importImageFiles({ database, packetDirectory, manifestDigest: sealed.manifestDigest, python: decoderPython })
  assert.equal(imported.action, 'imported'); assert.equal(imported.version, 1); assert.equal(imported.count, 1)
  assert.equal(inventory.catalog().filter(row => row.imageUrl).length, 0, 'not visible to a customer until the owner approves')

  // ------------------------------------------------------------------ approve
  const images_ = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python: decoderPython })
  const approved = images_.decide(imported.digest, { action: 'approved', expectedVersion: 1 }, 'owner:e2e-fixture')
  assert.equal(approved.version, 2)
  assert.equal(verifyImageDecisions(inventory.db).count, 2)
  const catalogRow = inventory.catalog().find(row => row.id === TIRE_ROW.id)
  assert.ok(catalogRow.imageUrl, 'now visible to a customer')

  // -------------------------------------------------------------------- serve
  const owner = await ownerServer(t, images_, inventory)
  const served = await fetch(owner.base + catalogRow.imageUrl)
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'image/png')
  const servedBytes = Buffer.from(await served.arrayBuffer())

  // --------------------------------------------------- the whole point of this file
  assert.equal(sha256Bytes(servedBytes), sha256Bytes(images.png),
    'byte-identical, end to end: fetched, decoded, staged, sealed, imported, approved, and served bytes all hash the same as the original fixture image')
  assert.deepEqual(servedBytes, images.png)

  // Explicit, ordered close -- see ownerServer's comment. The server holds
  // the only other reference to `inventory`'s connection; closing it first
  // means `inventory.close()` right after is the actual last user of the
  // file, not a race against a server still finishing a keep-alive socket.
  await owner.close()
  inventory.close()
})

// ------------------------------------------------------- the five mutations

test('MUTATION 1: a byte-corrupted asset is caught by sha256, isolated from the separate "does it even decode" check', async t => {
  const { packetDirectory, sealed } = await stageAndSeal(t)
  // sealImagePacket names the sealed asset file by its own real content
  // hash (scripts/seal-image-packet.mjs's `write(name, bytes)`, name =
  // `${sha256}.${format}`) -- replacing its content after the fact makes
  // the FILENAME lie about the CONTENT.
  //
  // Flipping a single byte was the first draft, and mutation-testing this
  // test itself caught the flaw: disabling image-publication.mjs:162's
  // sha256 check on the production line left this test GREEN anyway,
  // because flipping a trailing byte usually breaks PNG decoding outright
  // -- "too easy" in exactly the shape the standing warning named. Chasing
  // the actual reason surfaced something better than a fixed test: THREE
  // INDEPENDENT LAYERS each verify the byte hash before this can be
  // imported (image-publication.mjs:162 before ever calling storage.put;
  // image-staging.mjs's put() re-checks before writing; its own verify()
  // re-checks AGAIN after writing, reading the file back). Disabling one,
  // then two, still left this test green; only disabling all three made it
  // fail. Swapping in a DIFFERENT, genuinely valid, decodable PNG isolates
  // hash mismatch from decode failure -- decoding succeeds, format still
  // matches, only the content address is wrong -- and mutation-testing all
  // three real guards, one at a time and then together, is what this test
  // now actually proves: not "a check exists" but "three do, independently."
  const differentValidPng = realImageFixtures()['valid-png-RGBA']
  assert.notEqual(sha256Bytes(differentValidPng), sha256Bytes(images.png), 'sanity: genuinely different bytes')
  const assetPath = path.join(packetDirectory, `${sha256Bytes(images.png)}.png`)
  await writeFile(assetPath, differentValidPng)

  const inventoryDirectory = await workspace(t)
  const database = path.join(inventoryDirectory, 'owner.sqlite')
  const inventory = new Inventory(database, ['215/60R16'])
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-10T00:00:00Z', tires: [TIRE_ROW] })
  t.after(() => { try { inventory.close() } catch { /* already closed */ } })

  await assert.rejects(() => importImageFiles({ database, packetDirectory, manifestDigest: sealed.manifestDigest, python: decoderPython }))
  assert.equal(inventory.catalog().filter(row => row.imageUrl).length, 0, 'the corrupted bytes never became a catalog image')
  inventory.close()
})

test('MUTATION 2: a host outside the confirmed allowlist is refused before any fetch is attempted', async t => {
  const server = await fixtureServer(t, () => assert.fail('the fixture server must never receive a request for an unconfirmed host'))
  const packetDirectory = await workspace(t)
  await writePacket(packetDirectory)
  const stagingDirectory = await workspace(t)

  // profile.allowedHosts (written by writePacket) is [HOST, PRODUCT_HOST].
  // Confirming only PRODUCT_HOST is a caller who reviewed a different host
  // list than the packet actually declares -- assertReviewedHosts
  // (scripts/import-product-images.mjs) must catch this before run() is
  // ever called, not after a fetch already happened.
  await assert.rejects(() => importProductImages(
    { packetDirectory, stagingDirectory, confirmHosts: [PRODUCT_HOST], python: decoderPython },
    { run: () => { assert.fail('run() must never be called -- the host mismatch has to refuse before the transport is even built') } },
  ), /not the hosts/)
  assert.equal(server.requests.length, 0, 'zero real requests reached the fixture server')
})

test('MUTATION 3: approving with no owner session is refused, the same gate every owner route uses', async t => {
  const { sealed, packetDirectory } = await stageAndSeal(t)
  const inventoryDirectory = await workspace(t)
  const database = path.join(inventoryDirectory, 'owner.sqlite')
  const inventory = new Inventory(database, ['215/60R16'])
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-10T00:00:00Z', tires: [TIRE_ROW] })
  t.after(() => { try { inventory.close() } catch { /* already closed */ } })
  const imported = await importImageFiles({ database, packetDirectory, manifestDigest: sealed.manifestDigest, python: decoderPython })

  const images_ = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python: decoderPython })
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'fixture-e2e-owner-password' }))
  const handler = createImageApi(images_, auth)
  const server = createHttpServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, 'http://localhost'), readJsonBody)) return
    if (await handler(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  // No cookie at all -- the same 401 gate createImageApi puts in front of
  // every /api/owner/images route, not a separate, weaker check written
  // just for approval.
  const response = await fetch(`${base}/api/owner/images/${imported.digest}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ action: 'approved', expectedVersion: 1 }),
  })
  assert.equal(response.status, 401)
  assert.equal(inventory.catalog().filter(row => row.imageUrl).length, 0, 'refused before anything changed')
  await new Promise(resolve => server.close(resolve))
  inventory.close()
})

test('MUTATION 4: a stale expectedVersion is a version conflict, and never overwrites the successful approval', async t => {
  const { sealed, packetDirectory } = await stageAndSeal(t)
  const inventoryDirectory = await workspace(t)
  const database = path.join(inventoryDirectory, 'owner.sqlite')
  const inventory = new Inventory(database, ['215/60R16'])
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-10T00:00:00Z', tires: [TIRE_ROW] })
  t.after(() => { try { inventory.close() } catch { /* already closed */ } })
  const imported = await importImageFiles({ database, packetDirectory, manifestDigest: sealed.manifestDigest, python: decoderPython })

  const images_ = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python: decoderPython })
  const first = images_.decide(imported.digest, { action: 'approved', expectedVersion: 1 }, 'owner:e2e-fixture')
  assert.equal(first.version, 2)
  const catalogAfterFirst = inventory.catalog().find(row => row.id === TIRE_ROW.id).imageUrl
  assert.ok(catalogAfterFirst)

  // expectedVersion:1 a second time -- stale the instant the first call
  // succeeded and bumped the row to version 2. This second call uses
  // action:'revoked', not 'approved' again: decide()'s refusal is really two
  // ORed conditions (stale version OR wrong state-machine transition), and
  // current.action is now 'approved', so a repeated 'approved' call trips the
  // transition check (it requires 'imported') regardless of version -- that
  // shape was checked and confirmed to pass even with the version check
  // disabled, which is exactly the false-confirmation this harness is
  // supposed to catch. 'revoked' is a VALID transition from 'approved', so
  // this call is refused (or not) on the stale version alone.
  assert.throws(() => images_.decide(imported.digest, { action: 'revoked', expectedVersion: 1 }, 'owner:e2e-fixture'))
  const catalogAfterStale = inventory.catalog().find(row => row.id === TIRE_ROW.id).imageUrl
  assert.equal(catalogAfterStale, catalogAfterFirst, 'the stale call did nothing -- the image URL is exactly what the first, successful approval set')
  assert.equal(verifyImageDecisions(inventory.db).count, 2, 'the rejected call appended no decision -- the chain has only the ingest and the one real approval')
  inventory.close()
})

test('MUTATION 5 (verified by forcing the documented interruption path, not by inspection alone): an aborted publish never leaves a partial asset readable', async t => {
  // backend/image-staging.mjs's put() documents its own atomicity boundary:
  // "Synchronous linearization: abort cannot be delivered between [the
  // no-clobber check] and no-clobber publication" -- meaning an abort
  // BEFORE that point must leave nothing at the canonical path, and this
  // is the one real interruption mechanism put() actually exposes (a
  // process kill mid-write is what coordinator-worker.mjs/
  // staging-worker.mjs already exist to test, for the STAGING coordinator,
  // not this storage primitive). Forcing it directly here rather than
  // reasoning about the comment.
  const { createImageStagingStorage } = await import('./image-staging.mjs')
  const directory = await workspace(t)
  const storage = createImageStagingStorage({ directory, storeId: 'e2e-mutation-5' })
  const bytes = images.png
  const sha256 = sha256Bytes(bytes)
  const controller = new AbortController()
  // Aborted before the call even starts: the earliest possible interruption,
  // and the clearest test that NOTHING can be observed at the canonical
  // path afterward.
  controller.abort()

  // Every field a real publish needs, not a stripped-down input -- otherwise
  // the rejection could come from metadata() refusing an incomplete shape
  // (it does, unconditionally, regardless of the signal) rather than from
  // the abort actually being honored. Checked by disabling checkSignal()
  // entirely: with the fields stripped, this assertion still passed.
  await assert.rejects(() => storage.put({ bytes, sha256, format: 'png', storageKey: imageStorageKey(sha256, 'png'),
    width: 4, height: 3, contentType: 'image/png', ifAbsent: true, signal: controller.signal }))
  const canonicalPath = path.join(directory, imageStorageKey(sha256, 'png'))
  await assert.rejects(() => readFile(canonicalPath), /ENOENT/, 'no file exists at the canonical path -- an aborted publish is invisible, not partial')

  // A second, real publish of the SAME content afterward must still work --
  // an aborted attempt must not leave the store in a state that blocks a
  // later, real one.
  const second = await storage.put({ bytes, sha256, format: 'png', storageKey: imageStorageKey(sha256, 'png'), width: 4, height: 3, contentType: 'image/png', ifAbsent: true })
  assert.equal(second.sha256, sha256)
  const read = storage.read({ storageKey: second.storageKey, storageUrl: second.storageUrl, sha256, format: 'png',
    contentType: 'image/png', width: 4, height: 3, byteLength: bytes.length })
  assert.deepEqual(read.bytes, bytes, 'the real publish that follows an aborted one is intact and byte-identical')
})
