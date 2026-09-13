#!/usr/bin/env node
/**
 * Which models still need a photo, ranked by how much of the catalogue each
 * one would cover.
 *
 *   node scripts/photo-gaps.mjs --from URL [--limit 100] [--brands a,b] [--out FILE]
 *
 * WHY THIS EXISTS. Every photo batch so far was a list somebody assembled by
 * hand, and the only mechanical alternative in the tree is
 * `build-image-mapping.mjs --models N`, whose own help says what is wrong with
 * it: it ranks by row count IN THE 4-SIZE SNAPSHOT, which overlapped the real
 * catalogue's top models 2 times out of 37 when that was measured. So the
 * choice of what to photograph next has been a judgement call made without the
 * one number that decides it.
 *
 * THE NUMBER THAT DECIDES IT. A photo belongs to a MODEL, and a model appears
 * in many sizes. "Royal Black Racing Trac" is one photo and 110 catalogue
 * listings. So the useful ranking is not how many models lack a photo -- it is
 * how many ROWS each missing photo would cover, which is what this sorts by.
 * Measured against the live catalogue on 2026-09-13: 6,116 rows, 1,354 models,
 * 1,165 of them with no photo at all, and the first five gaps alone worth 451
 * rows.
 *
 * WHAT IT READS. A catalogue endpoint, and nothing else. It never contacts a
 * supplier, never writes, and never needs a credential -- `/api/catalog` is the
 * public customer endpoint and this asks it the same question a browser does.
 *
 * `--from` IS REQUIRED AND HAS NO DEFAULT, on purpose. The local database
 * carries 4 sizes; the live one carries 511. Both are legitimate sources and
 * they give very different answers, and the expensive mistake -- scraping the
 * wrong hundred models from a home connection, one page at a time -- is
 * exactly what a quietly-wrong default would cause. Naming the source costs one
 * word and removes that failure. The scope of whatever answered is printed
 * above the results for the same reason.
 */
import { writeFileSync } from 'node:fs'

const HELP = `
node scripts/photo-gaps.mjs --from URL [options]

  --from URL       REQUIRED. A catalogue endpoint, e.g. http://127.0.0.1:4180
                   for the local database or https://kensmobiletire.com for the
                   live one. No default: the two answer differently and the
                   wrong answer costs a supplier scrape.
  --limit N        How many models to list (default 100, the batch size).
  --brands a,b     Only these brands, matched against the brand the catalogue
                   reports, case-insensitively.
  --out FILE       Write the model names to FILE, one per line, ready for
                   build-image-mapping.mjs --models-file. Without it they go to
                   stdout and the summary goes to stderr, so a pipe gets a
                   clean list.
  --help           This message.
`.trimStart()

/**
 * Group a catalogue into models, keeping only those still missing a photo.
 *
 * Pure, so the ranking can be tested without a server. `gap` is rows the model
 * appears in with no photo -- the coverage one photo session would buy -- and
 * it is the sort key for that reason. Ties break on total rows, then on name,
 * so the order is total and two runs over the same catalogue agree.
 *
 * IT RETURNS EVERY GAP, and the caller takes the batch it wants. This used to
 * slice to `limit` itself, and the summary then reported the slice as the
 * total: asked for twelve models it announced "12 model(s) still missing at
 * least one" when the real number was 1,324. A report that makes the remaining
 * work look finished is worse than no report, and the shape that caused it was
 * one function answering two questions.
 */
export function rankPhotoGaps(tires, { brands = [] } = {}) {
  const wanted = brands.map(brand => brand.trim().toLowerCase()).filter(Boolean)
  const byModel = new Map()

  for (const tire of tires) {
    const name = typeof tire?.name === 'string' ? tire.name.trim() : ''
    if (!name) continue
    // A row with no recognisable brand is still a row that needs a photo; it is
    // only excluded when the caller asked for specific brands.
    const brand = typeof tire?.brand === 'string' ? tire.brand : ''
    if (wanted.length && !wanted.includes(brand.toLowerCase())) continue

    const entry = byModel.get(name) ?? { name, brand, rows: 0, covered: 0, sizes: new Set() }
    entry.rows += 1
    if (tire?.imageUrl) entry.covered += 1
    if (tire?.size) entry.sizes.add(tire.size)
    if (!entry.brand && brand) entry.brand = brand
    byModel.set(name, entry)
  }

  const ranked = [...byModel.values()]
    .map(entry => ({
      name: entry.name,
      brand: entry.brand,
      rows: entry.rows,
      covered: entry.covered,
      gap: entry.rows - entry.covered,
      sizes: entry.sizes.size,
    }))
    .filter(model => model.gap > 0)
    .sort((a, b) => b.gap - a.gap || b.rows - a.rows || a.name.localeCompare(b.name))

  return ranked
}

/**
 * What the catalogue looks like as a whole, so a narrow source cannot pass
 * itself off as a wide one. `sizes` is the line that matters: 4 means somebody
 * pointed this at the local database.
 */
export function catalogueScope(tires) {
  const sizes = new Set(), models = new Set()
  let covered = 0
  for (const tire of tires) {
    if (tire?.size) sizes.add(tire.size)
    if (tire?.name) models.add(tire.name)
    if (tire?.imageUrl) covered += 1
  }
  return { rows: tires.length, sizes: sizes.size, models: models.size, covered }
}

/** Rows covered by the first n entries, so "how far does this batch get me" is answerable. */
export function cumulativeCoverage(ranked, n) {
  return ranked.slice(0, n).reduce((sum, model) => sum + model.gap, 0)
}

export function parseArgs(argv) {
  const options = { from: null, limit: 100, brands: [], out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    const value = argv[i + 1]
    if (arg === '--from') { options.from = value; i++; continue }
    if (arg === '--out') { options.out = value; i++; continue }
    if (arg === '--brands') { options.brands = String(value ?? '').split(',').map(b => b.trim()).filter(Boolean); i++; continue }
    if (arg === '--limit') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--limit must be a positive whole number; got ${value}`)
      options.limit = parsed; i++; continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!options.help && !options.from) {
    throw new Error('--from is required. Name the catalogue to read: http://127.0.0.1:4180 for the local\ndatabase (4 sizes) or https://kensmobiletire.com for the live one (511). They\nanswer differently and there is deliberately no default.')
  }
  return options
}

/** The summary, as lines, so the test can read it without capturing a stream. */
export function summarise(scope, ranked, limit) {
  const shown = Math.min(limit, ranked.length)
  const remaining = cumulativeCoverage(ranked, ranked.length) - cumulativeCoverage(ranked, shown)
  const lines = [
    `CATALOGUE  ${scope.rows} row(s), ${scope.models} model(s), ${scope.sizes} size(s)`,
    `           ${scope.covered} row(s) already show a photo`,
    // `ranked` is every gap, never the batch -- see rankPhotoGaps.
    `GAPS       ${ranked.length} model(s) still missing at least one, worth ${cumulativeCoverage(ranked, ranked.length)} row(s)`,
  ]
  if (scope.sizes <= 4) {
    lines.push('           NOTE: 4 sizes or fewer -- this looks like the local database, not the live catalogue.')
  }
  if (shown > 0) {
    lines.push(`BATCH      the ${shown} below cover ${cumulativeCoverage(ranked, shown)} row(s); ${remaining} row(s) would remain`)
  }
  return lines
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) { console.log(HELP); process.exit(0) }

    const url = new URL('/api/catalog', options.from)
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    const type = response.headers.get('content-type') || ''
    // Same check the customer flow makes: a dev server that does not know the
    // route answers 200 with index.html, and parsing that as JSON is a
    // confusing crash where a clear message belongs.
    if (!type.includes('application/json')) throw new Error(`${url} answered ${response.status} as ${type || 'an unknown type'}, not JSON. Is that a catalogue?`)
    const body = await response.json()
    if (!Array.isArray(body?.tires)) throw new Error(`${url} answered JSON, but with no tires array.`)

    const scope = catalogueScope(body.tires)
    const ranked = rankPhotoGaps(body.tires, { brands: options.brands })
    const summary = summarise(scope, ranked, options.limit)
    const batch = ranked.slice(0, options.limit)
    const names = batch.map(model => model.name)

    if (options.out) {
      writeFileSync(options.out, names.join('\n') + (names.length ? '\n' : ''))
      console.log(summary.join('\n'))
      console.log(`WROTE      ${names.length} model name(s) to ${options.out}`)
      console.log(`           node scripts/build-image-mapping.mjs --models-file ${options.out} --work ABS_WORK_DIR`)
    } else {
      // Summary to stderr so stdout is a clean list somebody can pipe.
      console.error(summary.join('\n'))
      console.error('')
      for (const model of batch) console.error(`  ${String(model.gap).padStart(4)} rows  ${model.sizes} size(s)  ${model.name}`)
      console.log(names.join('\n'))
    }
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
}
