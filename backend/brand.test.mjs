import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveBrand } from '../src/data/brand.js'

test('derives the brand slug and a title-cased label from a real supplier URL', () => {
  assert.deepEqual(
    deriveBrand('https://www.giga-tires.com/205-65-15/waterfall-tires/quattro/tirecode/WT25'),
    { slug: 'waterfall', label: 'Waterfall' },
  )
})

test('a multi-hyphen brand slug title-cases word by word by default', () => {
  assert.deepEqual(
    deriveBrand('https://www.giga-tires.com/205-65-15/mickey-thompson-tires/atz/tirecode/X'),
    { slug: 'mickey-thompson', label: 'Mickey Thompson' },
  )
})

test('the four label overrides fix the slugs where title-casing is demonstrably wrong', () => {
  assert.equal(deriveBrand('https://www.giga-tires.com/x/bf-goodrich-tires/y/tirecode/z').label, 'BFGoodrich')
  assert.equal(deriveBrand('https://www.giga-tires.com/x/gt-radial-tires/y/tirecode/z').label, 'GT Radial')
  assert.equal(deriveBrand('https://www.giga-tires.com/x/rbp-tires/y/tirecode/z').label, 'RBP')
  assert.equal(deriveBrand('https://www.giga-tires.com/x/tbb-tires/y/tirecode/z').label, 'TBB')
})

test('a URL with no recognisable brand segment returns null rather than a guess', () => {
  assert.equal(deriveBrand('https://www.giga-tires.com/tires/test'), null)
  assert.equal(deriveBrand(''), null)
  assert.equal(deriveBrand(undefined), null)
  assert.equal(deriveBrand(null), null)
})

test('every real supplier URL in the tracked snapshot resolves to a brand -- the claim this feature is built on', () => {
  const data = JSON.parse(readFileSync(new URL('../src/data/scraped-tires.json', import.meta.url), 'utf8'))
  const misses = data.tires.filter(t => !deriveBrand(t.source?.url))
  assert.deepEqual(misses, [], `${misses.length} of ${data.tires.length} tires have no derivable brand`)
  const brands = new Set(data.tires.map(t => deriveBrand(t.source.url).slug))
  assert.equal(brands.size, 125, 'distinct brand count drifted from what was measured before building this')
})
