import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { MAX_PACKET_FILE_BYTES, MAX_MAPPING_FILE_BYTES } from './image-manifest.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * `65536` used to appear at eight sites across `scripts/` and `backend/`,
 * meaning two unrelated things: the cap on a packet's snapshot/profile/manifest,
 * and the cap on the owner's mapping. Raising "the packet cap" on 2026-09-12
 * therefore changed two sites and silently left six -- and the next real batch,
 * 96 images with a 616KB snapshot, refused at `seal-image-packet.mjs`.
 *
 * A comment in `scrape-tires.mjs` had predicted exactly that, in exactly those
 * words: *"raising one leaves the others silently disagreeing: grep the class,
 * do not trust one file."* It was accurate, specific, and in the file. It was
 * simply not read before a neighbouring line was edited.
 *
 * This is that comment as a check. A comment asks the next person to be
 * careful; a test does not need them to be.
 */
const ALLOWED = new Map([
  // A write-chunk size, not a cap on anything. Unrelated to either constant.
  ['backend/image-staging.mjs', 'streams the body in 65536-byte chunks'],
])

function sourceFiles(directory) {
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'fixtures') continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.mjs$/.test(entry) && !entry.includes('.test.')) found.push(full)
    }
  }
  walk(path.join(ROOT, directory))
  return found
}

test('the two packet caps are distinct constants, not one number wearing two hats', () => {
  assert.notEqual(MAX_PACKET_FILE_BYTES, MAX_MAPPING_FILE_BYTES,
    'if these are ever equal, a future edit will again change "the cap" and move only half of what it meant')
  assert.ok(MAX_PACKET_FILE_BYTES > 0 && MAX_MAPPING_FILE_BYTES > 0)
})

test('each cap clears the count ceiling it has to serve, with the arithmetic stated', () => {
  // Measured 2026-09-12 on real files rather than assumed: a packet candidate
  // costs ~5,700 bytes of snapshot.json, a mapping candidate ~271 bytes. The
  // politeness ceiling is 250 candidates. A cap that cannot hold what the count
  // ceilings allow is the defect this pair was split to fix.
  const PACKET_BYTES_PER_CANDIDATE = 5700
  const MAPPING_BYTES_PER_CANDIDATE = 271
  const CANDIDATE_LIMIT = 250

  assert.ok(MAX_PACKET_FILE_BYTES >= PACKET_BYTES_PER_CANDIDATE * 100,
    `the packet cap must hold the 100 pages MAX_VALIDATION_COUNT allows (~${PACKET_BYTES_PER_CANDIDATE * 100} bytes)`)
  assert.ok(MAX_MAPPING_FILE_BYTES >= MAPPING_BYTES_PER_CANDIDATE * CANDIDATE_LIMIT,
    `the mapping cap must hold the ${CANDIDATE_LIMIT} candidates the politeness budget allows (~${MAPPING_BYTES_PER_CANDIDATE * CANDIDATE_LIMIT} bytes)`)
})

test('no source file re-states 65536 as a cap; every site imports one of the two', () => {
  const offenders = []
  for (const directory of ['scripts', 'backend']) {
    for (const file of sourceFiles(directory)) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/')
      if (ALLOWED.has(relative)) continue
      const source = readFileSync(file, 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        // Prose may discuss the old value -- that history is worth keeping.
        // Code may not re-state it.
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
        if (!isComment && line.includes('65536')) offenders.push(`${relative}:${index + 1}  ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    'import MAX_PACKET_FILE_BYTES or MAX_MAPPING_FILE_BYTES instead; a repeated literal is how six sites were left behind')
})

test('the allowlist names why, so an entry cannot be added silently', () => {
  for (const [file, reason] of ALLOWED) {
    assert.ok(reason.length > 20, `${file} needs a real reason, not a placeholder`)
    assert.ok(readFileSync(path.join(ROOT, file), 'utf8').includes('65536'),
      `${file} is allowlisted for a 65536 it no longer contains -- drop the entry`)
  }
})
