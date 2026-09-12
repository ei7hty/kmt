import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import path from 'node:path'
import { sha256Bytes, assertAllowedImageUrl } from '../backend/image-assets.mjs'
import { IMAGE_SELECTION_TAG, supplierImageRevision } from '../backend/image-manifest.mjs'
import { IMAGE_PILOT_POLICY, compileImageProviderProfile } from '../backend/image-provider-profile.mjs'
import { parseProductPage, productUrl } from './giga-tires.mjs'

/**
 * The message stays constant; the REASON is attached as a cause.
 *
 * Every refusal in this file used to throw one identical sentence, so a run
 * that stopped told the operator nothing about which of a dozen checks
 * objected. That is the same defect the bare `catch` in scrape-tires.mjs had,
 * and it cost the same thing: live requests spent re-running a command by hand
 * to learn what one printed word would have said. The packet is private and so
 * is its content -- but this runs on the owner's own machine, against a packet
 * the owner supplied, and the NAME of the check that refused is not a secret
 * from him.
 */
const reject = reason => {
  throw new Error('Private pilot input or outcome refused', reason ? { cause: new Error(reason) } : undefined)
}
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
export function prepareImagePilot(inputBytes, mappingBytes) {
  if (!(inputBytes instanceof Uint8Array) || inputBytes.length > 8 * 1024 * 1024 ||
      !(mappingBytes instanceof Uint8Array) || mappingBytes.length > 65536) reject()
  const input = parse(inputBytes), mapping = parse(mappingBytes)
  if (Object.keys(mapping).sort().join(',') !== 'candidates,inputDigest,version' || mapping.version !== 1 || mapping.inputDigest !== sha256Bytes(inputBytes) || !Array.isArray(mapping.candidates) || !mapping.candidates.length) reject()
  const ids = new Set(), urls = new Set(), baseline = new Map()
  for (const item of mapping.candidates) {
    if (Object.keys(item).sort().join(',') !== 'productUrl,revision,supplierId,supplierSku') reject()
    const rows = input.tires?.filter(row => row.id === item.supplierId)
    if (rows?.length !== 1 || rows[0].source?.sku !== item.supplierSku || supplierImageRevision(rows[0]) !== item.revision ||
        typeof item.productUrl !== 'string' || productUrl(item.productUrl) !== item.productUrl ||
        new URL(item.productUrl).username || new URL(item.productUrl).password || ids.has(item.supplierId) || urls.has(item.productUrl)) reject()
    ids.add(item.supplierId); urls.add(item.productUrl)
    baseline.set(item.productUrl, { mapping: structuredClone(item), tire: structuredClone(rows[0]) })
  }
  return { baseline, inputDigest: mapping.inputDigest, mappingDigest: sha256Bytes(mappingBytes) }
}

export async function collectImagePilot(plan, orderedUrls, { codeSha, seed, delayForNext, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }, fetchPage) {
  if (!/^[a-f0-9]{40}$/.test(codeSha) || !Number.isSafeInteger(seed) || !orderedUrls.length || new Set(orderedUrls).size !== orderedUrls.length || orderedUrls.some(url => !plan.baseline.has(url))) reject()
  const candidates = [], observations = [], enrichedRows = []
  let lastStart
  for (const requestedUrl of orderedUrls) {
    if (lastStart !== undefined) {
      const delay = delayForNext()
      if (!Number.isFinite(delay) || delay < 2000 || delay > 5000) reject()
      const remaining = delay - (now() - lastStart)
      if (remaining > 0) await sleep(remaining)
    }
    lastStart = now()
    const fetched = await fetchPage(requestedUrl)
    if (fetched.url !== requestedUrl || productUrl(fetched.url) !== fetched.url || Buffer.byteLength(fetched.html ?? '') > 4 * 1024 * 1024) reject()
    // No fallback: SKU/MPN and size must be present in the actual response.
    const row = parseProductPage(fetched.html, { url: fetched.url })
    const { mapping, tire } = plan.baseline.get(requestedUrl)
    // Named one at a time, so a refusal says which field disagreed and with
    // what.
    //
    // THE IDENTITY CHECK TIES THE PAGE TO THE URL, NOT TO THE LISTING.
    //
    // This used to compare the product page's sku against `mapping.supplierSku`
    // -- the value in the committed snapshot. Measured 2026-09-11 against three
    // real pages, those are two different identifier systems and never match:
    //
    //   /...racing-trac/tirecode/20000533   page sku "20000533"   snapshot "ROYA0041722550WXL"
    //   /...pro-racing/tirecode/20000281    page sku "20000281"   snapshot "APLS0061722550WXL"
    //   /...milage-suv-cuv/tirecode/20000466 page sku "20000466"  snapshot "ROYA0161626570H"
    //
    // The page reports the TIRECODE, which is the last segment of the URL the
    // request asked for. The snapshot carries giga's internal listing code. The
    // old comparison could not have succeeded on any page, ever.
    //
    // What this check is FOR is anti-substitution: proof the server returned
    // the product the URL named, rather than a near-miss or a redirect target.
    // Comparing the page's sku to the tirecode in the requested URL does that
    // directly and is STRICTER than the old comparison, which only ever tested
    // whether two unrelated codes happened to be equal.
    //
    // The snapshot-to-mapping tie is not lost: `prepareImagePilot` already
    // refuses any candidate whose `supplierSku` does not match the snapshot
    // row, before a single request is made.
    const requestedTireCode = fetched.url.split('/tirecode/')[1]?.split(/[/?#]/)[0]
    if (!requestedTireCode) reject(`tirecode: no /tirecode/<code> segment in ${fetched.url}`)
    if (row.source?.sku !== requestedTireCode) {
      reject(`identity: page sku ${JSON.stringify(row.source?.sku)} is not the tirecode ${JSON.stringify(requestedTireCode)} the URL asked for`)
    }
    if (row.size !== tire.size) {
      reject(`size: page has ${JSON.stringify(row.size)}, snapshot expects ${JSON.stringify(tire.size)}`)
    }
    if (!row.imageUrls?.length) {
      reject('imageUrls: the product page carried no image URLs in its structured data')
    }
    if (tire.source.productId && row.source.productId !== tire.source.productId) {
      reject(`productId: page has ${JSON.stringify(row.source?.productId)}, snapshot expects ${JSON.stringify(tire.source.productId)}`)
    }
    const originalUrl = row.imageUrls[0]
    const imageHost = new URL(originalUrl).hostname
    if (assertAllowedImageUrl(originalUrl, [imageHost]) !== originalUrl || new URL(originalUrl).hash) reject()
    candidates.push({ supplierId: tire.id, supplierSku: mapping.supplierSku, productUrl: fetched.url, originalUrl, revision: mapping.revision })
    observations.push({ supplierId: tire.id, requestedUrl, finalUrl: fetched.url, sku: row.source.sku, size: row.size, listingUrl: tire.source.url })
    enrichedRows.push(row)
  }
  const hosts = values => [...new Set(values.map(value => new URL(value).hostname))].sort()
  const productHosts = hosts(observations.flatMap(row => [row.requestedUrl, row.finalUrl, row.listingUrl]))
  const imageHosts = hosts(candidates.map(row => row.originalUrl))
  const profile = { version: 1, providerId: 'giga-tires', allowedHosts: [...new Set([...productHosts, ...imageHosts])].sort(), policy: IMAGE_PILOT_POLICY }
  const profileDigest = compileImageProviderProfile(profile).digest
  const snapshot = { version: 2, candidates, provenance: { codeSha, seed, inputDigest: plan.inputDigest, mappingDigest: plan.mappingDigest,
    selection: IMAGE_SELECTION_TAG, productHosts, imageHosts, observations }, enrichedRows }
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot))
  if (snapshotBytes.length > 65536) reject()
  return { snapshotBytes, profileBytes: Buffer.from(JSON.stringify(profile)), profileDigest, snapshotDigest: sha256Bytes(snapshotBytes),
    orderedIds: candidates.map(row => row.supplierId), productHosts, imageHosts }
}

export function assertImagePilotOutput(directory, repositoryRoot) {
  if (!path.isAbsolute(directory) || path.resolve(directory).startsWith(path.resolve(repositoryRoot) + path.sep) ||
      path.resolve(directory) === path.resolve(repositoryRoot) || path.resolve(directory).split(path.sep).some(p => ['public', 'dist'].includes(p.toLowerCase()))) reject()
  const parent = path.dirname(directory)
  if (realpathSync(parent) !== path.resolve(parent)) reject()
  let component = path.parse(parent).root
  for (const part of path.relative(component, parent).split(path.sep).filter(Boolean)) {
    component = path.join(component, part)
    if (lstatSync(component).isSymbolicLink()) reject()
  }
  if (existsSync(directory)) reject()
}

export function writeImagePilotPacket(directory, packet, repositoryRoot) {
  assertImagePilotOutput(directory, repositoryRoot)
  const parent = path.dirname(directory)
  mkdirSync(directory, { mode: 0o700 }) // no overwrite, no recursive aliases
  const write = (name, bytes) => {
    const fd = openSync(path.join(directory, name), 'wx', 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  }
  write('snapshot.json', packet.snapshotBytes)
  write('profile.json', packet.profileBytes)
  write('pilot-summary.json', JSON.stringify({ profileDigest: packet.profileDigest, snapshotDigest: packet.snapshotDigest,
    orderedIds: packet.orderedIds, productHosts: packet.productHosts, imageHosts: packet.imageHosts }))
  if (process.platform !== 'win32') {
    for (const dir of [directory, parent]) { const fd = openSync(dir, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  }
}
