/**
 * Assert that every test file in the tree actually runs somewhere.
 *
 *   node .forge/orphaned-test-check.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `.forge/restore-integrity-check.test.mjs` sat in this repository with 11
 * passing tests, named by no glob and no workflow line, and never ran once. It
 * guards the instrument that says whether a restored customer database is
 * trustworthy. Nothing was broken, nothing was red, and nobody could have
 * noticed: a test that never runs is indistinguishable from a test that passes,
 * in every report anyone reads.
 *
 * `test-count-check.mjs` cannot catch this, and the pair is the point. It pins
 * the TOTAL the baseline patterns produce, so it sees a suite that STOPPED
 * running -- the count drops. A file that never entered the patterns never
 * contributed to the count, so its absence is not a drop from anything. The two
 * checks ask opposite questions and neither substitutes for the other:
 *
 *   test-count-check   did everything that ran before still run?
 *   this file          is there anything that has never run at all?
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS
 *
 * Three things, all against `test-baseline.mjs`, which is the single
 * declaration both checks import -- never a second copy that has to agree with
 * the first:
 *
 *   1. Every tracked `*.test.mjs` is matched by a BASELINE_PATTERN or listed in
 *      RUN_ELSEWHERE. Anything else is an orphan.
 *   2. Every RUN_ELSEWHERE entry names a file that exists. A row outlives the
 *      file it excuses, and then it is excusing nothing while looking like
 *      coverage.
 *   3. No RUN_ELSEWHERE entry is ALSO matched by a pattern. That file would run
 *      twice -- once in its own job, once in the baseline invocation -- which is
 *      the exact thing the `.forge/restore-integrity-check.test.mjs` comment in
 *      `test-baseline.mjs` explains the named-file form to avoid. Silent double
 *      execution also quietly inflates EXPECTED_TESTS, so a later reader
 *      re-measuring the baseline would enshrine the duplication as the number.
 *
 * Exit codes match this directory's convention:
 *   0  judged, and the tree is clean
 *   1  judged, and something is wrong
 *   2  could not judge (no file list to work from) -- refuses rather than
 *      reporting an empty tree as a pass, which is how a check that has quietly
 *      stopped working looks exactly like a check that is happy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_PATTERNS, RUN_ELSEWHERE } from './test-baseline.mjs'

/**
 * Derived from this file's own location, never `process.cwd()`.
 *
 * The cwd-relative form is not a hypothetical mistake here: `decoder.local`
 * resolved against `process.cwd()` and silently found nothing in every
 * `.worktrees/` checkout, which is where AGENTS.md tells every agent to work.
 * That cost two agents a night and a duplicated venv each.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const toPosix = (p) => p.split(path.sep).join('/')

/**
 * `git ls-files`, not a filesystem walk.
 *
 * A walk would have to re-implement `.gitignore` to avoid reporting every
 * `*.test.mjs` under `node_modules` as an orphan, and would report an untracked
 * scratch file as one too. The question this check asks is about the
 * repository's contents, so the repository's own index is the right source. It
 * also means a test file deleted in the working tree stops being reported the
 * moment it is staged, rather than the moment somebody re-runs a walk.
 */
let tracked
try {
  tracked = execFileSync('git', ['ls-files', '*.test.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean).map(toPosix).sort()
} catch (error) {
  console.error('FAIL: could not list tracked test files.')
  console.error(`      ${error.message.split('\n')[0]}`)
  console.error('      This check cannot vouch for a tree it could not read, so it refuses rather than passing.')
  process.exit(2)
}

if (!tracked.length) {
  console.error('FAIL: found no tracked *.test.mjs files at all.')
  console.error(`      Looked in ${REPO_ROOT}. A repository with no tests is not a clean result here --`)
  console.error('      it is far more likely this check lost its footing, so it refuses rather than passing.')
  process.exit(2)
}

/**
 * The files the baseline invocation would run.
 *
 * `globSync` with the same pattern strings the workflow hands to `node --test`.
 * This is a close approximation of node's own expansion rather than node's
 * actual expansion -- there is no way to ask node which files a pattern covers
 * without running them, and running the suite to answer a question about file
 * placement would make this check cost four minutes instead of milliseconds.
 * The approximation is safe in the direction that matters: both expand the same
 * `**` and `*` syntax over the same tree, and a disagreement would surface as a
 * spurious orphan report naming a specific file, not as a silent pass.
 */
const covered = new Set()
for (const pattern of BASELINE_PATTERNS) {
  for (const match of globSync(pattern, { cwd: REPO_ROOT })) covered.add(toPosix(match))
}

const elsewhere = new Map(RUN_ELSEWHERE.map(entry => [toPosix(entry.file), entry]))

const orphans = tracked.filter(file => !covered.has(file) && !elsewhere.has(file))
const missing = [...elsewhere.values()].filter(entry => !existsSync(path.join(REPO_ROOT, entry.file)))
const doubled = [...elsewhere.keys()].filter(file => covered.has(file))

console.log(`Test files tracked: ${tracked.length}`)
console.log(`  matched by a baseline pattern: ${covered.size}`)
console.log(`  declared as run elsewhere:     ${elsewhere.size}`)

let problem = false

if (orphans.length) {
  problem = true
  console.error(`\nFAIL: ${orphans.length} test file(s) run nowhere.`)
  for (const file of orphans) console.error(`        ${file}`)
  console.error('\n      These are tracked, they contain tests, and no pattern or workflow line')
  console.error('      names them -- so they have never run, and no report anyone reads would')
  console.error('      show that. Fix by widening a pattern in .forge/test-baseline.mjs (and')
  console.error('      re-measuring EXPECTED_TESTS in the same commit, since the total moves),')
  console.error('      or by adding a workflow line and then a RUN_ELSEWHERE row citing it.')
  console.error('      Adding a RUN_ELSEWHERE row WITHOUT a line that runs the file silences')
  console.error('      this check without running anything, which is strictly worse than the')
  console.error('      orphan: it looks like coverage.')
}

if (missing.length) {
  problem = true
  console.error(`\nFAIL: ${missing.length} RUN_ELSEWHERE entr(ies) name a file that does not exist.`)
  for (const entry of missing) console.error(`        ${entry.file} (declared run by ${entry.runBy})`)
  console.error('\n      The file was renamed or deleted and the row outlived it. Remove the row.')
  console.error('      Left in place it excuses nothing while reading as deliberate coverage,')
  console.error('      and would silently re-excuse a future file that lands at that path.')
}

if (doubled.length) {
  problem = true
  console.error(`\nFAIL: ${doubled.length} file(s) are both matched by a baseline pattern and declared run elsewhere.`)
  for (const file of doubled) console.error(`        ${file} (also declared run by ${elsewhere.get(file).runBy})`)
  console.error('\n      That file runs twice per CI run. Beyond the wasted minutes, its tests are')
  console.error('      counted twice in the total EXPECTED_TESTS is measured against, so the next')
  console.error('      person to re-measure the baseline would pin the duplication as the number')
  console.error('      and it would take a shortfall to ever notice. Either narrow the pattern or')
  console.error('      drop the RUN_ELSEWHERE row -- whichever leaves the file running exactly once.')
}

if (!problem) {
  console.log(`\nOK: all ${tracked.length} test files run somewhere.`)
}

process.exitCode = problem ? 1 : 0
