import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KNOWN_UNRESOLVED, LOAD_INDEX_KG, MAX_CATEGORY_CHARS, SIDEWALL_CODES, SPEED_SYMBOL_KMH,
  describeTireSpec, milesPerHourFromKph, parseTireSpec, poundsFromKilograms,
} from './tire-spec.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')

test('the three strings a customer reads today become plain English', () => {
  const uhp = describeTireSpec('Ultra High Performance All Season · 94V BSW')
  assert.equal(uhp.category, 'Ultra High Performance All Season')
  assert.deepEqual(uhp.points, [
    'Carries up to 1,477 lb per tire (load index 94).',
    'Rated to 149 mph (speed rating V).',
    'Black sidewall.',
  ])

  const xl = describeTireSpec('High Performance All Season · XL 98W BSW')
  assert.deepEqual(xl.points, [
    'Carries up to 1,653 lb per tire (load index 98).',
    'Rated to 168 mph (speed rating W).',
    'Extra load (XL) — rated to carry more than a standard tire of the same size.',
    'Black sidewall.',
  ])

  // The category is passed through, never rewritten: "Racing" is already plain
  // English and inventing something friendlier would be marketing copy.
  assert.equal(describeTireSpec('Racing · XL 98W BSW').category, 'Racing')
})

test('pounds and miles per hour are COMPUTED from the standard tables, never stored beside them', () => {
  // Two numbers encoding one fact agree on the day they are typed and drift
  // afterwards. So the tables hold kg and km/h only, and these conversions are
  // the single place the other unit exists. Changing the factor must move
  // every pound figure in the file, which is what these assertions pin.
  for (const [index, kg, lb] of [[92, 630, 1389], [94, 670, 1477], [98, 750, 1653], [112, 1120, 2469], [116, 1250, 2756]]) {
    assert.equal(LOAD_INDEX_KG[index], kg, `load index ${index}`)
    assert.equal(poundsFromKilograms(kg), lb, `load index ${index} in pounds`)
    assert.equal(parseTireSpec(`Touring · ${index}H BSW`).loadLb, lb)
  }
  for (const [symbol, kmh, mph] of [['Q', 160, 99], ['R', 170, 106], ['S', 180, 112], ['T', 190, 118], ['H', 210, 130], ['V', 240, 149], ['W', 270, 168], ['Y', 300, 186]]) {
    assert.equal(SPEED_SYMBOL_KMH[symbol], kmh, `speed ${symbol}`)
    assert.equal(milesPerHourFromKph(kmh), mph, `speed ${symbol} in mph`)
    assert.equal(parseTireSpec(`Touring · 94${symbol} BSW`).speedMph, mph)
  }
})

test('the speed table is not alphabetical, and H sits between U and V', () => {
  // The usual way one of these tables gets broken is somebody tidying it into
  // alphabetical order. H certifies 210 km/h, above U's 200 and below V's 240.
  assert.ok(SPEED_SYMBOL_KMH.U < SPEED_SYMBOL_KMH.H)
  assert.ok(SPEED_SYMBOL_KMH.H < SPEED_SYMBOL_KMH.V)
  assert.equal(SPEED_SYMBOL_KMH.H, 210)
})

test('a load index outside the table is unresolved, never interpolated', () => {
  // The table is not linear -- the step is 20 kg at index 94 and 35 kg at 115 --
  // so an interpolated weight would be a confident wrong answer on a customer's
  // screen. 150 is not a real passenger load index and must not produce a number.
  const spec = parseTireSpec('Touring · 150H BSW')
  assert.equal(spec.loadIndex, null)
  assert.equal(spec.loadKg, null)
  assert.equal(spec.loadLb, null)
  assert.deepEqual(spec.unresolved, ['150'])
  // The other half of the same token still resolves: one unknown must not
  // discard a fact the string genuinely carries.
  assert.equal(spec.speedMph, 130)
})

test('an unknown speed symbol leaves the load index intact, and vice versa', () => {
  const unknownSpeed = parseTireSpec('Touring · 94Z BSW')
  assert.equal(unknownSpeed.loadLb, 1477)
  assert.equal(unknownSpeed.speedSymbol, null)
  assert.deepEqual(unknownSpeed.unresolved, ['Z'])

  const bothUnknown = parseTireSpec('Touring · 150Z BSW')
  assert.deepEqual(bothUnknown.unresolved, ['150', 'Z'])
})

test('a load range carries its own ply count, so the two cannot disagree', () => {
  for (const [token, code, ply] of [['B/4PLY', 'B', 4], ['C/6PLY', 'C', 6], ['D/8PLY', 'D', 8], ['E/10PLY', 'E', 10]]) {
    const spec = parseTireSpec(`All Terrain · ${token} BSW`)
    assert.deepEqual(spec.loadRange, { code, ply, text: `Load range ${code} — a ${ply}-ply rating` })
  }
  assert.ok(describeTireSpec('All Terrain · E/10PLY BSW').points.includes('Load range E — a 10-ply rating.'))
})

test('every sidewall code this expands is reachable from a real spec string', () => {
  for (const [code, text] of Object.entries(SIDEWALL_CODES)) {
    assert.deepEqual(parseTireSpec(`Touring · 94H ${code}`).sidewall, { code, text })
  }
  assert.equal(parseTireSpec('Touring · 94H BSW').sidewall.text, 'Black sidewall')
  assert.equal(parseTireSpec('All Terrain · 112T OWL').sidewall.text, 'Outlined white lettering on the sidewall')
})

test('a code that cannot be resolved honestly comes back unresolved, with a reason on file', () => {
  // The point of this test is that the parser does NOT guess. `W/G` has no
  // entry in any standard sidewall glossary; a bare `C` before a load range is
  // probably the European commercial marking and "probably" is not printable;
  // `RF` alone certifies nothing industry-wide, since run-flat markings are
  // manufacturer-specific. Each is named in KNOWN_UNRESOLVED with why.
  assert.deepEqual(parseTireSpec('Touring · XL 98V W/G').unresolved, ['W/G'])
  assert.deepEqual(parseTireSpec('Highway · C C/6PLY BSW').unresolved, ['C'])
  assert.deepEqual(parseTireSpec('Touring · RF 98W BSW').unresolved, ['RF'])
  for (const code of ['W/G', 'C', 'RF']) {
    assert.ok(KNOWN_UNRESOLVED[code]?.length > 20, `${code} needs a reason, not an entry`)
    assert.ok(!(code in SIDEWALL_CODES), `${code} must not also claim to be resolved`)
  }
  // And the rest of the string still yields what it does carry.
  assert.equal(parseTireSpec('Highway · C C/6PLY BSW').loadRange.ply, 6)
})

test('a description with no category is told apart from one with no spec', () => {
  // 28 of the 1,083 rows are a bare spec with no separator at all. Splitting on
  // the separator and trusting each half gets both of these wrong.
  const specOnly = parseTireSpec('94H BSW')
  assert.equal(specOnly.category, null)
  assert.equal(specOnly.loadLb, 1477)
  assert.equal(specOnly.sidewall.code, 'BSW')

  const categoryOnly = parseTireSpec('Sport truck')
  assert.equal(categoryOnly.category, 'Sport truck')
  assert.equal(categoryOnly.loadLb, null)
  assert.deepEqual(categoryOnly.unresolved, [])

  assert.equal(parseTireSpec('112T').category, null, 'a lone load-and-speed token is a spec')
  assert.equal(parseTireSpec('Racing').category, 'Racing', 'a lone word is a category')
})

test('supplier marketing boilerplate is refused as a category, and the spec beside it survives', () => {
  // 7 rows carry the supplier's own comparison-tool advertisement in the
  // category field. cleanCatalogDescription() strips the markup, so LENGTH is
  // the load-bearing half of this check, not the tag.
  const boilerplate = 'Compare tires at a glance using our easy test score<sup>®</sup> system. Our proprietary algorithm factors in performance, expert insights, user reviews, and Uniform Tire Quality Grading (UTQG) scores.'
  const withMarkup = parseTireSpec(`${boilerplate} · 95V BSW`)
  assert.equal(withMarkup.category, null)
  assert.match(withMarkup.categoryRejected, /^Compare tires at a glance/)
  assert.equal(withMarkup.loadLb, 1521, 'the half that is real still parses')

  const stripped = parseTireSpec(`${boilerplate.replace(/<[^>]+>/g, '')} · 95V BSW`)
  assert.equal(stripped.category, null, 'length alone must refuse it once the tags are gone')

  // Headroom, stated as an assertion rather than a comment: the longest real
  // category in the snapshot is 33 characters.
  assert.equal('Ultra High Performance All Season'.length, 33)
  assert.ok(MAX_CATEGORY_CHARS > 33 * 1.5)
  assert.equal(parseTireSpec('Ultra High Performance All Season · 94V BSW').category, 'Ultra High Performance All Season')
})

test('where the string says nothing, this says nothing', () => {
  for (const nothing of ['', '   ', null, undefined, 42, {}]) {
    const described = describeTireSpec(nothing)
    assert.deepEqual(described.points, [], `${JSON.stringify(nothing)} must produce no points`)
    assert.deepEqual(described.unresolved, [])
    assert.equal(described.category, null)
  }
  // A category with no codes is a category and nothing more -- no invented
  // sentence to fill the space.
  assert.deepEqual(describeTireSpec('Commercial Van').points, [])
})

test('no token in the shipped snapshot is silently dropped', () => {
  // The honesty check, against the real 1,083 rows rather than a fixture. Every
  // token either resolves or is named in KNOWN_UNRESOLVED with a reason; a code
  // the parser neither explains nor admits to is the failure this catches.
  //
  // A new supplier code arriving in a future scrape will fail here, and that is
  // the intended behaviour: it is a finding to look at, not a regression. The
  // fix is to resolve it or to name it in KNOWN_UNRESOLVED -- never to delete
  // this test.
  const rows = JSON.parse(readFileSync(SNAPSHOT, 'utf8')).tires
  assert.ok(Array.isArray(rows) && rows.length > 100, 'the snapshot must actually have been read')

  const undocumented = new Map(), seen = new Set()
  let withPoints = 0
  for (const row of rows) {
    for (const token of parseTireSpec(row.description).unresolved) {
      seen.add(token)
      if (!(token in KNOWN_UNRESOLVED)) undocumented.set(token, (undocumented.get(token) ?? 0) + 1)
    }
    if (describeTireSpec(row.description).points.length > 0) withPoints++
  }
  assert.deepEqual([...undocumented.keys()], [],
    'add each of these to KNOWN_UNRESOLVED with a reason, or resolve it in the tables')
  // The control on the line above. An empty `undocumented` means nothing until
  // the sweep is shown capable of finding an unresolved token at all -- a
  // parser that silently discarded every token it did not understand would
  // produce exactly the same empty result and read as a pass. Mutation testing
  // confirmed that gap: dropping unknown tokens left this test green.
  assert.ok(seen.size > 0, 'the sweep found no unresolved token at all, so its silence proves nothing')
  // Measured over this snapshot: every single row yields at least one point.
  assert.equal(withPoints, rows.length, 'every row must become something a customer can read')
})
