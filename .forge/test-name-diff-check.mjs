/**
 * Fail when a test that ran on `main` has stopped existing on this branch.
 *
 *   node .forge/test-name-diff-check.mjs
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 *
 * `test-count-check.mjs` pins the TOTAL and `orphaned-test-check.mjs` pins that
 * every file runs somewhere. Between them sits a change neither can see:
 *
 *   delete a suite of 12 tests, add a new suite of 12 tests
 *
 * The total is identical. The file count is identical. Every remaining test
 * passes. Both existing guards go green, and twelve assertions that used to
 * protect something protect nothing. The swap does not even have to be
 * deliberate -- a rename during a refactor, a file moved and its old copy left
 * behind in a stale worktree, a merge that resolved the wrong way.
 *
 * Until now the defence was a SENTENCE. `test-count-check.mjs` ends its
 * shortfall message by asking the author to "say so in the pull request", which
 * makes the last line of defence a person noticing, in a diff, that a filename
 * they have never seen before is missing. One lane proved the gap by hand one
 * night -- diffing test names between the merge base and the head, by eye, and
 * showing nothing was lost. It took real time, it is not repeatable, and
 * nothing made the next lane do it. This is that, mechanically.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COMPARES, AND WHY THAT GRANULARITY
 *
 * Test NAMES, counted, at `git merge-base HEAD origin/main` against the working
 * tree. Not files, not totals:
 *
 *   - a total cannot distinguish a swap from a wash, which is the whole bug;
 *   - a file list cannot see twelve tests deleted from a file that still
 *     exists;
 *   - names keyed BY FILE would report every legitimate refactor that moves a
 *     test, and a check that cries wolf is one people learn to route around.
 *
 * The merge base, never `origin/main` itself. Basing on the branch tip means
 * every test added to main after you branched reads as "lost" from your branch,
 * which is noise you cannot fix and would teach everyone to ignore the output.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS RUNS, STATED PLAINLY BECAUSE IT IS NOT YET CI
 *
 * The gate job's checkout (`.github/workflows/fly-deploy.yml`, the `check` job)
 * carries no `fetch-depth`, so `actions/checkout` gives it depth 1 and there is
 * no merge base in that clone at all -- this check would refuse on every pull
 * request, which is worse than not running. Wiring it needs `fetch-depth: 0` on
 * that job plus one `- run:` line, and `.github/workflows/` belongs to the repo
 * agent by an explicit ruling, so that change is requested rather than made
 * here.
 *
 * Until then this is a local gate: run it before you open a pull request, the
 * way the browser audits are run. That is a weaker guarantee than CI and is
 * said out loud rather than implied, because a check nobody invokes is
 * indistinguishable from a check that passes.
 *
 * Exit codes match this directory's convention:
 *   0  judged, and nothing was lost
 *   1  judged, and tests that ran on main no longer exist
 *   2  could NOT judge -- no merge base reachable, or no test files found
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lostNames, nameCounts } from './test-names.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/**
 * REFUSING IS A RESULT, AND IT IS NOT A PASS.
 *
 * Everything below that cannot answer the question exits 2 and says which
 * question it could not answer. The failure this avoids has a name in
 * `.forge/NOTES.md`: a CI watcher whose "no results" and "no failures" were the
 * same value, announcing all-clear while the only meaningful check was still
 * running. A check that degrades quietly to green in the environment where it
 * matters is worse than no check, because it also consumes the attention that
 * would have gone to a real one.
 */
const refuse = (what, detail) => {
  console.error(`REFUSING TO JUDGE: ${what}`)
  for (const line of detail) console.error(`      ${line}`)
  console.error('      Exiting 2. This is NOT a pass -- nothing was compared.')
  process.exit(2)
}

let base
try {
  git(['fetch', '-q', 'origin', 'main'])
} catch {
  // Not fatal on its own: the ref may already be fresh, or the network may be
  // down while a perfectly good merge base sits in the local object store.
  // Reported only if the merge base then turns out to be unreachable.
}
try {
  base = git(['merge-base', 'HEAD', 'origin/main']).trim()
} catch (error) {
  refuse('no merge base between HEAD and origin/main.', [
    error.message.split('\n')[0],
    'A shallow clone (actions/checkout defaults to fetch-depth: 1) has no common',
    'ancestor to compare against, and neither does a checkout with no origin/main.',
    'Locally: `git fetch origin main`. In CI: set `fetch-depth: 0` on the job.',
  ])
}

const testFilesAt = (rev) => git(['ls-tree', '-r', '--name-only', rev])
  .split('\n').map(line => line.trim()).filter(name => name.endsWith('.test.mjs')).sort()

const sourcesAt = (rev, files) => new Map(files.map(file =>
  [file, git(['show', `${rev}:${file}`])]))

const baseFiles = testFilesAt(base)
if (!baseFiles.length) {
  refuse(`found no *.test.mjs at the merge base (${base.slice(0, 8)}).`, [
    'A repository with no tests at the base is far more likely to be this check',
    'losing its footing than a real state worth reporting as clean.',
  ])
}

/**
 * The head side reads the WORKING TREE, not `HEAD`.
 *
 * Deliberate: the point is to catch the swap before it is pushed, and an
 * uncommitted deletion is exactly as destructive as a committed one. It also
 * means running this twice around a `git add` gives the same answer, which a
 * HEAD-based comparison would not.
 */
const headFiles = git(['ls-files', '*.test.mjs'])
  .split('\n').map(line => line.trim()).filter(Boolean).sort()

const before = nameCounts(sourcesAt(base, baseFiles))
const after = nameCounts(new Map(headFiles.map(file =>
  [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])))

const lost = lostNames(before, after)
const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0)
const afterTotal = [...after.values()].reduce((a, b) => a + b, 0)

console.log(`Base: ${base.slice(0, 8)} (merge-base HEAD origin/main)`)
console.log(`  test declarations at base: ${beforeTotal} across ${baseFiles.length} files`)
console.log(`  test declarations at head: ${afterTotal} across ${headFiles.length} files`)

if (lost.length) {
  console.error(`\nFAIL: ${lost.length} test name(s) that existed at the merge base do not exist now.`)
  for (const { name, before: was, after: now } of lost) {
    console.error(`        ${JSON.stringify(name)}${was > 1 ? `  (${was} -> ${now})` : ''}`)
  }
  console.error('\n      A test that no longer exists cannot fail, so nothing else in the gate')
  console.error('      will mention this. The total can be unchanged -- deleting a suite and')
  console.error('      adding one of the same size is the case this check exists for, and it')
  console.error('      passes the count guard and the orphan guard both.')
  console.error('')
  console.error('      If you RENAMED a test on purpose, that is this check working: say so in')
  console.error('      the pull request and the reviewer merges it. If you did not, find where')
  console.error('      it went before you do anything else -- `git log --diff-filter=D --name-only')
  console.error(`      ${base.slice(0, 8)}..` + ' -- "*.test.mjs"` names files deleted on this branch.')
  process.exitCode = 1
} else {
  console.log(`\nOK: every one of the ${before.size} distinct test names at the merge base still exists.`)
  process.exitCode = 0
}
