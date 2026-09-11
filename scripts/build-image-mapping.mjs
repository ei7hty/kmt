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
 * ## Selection: one photo per model, ranked by how many sizes it has
 *
 * The packet's whole point is one representative photo per MODEL, not one per
 * SKU -- a model sold in nine sizes needs one picture, not nine. `--models N`
 * ranks every distinct `name` in the snapshot by how many rows share it
 * (ties broken alphabetically by name, stated so a re-run is reproducible
 * without reading this file), takes the top N, and picks exactly one row per
 * chosen model (the row whose `id` sorts first -- also stated so it's not a
 * silent implementation detail).
 *
 * DELIBERATELY NOT ENCODED: no assumption about how many models exist, what
 * their names look like, or how many sizes a "normal" model has. `--models N`
 * asking for more than the snapshot actually contains is reported loudly (see
 * below), never silently satisfied with fewer -- the same principle
 * `--validation-count` was fixed to respect in scripts/scrape-tires.mjs
 * (#499): a count flag that quietly does less than it says is the trap, not
 * the size of the shortfall.
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
  --allow-fewer    If the snapshot has fewer than N distinct models, proceed
                    with all of them instead of refusing. Without this flag,
                    a shortfall is a hard error, named exactly -- never a
                    silent smaller run.
  --help           This message.

Every candidate is verified by feeding the generated mapping through the real
prepareImagePilot() before anything is written; a mapping that function
refuses is never saved.
`.trimStart()

function parseArgs(argv) {
  const options = { models: null, out: null, snapshot: DEFAULT_SNAPSHOT, allowFewer: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--allow-fewer') options.allowFewer = true
    else if (arg === '--models') options.models = Number(argv[++i])
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--snapshot') options.snapshot = path.resolve(argv[++i])
    else throw new Error(`Unknown argument ${arg}. Run with --help.`)
  }
  return options
}

function validateOptions(options) {
  if (!Number.isInteger(options.models) || options.models < 1) throw new Error('--models must be a positive integer.')
  if (typeof options.out !== 'string' || !options.out) throw new Error('--out is required.')
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
  console.log(`${ranking.length} distinct model(s) in ${options.snapshot}.`)

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

  const selected = ranking.slice(0, Math.min(options.models, ranking.length))
  console.log(`Selected ${selected.length} model(s):`)
  for (const [name, rows] of selected) console.log(`  ${name} (${rows.length} size${rows.length === 1 ? '' : 's'} in snapshot)`)

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
    console.error(`Generated mapping is ${mappingBytes.length} bytes, over prepareImagePilot's ${MAX_MAPPING_BYTES}-byte limit. Use fewer --models.`)
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
