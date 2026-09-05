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

import { createBrowserFetcher } from './browser-fetch.mjs'
import { canonicalSize, fetchSizePage, parseListingPage, parseSize } from './giga-tires.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')

// Identifies the tool rather than pretending to be a browser. If giga-tires
// ever wants to rate-limit or block this, they should be able to.
const USER_AGENT = 'KMT-catalog-updater/0.1 (manual catalog sync; +https://github.com/kmt)'

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
  --delay MS         Pause between requests (default 1500).
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

function parseArgs(argv) {
  const options = {
    sizes: [],
    fromCatalog: false,
    limit: 8,
    pages: 1,
    delay: 1500,
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
    else if (arg === '--limit') options.limit = Number(value())
    else if (arg === '--pages') options.pages = Number(value())
    else if (arg === '--delay') options.delay = Number(value())
    else if (arg === '--out') options.out = path.resolve(ROOT, value())
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else options.sizes.push(arg)
  }

  return options
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const money = (amount) => `$${amount.toFixed(2)}`

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

  // Pages are 1-indexed, matching the site's own pager.
  for (let page = 1; page <= options.pages; page++) {
    if (pagesRead > 0) await sleep(options.delay)
    const { html } = await fetcher(size, page)
    const parsed = parseListingPage(html, size)
    pagesRead++

    rows.push(...parsed.rows)
    skipped.push(...parsed.skipped)

    if (page >= parsed.totalPages) break
  }

  // The same SKU can appear twice when a page boundary shifts between requests.
  const byId = new Map(rows.map(row => [row.id, row]))
  return { rows: [...byId.values()], skipped, pagesRead }
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

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP)
    return
  }

  let sizes = options.fromCatalog ? await sizesFromCatalog() : options.sizes
  if (!sizes.length) {
    console.error('Give at least one tire size, or --from-catalog. See --help.')
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

  console.log(`Reading ${sizes.length} size${sizes.length === 1 ? '' : 's'} from giga-tires.com`)
  console.log(`${options.pages} page(s) each, keeping ${options.limit || 'all'} per size, ${options.delay}ms between requests`)
  console.log(options.plainFetch ? 'Using plain HTTP.\n' : 'Opening a browser window.\n')

  const browser = options.plainFetch
    ? null
    : await createBrowserFetcher({ headless: options.headless })
  const fetcher = browser
    ? (size, page) => browser.fetchSizePage(size, page)
    : (size, page) => fetchSizePage(size, page, { userAgent: USER_AGENT })

  const tires = []
  const failures = []
  const scrapedSizes = new Set()
  let totalSkipped = 0

  try {
    for (const [index, size] of sizes.entries()) {
      if (index > 0) await sleep(options.delay)
      try {
        const result = await scrapeSize(size, options, fetcher)
        scrapedSizes.add(size)
        const kept = rank(result.rows, options.limit)
        tires.push(...kept)
        totalSkipped += result.skipped.length

        const cheapest = kept.length ? money(Math.min(...kept.map(tire => tire.price))) : 'n/a'
        const outOfStock = kept.filter(tire => !tire.inStock).length
        console.log(
          `  ${size.padEnd(12)} ${String(result.rows.length).padStart(3)} found` +
          ` -> ${String(kept.length).padStart(2)} kept, from ${cheapest}` +
          (outOfStock ? `, ${outOfStock} out of stock` : '')
        )
      } catch (error) {
        failures.push({ size, message: error.message })
        console.log(`  ${size.padEnd(12)} FAILED: ${error.message}`)
      }
    }
  } finally {
    if (browser) await browser.close()
  }

  if (!tires.length) {
    console.error('\nNothing scraped. Leaving the existing snapshot alone.')
    process.exitCode = 1
    return
  }

  const hadPrevious = existsSync(options.out)
  const previous = hadPrevious
    ? JSON.parse(await readFile(options.out, 'utf8'))
    : null

  // Sizes this run did not touch keep their existing rows. Without this,
  // refreshing one size would quietly delete every other size from the
  // snapshot -- and a size whose fetch *failed* would be indistinguishable
  // from one that genuinely has nothing left. --replace opts into the wipe.
  const carried = options.replace
    ? []
    : (previous?.tires || []).filter(tire => !scrapedSizes.has(tire.size))

  const snapshot = {
    source: 'giga-tires.com',
    scrapedAt: new Date().toISOString(),
    sizes: [...new Set([...carried.map(tire => tire.size), ...scrapedSizes])].sort(),
    tires: [...tires, ...carried]
      .sort((a, b) => a.size.localeCompare(b.size) || a.price - b.price),
  }

  // Carried rows are byte-identical to their previous selves, so they simply
  // do not show up as changes.
  reportDiff(diffSnapshots(previous, snapshot), hadPrevious)
  if (carried.length) {
    const untouched = new Set(carried.map(tire => tire.size))
    console.log(`\nKept ${carried.length} tire(s) across ${untouched.size} size(s) this run did not cover.`)
  }

  console.log(`\nSnapshot now holds ${snapshot.tires.length} tires across ${snapshot.sizes.length} size(s).`)
  if (totalSkipped) console.log(`${totalSkipped} card(s) skipped for having no price.`)
  if (failures.length) console.log(`${failures.length} size(s) failed.`)

  if (options.dryRun) {
    console.log('\n--dry-run: nothing written.')
    return
  }

  await writeFile(options.out, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`\nWrote ${path.relative(ROOT, options.out)}`)
  console.log('Review it, then wire it into src/data/catalog.js when it looks right.')

  if (failures.length) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
