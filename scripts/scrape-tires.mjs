#!/usr/bin/env node
/**
 * Manual catalog updater: pull real tires from giga-tires.com for the sizes we
 * care about and write them to a JSON snapshot.
 *
 * This is deliberately a person-in-the-loop tool, not a job. Ken's prices are
 * his own decision, so the scraper's output is a snapshot to review and a diff
 * to read -- never something that silently becomes the live catalog. Nothing
 * here writes to src/data/catalog.js.
 *
 *   node scripts/scrape-tires.mjs 215/60R16 225/50R17
 *   node scripts/scrape-tires.mjs 215/60R16 --limit 5 --dry-run
 *   node scripts/scrape-tires.mjs --from-catalog --limit 4
 *
 * Run `node scripts/scrape-tires.mjs --help` for the full flag list.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readPrivateImageInput } from './import-images.mjs'
import { prepareImagePilot, collectImagePilot, writeImagePilotPacket, assertImagePilotOutput } from './image-pilot-packet.mjs'

import { createBrowserFetcher, RateLimitedError } from './browser-fetch.mjs'
import { canonicalSize, fetchProductPage, fetchSizePage, parseListingPage, parseProductPage, parseSize, productUrl, ProviderRefusalError, USER_AGENT } from './giga-tires.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')

const HELP = `
Pull tires from giga-tires.com into a reviewable JSON snapshot.

Usage:
  node scripts/scrape-tires.mjs <size...> [options]

Sizes may be written 215/60R16 or 215-60-16.

Options:
  --from-catalog     Use every distinct size already in src/data/catalog.js
                     instead of listing sizes by hand. This is a lot of sizes;
                     it prints the count and waits --delay between requests.
  --limit N          Keep the N cheapest in-stock tires per size (default 8).
                     Use 0 to keep everything found.
  --pages N          Listing pages to read per size, 10 tires each (default 1).
  --delay MS         Pause between pages within one size (default 1500).
  --enrich-products  Read product pages for rows found by the size scrape.
  --product-url URL  Read one product URL directly; repeat for a small batch.
  --enrich-limit N   Maximum product pages to read in this run (default 8,
                     maximum 50). Required bounding applies across all URLs.
  --concurrency N    Product-page workers (default 1, maximum 4).
  --product-delay MS Minimum delay between product-page starts (default 1500).
  --validate-products Validate seeded random product pages from the snapshot;
                     read-only, serial and fail-closed. Count via --validation-count.
  --validation-seed N Required integer seed for reproducible page selection.
  --validation-count N Pages to select (default 5; an over-cap value is refused,
                     naming the limit -- a packet's snapshot must fit the importer).
  --allow-partial    Build the packet from the pages that validated instead of
                     refusing the run. Every skipped page is named with the
                     reason either way; this only decides whether a partial
                     result is written. Off by default.
  --validation-input ABS_PATH  Private owner product-URL mapping.
  --validation-snapshot ABS_PATH  Optional private supplier baseline snapshot.
  --validation-output ABS_DIR  New private packet directory outside this repo.
                     Both are required for an export; --dry-run performs only
                     local input validation. Export uses document-only browser
                     requests, 2-5s spacing, and stops on any incomplete result.
  --validation-jitter-min MS  Lower bound for validation pacing (default 2000).
  --validation-jitter-max MS  Upper bound for validation pacing (default 5000).
  --min-interval MS  Minimum time between one size's request and the next,
                     regardless of outcome -- empty, full or error alike
                     (default 10000). See docs/supplier-refresh.md for why
                     this exists: an empty result used to take long enough
                     that it paced requests by accident, and does not
                     anymore.
  --out PATH         Snapshot path (default src/data/scraped-tires.json).
  --dry-run          Print the report, write nothing.
  --replace          Drop sizes this run did not cover. Off by default: a run
                     over one size updates that size and leaves the rest of the
                     snapshot alone.
  --plain-fetch      Use plain HTTP instead of a browser window. Faster, but
                     the site's WAF answers it with a challenge page, so this
                     currently returns nothing. Kept for when that changes.
  --headless         Run the browser hidden. The site refuses headless browsers,
                     so this is here for debugging, not for real runs.
  --help             This message.

The default run opens a visible browser window and reads pages the way a person
would. Leave it on screen while it works -- it is how you see it going wrong.
`.trimStart()

export function parseArgs(argv) {
  const options = {
    sizes: [],
    fromCatalog: false,
    limit: 8,
    pages: 1,
    delay: 1500,
    enrichProducts: false,
    productUrls: [],
    enrichLimit: 8,
    concurrency: 1,
    productDelay: 1500,
    validateProducts: false,
    validationSeed: null,
    validationCount: 5,
    allowPartial: false,
    validationJitterMin: 2000,
    validationJitterMax: 5000,
    minInterval: 10000,
    out: DEFAULT_OUT,
    dryRun: false,
    replace: false,
    plainFetch: false,
    headless: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]

    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--from-catalog') options.fromCatalog = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--replace') options.replace = true
    else if (arg === '--plain-fetch') options.plainFetch = true
    else if (arg === '--headless') options.headless = true
    else if (arg === '--enrich-products') options.enrichProducts = true
    else if (arg === '--product-url') options.productUrls.push(value())
    else if (arg === '--enrich-limit') options.enrichLimit = Number(value())
    else if (arg === '--concurrency') options.concurrency = Number(value())
    else if (arg === '--product-delay') options.productDelay = Number(value())
    else if (arg === '--validate-products') options.validateProducts = true
    else if (arg === '--validation-seed') options.validationSeed = Number(value())
    else if (arg === '--validation-count') options.validationCount = Number(value())
    else if (arg === '--allow-partial') options.allowPartial = true
    else if (arg === '--validation-input') options.validationInput = value()
    else if (arg === '--validation-snapshot') options.validationSnapshot = value()
    else if (arg === '--validation-output') options.validationOutput = value()
    else if (arg === '--validation-jitter-min') options.validationJitterMin = Number(value())
    else if (arg === '--validation-jitter-max') options.validationJitterMax = Number(value())
    else if (arg === '--limit') options.limit = Number(value())
    else if (arg === '--pages') options.pages = Number(value())
    else if (arg === '--delay') options.delay = Number(value())
    else if (arg === '--min-interval') options.minInterval = Number(value())
    else if (arg === '--out') options.out = path.resolve(ROOT, value())
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else options.sizes.push(arg)
  }

  return options
}

function validateEnrichmentOptions(options) {
  if (!Number.isInteger(options.enrichLimit) || options.enrichLimit < 1 || options.enrichLimit > 50) {
    throw new Error('--enrich-limit must be an integer from 1 to 50')
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error('--concurrency must be an integer from 1 to 4')
  }
  if (!Number.isFinite(options.productDelay) || options.productDelay < 0) throw new Error('--product-delay must be zero or greater')
}

// The most pages one --validation-count run may request. A downstream safety
// bound, not a business rule: each selected page becomes one enriched row in the
// packet's snapshot.json, which the CLI the owner actually runs to import that
// packet -- scripts/import-product-images.mjs, the #468 caller -- reads under
// MAX_PACKET_FILE_BYTES (65536) in readPacketInputs. (scripts/import-images.mjs:35
// caps the same file at an inline 65536 too; same number, a second import path.)
// Measured 2026-09-10 against src/data/scraped-tires.json with JSON.stringify --
// the bytes the packet actually writes, not json.dumps pretty-printed, which runs
// ~10% high (1083 rows: ~362 B/row avg, 573 max) -- ~166 of the largest raw rows
// fit under 65536, and the enriched form (candidates + per-URL provenance) lowers
// the practical ceiling to ~120-150. 100 stays under that with headroom for the
// owner's 37-model target. INVALIDATED BY a change to ANY of the 65536 packet-file
// caps -- 8 sites as of 2026-09-10 (`git grep 65536 -- scripts/ backend/`), only
// import-product-images.mjs's MAX_PACKET_FILE_BYTES named and the rest inline, so
// raising one leaves the others silently disagreeing: grep the class, do not trust
// one file. Or growth in per-row size. Re-measure; do not just raise this.
export const MAX_VALIDATION_COUNT = 100

function validateValidationOptions(options) {
  if (!Number.isInteger(options.validationSeed)) throw new Error('--validation-seed must be an integer')
  if (!Number.isInteger(options.validationCount) || options.validationCount < 1) {
    throw new Error('--validation-count must be a positive integer')
  }
  if (options.validationCount > MAX_VALIDATION_COUNT) {
    throw new Error(`--validation-count ${options.validationCount} exceeds the ${MAX_VALIDATION_COUNT}-page cap: each selected page becomes one row in the packet's snapshot.json, which import-images.mjs reads under a 65536-byte limit. Run fewer pages per packet.`)
  }
  if (!Number.isFinite(options.validationJitterMin) || options.validationJitterMin < 0 ||
      !Number.isFinite(options.validationJitterMax) || options.validationJitterMax < options.validationJitterMin) {
    throw new Error('--validation-jitter-min/max must be non-negative, with max at least min')
  }
  if (options.sizes.length || options.fromCatalog || options.enrichProducts || options.productUrls.length || options.replace) {
    throw new Error('--validate-products is standalone; do not combine it with size, enrichment, or replacement options')
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const money = (amount) => `$${amount.toFixed(2)}`

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick a stable, bounded set from the snapshot without making a network call. */
export function selectValidationUrls(rows, seed, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('selectValidationUrls requires a positive integer count')
  const candidates = [...new Set(rows.map(row => row.source?.url).filter(Boolean).map(productUrl))]
  if (candidates.length < count) throw new Error(`Validation needs ${count} valid product URLs; snapshot has ${candidates.length}`)
  const random = seededRandom(seed)
  for (let index = candidates.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[candidates[index], candidates[swap]] = [candidates[swap], candidates[index]]
  }
  return candidates.slice(0, count)
}

export function createValidationOptions(options) {
  validateValidationOptions(options)
  const random = seededRandom(options.validationSeed ^ 0x9E3779B9)
  return {
    ...options,
    enrichLimit: options.validationCount,
    concurrency: 1,
    productDelay: 0,
    delayForNext: () => options.validationJitterMin + Math.floor(random() * (options.validationJitterMax - options.validationJitterMin + 1)),
  }
}

async function sizesFromCatalog() {
  const { TIRE_CATALOG } = await import('../src/data/catalog.js')
  return [...new Set(TIRE_CATALOG.map(tire => tire.size))].sort()
}

/**
 * Cheapest first, and never let an out-of-stock row take a slot from an
 * in-stock one: a --limit of 4 that comes back with four unbuyable tires is
 * worse than useless to whoever is reviewing it.
 */
function rank(rows, limit) {
  const sorted = [...rows].sort((a, b) => {
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1
    return a.price - b.price
  })
  return limit > 0 ? sorted.slice(0, limit) : sorted
}

async function scrapeSize(size, options, fetcher) {
  const rows = []
  const skipped = []
  let pagesRead = 0
  let totalPages = 1

  // Pages are 1-indexed, matching the site's own pager.
  for (let page = 1; page <= options.pages; page++) {
    if (pagesRead > 0) await sleep(options.delay)
    const { html } = await fetcher(size, page)
    const parsed = parseListingPage(html, size)
    pagesRead++
    totalPages = parsed.totalPages

    rows.push(...parsed.rows)
    skipped.push(...parsed.skipped)

    if (page >= parsed.totalPages) break
  }

  // The same SKU can appear twice when a page boundary shifts between requests.
  const byId = new Map(rows.map(row => [row.id, row]))
  return { rows: [...byId.values()], skipped, pagesRead, totalPages }
}

/**
 * What one size's scrape actually covered, written into the snapshot.
 *
 * A size is complete only when nothing was left out: no --limit, and every
 * page the supplier reported was read. The import CLI and the server both
 * refuse to treat a size as the supplier's whole listing without this record
 * saying so, because retiring tires that a partial scrape merely did not
 * fetch would take tires off Ken's list that the supplier still sells.
 */
export function sizeCoverage({ limit, pagesRead, totalPages, scrapedAt }) {
  return { limit, pagesRead, totalPages, complete: limit === 0 && pagesRead >= totalPages, scrapedAt }
}

/**
 * Assemble the snapshot: this run's rows and coverage, plus whatever the
 * previous snapshot held for sizes this run did not touch.
 *
 * Sizes this run did not touch keep their existing rows and their existing
 * coverage record. Without this, refreshing one size would quietly delete
 * every other size from the snapshot -- and a size whose fetch *failed* would
 * be indistinguishable from one that genuinely has nothing left. `replace`
 * opts into the wipe. Carried rows are byte-identical to their previous
 * selves, so they do not show up as changes in the diff.
 */
export function buildSnapshot({ previous = null, tires, coverage, replace = false, scrapedAt = new Date().toISOString() }) {
  const scrapedSizes = new Set(Object.keys(coverage))
  const carried = replace ? [] : (previous?.tires || []).filter(tire => !scrapedSizes.has(tire.size))

  // Coverage carries forward by its own key, not by riding along on a tire.
  // A confirmed-empty size (read in full, genuinely nothing there) has no
  // tire to anchor it -- keying this off `carried`'s tire sizes, as an
  // earlier version did, silently dropped every empty size's record on the
  // next run that did not re-scrape it, which is exactly the outcome #81
  // exists to prevent.
  const carriedCoverage = replace ? {} : Object.fromEntries(
    Object.entries(previous?.coverage || {}).filter(([size]) => !scrapedSizes.has(size)),
  )
  const merged = { ...carriedCoverage, ...coverage }
  return {
    carried,
    snapshot: {
      source: 'giga-tires.com',
      scrapedAt,
      sizes: Object.keys(merged).sort(),
      coverage: Object.fromEntries(Object.keys(merged).sort().map(size => [size, merged[size]])),
      tires: [...tires, ...carried]
        .sort((a, b) => a.size.localeCompare(b.size) || a.price - b.price),
    },
  }
}

/** What changed against the previous snapshot -- the thing worth reading. */
function diffSnapshots(previous, next) {
  const before = new Map((previous?.tires || []).map(tire => [tire.id, tire]))
  const after = new Map(next.tires.map(tire => [tire.id, tire]))

  const added = next.tires.filter(tire => !before.has(tire.id))
  const removed = [...before.values()].filter(tire => !after.has(tire.id))
  const repriced = []
  const restocked = []

  for (const [id, tire] of after) {
    const old = before.get(id)
    if (!old) continue
    if (old.price !== tire.price) repriced.push({ tire, from: old.price, to: tire.price })
    if (old.inStock !== tire.inStock) restocked.push({ tire, to: tire.inStock })
  }

  return { added, removed, repriced, restocked }
}

function reportDiff(diff, hadPrevious) {
  if (!hadPrevious) {
    console.log('\nNo previous snapshot, so everything is new.')
    return
  }

  const { added, removed, repriced, restocked } = diff
  if (!added.length && !removed.length && !repriced.length && !restocked.length) {
    console.log('\nNo change since the last snapshot.')
    return
  }

  console.log('\nChanges since the last snapshot')
  for (const tire of added) {
    console.log(`  + ${tire.size}  ${tire.name} @ ${money(tire.price)}`)
  }
  for (const tire of removed) {
    console.log(`  - ${tire.size}  ${tire.name} (no longer listed)`)
  }
  for (const { tire, from, to } of repriced) {
    const arrow = to > from ? 'up' : 'down'
    console.log(`  ~ ${tire.size}  ${tire.name}: ${money(from)} -> ${money(to)} (${arrow})`)
  }
  for (const { tire, to } of restocked) {
    console.log(`  ! ${tire.size}  ${tire.name}: now ${to ? 'in stock' : 'OUT OF STOCK'}`)
  }
}

/**
 * Walk every size, pacing requests so the rate does not depend on outcome.
 *
 * Before #129, an empty size took ~20s to conclude -- accidentally pacing
 * requests as a side effect of a slow failure. #129 made empty and full
 * alike resolve in ~1.7s, which is faster and more honest, and also removed
 * that accidental pacing on exactly the runs that are mostly empty. This is
 * the explicit replacement: at least `options.minInterval` between the
 * start of one size's request and the next, measured regardless of whether
 * that size turned out empty, full, or failed, so a fast path can never
 * shrink the gap back down. See docs/supplier-refresh.md.
 *
 * A 429 is not a per-size failure. It is the supplier saying the rate is
 * too high, and the runbook's rule is to stop the whole run rather than
 * retry, back off and continue, or route around it -- so it breaks the loop
 * immediately rather than joining `failures`.
 */
export async function scrapeAll(sizes, options, fetcher) {
  const tires = []
  const failures = []
  const coverage = {}
  const scrapedAt = new Date().toISOString()
  let totalSkipped = 0
  let stoppedOnRateLimit = null
  let stoppedOnRefusal = null
  let lastStart = 0

  for (const [index, size] of sizes.entries()) {
    if (index > 0) {
      const wait = options.minInterval - (Date.now() - lastStart)
      if (wait > 0) await sleep(wait)
    }
    lastStart = Date.now()

    try {
      const result = await scrapeSize(size, options, fetcher)
      coverage[size] = sizeCoverage({ limit: options.limit, pagesRead: result.pagesRead, totalPages: result.totalPages, scrapedAt })
      const kept = rank(result.rows, options.limit)
      tires.push(...kept)
      totalSkipped += result.skipped.length

      const cheapest = kept.length ? money(Math.min(...kept.map(tire => tire.price))) : 'n/a'
      const outOfStock = kept.filter(tire => !tire.inStock).length
      console.log(
        `  ${size.padEnd(12)} ${String(result.rows.length).padStart(3)} found` +
        ` -> ${String(kept.length).padStart(2)} kept, from ${cheapest}` +
        (outOfStock ? `, ${outOfStock} out of stock` : '') +
        (coverage[size].complete ? ', complete' : `, partial (page ${result.pagesRead} of ${result.totalPages}${options.limit ? `, limit ${options.limit}` : ''})`)
      )
    } catch (error) {
      if (error instanceof ProviderRefusalError) {
        stoppedOnRefusal = { size, status: error.status, reason: error.reason, message: error.message }
        if (error instanceof RateLimitedError || error.status === 429) {
          stoppedOnRateLimit = { size, retryAfter: error.retryAfter }
        }
        break
      }
      failures.push({ size, message: error.message })
      console.log(`  ${size.padEnd(12)} FAILED: ${error.message}`)
    }
  }

  return { tires, failures, coverage, totalSkipped, scrapedAt, stoppedOnRateLimit, stoppedOnRefusal }
}

/** Bounded product-page work queue, exported so fixtures can prove pacing and preservation. */
export async function enrichRows(rows, urls, options, fetcher) {
  validateEnrichmentOptions(options)
  const fallbacks = new Map(rows.filter(row => row.source?.url).map(row => [productUrl(row.source.url), row]))
  const targets = [...new Set(urls.map(productUrl))].slice(0, options.enrichLimit)
  const enriched = new Map(rows.map(row => [row.id, row]))
  const failures = []
  let stoppedOnRefusal = null
  let cursor = 1
  let lastStart = 0
  let pace = Promise.resolve()

  const nextTarget = () => cursor < targets.length ? targets[cursor++] : null
  const now = options.now || Date.now
  const wait = options.sleep || sleep
  const delayForNext = options.delayForNext || (() => options.productDelay)
  const waitForTurn = () => {
    const turn = pace.then(async () => {
      const remaining = delayForNext() - (now() - lastStart)
      if (lastStart && remaining > 0) await wait(remaining)
      lastStart = now()
    })
    pace = turn.catch(() => {})
    return turn
  }
  const fetchOne = async url => {
    try {
      const fetched = await fetcher(url)
      const row = parseProductPage(fetched.html, { url: fetched.url || url, fallback: fallbacks.get(url) })
      if (!row.id || !row.size || !Number.isFinite(row.price)) throw new Error('Product page did not contain an importable SKU, size, and price')
      enriched.set(row.id, row)
    } catch (error) {
      if (error instanceof ProviderRefusalError) {
        stoppedOnRefusal = { url, status: error.status, reason: error.reason, message: error.message }
        throw error
      }
      failures.push({ url, message: error.message })
    }
  }

  // Establish the provider's answer before reserving any parallel work. If
  // the first page is refused immediately, no other worker can have already
  // reserved a URL and later slip through the stop check.
  if (targets.length) {
    await waitForTurn()
    if (!stoppedOnRefusal) await fetchOne(targets[0])
  }

  const worker = async () => {
    for (let url; (url = nextTarget());) {
      if (stoppedOnRefusal) return
      await waitForTurn()
      if (stoppedOnRefusal) return
      await fetchOne(url)
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(0, targets.length - 1)) }, worker))
  return { rows: [...enriched.values()], failures, attempted: targets.length, stoppedOnRefusal }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP)
    return
  }

  if (!options.validateProducts && (options.validationInput || options.validationOutput || options.validationSnapshot)) throw new Error('Private packet flags require --validate-products')

  if (options.validateProducts) {
    const validationOptions = createValidationOptions(options)
    if (options.validationInput || options.validationOutput || options.validationSnapshot) {
      if (!options.validationInput || !options.validationOutput || options.headless || options.plainFetch ||
          options.validationJitterMin < 2000 || options.validationJitterMax > 5000) throw new Error('Private packet export requires both paths, a visible document-only browser and 2-5 second pacing')
      const inputBytes = readPrivateImageInput(options.validationSnapshot || DEFAULT_OUT, 8 * 1024 * 1024)
      const mappingBytes = readPrivateImageInput(options.validationInput, 65536)
      const plan = prepareImagePilot(inputBytes, mappingBytes)
      assertImagePilotOutput(options.validationOutput, ROOT)
      const urls = selectValidationUrls([...plan.baseline.keys()].map(url => ({ source: { url } })), options.validationSeed, options.validationCount)
      const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim()
      if (options.dryRun) { console.log(`Private inputs valid (${urls.length} product URLs); dry run made no provider requests and wrote no packet.`); return }
      if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim()) throw new Error('Pilot execution requires a clean reviewed checkout')
      const browser = await createBrowserFetcher({ headless: false, userAgent: USER_AGENT, productMetadataOnly: true })
      try {
        const packet = await collectImagePilot(plan, urls, { codeSha, seed: options.validationSeed, delayForNext: validationOptions.delayForNext, allowPartial: options.allowPartial }, url => browser.fetchProductPage(url))
        writeImagePilotPacket(options.validationOutput, packet, ROOT)
        // Report what was WRITTEN, and say so against what was asked for. This
        // printed `urls.length` -- the number of pages requested -- so a run
        // that asked for 10, skipped one and wrote 9 announced "10 product
        // URLs". The skipped page was named a few lines above, which made the
        // overstatement easy to miss and easy to believe.
        const written = packet.orderedIds.length
        console.log(written === urls.length
          ? `Private metadata packet written (${written} product URLs). No image files downloaded or approval granted.`
          : `Private metadata packet written (${written} of ${urls.length} product URLs; ${urls.length - written} skipped above). No image files downloaded or approval granted.`)
      // The message stays generic, but the cause is ATTACHED rather than
      // discarded. A bare `catch` here made every failure of this command
      // indistinguishable from every other -- a redirect, a parse mismatch, a
      // real block and a page that had not rendered yet all produced the same
      // sentence, and the only way to tell them apart was to re-run the whole
      // thing by hand with the error printed. That cost three live requests to
      // somebody else's server on 2026-09-10 to learn the page simply had not
      // finished loading. This runs on the owner's own machine, against a
      // packet the owner supplied; the cause is his to read.
      } catch (error) { throw new Error('Private product pilot stopped; no retry, substitution, image download or activation. Inspect operator-local evidence.', { cause: error }) }
      finally { await browser.close() }
      return
    }
    if (options.dryRun) { console.log('Validation dry run: no provider requests. Supply private mapping/output paths to validate a packet.'); return }
    const snapshot = JSON.parse(await readFile(DEFAULT_OUT, 'utf8'))
    const urls = selectValidationUrls(snapshot.tires || [], options.validationSeed, options.validationCount)
    console.log(`Validating exactly ${urls.length} seeded product pages (seed ${options.validationSeed}); read-only, serial, no retries.`)
    console.log(`Validation pacing: randomized ${options.validationJitterMin}-${options.validationJitterMax}ms between starts.`)
    console.log(options.plainFetch ? 'Using plain HTTP.\n' : 'Opening a browser window.\n')
    const browser = options.plainFetch
      ? null
      : await createBrowserFetcher({ headless: options.headless, userAgent: USER_AGENT, productMetadataOnly: true })
    const productFetcher = browser
      ? url => browser.fetchProductPage(url)
      : url => fetchProductPage(url, { userAgent: USER_AGENT })
    try {
      const result = await enrichRows([], urls, validationOptions, productFetcher)
      console.log(`Validation complete: ${result.attempted - result.failures.length} passed, ${result.failures.length} failed.`)
      if (result.failures.length) process.exitCode = 1
    } finally {
      if (browser) await browser.close()
    }
    return
  }

  validateEnrichmentOptions(options)
  options.productUrls = options.productUrls.map(productUrl)
  let sizes = options.fromCatalog ? await sizesFromCatalog() : options.sizes
  if (!sizes.length && !options.productUrls.length) {
    console.error('Give at least one tire size, --from-catalog, or --product-url. See --help.')
    process.exitCode = 1
    return
  }

  const invalid = sizes.filter(size => !parseSize(size))
  if (invalid.length) {
    console.error(`Not tire sizes: ${invalid.join(', ')}`)
    process.exitCode = 1
    return
  }
  sizes = [...new Set(sizes.map(canonicalSize))]

  if (sizes.length) {
    console.log(`Reading ${sizes.length} size${sizes.length === 1 ? '' : 's'} from giga-tires.com`)
    console.log(`${options.pages} page(s) each, keeping ${options.limit || 'all'} per size, ${options.delay}ms between pages, ${options.minInterval}ms between sizes`)
  }
  if (options.enrichProducts || options.productUrls.length) {
    console.log(`Product enrichment: limit ${options.enrichLimit}, concurrency ${options.concurrency}, ${options.productDelay}ms between starts`)
  }
  console.log(options.plainFetch ? 'Using plain HTTP.\n' : 'Opening a browser window.\n')

  const browser = options.plainFetch
    ? null
    : await createBrowserFetcher({ headless: options.headless, userAgent: USER_AGENT })
  const fetcher = browser
    ? (size, page) => browser.fetchSizePage(size, page)
    : (size, page) => fetchSizePage(size, page, { userAgent: USER_AGENT })
  const productFetcher = browser
    ? url => browser.fetchProductPage(url)
    : url => fetchProductPage(url, { userAgent: USER_AGENT })

  let result
  try {
    result = sizes.length
      ? await scrapeAll(sizes, options, fetcher)
      : { tires: [], failures: [], coverage: {}, totalSkipped: 0, scrapedAt: new Date().toISOString(), stoppedOnRateLimit: null, stoppedOnRefusal: null }
    const requestedUrls = [
      ...options.productUrls,
      ...(options.enrichProducts ? result.tires.map(tire => tire.source?.url).filter(Boolean) : []),
    ]
    if (requestedUrls.length) {
      const productResult = await enrichRows(result.tires, requestedUrls, options, productFetcher)
      result.tires = productResult.rows
      result.failures.push(...productResult.failures.map(failure => ({ size: failure.url, message: failure.message })))
      console.log(`  Product pages: ${productResult.attempted - productResult.failures.length} enriched, ${productResult.failures.length} failed.`)
    }
  } finally {
    if (browser) await browser.close()
  }
  let { tires, coverage } = result
  const { failures, totalSkipped, scrapedAt, stoppedOnRateLimit, stoppedOnRefusal } = result

  if (stoppedOnRateLimit) {
    const { size, retryAfter } = stoppedOnRateLimit
    console.error(
      `\n429 from the supplier at ${size}${retryAfter ? ` (Retry-After: ${retryAfter})` : ''}. ` +
      'Stopped -- a 429 is a stop, not a backoff. See docs/supplier-refresh.md.'
    )
    process.exitCode = 1
  }

  if (stoppedOnRefusal) {
    console.error(`\n${stoppedOnRefusal.message}. Stopped -- provider refusal is a run-global stop; no snapshot was written.`)
    process.exitCode = 1
    return
  }

  // Zero tires is not the same claim as zero progress: a run of genuinely
  // empty sizes now succeeds (see fetchSizePage) and leaves a coverage
  // record for each one, confirmed read rather than unattempted. Only bail
  // here when nothing was read at all -- every size threw, the case this
  // guard exists for.
  if (!tires.length && !Object.keys(coverage).length) {
    console.error('\nNothing scraped. Leaving the existing snapshot alone.')
    process.exitCode = 1
    return
  }

  const hadPrevious = existsSync(options.out)
  const previous = hadPrevious
    ? JSON.parse(await readFile(options.out, 'utf8'))
    : null

  // A direct product URL is a surgical update, not a claim that the rest of
  // that size disappeared. Replace matching IDs and carry every other row.
  if (!sizes.length && options.productUrls.length) {
    const updated = new Map((previous?.tires || []).map(tire => [tire.id, tire]))
    for (const tire of tires) updated.set(tire.id, tire)
    tires = [...updated.values()]
    coverage = { ...(previous?.coverage || {}) }
    for (const tire of result.tires) coverage[tire.size] ??= {
      limit: options.enrichLimit, pagesRead: 0, totalPages: null, complete: false, scrapedAt,
    }
  }

  const { snapshot, carried } = buildSnapshot({ previous, tires, coverage, replace: options.replace, scrapedAt })

  reportDiff(diffSnapshots(previous, snapshot), hadPrevious)
  if (carried.length) {
    const untouched = new Set(carried.map(tire => tire.size))
    console.log(`\nKept ${carried.length} tire(s) across ${untouched.size} size(s) this run did not cover.`)
  }

  console.log(`\nSnapshot now holds ${snapshot.tires.length} tires across ${snapshot.sizes.length} size(s).`)
  const completeSizes = Object.values(snapshot.coverage).filter(record => record.complete).length
  console.log(`${completeSizes} of ${snapshot.sizes.length} size(s) read completely; only those can be imported with --complete.`)
  if (totalSkipped) console.log(`${totalSkipped} card(s) skipped for having no price.`)
  if (failures.length) console.log(`${failures.length} size(s) failed.`)
  if (stoppedOnRateLimit) {
    const unattempted = sizes.length - Object.keys(coverage).length
    console.log(`${unattempted} size(s) never attempted -- stopped on the 429 before reaching them.`)
  }

  if (options.dryRun) {
    console.log('\n--dry-run: nothing written.')
    return
  }

  await writeFile(options.out, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`\nWrote ${path.relative(ROOT, options.out)}`)
  console.log('Review it, then push it to a running server with `npm run import-tires`.')

  if (failures.length) process.exitCode = 1
}

// Guarded so the tests can import buildSnapshot without starting a scrape.
if (import.meta.main) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
