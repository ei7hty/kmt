import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { ImagePublication, imageDirectoryForDatabase, verifyImageDecisions } from './image-publication.mjs'
import { IMAGE_SELECTION_TAG, parseImagePacket, supplierImageRevision } from './image-manifest.mjs'
import { sha256Bytes } from './image-assets.mjs'
import { IMAGE_PILOT_POLICY, compileImageProviderProfile } from './image-provider-profile.mjs'
import { createImageStagingStorage, createPrivateImageStorage } from './image-staging.mjs'
import { createImageApi } from './image-api.mjs'
import { createCatalogApi, readJsonBody, isPublicApiCall, isKnownApiPath } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'
import { decoderPython, realImageFixtures } from './fixtures/image-provider/decoder-fixtures.mjs'
import { importImageFiles, readPrivateImageInput } from '../scripts/import-images.mjs'
import { sealImagePacket } from '../scripts/seal-image-packet.mjs'

const fixtures = realImageFixtures()
const profile = { version: 1, providerId: 'fixture', allowedHosts: ['provider.test'], policy: IMAGE_PILOT_POLICY }
const baseRows = (count = 5) => Array.from({ length: count }, (_, i) => ({ id: `giga-fixture-${i}`, name: `Fixture ${i}`, size: '215/60R16', price: 80,
  inStock: true, category: 'All Season', description: '<p>Fixture</p>', source: { sku: `FIXTURE-${i}`, url: 'https://provider.test/listing' } }))
// `bytes` and `format` also take an array, one entry per row, for a packet whose
// assets are not all the same picture -- the only way a test can tell one
// ordinal's bytes from another's. A single value still means one shared image,
// which is what every caller below relies on.
function packetFor(rows, bytes = fixtures.png, format = 'png', seed = 1) {
  const bytesAt = i => (Array.isArray(bytes) ? bytes[i] : bytes)
  const formatAt = i => (Array.isArray(format) ? format[i] : format)
  const candidates = rows.map(row => ({ supplierId: row.id, supplierSku: row.source.sku, productUrl: `https://provider.test/product/${row.id}`,
    originalUrl: `https://provider.test/photo/${row.id}`, revision: supplierImageRevision(row) }))
  const snapshot = { version: 2, candidates, provenance: { codeSha: 'a'.repeat(40), seed, inputDigest: 'b'.repeat(64), mappingDigest: 'c'.repeat(64),
    selection: IMAGE_SELECTION_TAG, productHosts: ['provider.test'], imageHosts: ['provider.test'],
    observations: candidates.map((c, i) => ({ supplierId: c.supplierId, requestedUrl: c.productUrl, finalUrl: c.productUrl, sku: c.supplierSku, size: rows[i].size, listingUrl: rows[i].source.url })) },
  enrichedRows: candidates.map((c, i) => ({ ...rows[i], source: { sku: c.supplierSku, url: c.productUrl }, imageUrls: [c.originalUrl] })) }
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot))
  const manifest = { version: 1, profileDigest: compileImageProviderProfile(profile).digest, snapshotDigest: sha256Bytes(snapshotBytes),
    assets: candidates.map((c, i) => ({ supplierId: c.supplierId, sha256: sha256Bytes(bytesAt(i)), format: formatAt(i) })) }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const fileFor = i => `${sha256Bytes(bytesAt(i))}.${formatAt(i)}`
  return { input: { manifestBytes, snapshotBytes, profileBytes: Buffer.from(JSON.stringify(profile)), expectedManifestDigest: sha256Bytes(manifestBytes) },
    files: new Map(candidates.map((c, i) => [fileFor(i), bytesAt(i)])), url: `/api/images/${fileFor(0)}`, snapshot, manifest }
}
async function setup(t, count = 5) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kmt-publication-'))
  const database = path.join(directory, 'owner.sqlite'), rows = baseRows(count)
  const inventory = new Inventory(database, ['215/60R16'])
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-08T00:00:00Z', tires: rows })
  const images = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python: decoderPython })
  const cleanup = []
  t.after(async () => { for (const close of cleanup) await close(); try { inventory.close() } catch { /* reopened fixture */ } await rm(directory, { recursive: true, force: true }) })
  return { directory, database, inventory, images, rows, cleanup, packet: packetFor(rows) }
}
const approve = (images, digest) => images.decide(digest, { action: 'approved', expectedVersion: 1 }, 'owner:fixture')

// The same mounting the server uses: auth first, then the image handler, then
// the customer catalog. Returns a signed-in cookie so a test can ask the same
// URL with and without one.
async function ownerServer(t, images, inventory) {
  const password = 'fixture-image-owner-password'
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: password }))
  const handler = createImageApi(images, auth), catalog = createCatalogApi(inventory)
  const server = createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, 'http://localhost'), readJsonBody)) return
    if (await handler(req, res) || await catalog(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  return { base, cookie: login.headers.get('set-cookie').split(';')[0] }
}

test('real fixture import stays pending; explicit approval serves exact bytes; revoke and retry cannot reactivate', async t => {
  const { inventory, images, packet } = await setup(t)
  const before = inventory.db.prepare('SELECT * FROM supplier').all()
  const imported = await images.ingest(packet.input, packet.files)
  assert.equal(imported.action, 'imported'); assert.equal(imported.version, 1)
  assert.equal(inventory.catalog().filter(t => t.imageUrl).length, 0)
  assert.throws(() => images.readPublic(packet.url))
  assert.equal(approve(images, imported.digest).version, 2)
  assert.equal(inventory.catalog().filter(t => t.imageUrl === packet.url).length, 5)
  assert.deepEqual(images.readPublic(packet.url).bytes, fixtures.png)
  assert.deepEqual(inventory.db.prepare('SELECT * FROM supplier').all(), before)
  assert.throws(() => approve(images, imported.digest))
  images.decide(imported.digest, { action: 'revoked', expectedVersion: 2 }, 'owner:fixture')
  assert.equal(inventory.catalog().filter(t => t.imageUrl).length, 0)
  assert.throws(() => images.readPublic(packet.url))
  assert.equal((await images.ingest(packet.input, packet.files)).action, 'revoked')
  assert.equal(verifyImageDecisions(inventory.db).count, 3)
})

test('same store and approval survive reopen on a volume-shaped data path', async t => {
  const f = await setup(t)
  const digest = (await f.images.ingest(f.packet.input, f.packet.files)).digest
  approve(f.images, digest); f.inventory.close()
  const reopened = new Inventory(f.database, ['215/60R16'])
  f.cleanup.push(() => reopened.close())
  const images = new ImagePublication(reopened, { directory: imageDirectoryForDatabase(f.database) })
  assert.deepEqual(images.readPublic(f.packet.url).bytes, fixtures.png)
  const volume = path.join(f.directory, 'data', 'catalog-images-private')
  assert.throws(() => createImageStagingStorage({ directory: volume, storeId: 'fixture' }))
  const storage = createPrivateImageStorage({ directory: volume })
  const sha256 = sha256Bytes(fixtures.png)
  const saved = await storage.put({ sha256, format: 'png', contentType: 'image/png', storageKey: `images/${sha256}.png`, width: 4, height: 3, bytes: fixtures.png, ifAbsent: true })
  assert.deepEqual(createPrivateImageStorage({ directory: volume }).read({ ...saved, byteLength: saved.bytes }).bytes, fixtures.png)
})

test('packet digest, order, exact-five, profile, source revision and format fail before object publication', async t => {
  const { images, packet, directory } = await setup(t)
  const variants = [
    { ...packet.input, expectedManifestDigest: '0'.repeat(64) },
    { ...packet.input, snapshotBytes: Buffer.concat([packet.input.snapshotBytes, Buffer.from(' ')]) },
  ]
  for (const input of variants) await assert.rejects(images.ingest(input, packet.files))
  for (const change of [m => m.assets.pop(), m => m.assets.reverse(), m => m.assets[0].format = 'svg', m => m.profileDigest = '0'.repeat(64)]) {
    const manifest = structuredClone(packet.manifest); change(manifest)
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    await assert.rejects(images.ingest({ ...packet.input, manifestBytes, expectedManifestDigest: sha256Bytes(manifestBytes) }, packet.files))
  }
  const stale = packetFor(baseRows().map(row => ({ ...row, price: 81 })))
  await assert.rejects(images.ingest(stale.input, stale.files))
  assert.equal(images.list().length, 0)
  await assert.rejects(readFile(path.join(directory, 'catalog-images-private', '.kmt-image-staging.json')), { code: 'ENOENT' })
})

test('malformed real image and wrong local file hash create no packet or public map', async t => {
  const { images, rows, inventory } = await setup(t)
  const malformed = packetFor(rows, Buffer.concat([fixtures.jpeg.subarray(0, -7), Buffer.from([255, 217])]), 'jpeg')
  await assert.rejects(images.ingest(malformed.input, malformed.files))
  const valid = packetFor(rows)
  await assert.rejects(images.ingest(valid.input, new Map([[[...valid.files.keys()][0], fixtures.jpeg]])))
  assert.equal(images.list().length, 0); assert.equal(inventory.catalog().filter(t => t.imageUrl).length, 0)
})

test('source changes hide photos; shared hash remains available until every eligible offer disappears', async t => {
  const { images, inventory, packet, rows } = await setup(t)
  approve(images, (await images.ingest(packet.input, packet.files)).digest)
  const change = { ...rows[0], price: 90 }
  inventory.db.prepare('UPDATE supplier SET payload=? WHERE id=?').run(JSON.stringify(change), change.id)
  assert.equal(inventory.catalog().filter(t => t.imageUrl).length, 4)
  assert.deepEqual(images.readPublic(packet.url).bytes, fixtures.png)
  inventory.db.prepare('UPDATE supplier SET active=0').run()
  assert.equal(inventory.catalog().filter(t => t.imageUrl).length, 0)
  assert.throws(() => images.readPublic(packet.url))
})

test('disabled offers deny content; stale supplier prevents atomic all-five approval', async t => {
  const { images, inventory, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  inventory.db.prepare('UPDATE supplier SET active=0 WHERE id=?').run('giga-fixture-4')
  assert.throws(() => approve(images, digest))
  assert.equal(inventory.db.prepare('SELECT count(*) n FROM image_publications').get().n, 0)
  inventory.db.prepare('UPDATE supplier SET active=1').run()
  approve(images, digest)
  inventory.db.exec(`INSERT INTO offers(id,enabled,updated_at) SELECT id,0,'fixture' FROM supplier`)
  assert.equal(inventory.catalog().length, 0); assert.throws(() => images.readPublic(packet.url))
})

test('corrupt/missing bytes and symlink paths fail closed; immutable provenance refuses edits', async t => {
  const { images, inventory, packet, directory, cleanup } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  for (const table of ['image_packets', 'image_packet_assets', 'image_decisions']) {
    assert.throws(() => inventory.db.exec(`DELETE FROM ${table}`), /immutable/)
  }
  const file = path.join(images.storage.root, 'images', [...packet.files.keys()][0])
  const bytes = await readFile(file)
  await writeFile(file, bytes.subarray(0, -1))
  assert.throws(() => approve(images, digest))
  await writeFile(file, bytes); approve(images, digest)
  await unlink(file); assert.throws(() => images.readPublic(packet.url))
  const outside = path.join(directory, 'other'); await mkdir(outside)
  const linked = path.join(directory, 'link'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  cleanup.push(() => unlink(linked))
  const storage = createPrivateImageStorage({ directory: path.join(linked, 'catalog-images-private') })
  assert.throws(() => storage.read({}))
  assert.throws(() => readPrivateImageInput(path.join(linked, 'x'), 100))
})

test('HTTP auth and strict origin guard owner decisions; public bytes have safe headers and no conditional bypass', async t => {
  const { images, inventory, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  const password = 'fixture-image-owner-password'
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: password }))
  const handler = createImageApi(images, auth), catalog = createCatalogApi(inventory)
  const server = createServer(async (req, res) => {
    if (await auth.handle(req, res, new URL(req.url, 'http://localhost'), readJsonBody)) return
    if (await handler(req, res) || await catalog(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const owner = `/api/owner/images/${digest}`
  assert.equal((await fetch(base + owner)).status, 401)
  const login = await fetch(base + '/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const post = (origin, action = 'approved', expectedVersion = 1) => fetch(base + owner, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ action, expectedVersion }) })
  assert.equal((await post()).status, 403); assert.equal((await post('https://foreign.test')).status, 403)
  assert.equal((await fetch(base + packet.url)).status, 404)
  assert.equal((await post(base)).status, 200)
  const response = await fetch(base + packet.url)
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtures.png)
  for (const [key, value] of [['content-type', 'image/png'], ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'], ['cross-origin-resource-policy', 'same-origin']]) assert.equal(response.headers.get(key), value)
  const cat = await fetch(base + '/api/catalog'); assert.equal(cat.headers.get('cache-control'), 'no-store')
  const json = await cat.text(); assert.ok(!json.includes('provider.test') && !json.includes('storageUrl') && !json.includes('sku'))
  assert.equal((await fetch(base + packet.url, { method: 'HEAD' })).status, 200)
  assert.equal((await post(base, 'revoked', 2)).status, 200)
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + packet.url, { method, headers: { 'If-None-Match': '*' } })).status, 404)
  assert.equal((await fetch(base + packet.url + '?x=1')).status, 404)
  assert.equal(isPublicApiCall('GET', packet.url), true); assert.equal(isKnownApiPath(packet.url), true)
  assert.equal(isPublicApiCall('POST', packet.url), false); assert.equal(isKnownApiPath('/api/images/../../owner.sqlite'), false)
})

test('local seal/import operator path verifies hashes and never mutates supplier rows', async t => {
  const { directory, database, inventory, rows, packet } = await setup(t)
  const privatePacket = path.join(directory, 'packet'); await mkdir(privatePacket)
  await writeFile(path.join(privatePacket, 'snapshot.json'), packet.input.snapshotBytes)
  await writeFile(path.join(privatePacket, 'profile.json'), packet.input.profileBytes)
  const image = path.join(directory, 'fixture.png'); await writeFile(image, fixtures.png)
  const bindings = path.join(directory, 'bindings.json')
  await writeFile(bindings, JSON.stringify(rows.map(row => ({ supplierId: row.id, format: 'png', path: image }))))
  const { manifestDigest } = sealImagePacket(privatePacket, bindings)
  assert.equal(parseImagePacket(packet.input).manifest.digest, manifestDigest)
  const before = inventory.db.prepare('SELECT * FROM supplier').all()
  const result = await importImageFiles({ database, packetDirectory: privatePacket, manifestDigest, python: decoderPython })
  assert.deepEqual(result, { digest: manifestDigest, version: 1, action: 'imported', count: 5 })
  assert.deepEqual(inventory.db.prepare('SELECT * FROM supplier').all(), before)
})

test('supplier change during decoder work prevents commit; unchanged retry recovers private orphan objects', async t => {
  const { images, inventory, packet } = await setup(t)
  const row = inventory.db.prepare('SELECT * FROM supplier WHERE id=?').get('giga-fixture-4')
  const pending = images.ingest(packet.input, packet.files)
  const changed = JSON.parse(row.payload); changed.price++
  inventory.db.prepare('UPDATE supplier SET payload=? WHERE id=?').run(JSON.stringify(changed), row.id)
  await assert.rejects(pending)
  assert.equal(images.list().length, 0); assert.throws(() => images.readPublic(packet.url))
  inventory.db.prepare('UPDATE supplier SET payload=? WHERE id=?').run(row.payload, row.id)
  assert.equal((await images.ingest(packet.input, packet.files)).action, 'imported')
})

test('provenance commit failure rolls back the entire packet; retry does not implicitly approve', async t => {
  const { images, inventory, packet } = await setup(t)
  inventory.db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON image_decisions BEGIN SELECT RAISE(ABORT, 'fixture crash boundary'); END")
  await assert.rejects(images.ingest(packet.input, packet.files))
  assert.equal(images.list().length, 0)
  assert.equal(inventory.db.prepare('SELECT count(*) n FROM image_packet_assets').get().n, 0)
  inventory.db.exec('DROP TRIGGER fixture_fail')
  assert.equal((await images.ingest(packet.input, packet.files)).action, 'imported')
  assert.throws(() => images.readPublic(packet.url))
})

// The owner approval screen used to draw a grey placeholder for anything not
// yet approved, because no owner-scoped route for the bytes existed: he was
// asked to approve photos he could not see. These two tests hold the route
// that fixes it, and the line the fix must not cross -- an owner preview must
// not make unapproved bytes publicly reachable.
test('the owner previews an unapproved packet; nobody else can, and the public route still refuses it', async t => {
  const { images, inventory, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  const { base, cookie } = await ownerServer(t, images, inventory)
  const asset = index => `${base}/api/owner/images/${digest}/assets/${index}`

  // Signed out: 401, and not one byte of the image.
  const anonymous = await fetch(asset(0))
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('content-type'), 'application/json')
  const refused = Buffer.from(await anonymous.arrayBuffer())
  assert.ok(!refused.includes(fixtures.png.subarray(0, 16)), 'the refusal must carry no image bytes')

  // The security line: an owner route for unapproved bytes must not open the
  // public one. Both the HTTP path and the projection behind it still refuse.
  assert.equal((await fetch(base + packet.url)).status, 404)
  assert.throws(() => images.readPublic(packet.url))
  assert.equal(inventory.catalog().filter(row => row.imageUrl).length, 0)

  // The defect itself: a packet still waiting on him shows its real photo.
  const preview = await fetch(asset(0), { headers: { Cookie: cookie } })
  assert.equal(preview.status, 200)
  assert.equal(images.review(digest).action, 'imported')
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), fixtures.png)
  for (const [key, value] of [['content-type', 'image/png'], ['content-length', String(fixtures.png.length)],
    ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
    ['cross-origin-resource-policy', 'same-origin'], ['content-disposition', 'inline'],
    ['content-security-policy', "default-src 'none'; sandbox"]]) assert.equal(preview.headers.get(key), value)

  // An ordinal past the end of the packet is a 404, and so is a digest with no
  // packet at all. Nothing anywhere declares how many assets a packet may have.
  assert.equal((await fetch(asset(5), { headers: { Cookie: cookie } })).status, 404)
  assert.equal((await fetch(asset(99), { headers: { Cookie: cookie } })).status, 404)
  assert.equal((await fetch(`${base}/api/owner/images/${'0'.repeat(64)}/assets/0`, { headers: { Cookie: cookie } })).status, 404)
  assert.throws(() => images.readOwnerAsset(digest, 5))
  assert.throws(() => images.readOwnerAsset(digest, -1))
  assert.throws(() => images.readOwnerAsset('not-a-digest', 0))

  // Approve, then take it down. Looking back at what was revoked is the other
  // half of reviewing: the bytes come back for the owner and stay gone publicly.
  approve(images, digest)
  assert.equal((await fetch(asset(0), { headers: { Cookie: cookie } })).status, 200)
  images.decide(digest, { action: 'revoked', expectedVersion: 2 }, 'owner:fixture')
  const revoked = await fetch(asset(0), { headers: { Cookie: cookie } })
  assert.equal(revoked.status, 200)
  assert.deepEqual(Buffer.from(await revoked.arrayBuffer()), fixtures.png)
  assert.equal(revoked.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(base + packet.url)).status, 404)
})

test('a six-photo packet previews its sixth photo: the packet bounds the ordinal, nothing else does', async t => {
  const { images, inventory, rows } = await setup(t, 6)
  // The last asset is a JPEG so ordinal 5 is distinguishable from 0-4 by bytes
  // and by Content-Type -- a route capped at five would answer 404 here, and a
  // route that quietly served the wrong row would answer with PNG.
  const bytes = rows.map((_, i) => (i === 5 ? fixtures.jpeg : fixtures.png))
  const formats = rows.map((_, i) => (i === 5 ? 'jpeg' : 'png'))
  const packet = packetFor(rows, bytes, formats, 6)
  const imported = await images.ingest(packet.input, packet.files)
  assert.equal(imported.assets.length, 6)
  // Left imported on purpose: approval is a separate gate with its own count
  // rule, and previewing is exactly the thing that has to work before it.
  const { base, cookie } = await ownerServer(t, images, inventory)
  const asset = index => fetch(`${base}/api/owner/images/${imported.digest}/assets/${index}`, { headers: { Cookie: cookie } })

  const sixth = await asset(5)
  assert.equal(sixth.status, 200)
  assert.equal(sixth.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await sixth.arrayBuffer()), fixtures.jpeg)
  const first = await asset(0)
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), fixtures.png)
  assert.equal((await asset(6)).status, 404)
  assert.deepEqual(images.readOwnerAsset(imported.digest, 5).bytes, fixtures.jpeg)
})

// --- eligibility: the same refusal decide() throws, named ahead of the click ---
//
// The defect this exists for: the owner screen offered Approve on every
// imported packet regardless of whether decide() would actually accept it, so
// pressing it was the only way to learn a packet was blocked. These mirror
// decide()'s own checks (see `approvalIssues`) rather than re-deriving them,
// so a preview that disagrees with the enforcement is not a risk this file
// can silently grow.

test('a clean imported packet is eligible to approve, with no issues to explain', async t => {
  const { images, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  const reviewed = images.review(digest)
  assert.equal(reviewed.eligibility.approve, true)
  assert.deepEqual(reviewed.eligibility.issues, [])
})

test('a delisted supplier blocks approval and names which one, before decide() is ever called', async t => {
  const { images, inventory, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  inventory.db.prepare('UPDATE supplier SET active=0 WHERE id=?').run('giga-fixture-4')
  const reviewed = images.review(digest)
  assert.equal(reviewed.eligibility.approve, false)
  assert.ok(reviewed.eligibility.issues.some(issue => issue.includes('giga-fixture-4')), 'names the blocked row')
  // The preview and the enforcement must actually agree.
  assert.throws(() => approve(images, digest))
})

test('a supplier tire that changed since import blocks approval', async t => {
  const { images, inventory, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  const row = inventory.db.prepare('SELECT payload FROM supplier WHERE id=?').get('giga-fixture-2')
  const tire = JSON.parse(row.payload)
  inventory.db.prepare('UPDATE supplier SET payload=? WHERE id=?').run(JSON.stringify({ ...tire, price: tire.price + 5 }), 'giga-fixture-2')
  const reviewed = images.review(digest)
  assert.equal(reviewed.eligibility.approve, false)
  assert.ok(reviewed.eligibility.issues.some(issue => issue.startsWith('giga-fixture-2:')))
})

test('once approved, eligibility offers revoke and stops explaining approval', async t => {
  const { images, packet } = await setup(t)
  const digest = (await images.ingest(packet.input, packet.files)).digest
  approve(images, digest)
  const reviewed = images.review(digest)
  assert.equal(reviewed.eligibility.approve, false)
  assert.equal(reviewed.eligibility.revoke, true)
  assert.deepEqual(reviewed.eligibility.issues, [], 'a state with no Approve button has nothing to justify')
})

/* ==========================================================================
 * One photo, many sizes: serving a url that several rows share.
 *
 * `catalog()` now hands the same `imageUrl` to every size of a model once one
 * of them has an approved photo. `readPublic` used to resolve the bytes by
 * finding the FIRST catalogue row carrying that url and looking the
 * publication up by that row's id -- which worked only while each url belonged
 * to exactly one row.
 *
 * The moment a url was shared, `.find()` started returning whichever row
 * sorted first, that row had no `image_publications` entry of its own, and
 * EVERY photo on the site 404ed -- including ones that had served for weeks.
 * Caught in production by the owner, not by this suite.
 * ========================================================================== */

/** Two sizes of ONE model, plus an unrelated model, in a fresh inventory. */
async function acrossSizes(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kmt-across-'))
  const database = path.join(directory, 'owner.sqlite')
  const rows = [
    { id: 'giga-shared-b17', name: 'Shared Model', size: '225/50R17', price: 80, inStock: true, category: 'All Season',
      description: '<p>Fixture</p>', source: { sku: 'SHARED-17', url: 'https://provider.test/listing' } },
    { id: 'giga-shared-a16', name: 'Shared Model', size: '215/60R16', price: 80, inStock: true, category: 'All Season',
      description: '<p>Fixture</p>', source: { sku: 'SHARED-16', url: 'https://provider.test/listing' } },
    { id: 'giga-other-a16', name: 'Other Model', size: '215/60R16', price: 80, inStock: true, category: 'All Season',
      description: '<p>Fixture</p>', source: { sku: 'OTHER-16', url: 'https://provider.test/listing' } },
  ]
  const inventory = new Inventory(database, ['215/60R16', '225/50R17'])
  inventory.importSnapshot({ source: 'giga-tires.com', scrapedAt: '2026-09-08T00:00:00Z', tires: rows })
  const images = new ImagePublication(inventory, { directory: imageDirectoryForDatabase(database), python: decoderPython })
  t.after(async () => { try { inventory.close() } catch { /* already closed */ } await rm(directory, { recursive: true, force: true }) })
  return { inventory, images, rows }
}

test('a url shared by every size of a model still serves its bytes', async t => {
  const { inventory, images, rows } = await acrossSizes(t)
  // Approved on ONE size only, and on the size that sorts LAST. `catalog()`
  // orders by size, so 215/60R16 comes first and is therefore the BORROWER --
  // which is the arrangement the old lookup got wrong. Approving the 16 instead
  // puts the owner first, and the old code passes while still being broken for
  // every other size; the assertion below refuses that fixture.
  const owner = rows.find(row => row.id === 'giga-shared-b17')
  const packet = packetFor([owner])
  const { digest } = await images.ingest(packet.input, packet.files)
  approve(images, digest)

  const catalogue = inventory.catalog()
  const sharing = catalogue.filter(row => row.imageUrl === packet.url)
  assert.equal(sharing.length, 2, 'both sizes of the model must be offering the same url for this test to mean anything')

  // THE FIXTURE ONLY DISCRIMINATES IF THE FIRST MATCH IS THE BORROWER. If the
  // owning row sorted first, the old lookup by `tire.id` would find its
  // publication and pass while still being wrong for every other row.
  assert.notEqual(sharing[0].id, owner.id, 'the first row carrying this url is the one that owns it; the fixture proves nothing')

  assert.deepEqual(images.readPublic(packet.url).bytes, fixtures.png,
    'a url shared across sizes did not serve -- this is the 404 that took every photo off the site')
})

test('sharing a url does not let an unrelated model borrow one', async t => {
  const { inventory, images, rows } = await acrossSizes(t)
  const packet = packetFor([rows.find(row => row.id === 'giga-shared-a16')])
  const { digest } = await images.ingest(packet.input, packet.files)
  approve(images, digest)

  const other = inventory.catalog().find(row => row.id === 'giga-other-a16')
  assert.equal(other.imageUrl, undefined, 'a different model was handed a photo')
})

test('a url no catalogue row offers is still refused', async t => {
  // The eligibility half is unchanged and must stay: resolving by digest alone
  // would serve a revoked or hidden photo to anyone who kept the url.
  const { images } = await acrossSizes(t)
  assert.throws(() => images.readPublic(`/api/images/${'d'.repeat(64)}.png`))
})
