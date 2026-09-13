import test from 'node:test'
import assert from 'node:assert/strict'

import { rankPhotoGaps, catalogueScope, cumulativeCoverage, parseArgs, summarise } from './photo-gaps.mjs'

/** A catalogue row as `/api/catalog` returns one. */
const row = (name, size, extra = {}) => ({
  id: `giga-${name}-${size}`.replace(/\W+/g, ''), name, size,
  price: 100, inStock: true, category: 'all-season', description: 'd', ...extra,
})

test('the ranking is by rows a photo would cover, not by how many models lack one', () => {
  // The whole point. One photo of a model in 40 sizes is worth more than one
  // of a model in 2, and counting models instead of rows gets that backwards.
  const wide = Array.from({ length: 40 }, (_, i) => row('Wide Model', `s${i}`))
  const narrow = Array.from({ length: 2 }, (_, i) => row('Narrow Model', `n${i}`))
  const ranked = rankPhotoGaps([...narrow, ...wide])

  assert.deepEqual(ranked.map(m => m.name), ['Wide Model', 'Narrow Model'])
  assert.equal(ranked[0].gap, 40)
  assert.equal(ranked[0].sizes, 40)
})

test('the ranking sorts by the GAP, not by total rows -- the case where they disagree', () => {
  // The test above cannot tell those two apart: nothing in it has a photo, so
  // gap equals rows for every model and both orderings agree. Mutating the
  // comparator from `gap` to `rows` left the whole suite green, which made the
  // tool's primary decision untested by the test named after it.
  //
  // These two disagree on purpose. "Nearly Done" is the bigger model and the
  // smaller job; "Untouched" is the smaller model and the bigger job. Ranking
  // by rows puts the wrong one first and sends someone to photograph a model
  // that is already nine-tenths covered.
  const nearlyDone = Array.from({ length: 10 }, (_, i) =>
    row('Nearly Done', `s${i}`, i < 9 ? { imageUrl: `/p${i}.webp` } : {}))
  const untouched = Array.from({ length: 3 }, (_, i) => row('Untouched', `u${i}`))
  const ranked = rankPhotoGaps([...nearlyDone, ...untouched])

  assert.deepEqual(ranked.map(m => m.name), ['Untouched', 'Nearly Done'],
    'ranked by total rows rather than by what is still missing')
  assert.equal(ranked[0].gap, 3)
  assert.equal(ranked[1].gap, 1)
  assert.ok(ranked[1].rows > ranked[0].rows, 'the fixture only discriminates while the loser is the bigger model')
})

test('a model whose every row already has a photo is not a gap', () => {
  const covered = [row('Done', 'a', { imageUrl: '/x.webp' }), row('Done', 'b', { imageUrl: '/y.webp' })]
  assert.deepEqual(rankPhotoGaps(covered), [])
})

test('a partly covered model is a gap worth only what is still missing', () => {
  // Photo coverage is per row, so a model can be half done. Ranking it by its
  // total rows would send someone to re-photograph what is already there.
  const partial = [
    row('Half', 'a', { imageUrl: '/x.webp' }),
    row('Half', 'b'),
    row('Half', 'c'),
  ]
  const [model] = rankPhotoGaps(partial)
  assert.equal(model.rows, 3)
  assert.equal(model.covered, 1)
  assert.equal(model.gap, 2, 'the gap is what is missing, not what exists')
})

test('every gap is returned, so a caller asking for twelve cannot be told twelve is all there is', () => {
  // The defect this replaced: the ranking sliced to the limit itself, and the
  // summary then reported the slice as the total -- "12 model(s) still missing
  // at least one" when the real number was 1,324. A report that makes the
  // remaining work look finished is worse than no report.
  //
  // The fixture is deliberately LARGER than the default limit of 100. At 50 it
  // proved nothing: re-introducing `slice(0, 100)` inside the ranking left this
  // green, because fifty models fit under the limit being reintroduced.
  const many = Array.from({ length: 130 }, (_, i) => row(`Model ${String(i).padStart(3, '0')}`, 'a'))
  const ranked = rankPhotoGaps(many)
  assert.equal(ranked.length, 130, 'ranking must not take a limit; the caller slices')
})

test('the summary counts every gap and says what the batch leaves behind', () => {
  const tires = [
    ...Array.from({ length: 5 }, (_, i) => row('Big', `s${i}`)),
    ...Array.from({ length: 3 }, (_, i) => row('Mid', `s${i}`)),
    row('Small', 'a'),
  ]
  const ranked = rankPhotoGaps(tires)
  const lines = summarise(catalogueScope(tires), ranked, 1).join('\n')

  assert.match(lines, /3 model\(s\) still missing at least one/, lines)
  assert.match(lines, /worth 9 row\(s\)/, lines)
  // Asked for one, it must say what the other two still cost.
  assert.match(lines, /the 1 below cover 5 row\(s\); 4 row\(s\) would remain/, lines)
})

test('a four-size source is called out as the local database', () => {
  // Pointing this at the local server answers about 4 sizes out of 511, and
  // acting on that answer costs a supplier scrape of the wrong hundred models.
  const local = ['a', 'b', 'c', 'd'].map((size, i) => row(`M${i}`, size))
  assert.match(summarise(catalogueScope(local), rankPhotoGaps(local), 10).join('\n'), /looks like the local database/)

  const wide = Array.from({ length: 20 }, (_, i) => row(`M${i}`, `size-${i}`))
  assert.doesNotMatch(summarise(catalogueScope(wide), rankPhotoGaps(wide), 10).join('\n'), /looks like the local database/)
})

test('the source must be named, because the two sources answer differently', () => {
  assert.throws(() => parseArgs([]), /--from is required/)
  assert.throws(() => parseArgs(['--limit', '10']), /--from is required/)
  assert.equal(parseArgs(['--from', 'http://127.0.0.1:4180']).from, 'http://127.0.0.1:4180')
  // --help is the one thing that does not need a source.
  assert.equal(parseArgs(['--help']).help, true)
})

test('a limit that is not a positive whole number is refused rather than rounded', () => {
  for (const bad of ['0', '-3', '2.5', 'ten', '']) {
    assert.throws(() => parseArgs(['--from', 'http://127.0.0.1:4180', '--limit', bad]), /positive whole number/, bad)
  }
  assert.equal(parseArgs(['--from', 'http://x', '--limit', '25']).limit, 25)
})

test('a brand filter keeps only that brand, and brandless rows are not collateral', () => {
  const tires = [
    row('Mich A', 'a', { brand: 'Michelin' }),
    row('Mich A', 'b', { brand: 'Michelin' }),
    row('Nameless', 'a'),
    row('Other', 'a', { brand: 'Aplus' }),
  ]
  assert.deepEqual(rankPhotoGaps(tires, { brands: ['michelin'] }).map(m => m.name), ['Mich A'])
  // Without a filter the brandless row is still a gap -- it is a tire that
  // needs a photo, whatever its URL said.
  assert.ok(rankPhotoGaps(tires).some(m => m.name === 'Nameless'))
})

test('the order is total, so two runs over one catalogue agree', () => {
  // Equal gap and equal rows: without the name tie-break the order depends on
  // Map insertion, and a batch list that reshuffles between runs is one nobody
  // can check against the last one.
  const tires = [row('Beta', 'a'), row('Alpha', 'a'), row('Gamma', 'a')]
  assert.deepEqual(rankPhotoGaps(tires).map(m => m.name), ['Alpha', 'Beta', 'Gamma'])
  assert.deepEqual(rankPhotoGaps([...tires].reverse()).map(m => m.name), ['Alpha', 'Beta', 'Gamma'])
})

test('cumulative coverage adds up what a batch of n would buy', () => {
  const ranked = rankPhotoGaps([
    ...Array.from({ length: 4 }, (_, i) => row('A', `s${i}`)),
    ...Array.from({ length: 3 }, (_, i) => row('B', `s${i}`)),
    ...Array.from({ length: 2 }, (_, i) => row('C', `s${i}`)),
  ])
  assert.equal(cumulativeCoverage(ranked, 0), 0)
  assert.equal(cumulativeCoverage(ranked, 1), 4)
  assert.equal(cumulativeCoverage(ranked, 2), 7)
  assert.equal(cumulativeCoverage(ranked, 99), 9, 'asking for more than exists is the whole catalogue, not an error')
})

test('a row with no usable name is skipped rather than becoming a model called nothing', () => {
  const tires = [row('Real', 'a'), { ...row('x', 'b'), name: '   ' }, { ...row('y', 'c'), name: undefined }]
  assert.deepEqual(rankPhotoGaps(tires).map(m => m.name), ['Real'])
})
