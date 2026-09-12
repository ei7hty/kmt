import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ratio } from '../../.forge/contrast-measure.mjs'

// The photo state words are the only thing on the inventory grid that carries
// meaning in colour alone, and the browser audit cannot check them: it measures
// what the seeded database renders, and seeded rows are all `none`. One colour
// of six got measured; the `none` grey shipped at 3.88:1 under a comment
// claiming every one of them cleared 4.5:1.
//
// So this reads the real files rather than restating them. Both hex values come
// out of the CSS -- writing #121212 here as "the ground" would be a second copy
// of a fact the stylesheet already owns, and it would keep passing on the day
// someone restyles the table.

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'OwnerInventory.css'), 'utf8')
const jsx = readFileSync(join(here, 'OwnerInventoryGrid.jsx'), 'utf8')

const rgb = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) })

function gridGround() {
  const rule = /\.oi-g-table \{([^}]*)\}/.exec(css)
  assert.ok(rule, '.oi-g-table rule not found -- this test cannot find the ground it measures against')
  const bg = /background:\s*(#[0-9a-f]{6})/i.exec(rule[1])
  assert.ok(bg, '.oi-g-table has no background colour -- the ground is no longer stated here')
  return bg[1]
}

function stateColours() {
  const found = new Map()
  const pattern = /\.oi-g-photo-([a-z]+) \.oi-g-photo-state \{\s*color:\s*(#[0-9a-f]{6})/gi
  for (const m of css.matchAll(pattern)) found.set(m[1], m[2])
  return found
}

function labelledStates() {
  const block = /const PHOTO_LABELS = \{([\s\S]*?)\n\}/.exec(jsx)
  assert.ok(block, 'PHOTO_LABELS not found in OwnerInventoryGrid.jsx')
  return [...block[1].matchAll(/^\s{2}([a-z]+):/gm)].map(m => m[1])
}

test('every photo state the grid can show has a colour rule', () => {
  const states = labelledStates()
  // Six today. Asserted so that a regex that quietly stops matching fails here
  // instead of reducing every loop below to zero iterations and passing.
  assert.equal(states.length, 6, `expected 6 photo states, parsed ${states.length}: ${states.join(', ')}`)
  const colours = stateColours()
  for (const state of states) {
    assert.ok(colours.has(state), `photo state "${state}" has no .oi-g-photo-${state} colour rule`)
  }
})

test('every photo state word clears 4.5:1 on the grid ground', () => {
  const ground = gridGround()
  const colours = stateColours()
  assert.ok(colours.size >= 6, `parsed ${colours.size} photo state colours, expected at least 6`)
  const failures = []
  for (const [state, colour] of colours) {
    const measured = ratio(rgb(colour), rgb(ground))
    if (measured < 4.5) failures.push(`${state} ${colour} on ${ground} -> ${measured.toFixed(2)}:1`)
  }
  assert.deepEqual(failures, [], `photo state words below 4.5:1:\n  ${failures.join('\n  ')}`)
})
