#!/usr/bin/env node
/**
 * Build the owner's mapping.json for the product-photo pipeline -- pure local
 * computation over the committed scrape snapshot, no network, structurally
 * incapable of one (nothing in this file imports `fetch`, `browser-fetch.mjs`,
 * or anything that opens a socket).
 *
 * For hours the pipeline's blocker was described as "the mapping is
 * hand-authored": three of a candidate's four fields derive mechanically, and
 * `productUrl` supposedly had to be typed by a person. Measured against a real
 * snapshot row, that was never true -- `productUrl` is `row.source.url`, sitting
 * in the same object as the other three. It looked unusable only because
 * `productUrl()` (scripts/giga-tires.mjs) refused it, the `/tires/` prefix
 * paraphrase bug now fixed. The "hand-authored" requirement was a consequence
 * of that defect, not a property of the data, and it outlived the defect in
 * this project's own notes until someone re-measured rather than re-read them.
 *
 *   node scripts/build-image-mapping.mjs --models N --out ABS_PATH
 *     [--snapshot ABS_OR_REL_PATH] [--allow-fewer]
 *
 * ## What this does NOT do
 *
 * It does not fetch a product page, does not decide which image to use (that
 * is `collectImagePilot`, later, against a real fetch), and does not invent a
 * URL: every field is read or derived from a row already in the committed
 * snapshot. The one piece of judgment here is SELECTION -- which tires get a
 * photo this run -- and that is stated plainly below, not hidden in a helper.
 *
 * ## Selection: one photo per model -- from a list, or a quick approximation
 *
 * The packet's whole point is one representative photo per MODEL, not one per
 * SKU -- a model sold in nine sizes needs one picture, not nine. Whichever
 * selects the models, exactly one row per chosen model is picked (the row
 * whose `id` sorts first -- stated so it's not a silent implementation
 * detail).
 *
 * `--models-file ABS_PATH` names the exact models, one per line, in the order
 * a person or process decided they matter -- WHICH models get a photo is a
 * business decision, not something this script should guess at, and burying
 * that decision in a ranking heuristic makes it unauditable and liable to
 * silently change when the underlying data does. See
 * scripts/fixtures/top-models-2026-09-10.txt for the shape of such a list and
 * how one gets derived and provenanced.
 *
 * `--models N` is the "just give me some models" mode: ranks every distinct
 * `name` IN THIS SNAPSHOT ONLY by how many rows share it (ties broken
 * alphabetically by name, stated so a re-run is reproducible without reading
 * this file), takes the top N. THIS IS NOT CATALOGUE POPULARITY -- it is
 * popularity within whichever 4 sizes happen to be scraped, and the two can
 * diverge almost completely (measured 2026-09-10: the top 37 by snapshot row
 * count overlapped the top 37 by live-catalogue row count in only 2 of 37
 * models, because 478 of the snapshot's 703 models appear in it exactly once
 * -- nearly all ties). Good enough for "does the mapping mechanism work at
 * all," not a substitute for an actual priority list.
 *
 * DELIBERATELY NOT ENCODED, either mode: no assumption about how many models
 * exist, what their names look like, or how many sizes a "normal" model has.
 * A requested model with no snapshot row -- whether that's `--models N`
 * asking for more distinct models than exist, or `--models-file` naming one
 * that isn't there -- is reported loudly, by name where a name exists, never
 * silently satisfied with fewer. Same principle `--validation-count` was
 * fixed to respect in scripts/scrape-tires.mjs (#499): a count or list that
 * quietly does less than it says is the trap, not the size of the shortfall.
 *
 * ## The proof
 *
 * This script feeds its own output through the real `prepareImagePilot`
 * (scripts/image-pilot-packet.mjs) before writing anything, and refuses to
 * write if that refuses. `prepareImagePilot` re-derives every field of every
 * candidate against the snapshot independently -- a mapping it accepts is a
 * mapping the real packet builder will accept, which is a stronger guarantee
 * than this file agreeing with its own idea of the shape.
 *
 * ## Output path
 *
 * Absolute, required, and refused if it resolves inside this repository --
 * the same discipline `assertImagePilotOutput`/`readPrivateImageInput` already
 * apply to the packet itself, applied here to the mapping that feeds it, so a
 * mapping never lands in the tree by accident.
 */

import { readFileSync, existsSync, statSync, lstatSync, realpathSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sha256Bytes } from '../backend/image-assets.mjs'
import { supplierImageRevision } from '../backend/image-manifest.mjs'
import { deriveBrand } from '../src/data/brand.js'
import { productUrl } from './giga-tires.mjs'
import { prepareImagePilot } from './image-pilot-packet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SNAPSHOT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')
const MAX_MAPPING_BYTES = 65536 // prepareImagePilot's own limit -- see its `reject()` on mappingBytes.length

const HELP = `
Build the owner's product-photo mapping.json from the committed scrape
snapshot -- pure local computation, no network.

Usage:
  node scripts/build-image-mapping.mjs --models N --out ABS_PATH
    [--snapshot PATH] [--allow-fewer]

Options:
  --models N       How many models to include, one photo each -- ranked by
                    how many sizes each model has in the snapshot (most
                    first, ties broken alphabetically by name).
  --out ABS_PATH   Where to write mapping.json. Must be an absolute path
                    outside this repository; refused if the file already
                    exists (delete it first to regenerate).
  --snapshot PATH  Scrape snapshot to read (default: src/data/scraped-tires.json,
                    this repository's committed one).
  --allow-fewer    If some requested models have no row in the snapshot (or,
                    for --models, fewer than N distinct models exist at all),
                    proceed with whatever's available instead of refusing.
                    Without this flag, any shortfall is a hard error, every
                    missing model named -- never a silent smaller run.
  --brands A,B,C   Every model of these brands, in snapshot ranking order.
                    Matches the supplier's own slug (royal-black) or the
                    label a person writes (Royal Black), case-insensitively.
                    A brand that matches nothing is named, along with the
                    full list of what is available, and refuses unless
                    --allow-fewer is given.
  --help           This message.

--models, --models-file and --brands are mutually exclusive; exactly one is
required.

--brands reads each row's brand from the SUPPLIER'S OWN URL (the "-tires"
path segment), not from the display name: splitting "Royal Black Racing Trac"
on its first space gives "Royal", and multi-word brands make that silently
wrong. See src/data/brand.js.

--models N ranks models by ROW COUNT IN THIS SNAPSHOT ONLY, most first, ties
broken alphabetically. THIS IS NOT CATALOGUE POPULARITY: the snapshot covers
only 4 sizes, most models appear in it once or twice, and the top N by
snapshot count can overlap the real top N by live-catalogue count almost not
at all (measured 2026-09-10: 2 of 37) -- a "just give me some models" mode,
not a business ranking. For an actual priority list, use --models-file.

--models-file ABS_PATH names the exact models to use, one per line (blank
lines and #-comment lines ignored), in file order -- the ranking is then
whatever business decision produced that file, not a heuristic guessed from
whatever data happens to be on disk. See scripts/fixtures/top-models-2026-09-10.txt
for the shape and an example of how one such file is derived and provenanced.

Every candidate is verified by feeding the generated mapping through the real
prepareImagePilot() before anything is written; a mapping that function
refuses is never saved.
`.trimStart()

function parseArgs(argv) {
  const options = { models: null, modelsFile: null, brands: null, out: null, snapshot: DEFAULT_SNAPSHOT, allowFewer: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--allow-fewer') options.allowFewer = true
    else if (arg === '--models') options.models = Number(argv[++i])
    else if (arg === '--models-file') options.modelsFile = path.resolve(argv[++i])
    else if (arg === '--brands') options.brands = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--snapshot') options.snapshot = path.resolve(argv[++i])
    else throw new Error(`Unknown argument ${arg}. Run with --help.`)
  }
  return options
}

function validateOptions(options) {
  const selectors = [['--models', options.models], ['--models-file', options.modelsFile], ['--brands', options.brands]]
    .filter(([, value]) => value !== null)
  if (selectors.length > 1) throw new Error(`${selectors.map(([flag]) => flag).join(', ')} are mutually exclusive; pass exactly one.`)
  if (selectors.length === 0) throw new Error('Exactly one of --models, --models-file or --brands is required.')
  if (options.brands !== null && !options.brands.length) throw new Error('--brands needs at least one brand.')
  if (options.models !== null && (!Number.isInteger(options.models) || options.models < 1)) throw new Error('--models must be a positive integer.')
  if (typeof options.out !== 'string' || !options.out) throw new Error('--out is required.')
}

/** Newline-delimited model names -- blank lines and `#`-comment lines ignored, order preserved. */
export function namesFromFile(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    .split(/\r\n|\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * Splits a requested list of model names against what's actually in the
 * snapshot (`byName`, from `rankModels`) -- `selected` in the order
 * requested, `missing` named exactly. The one place both `--models` and
 * `--models-file` funnel through, so a shortfall is reported identically
 * regardless of which produced the request.
 */
/**
 * Model names belonging to the requested brands, plus the brands that matched
 * nothing and the full list of what is available.
 *
 * BRAND COMES FROM THE SUPPLIER'S URL, NOT THE DISPLAY NAME. `deriveBrand`
 * (src/data/brand.js) reads the `<brand>-tires` segment out of the listing URL
 * the supplier itself published. Splitting "Royal Black Racing Trac" on its
 * first space would give "Royal", and there are multi-word brands where that
 * is simply wrong; reading the segment is reading data.
 *
 * A request matches either form, case-insensitively: the slug as it appears in
 * the URL (`royal-black`) or the label as a person would write it
 * (`Royal Black`). Nobody should have to know which one this file wanted.
 *
 * Within a brand, models come back in the snapshot's own ranking order, so a
 * brand request composes with `--allow-fewer` and the shortfall reporting the
 * other two selectors already use.
 */
export function namesForBrands(ranking, tires, requested) {
  const brandOf = new Map()
  const available = new Map()
  for (const tire of tires) {
    const brand = deriveBrand(tire?.source?.url)
    if (!brand) continue
    brandOf.set(tire.name, brand.slug)
    available.set(brand.slug, brand.label)
  }
  const wanted = new Set()
  const unmatched = []
  for (const entry of requested) {
    const needle = String(entry).trim().toLowerCase()
    if (!needle) continue
    const slug = available.has(needle) ? needle
      : [...available].find(([, label]) => label.toLowerCase() === needle)?.[0]
    if (slug) wanted.add(slug)
    else unmatched.push(entry)
  }
  const names = ranking.map(([name]) => name).filter(name => wanted.has(brandOf.get(name)))
  return { names, unmatched, available: [...available.values()].sort() }
}

export function selectByNames(byName, names) {
  const selected = [], missing = []
  for (const name of names) {
    if (byName.has(name)) selected.push([name, byName.get(name)])
    else missing.push(name)
  }
  return { selected, missing }
}

/**
 * Refuses everything `assertImagePilotOutput` refuses about the packet
 * directory (scripts/image-pilot-packet.mjs:67-78), applied to a single
 * output FILE instead of a directory: relative paths, paths that resolve
 * inside this repository or under a `public`/`dist` component anywhere (a
 * mapping is private provenance, never something a build could ship), a
 * symlink anywhere in the parent chain (so a real mistake here can't be
 * redirected outside where it looks like it's writing), and an existing
 * target -- no silent overwrite, delete it by hand to regenerate.
 */
function assertMappingOutputPath(filename) {
  if (!path.isAbsolute(filename)) throw new Error('--out must be an absolute path.')
  const resolved = path.resolve(filename)
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) throw new Error('--out must be outside this repository.')
  if (resolved.split(path.sep).some(part => ['public', 'dist'].includes(part.toLowerCase()))) {
    throw new Error('--out must not pass through a public/ or dist/ directory.')
  }
  const parent = path.dirname(resolved)
  // `statSync` (follows symlinks/junctions) for existence -- the parent may
  // legitimately BE a symlink pointing at a real directory, which the
  // symlink-chain check just below refuses on its own terms; `lstatSync`
  // here would misreport a valid junction as "not a directory" and mask that
  // with the wrong error.
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`--out's directory does not exist: ${parent}`)
  if (realpathSync(parent) !== path.resolve(parent)) throw new Error(`--out's directory resolves through a symlink: ${parent}`)
  let component = path.parse(parent).root
  for (const part of path.relative(component, parent).split(path.sep).filter(Boolean)) {
    component = path.join(component, part)
    if (lstatSync(component).isSymbolicLink()) throw new Error(`--out's path passes through a symlink at: ${component}`)
  }
  if (existsSync(resolved)) throw new Error(`Refusing to overwrite an existing file: ${resolved}`)
}

/**
 * Every distinct `name` in `tires`, with its rows, ranked by row count
 * (most first) and alphabetically by name on a tie -- stated here because a
 * ranking with no declared tie-break is not reproducible from the same input.
 */
export function rankModels(tires) {
  const byName = new Map()
  for (const tire of tires) {
    if (!byName.has(tire.name)) byName.set(tire.name, [])
    byName.get(tire.name).push(tire)
  }
  return [...byName.entries()].sort(([nameA, rowsA], [nameB, rowsB]) => rowsB.length - rowsA.length || nameA.localeCompare(nameB))
}

/** The one row a model's several sizes reduce to -- the row whose `id` sorts first, so this is reproducible without reading the code. */
export function pickRepresentativeTire(rows) {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))[0]
}

/**
 * One candidate for `mapping.candidates`, built entirely from fields already
 * on `tire` -- nothing here is invented. `productUrl(tire.source.url)` both
 * canonicalises the URL (strips a fragment, refuses it if it's not actually
 * a valid product URL under the current robots.txt-derived rules) and
 * doubles as this candidate's own proof that the URL is fetchable at all.
 */
export function buildCandidate(tire) {
  return {
    supplierId: tire.id,
    supplierSku: tire.source.sku,
    productUrl: productUrl(tire.source.url),
    revision: supplierImageRevision(tire),
  }
}

function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  if (options.help) { console.log(HELP); return }

  try { validateOptions(options) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  let assertOutputError
  try { assertMappingOutputPath(options.out) }
  catch (error) { assertOutputError = error } // checked early so a bad --out fails before any real work, but reported after --help/validation for a consistent error order

  if (assertOutputError) { console.error(assertOutputError.message); process.exitCode = 1; return }

  const snapshotBytes = readFileSync(options.snapshot)
  const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshotBytes))
  const tires = Array.isArray(snapshot.tires) ? snapshot.tires : []

  const ranking = rankModels(tires)
  const byName = new Map(ranking)
  console.log(`${ranking.length} distinct model(s) in ${options.snapshot}.`)

  // Requested names: from the file, in file order; or the top N by snapshot
  // row count, which for --models is ALWAYS a subset of `ranking`'s own
  // names, so selectByNames below can never find one of these "missing" --
  // only a genuine --models-file entry with no snapshot row can be.
  let requestedNames
  if (options.brands) {
    const { names, unmatched, available } = namesForBrands(ranking, tires, options.brands)
    if (unmatched.length) {
      // Naming what IS available, at the moment of the miss. A brand can be
      // typed as the supplier's slug or as a label, and nobody should have to
      // guess which spelling this file wanted, or run a second command to find
      // out.
      console.error(`${unmatched.length} requested brand(s) are not in ${options.snapshot}: ${unmatched.join(', ')}`)
      console.error(`Available brands (${available.length}): ${available.join(', ')}`)
      if (!options.allowFewer) {
        console.error('Refusing rather than quietly building a mapping for the brands that did match. Pass --allow-fewer to proceed with those.')
        process.exitCode = 1
        return
      }
    }
    if (!names.length) {
      console.error('No models matched the requested brand(s); nothing to write.')
      process.exitCode = 1
      return
    }
    console.log(`${names.length} model(s) across ${options.brands.length - unmatched.length} brand(s).`)
    requestedNames = names
  } else if (options.modelsFile) {
    requestedNames = namesFromFile(readFileSync(options.modelsFile))
  } else {
    if (options.models > ranking.length) {
      const message = `Requested --models ${options.models}; only ${ranking.length} distinct models exist in the snapshot.`
      if (!options.allowFewer) {
        console.error(message)
        console.error('Refusing to silently produce fewer than requested. Pass --allow-fewer to proceed with all available models instead.')
        process.exitCode = 1
        return
      }
      console.error(`${message} Proceeding with all ${ranking.length}, per --allow-fewer.`)
    }
    requestedNames = ranking.slice(0, options.models).map(([name]) => name)
  }

  const { selected, missing } = selectByNames(byName, requestedNames)

  if (missing.length) {
    console.error(`${missing.length} requested model(s) have no row in the snapshot:`)
    for (const name of missing) console.error(`  ${name}`)
    if (!options.allowFewer) {
      console.error('Refusing to silently drop a requested model. Pass --allow-fewer to proceed with only the models that do exist.')
      process.exitCode = 1
      return
    }
    console.error(`Proceeding with the ${selected.length} model(s) that do exist, per --allow-fewer.`)
  }

  console.log(`Selected ${selected.length} model(s):`)
  for (const [name, rows] of selected) console.log(`  ${name} (${rows.length} size${rows.length === 1 ? '' : 's'} in snapshot)`)

  if (!selected.length) throw new Error('No models selected -- refusing to write an empty mapping.')

  const candidates = selected.map(([, rows]) => buildCandidate(pickRepresentativeTire(rows)))

  const seenIds = new Set(), seenUrls = new Set()
  for (const candidate of candidates) {
    if (seenIds.has(candidate.supplierId)) throw new Error(`Duplicate supplierId produced: ${candidate.supplierId}`)
    if (seenUrls.has(candidate.productUrl)) throw new Error(`Duplicate productUrl produced: ${candidate.productUrl}`)
    seenIds.add(candidate.supplierId); seenUrls.add(candidate.productUrl)
  }

  const mapping = { version: 1, inputDigest: sha256Bytes(snapshotBytes), candidates }
  const mappingBytes = Buffer.from(JSON.stringify(mapping))

  if (mappingBytes.length > MAX_MAPPING_BYTES) {
    console.error(`Generated mapping is ${mappingBytes.length} bytes, over prepareImagePilot's ${MAX_MAPPING_BYTES}-byte limit. Request fewer models.`)
    process.exitCode = 1
    return
  }

  // The proof, not a claim about it: prepareImagePilot re-derives every field
  // against the snapshot independently. If it throws, nothing is written.
  const plan = prepareImagePilot(snapshotBytes, mappingBytes)

  const fd = openSync(options.out, 'wx', 0o600)
  try { writeSync(fd, mappingBytes); fsyncSync(fd) } finally { closeSync(fd) }

  console.log(`\nWrote ${mappingBytes.length} bytes to ${options.out}`)
  console.log(`inputDigest=${mapping.inputDigest}`)
  console.log(`candidates=${candidates.length}`)
  console.log(`accepted by prepareImagePilot: baseline size ${plan.baseline.size}`)
}

// Only run as a side effect of executing this file directly -- `rankModels`,
// `pickRepresentativeTire` and `buildCandidate` are exported for direct unit
// testing (build-image-mapping.test.mjs), and importing a module must never
// itself write a file or read argv that belongs to whatever imported it. A
// bare, unguarded `main()` here did exactly that the first time this file
// was imported rather than run -- caught by actually running the test file,
// not by reading the code. `pathToFileURL`, not a manual `file://` template
// literal: a plain Windows path (`C:\...`) needs its backslashes and drive
// letter escaped the same way `import.meta.url` already is, or the two never
// compare equal on this platform even when they name the same file.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
