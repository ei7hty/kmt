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
