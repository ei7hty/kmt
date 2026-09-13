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
 * Not a suite that throws. Measured on origin/main, both sides: a checkout with
 * no decoder environment reports `664 tests / 660 pass / 4 fail`, marks each
 * dead file with an X, and exits 1. Node already refuses to call that a pass,
 * and a guard on top of it would defend nothing.
 *
 * What nothing catches is a suite that stops being COLLECTED. Rename a file out
 * of the pattern, move it, delete an import that pulled it in -- and every
 * remaining test passes, no file is marked, and the process exits 0. The only
 * evidence is a number that got smaller, and until now nothing knew what the
 * number should be: 664 against 729 with no declaration of which is correct.
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
// Imported, not re-derived. This is the exact value the image suites
// consult, so this check cannot disagree with them about whether the decoder
// is present -- the CATALOG_FIELDS lesson, applied before it could bite.
import { decoderPython } from '../backend/fixtures/image-provider/decoder-fixtures.mjs'
import { BASELINE_PATTERNS, DECODER_SUITE_DELTA } from './test-baseline.mjs'

/**
 * The number of tests the named suites contain when every one of them can run.
 *
 * Measured on origin/main with the image decoder environment present. Without
 * one the same command reports this baseline minus DECODER_SUITE_DELTA (in
 * `test-baseline.mjs`) -- the image suites that die at module load, and not a
 * miscount here.
 *
 * NO FIGURE FOR THE NO-DECODER TOTAL IS WRITTEN HERE ON PURPOSE. It used to say
 * "reports 664", and 664 was two baselines out of date by the time anybody read
 * it: a second number derived from this one is a second copy of a fact, and it
 * goes stale every single time this one moves, which is several times a night.
 * The subtraction is one operation; the reader can do it against a delta that
 * has its own instrument.
 *
 * The gap USED to be the cwd-relative decoder defect. #464 fixed that for
 * `.worktrees/` checkouts and the git-common-dir step fixed the other 66
 * worktrees of 236 that its marker could not describe, so every checkout on
 * this machine now finds the shared venv and reports this same number.
 *
 * CHANGING THIS NUMBER: if the run came back LOWER, find the suite that stopped
 * running before you touch it. If it came back HIGHER because you added tests,
 * update it in the same commit and say the new number in the pull request, so a
 * reviewer sees the baseline move deliberately rather than discovering it later
 * in a diff nobody read.
 */
const EXPECTED_TESTS = 1017


/**
 * The patterns EXPECTED_TESTS was measured against, and the whole reason this
 * file can claim anything -- now declared in `test-baseline.mjs`, because
 * `orphaned-test-check.mjs` needs the identical list to ask the opposite
 * question (nothing outside these patterns) and two copies of one fact is the
 * defect that check exists to prevent.
 */

const files = process.argv.slice(2)
if (!files.length) {
  console.error('Usage: node .forge/test-count-check.mjs <test files...>')
  console.error('Refuses to guess a pattern: a harness that defaults to a target audits whatever it finds.')
  process.exit(2)
}

/** Same patterns, same order, as strings -- the workflow quotes them so node expands them, not the shell. */
const invocationMatches = files.length === BASELINE_PATTERNS.length
  && files.every((pattern, index) => pattern === BASELINE_PATTERNS[index])

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

if (!invocationMatches) {
  // A refusal, not a verdict. The count below is real; what this tool cannot do
  // is tell you whether it is RIGHT, because the baseline was not measured for
  // what you ran. Saying nothing would be better than saying the wrong thing,
  // and saying why is better than both.
  console.error('')
  console.error('REFUSING TO JUDGE: this baseline was not measured for the patterns you ran.')
  console.error(`      measured for: ${BASELINE_PATTERNS.map(x => JSON.stringify(x)).join(' ')}`)
  console.error(`      you ran:      ${files.map(x => JSON.stringify(x)).join(' ')}`)
  console.error('      The test result above stands; the COUNT means nothing against this baseline.')
  console.error('      Run the workflow line, or re-measure and update BASELINE_PATTERNS and EXPECTED_TESTS together.')
} else if (total !== null && total < EXPECTED_TESTS) {
  const short = EXPECTED_TESTS - total

  // Set once for the whole block, not per branch. It was set per branch and the
  // three short cases were added later without it, so a shortfall in an
  // otherwise-healthy run printed FAIL and exited 0 -- this check reading as a
  // plausible pass in the one case it exists for. Found by JUNIOR REPO AGENT
  // reproducing it with two trivial passing files, not by anyone reading it.
  problem = true
  // The third outcome: a shortfall this environment cannot help.
  //
  // It exits 1 like every other failure, deliberately. The exit code is the
  // enforcement and the message is the diagnosis, and coupling them is how a
  // check dies: an agent who learns that this wording means "proceed" will
  // proceed the day a real forty-five-test drop happens to wear it.
  //
  // What it buys is that a worktree agent can tell "I broke something" from
  // "my environment cannot run this". Without that distinction they treat
  // every red run as noise or every red run as a crisis, and both end the
  // signal.
  //
  // WAS TRANSITIONAL, AND THE TRANSITION HAPPENED. This existed because
  // `decoder.local` resolved against process.cwd() and existed only in the main
  // checkout, so following AGENTS.md's worktree rule was what produced the
  // shortfall. #464 fixed that resolution, so a compliant worktree now finds the
  // shared venv and this branch no longer fires for anyone following the rules.
  //
  // "IT IS KEPT BECAUSE CI HAS NO VENV" USED TO BE WRITTEN HERE, AND IT WAS
  // FALSE WHEN IT WAS WRITTEN. `fly-deploy.yml` builds a venv at :94-98 and
  // exports KMT_IMAGE_DECODER_PYTHON, in the SAME job (`check`) as the count
  // check at :134 -- so CI is precisely where this branch CANNOT fire. Between
  // that and the resolver fixes (#464 for `.worktrees/`, the git-common-dir
  // step for the other 66 worktrees of 236 the marker could not describe), this
  // branch now fires in exactly one honest situation: a fresh clone with no
  // venv built yet. That is a real situation and worth serving well, which is
  // why the branch stays.
  //
  // What it cost to have a branch nothing could reach: DECODER_SUITE_DELTA sat
  // stale at 45 through the addition of a fourth image suite, then at 65
  // through a fifth, and each time the message below confidently invented a
  // remainder. A guard nothing can reach decays at the speed of whatever it
  // guards -- so the delta now lives in `test-baseline.mjs` beside
  // DECODER_SUITE_FILES, and `backend/decoder-fixtures.test.mjs` fails the
  // moment a sixth such suite appears.
  //
  // Keyed on the decoder being ABSENT, not on the shortfall matching the delta.
  // A number that happens to match is not a diagnosis, and inferring a cause
  // from a coincidental count is the exact mistake this file exists to catch.
  if (!decoderPython && short === DECODER_SUITE_DELTA) {
    console.error('')
    console.error(`FAIL: ${short} test(s) short, and this environment cannot run them.`)
    console.error('      KMT_IMAGE_DECODER_PYTHON is unset and no decoder.local resolves from here, so the')
    console.error('      image suites died at module load. That is the whole shortfall -- nothing of yours is missing.')
    console.error('      Still exit 1: a suite that did not run did not pass, whoever is at fault.')
    console.error('      To run them, build the decoder the way CI does:')
    console.error('        python -m venv decoder.local')
    console.error('        decoder.local/Scripts/python -m pip install -r scripts/image-decoder-requirements.txt   # bin/python on POSIX')
    console.error('      or point KMT_IMAGE_DECODER_PYTHON at one you already have. Build it in the MAIN')
    console.error('      checkout: every worktree resolves the same one from there, whatever its layout.')
  } else if (!decoderPython && short > DECODER_SUITE_DELTA) {
    console.error('')
    console.error(`FAIL: ${short} test(s) short of the baseline (${total} of ${EXPECTED_TESTS}).`)
    console.error(`      This environment has no image decoder, which accounts for ${DECODER_SUITE_DELTA} of that.`)
    console.error(`      The remaining ${short - DECODER_SUITE_DELTA} is something else and is worth finding.`)
  } else if (!decoderPython) {
    // short < DECODER_SUITE_DELTA. The `=` case is handled above, so the only
    // way here is a shortfall SMALLER than the decoder alone should have caused
    // -- which is not a thing that can happen if the constant is right.
    //
    // THIS BRANCH EXISTS BECAUSE THE ONE ABOVE USED TO SWALLOW IT, and printed
    // "the remaining -6 is something else and is worth finding". That sentence
    // sent at least one reader hunting tests that did not exist, which is the
    // specific harm: a diagnosis nobody can act on is worse than none, because
    // it spends someone's night before it is disbelieved. The delta was 65
    // against a real 73 for exactly this reason, and no instrument could see it.
    //
    // So: say what is actually known, and name the constant that is most likely
    // wrong rather than inventing a missing suite to blame.
    console.error('')
    console.error(`FAIL: ${short} test(s) short of the baseline (${total} of ${EXPECTED_TESTS}).`)
    console.error(`      This environment has no image decoder, which should have cost ${DECODER_SUITE_DELTA} tests --`)
    console.error(`      MORE than the ${short} actually missing. Those two cannot both be right.`)
    console.error('      The likeliest cause is DECODER_SUITE_DELTA in .forge/test-baseline.mjs being stale')
    console.error('      (it has been twice: 45, then 65, each time after an image suite was added).')
    console.error('      Re-measure it the way that file describes before treating this as a lost suite,')
    console.error('      and do not go looking for tests this arithmetic cannot prove are missing.')
  } else {
    console.error(`\nFAIL: ${EXPECTED_TESTS - total} test(s) short of the baseline (${total} of ${EXPECTED_TESTS}).`)
    console.error('      A test that did not run did not pass. Before changing the number, find out which suite stopped:')
    console.error('        - a file renamed or moved out of the pattern shows up ONLY as this number, since node was never given it;')
    console.error('        - a suite that threw at module load is named with an X in the output above, and is a different problem.')
  }
} else if (total !== null && total > EXPECTED_TESTS) {
  console.error(`\nFAIL: ${total - EXPECTED_TESTS} test(s) more than the baseline (${total} of ${EXPECTED_TESTS}).`)
  console.error('      This is what adding tests looks like, and it is not an error in your work.')
  console.error(`      Set EXPECTED_TESTS to ${total} in this file, in the same commit, and say so in the pull request.`)
  problem = true
}

if (testExit !== 0) {
  console.error(`\nThe test run itself failed (exit ${testExit}${failed ? `, ${failed} failing` : ''}). That is reported above by node; this check does not restate it.`)
}

// Three outcomes, kept distinct on purpose:
//   1 -- judged, and something is wrong (a real test failure, or a count that moved)
//   2 -- could not judge (no patterns given, or a set this baseline was not measured for)
//   0 -- judged, and the count is exactly right
// A failing test run always wins, because that is a verdict this tool can reach
// whatever its baseline was measured against.
process.exitCode = testExit !== 0 ? 1 : !invocationMatches ? 2 : problem ? 1 : 0
