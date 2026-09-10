/**
 * Run a test suite and hold its total against a pinned baseline.
 *
 * `EXPECTED_CHECKS` guards every browser audit in this directory against a
 * check that stopped running. The test suite -- the largest thing in the gate --
 * had no such guard, and this is it.
 *
 *   node .forge/test-count-check.mjs backend/*.test.mjs
 *
 * The file list is an argument, not a constant here: the workflow decides WHAT
 * runs, this decides only whether the count is right.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CATCHES THAT `node --test` DOES NOT
 *
 * Not a suite that throws. Measured on origin/main, both sides: a worktree with
 * no decoder environment reports `587 tests / 584 pass / 3 fail`, marks each
 * dead file with an X, and exits 1. Node already refuses to call that a pass,
 * and a guard on top of it would defend nothing.
 *
 * What nothing catches is a suite that stops being COLLECTED. Rename a file out
 * of the pattern, move it, delete an import that pulled it in -- and every
 * remaining test passes, no file is marked, and the process exits 0. The only
 * evidence is a number that got smaller, and until now nothing knew what the
 * number should be: 587 against 632 with no declaration of which is correct.
 *
 * ---------------------------------------------------------------------------
 * WHY IT FAILS UPWARD TOO
 *
 * A baseline that only catches decreases rots. Every added test drifts the real
 * number away from the pinned one, and once the gap is wide enough nobody can
 * say whether a drop of forty is a deleted suite or four months of additions.
 * Failing in both directions costs one line in the commit that adds tests and
 * keeps the number meaning something.
 *
 * The failure this guards against is a person bumping the constant to turn a
 * red run green. Nothing here can stop that -- so the messages below spend
 * their length on telling that person what they are about to hide.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The number of tests the named suites contain when every one of them can run.
 *
 * Measured on origin/main in the main checkout with the image decoder
 * environment present. A worktree without it reports 587, which is this same
 * baseline minus the three image suites that die at module load -- that gap is
 * the decoder defect (decoder.local resolves against process.cwd()), not a
 * miscount here.
 *
 * CHANGING THIS NUMBER: if the run came back LOWER, find the suite that stopped
 * running before you touch it. If it came back HIGHER because you added tests,
 * update it in the same commit and say the new number in the pull request, so a
 * reviewer sees the baseline move deliberately rather than discovering it later
 * in a diff nobody read.
 */
const EXPECTED_TESTS = 632

const files = process.argv.slice(2)
if (!files.length) {
  console.error('Usage: node .forge/test-count-check.mjs <test files...>')
  console.error('Refuses to guess a pattern: a harness that defaults to a target audits whatever it finds.')
  process.exit(2)
}

const tapDir = mkdtempSync(path.join(tmpdir(), 'kmt-test-count-'))
const tapPath = path.join(tapDir, 'run.tap')

// Two reporters: `spec` to stdout so the log stays readable for a person, and
// `tap` to a file to parse. Parsing the human-readable output instead would
// tie this to whichever reporter the workflow happens to use.
const child = spawn(process.execPath, [
  '--test',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
  ...files,
], { stdio: ['ignore', 'inherit', 'inherit'] })

const testExit = await new Promise(resolve => child.on('close', resolve))

let tap = ''
try {
  tap = readFileSync(tapPath, 'utf8')
} finally {
  rmSync(tapDir, { recursive: true, force: true })
}

/** A literal backslash, written as a code point: a heredoc ate the escaped form once already. */
const BS = String.fromCharCode(92)

const summary = (key) => {
  const match = tap.match(new RegExp('^# ' + key + ' (' + BS + 'd+)$', 'm'))
  return match ? Number(match[1]) : null
}
const total = summary('tests')
const failed = summary('fail')

// Considered and dropped: asserting that every file given to node was actually
// reported on, so a missing suite could be named rather than merely counted.
//
// The TAP reporter does not name files when several are passed to one run --
// it flattens every suite into one stream of `ok N - <test name>` with no file
// grouping, verified by running two files and reading the output. So the data
// this assertion needed does not exist, and a first draft of it reported all 31
// files as unreported on a run where all 31 had run. It failed for the right
// reason and the wrong cause, which is the thing this file exists to prevent.
//
// The pinned total is therefore the whole mechanism, and it is enough: a file
// renamed out of the pattern shows up as a count that dropped. Naming which one
// is the spec reporter's job, and its output is already on stdout above.

let problem = false

if (total === null) {
  console.error('\nFAIL: could not read a test total out of the TAP output.')
  console.error('      This check cannot vouch for a run it could not parse, so it refuses rather than passing.')
  problem = true
} else {
  console.log(`\nTest count: ${total} against a baseline of ${EXPECTED_TESTS}.`)
}

if (total !== null && total < EXPECTED_TESTS) {
  console.error(`\nFAIL: ${EXPECTED_TESTS - total} test(s) short of the baseline (${total} of ${EXPECTED_TESTS}).`)
  console.error('      A test that did not run did not pass. Before changing the number, find out which suite stopped:')
  console.error('        - a file renamed or moved out of the pattern shows up ONLY as this number, since node was never given it;')
  console.error('        - a suite that threw at module load is named with an X in the output above, and is a different problem;')
  console.error('        - three image suites need KMT_IMAGE_DECODER_PYTHON, and their absence accounts for exactly 45.')
  problem = true
} else if (total !== null && total > EXPECTED_TESTS) {
  console.error(`\nFAIL: ${total - EXPECTED_TESTS} test(s) more than the baseline (${total} of ${EXPECTED_TESTS}).`)
  console.error('      This is what adding tests looks like, and it is not an error in your work.')
  console.error(`      Set EXPECTED_TESTS to ${total} in this file, in the same commit, and say so in the pull request.`)
  problem = true
}

if (testExit !== 0) {
  console.error(`\nThe test run itself failed (exit ${testExit}${failed ? `, ${failed} failing` : ''}). That is reported above by node; this check does not restate it.`)
}

process.exitCode = testExit !== 0 || problem ? 1 : 0
