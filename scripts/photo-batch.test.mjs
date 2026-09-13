import test from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, describeNextSteps } from './photo-batch.mjs'

test('parseArgs requires both directories and refuses relative paths', () => {
  assert.throws(() => parseArgs([]), /--models-file and --work are required/)
  assert.throws(() => parseArgs(['--models-file', '/abs/list.txt']), /--models-file and --work are required/)
  assert.throws(() => parseArgs(['--models-file', 'list.txt', '--work', '/abs/work']), /--models-file must be an absolute path/)
  assert.throws(() => parseArgs(['--models-file', '/abs/list.txt', '--work', 'work']), /--work must be an absolute path/)
  assert.throws(() => parseArgs(['--models-file', '/a', '--work', '/b', '--nope']), /Unknown option: --nope/)
})

test('parseArgs refuses a count that cannot mean anything', () => {
  const base = ['--models-file', '/a', '--work', '/b']
  for (const bad of ['0', '-1', 'x', '1.5']) {
    assert.throws(() => parseArgs([...base, '--count', bad]), /--count must be a positive integer/)
  }
  assert.equal(parseArgs([...base, '--count', '37']).count, 37)
})

test('a seed defaults to today so one day repeats and two days do not collide', () => {
  const seed = parseArgs(['--models-file', '/a', '--work', '/b']).seed
  assert.equal(seed, Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')))
  assert.ok(Number.isInteger(seed))
  assert.equal(parseArgs(['--models-file', '/a', '--work', '/b', '--seed', '20260912']).seed, 20260912)
})

test('the printed steps carry the digest rather than asking for it to be retyped', () => {
  const withDigest = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: 'a'.repeat(64) })
  assert.match(withDigest, new RegExp('a'.repeat(64)))
  assert.ok(!withDigest.includes('<manifest digest>'), 'a known digest must never print as a placeholder')

  const without = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null })
  assert.match(without, /<manifest digest>/)
})

test('the printed steps never omit the chown that cost an hour', () => {
  // The import runs as root over ssh and leaves storage unreadable by the app
  // user. The failure names the images, not the permissions, so the fix has to
  // travel with the instructions rather than live in someone's memory.
  const steps = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null })
  assert.match(steps, /chown -R node:node \/data\/catalog-images-private/)
  assert.match(steps, /not optional/)
  assert.match(steps, /missing or corrupt/, 'the symptom is named so a reader recognises it')
})

test('the printed steps put approval last and say nothing reaches a customer before it', () => {
  const steps = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null })
  assert.match(steps, /APPROVE in the owner screen/)
  assert.match(steps, /Nothing reaches a customer until you do/)
})

test('step 1 carries the snapshot the mapping was built from, or the command it prints cannot work', () => {
  // THE DEFECT THIS EXISTS FOR. `--snapshot X` is handed to
  // build-image-mapping, so the mapping carries X's digest. `scrape-tires`
  // reads src/data/scraped-tires.json unless told otherwise and refuses on
  // `mapping.inputDigest !== sha256Bytes(inputBytes)`. Printing step 1 without
  // `--validation-snapshot` therefore told the operator to run a command this
  // tool had already guaranteed would fail -- and the refusal names neither
  // file, so there is nothing in it to act on.
  const snapshot = '/photos/snapshot-production.json'
  const printed = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null, count: 100, seed: 20260913, snapshot })
  assert.match(printed, new RegExp(`--validation-snapshot ${snapshot}`))
  // On the same command as the input it has to agree with, not somewhere else
  // in the output where a reader might not carry it across.
  const stepOne = printed.slice(printed.indexOf('1. FETCH'), printed.indexOf('2. DOWNLOAD'))
  assert.match(stepOne, /--validation-snapshot/)
  assert.match(stepOne, /--validation-input/)
})

test('with no snapshot given, step 1 names none -- the default is already the right file', () => {
  const printed = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null, count: 100, seed: 20260913 })
  assert.doesNotMatch(printed, /--validation-snapshot/,
    'naming the default snapshot explicitly would be noise, and wrong the day the default moves')
  // The control: the same call WITH one does print it, so the assertion above
  // is the conditional working rather than the flag never being printed.
  assert.match(describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null, snapshot: '/s.json' }), /--validation-snapshot \/s\.json/)
})

test('a value this already holds is filled in, never left as a placeholder to type', () => {
  const printed = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null, count: 89, seed: 20260913 })
  assert.match(printed, /--validation-count 89/)
  assert.match(printed, /--validation-seed 20260913/)
  assert.doesNotMatch(printed, /<n>|<seed>/, 'a placeholder for a value the printer holds is how a wrong number gets typed')

  // Still honest when it genuinely does not know: the digest before sealing is
  // the case that has always been printed as a placeholder, and should be.
  assert.match(printed, /<manifest digest>/)
})

test('the count comes from the mapping, so it cannot disagree with what was written', () => {
  // parseArgs defaults `--count` to 100 whatever the models file holds, so the
  // printed count must not come from there: a 55-model mapping under a default
  // of 100 would print a fetch for pages that do not exist.
  const options = parseArgs(['--models-file', '/abs/list.txt', '--work', '/abs/work'])
  assert.equal(options.count, 100, 'the parsed default is 100 regardless of the list')
  const printed = describeNextSteps({ packet: '/w/packet', staging: '/w/staging', work: '/w', digest: null, count: 55, seed: options.seed })
  assert.match(printed, /--validation-count 55/, 'the printed count is the mapping it read, not the parsed default')
})
