import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { rankModels, pickRepresentativeTire, buildCandidate, namesFromFile, namesForBrands, selectByNames } from './build-image-mapping.mjs'
import { prepareImagePilot } from './image-pilot-packet.mjs'
import { sha256Bytes } from '../backend/image-assets.mjs'
import { supplierImageRevision } from '../backend/image-manifest.mjs'

const SCRIPT = fileURLToPath(new URL('./build-image-mapping.mjs', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..')

/** A minimal, valid tire row -- the fields prepareImagePilot and supplierImageRevision actually read. */
function tire({ id, name, url, sku = id.toUpperCase() }) {
  return {
    id, name, size: '205/65R15', price: 80, inStock: true, category: 'All Season', description: 'Fixture',
    source: { sku, url },
  }
}

/** N distinct models, each with `sizes` rows, ids/urls unique across the whole set. */
function snapshotWithModels(specs) {
  const tires = []
  for (const { name, sizes } of specs) {
    for (let i = 0; i < sizes; i++) {
      const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`
      tires.push(tire({ id, name, sku: `${id}-sku`, url: `https://www.giga-tires.com/205-65-15/fixture-tires/${id}/tirecode/${id}` }))
    }
  }
  return { tires }
}

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmt-image-mapping-test-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort on Windows locks */ } })
  return dir
}

function writeSnapshot(dir, snapshot) {
  const file = path.join(dir, 'snapshot.json')
  writeFileSync(file, JSON.stringify(snapshot))
  return file
}

function run(args, options = {}) {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', ...options })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// The pure helpers, unit-tested directly.

test('rankModels ranks by row count, ties broken alphabetically by name', () => {
  const tires = [
    ...['a', 'b'].map(i => tire({ id: `two-${i}`, name: 'Two Rows', url: `https://www.giga-tires.com/205-65-15/x/two-${i}/tirecode/${i}` })),
    tire({ id: 'one-a', name: 'One Row Z', url: 'https://www.giga-tires.com/205-65-15/x/one-a/tirecode/a' }),
    tire({ id: 'one-b', name: 'One Row A', url: 'https://www.giga-tires.com/205-65-15/x/one-b/tirecode/b' }),
  ]
  const ranked = rankModels(tires)
  assert.deepEqual(ranked.map(([name]) => name), ['Two Rows', 'One Row A', 'One Row Z'])
  assert.equal(ranked[0][1].length, 2)
})

test('pickRepresentativeTire chooses the row whose id sorts first', () => {
  const rows = [tire({ id: 'z-row', name: 'M' }), tire({ id: 'a-row', name: 'M' }), tire({ id: 'm-row', name: 'M' })]
  assert.equal(pickRepresentativeTire(rows).id, 'a-row')
})

test('buildCandidate reads supplierId/supplierSku/revision straight off the row and canonicalises productUrl', () => {
  const row = tire({ id: 'row-1', name: 'M', sku: 'SKU-1', url: 'https://www.giga-tires.com/205-65-15/x/m/tirecode/1#ignored' })
  const candidate = buildCandidate(row)
  assert.deepEqual(Object.keys(candidate).sort(), ['productUrl', 'revision', 'supplierId', 'supplierSku'])
  assert.equal(candidate.supplierId, 'row-1')
  assert.equal(candidate.supplierSku, 'SKU-1')
  assert.equal(candidate.productUrl, 'https://www.giga-tires.com/205-65-15/x/m/tirecode/1') // fragment stripped by productUrl()
  assert.equal(candidate.revision, supplierImageRevision(row))
})

test('buildCandidate refuses a row whose URL productUrl() would refuse', () => {
  const row = tire({ id: 'row-1', name: 'M', url: 'https://www.giga-tires.com/cart/tirecode/1' })
  assert.throws(() => buildCandidate(row), /Not a giga-tires product URL/)
})

// ---------------------------------------------------------------------------
// The CLI, end to end -- proof via the real prepareImagePilot, not a hand check.

test('generates a mapping that the real prepareImagePilot accepts, one candidate per model, most-rows-first', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([
    { name: 'Big Model', sizes: 4 }, { name: 'Medium Model', sizes: 2 }, { name: 'Small Model', sizes: 1 },
  ]))
  const out = path.join(dir, 'mapping.json')
  const result = run(['--models', '2', '--snapshot', snapshotFile, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Selected 2 model\(s\)/)
  assert.match(result.stdout, /Big Model \(4 sizes/)
  assert.match(result.stdout, /Medium Model \(2 sizes/)
  assert.doesNotMatch(result.stdout, /Small Model/)

  const mappingBytes = readFileSync(out)
  const inputBytes = readFileSync(snapshotFile)
  const mapping = JSON.parse(mappingBytes)
  assert.equal(mapping.version, 1)
  assert.equal(mapping.inputDigest, sha256Bytes(inputBytes))
  assert.equal(mapping.candidates.length, 2)

  // THE test: fed through the real function every candidate is re-derived against, not a copy of its rules.
  const plan = prepareImagePilot(inputBytes, mappingBytes)
  assert.equal(plan.baseline.size, 2)
})

test('refuses to overwrite an existing output file', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const out = path.join(dir, 'mapping.json')
  assert.equal(run(['--models', '1', '--snapshot', snapshotFile, '--out', out]).status, 0)
  const second = run(['--models', '1', '--snapshot', snapshotFile, '--out', out])
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /Refusing to overwrite/)
})

test('is deterministic: identical inputs produce byte-identical mappings', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([
    { name: 'A', sizes: 3 }, { name: 'B', sizes: 2 }, { name: 'C', sizes: 1 },
  ]))
  const outA = path.join(dir, 'a.json'), outB = path.join(dir, 'b.json')
  assert.equal(run(['--models', '3', '--snapshot', snapshotFile, '--out', outA]).status, 0)
  assert.equal(run(['--models', '3', '--snapshot', snapshotFile, '--out', outB]).status, 0)
  assert.deepEqual(readFileSync(outA), readFileSync(outB))
})

test('refuses a relative --out', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const result = run(['--models', '1', '--snapshot', snapshotFile, '--out', 'relative.json'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /absolute path/)
})

test('refuses an --out that resolves inside this repository', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const insideRepo = path.join(REPO_ROOT, 'scripts', 'should-not-be-written.json')
  const result = run(['--models', '1', '--snapshot', snapshotFile, '--out', insideRepo])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /outside this repository/)
  assert.equal(existsSync(insideRepo), false)
})

test('refuses an --out whose parent directory is reached through a symlink', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const real = path.join(dir, 'real-dir')
  const link = path.join(dir, 'linked-dir')
  mkdirSync(real)
  try { symlinkSync(real, link, 'junction') } catch { symlinkSync(real, link) }
  const result = run(['--models', '1', '--snapshot', snapshotFile, '--out', path.join(link, 'mapping.json')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink/)
})

test('refuses --models greater than the snapshot has, by name, unless --allow-fewer is given', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'Only Model', sizes: 1 }]))
  const out = path.join(dir, 'mapping.json')
  const refused = run(['--models', '5', '--snapshot', snapshotFile, '--out', out])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /Requested --models 5; only 1 distinct models? exist/)
  assert.equal(existsSync(out), false)

  const allowed = run(['--models', '5', '--allow-fewer', '--snapshot', snapshotFile, '--out', out])
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.match(allowed.stderr, /Proceeding with all 1/)
  const mapping = JSON.parse(readFileSync(out))
  assert.equal(mapping.candidates.length, 1)
})

test('refuses rather than writes a mapping over prepareImagePilot\'s 65536-byte limit', t => {
  const dir = sandbox(t)
  // ~400 distinct one-row models comfortably clears the 65536-byte candidate limit
  // (measured: each candidate serialises to roughly 200-250 bytes in this fixture's shape).
  const specs = Array.from({ length: 400 }, (_, i) => ({ name: `Model ${String(i).padStart(4, '0')}`, sizes: 1 }))
  const snapshotFile = writeSnapshot(dir, snapshotWithModels(specs))
  const out = path.join(dir, 'mapping.json')
  const result = run(['--models', '400', '--allow-fewer', '--snapshot', snapshotFile, '--out', out])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /over prepareImagePilot's 65536-byte limit/)
  assert.equal(existsSync(out), false)
})

test('duplicate model names in the snapshot are one model, not two -- rows still merge under the same name', t => {
  const dir = sandbox(t)
  // Two separately-recorded rows sharing a name (e.g. re-scraped) must count as
  // one model with two sizes, not two one-size models -- rankModels groups by
  // name, not by row identity.
  const snapshotFile = writeSnapshot(dir, { tires: [
    tire({ id: 'dup-0', name: 'Repeated', url: 'https://www.giga-tires.com/205-65-15/x/dup-0/tirecode/0' }),
    tire({ id: 'dup-1', name: 'Repeated', url: 'https://www.giga-tires.com/205-65-15/x/dup-1/tirecode/1' }),
  ] })
  const out = path.join(dir, 'mapping.json')
  const result = run(['--models', '1', '--snapshot', snapshotFile, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Repeated \(2 sizes/)
  const mapping = JSON.parse(readFileSync(out))
  assert.equal(mapping.candidates.length, 1)
  assert.equal(mapping.candidates[0].supplierId, 'dup-0') // lexicographically first id
})

// ---------------------------------------------------------------------------
// --models-file: an explicit, provenanced list of names, not a heuristic
// ranking over whatever data happens to be on disk (2026-09-10: --models N's
// own ranking is only over the snapshot, which measurably diverges from
// live-catalogue popularity almost completely -- 2 of 37 overlap).

test('namesFromFile ignores blank lines and #-comments, preserves order', () => {
  const bytes = Buffer.from('# header\n\nFirst Model\n  Second Model  \n# a comment\nThird Model\n')
  assert.deepEqual(namesFromFile(bytes), ['First Model', 'Second Model', 'Third Model'])
})

test('selectByNames splits requested names into found (in request order) and missing (by name)', () => {
  const byName = new Map([['A', ['rowA']], ['B', ['rowB']]])
  const { selected, missing } = selectByNames(byName, ['B', 'A', 'Nonexistent'])
  assert.deepEqual(selected.map(([name]) => name), ['B', 'A'])
  assert.deepEqual(missing, ['Nonexistent'])
})

test('--models and --models-file are mutually exclusive', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const listFile = path.join(dir, 'list.txt')
  writeFileSync(listFile, 'M\n')
  const result = run(['--models', '1', '--models-file', listFile, '--snapshot', snapshotFile, '--out', path.join(dir, 'mapping.json')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /mutually exclusive/)
})

test('no selector at all is a required-argument error', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  const result = run(['--snapshot', snapshotFile, '--out', path.join(dir, 'mapping.json')])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Exactly one of --models, --models-file or --brands is required/)
})

test('two selectors at once are refused, and the message names which two', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'M', sizes: 1 }]))
  for (const pair of [['--models', '1', '--brands', 'x'], ['--models-file', path.join(dir, 'l.txt'), '--brands', 'x']]) {
    const result = run(['--snapshot', snapshotFile, '--out', path.join(dir, 'mapping.json'), ...pair])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /mutually exclusive/)
    assert.match(result.stderr, /--brands/, 'the message names the flags actually given')
  }
})

test('--models-file selects the named models, in file order, ignoring row count', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([
    { name: 'Popular', sizes: 9 }, { name: 'Rare', sizes: 1 }, { name: 'Unrequested', sizes: 5 },
  ]))
  const listFile = path.join(dir, 'list.txt')
  writeFileSync(listFile, '# only these two, rare one first on purpose\nRare\nPopular\n')
  const out = path.join(dir, 'mapping.json')
  const result = run(['--models-file', listFile, '--snapshot', snapshotFile, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Selected 2 model\(s\)/)
  assert.doesNotMatch(result.stdout, /Unrequested/)

  const mappingBytes = readFileSync(out)
  const inputBytes = readFileSync(snapshotFile)
  const plan = prepareImagePilot(inputBytes, mappingBytes) // the proof again, not a hand check
  assert.equal(plan.baseline.size, 2)
})

test('--models-file refuses by name when a listed model has no snapshot row, unless --allow-fewer', t => {
  const dir = sandbox(t)
  const snapshotFile = writeSnapshot(dir, snapshotWithModels([{ name: 'Exists', sizes: 1 }]))
  const listFile = path.join(dir, 'list.txt')
  writeFileSync(listFile, 'Exists\nDoes Not Exist\n')
  const out = path.join(dir, 'mapping.json')

  const refused = run(['--models-file', listFile, '--snapshot', snapshotFile, '--out', out])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /1 requested model\(s\) have no row in the snapshot/)
  assert.match(refused.stderr, /Does Not Exist/)
  assert.equal(existsSync(out), false)

  const allowed = run(['--models-file', listFile, '--allow-fewer', '--snapshot', snapshotFile, '--out', out])
  assert.equal(allowed.status, 0, allowed.stderr)
  const mapping = JSON.parse(readFileSync(out))
  assert.equal(mapping.candidates.length, 1)
})

test('the committed top-models fixture selects 37 distinct candidates from the real snapshot, accepted by prepareImagePilot', t => {
  const dir = sandbox(t)
  const listFile = path.join(REPO_ROOT, 'scripts', 'fixtures', 'top-models-2026-09-10.txt')
  const snapshotFile = path.join(REPO_ROOT, 'src', 'data', 'scraped-tires.json')
  const out = path.join(dir, 'mapping.json')
  const result = run(['--models-file', listFile, '--snapshot', snapshotFile, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Selected 37 model\(s\)/)

  const mappingBytes = readFileSync(out)
  const mapping = JSON.parse(mappingBytes)
  assert.equal(mapping.candidates.length, 37)
  assert.equal(new Set(mapping.candidates.map(c => c.supplierId)).size, 37)
  assert.equal(new Set(mapping.candidates.map(c => c.productUrl)).size, 37)

  const plan = prepareImagePilot(readFileSync(snapshotFile), mappingBytes)
  assert.equal(plan.baseline.size, 37)
})

/**
 * `--brands`: the brand comes from the supplier's own URL segment, never from
 * splitting a display name. "Royal Black Racing Trac" split on its first space
 * gives "Royal", which is a brand that does not exist.
 */
const BRAND_ROWS = [
  { id: 'a', name: 'Royal Black Racing Trac', size: '225/50R17', source: { url: 'https://www.giga-tires.com/225-50-17/royal-black-tires/racing-trac/tirecode/1' } },
  { id: 'b', name: 'Royal Black Milage SUV/CUV', size: '265/70R16', source: { url: 'https://www.giga-tires.com/265-70-16/royal-black-tires/milage/tirecode/2' } },
  { id: 'c', name: 'Accelera Iota EVT', size: '205/55R16', source: { url: 'https://www.giga-tires.com/205-55-16/accelera-tires/iota-evt/tirecode/3' } },
  { id: 'd', name: 'Waterfall Quattro', size: '205/65R15', source: { url: 'https://www.giga-tires.com/205-65-15/waterfall-tires/quattro/tirecode/4' } },
]

test('--brands matches the supplier slug and the human label alike', () => {
  const ranking = rankModels(BRAND_ROWS)
  for (const request of [['royal-black'], ['Royal Black'], ['ROYAL BLACK'], ['  royal-black  ']]) {
    const { names, unmatched } = namesForBrands(ranking, BRAND_ROWS, request)
    assert.deepEqual(unmatched, [], `should match: ${JSON.stringify(request)}`)
    assert.deepEqual(names.sort(), ['Royal Black Milage SUV/CUV', 'Royal Black Racing Trac'])
  }
})

test('--brands never infers a brand from the display name', () => {
  // "Royal" is the first word of two model names and is not a brand. A request
  // for it must miss, not quietly return the Royal Black models.
  const ranking = rankModels(BRAND_ROWS)
  const { names, unmatched } = namesForBrands(ranking, BRAND_ROWS, ['Royal'])
  assert.deepEqual(names, [])
  assert.deepEqual(unmatched, ['Royal'])
})

test('--brands reports what is available when a brand misses', () => {
  const ranking = rankModels(BRAND_ROWS)
  const { unmatched, available } = namesForBrands(ranking, BRAND_ROWS, ['Nonesuch', 'accelera'])
  assert.deepEqual(unmatched, ['Nonesuch'])
  assert.deepEqual(available, ['Accelera', 'Royal Black', 'Waterfall'])
})

test('--brands returns models in the snapshot ranking order it was given', () => {
  const ranking = rankModels(BRAND_ROWS)
  const { names } = namesForBrands(ranking, BRAND_ROWS, ['royal-black', 'accelera', 'waterfall'])
  const order = ranking.map(([name]) => name).filter(name => names.includes(name))
  assert.deepEqual(names, order, 'brand selection must not reorder relative to the ranking')
})

test('a row whose URL has no brand segment is skipped, not guessed at', () => {
  const rows = [...BRAND_ROWS, { id: 'e', name: 'Mystery Tire', size: '205/65R15', source: { url: 'https://www.giga-tires.com/nonsense' } }]
  const { available } = namesForBrands(rankModels(rows), rows, ['royal-black'])
  assert.ok(!available.includes('Mystery'), 'an unparseable URL contributes no brand')
})
