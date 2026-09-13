/**
 * The one declaration of which test files this repository runs, and where.
 *
 * Two consumers, one copy, on purpose. `test-count-check.mjs` pins the TOTAL
 * these patterns produce; `orphaned-test-check.mjs` pins that no test file in
 * the tree falls OUTSIDE them. Those are opposite questions -- one catches a
 * suite that stopped running, the other catches a suite that never started --
 * and both need the same list.
 *
 * Two copies of that list would be the `CATALOG_FIELDS`/`EXPECTED_CHECKS`
 * defect this repository has already paid for twice: two constants encoding one
 * fact, which agree on the day they are written and silently stop agreeing
 * later. The orphan check would then be measuring a list nothing runs. So both
 * import from here, and there is no second copy to drift.
 */

/**
 * The patterns CI hands to `node --test`, in order.
 *
 * Order is load-bearing: `test-count-check.mjs` asserts that its own argv is
 * exactly this list, so a workflow that quietly narrows the invocation cannot
 * pass by counting a smaller run against the same baseline.
 */
export const BASELINE_PATTERNS = [
  'backend/**/*.test.mjs',
  'src/**/*.test.mjs',
  // Matches nothing today and is here on purpose: scripts/ is covered by no
  // glob, so a test beside a script has been invisible to CI and three sessions
  // have routed one into backend/ to be seen. Declaring it means the next such
  // test lands INTO coverage and the count below demands the bump, rather than
  // running nowhere until somebody remembers to widen a pattern.
  'scripts/**/*.test.mjs',
  // Named as a file, not a glob. `.forge/*.test.mjs` would also match
  // release-check and release-browser, which the workflow runs at :101 and :250
  // for their own reasons -- matching them here would run them twice. This one
  // has no such placement and had simply never been added to any list: 11 tests
  // that have never executed in CI, guarding the instrument that says whether a
  // restored customer database is trustworthy.
  '.forge/restore-integrity-check.test.mjs',
]

/**
 * Test files deliberately run somewhere OTHER than the baseline invocation.
 *
 * Not an exemption list and not a place to silence a finding. Every entry names
 * the WORKFLOW that runs it, because the whole value of the orphan check is the
 * claim "every test file in this tree runs somewhere", and an entry without a
 * runner turns that claim into "every test file is either run or listed here",
 * which is worth nothing.
 *
 * NOTE WHAT IS ABSENT: a line number. An earlier draft of this file cited
 * `fly-deploy.yml:250`, and REPO AGENT LEAD pointed out within the hour that
 * #482 adds ten comment lines above it and moves that invocation to :260 -- so
 * the citation would have been stale the moment their PR landed. The proposed
 * fix was to have the check verify the number. The better fix is to not store a
 * number that can disagree with anything: `orphaned-test-check.mjs` SEARCHES the
 * named workflow for the invocation and reports the line it found. There is
 * nothing to keep in sync, so nothing can drift, and the error message carries a
 * line number that is true by construction rather than by maintenance.
 *
 * That is the same move as this module itself, one level down -- the defect was
 * never "the copies disagree", it was "there are two copies".
 *
 * If you are about to add a row because a new test is reported as an orphan:
 * that report is almost certainly correct, and the fix is a pattern above or a
 * workflow line, not a row here. A row here is only honest once the workflow
 * actually invokes the file -- which the check now confirms rather than trusts.
 *
 * These two are genuine: both run in earlier jobs, against a built release
 * rather than the source tree, and both would run TWICE if a `.forge/*.test.mjs`
 * glob picked them up alongside the baseline invocation.
 */
export const RUN_ELSEWHERE = [
  { file: '.forge/release-check.test.mjs', runBy: '.github/workflows/fly-deploy.yml' },
  { file: '.forge/release-browser.test.mjs', runBy: '.github/workflows/fly-deploy.yml' },
]

/**
 * The test files that cannot run without a Python image decoder.
 *
 * These call `realImageFixtures()` at module scope, so with no decoder they
 * throw at module load: node reports each as ONE failing test rather than the
 * many it holds, and the suite total drops by `DECODER_SUITE_DELTA` below.
 *
 * DECLARED HERE, NOT IN `test-count-check.mjs`, for one reason: that file is a
 * script. Importing it runs the whole four-minute suite, so nothing could ever
 * assert against a constant living inside it, and `DECODER_SUITE_DELTA` sat
 * stale at 45 through the addition of a fourth image suite, then at 65 through
 * a fifth, because no instrument could reach it. A plain data module can be
 * imported by a test in milliseconds, and `backend/decoder-fixtures.test.mjs`
 * now does exactly that: it greps the tree for `realImageFixtures` callers and
 * fails if this list is not the answer.
 *
 * SO WHEN THAT TEST FAILS, RE-MEASURE `DECODER_SUITE_DELTA` -- do not merely
 * add the new file here. The list is the tripwire; the delta is the fact.
 */
export const DECODER_SUITE_FILES = [
  'backend/image-decoder.test.mjs',
  'backend/image-import-cli.test.mjs',
  'backend/image-pipeline-e2e.test.mjs',
  'backend/image-publication.test.mjs',
  'backend/image-staging-coordinator.test.mjs',
]

/**
 * The DIFFERENCE a decoder makes to the suite total: measured 2026-09-12 as
 * 907 tests with one and 834 without, same tree, same command, nothing
 * different but the resolver's ability to find the venv.
 *
 * Not the number of tests those five files hold. Each dead file still
 * registers one failing test, so the five leave 5 behind and the total drops
 * by 73 rather than by the 78 they contain. The name is the arithmetic it
 * actually does, because calling it a suite size invited that confusion once
 * already.
 *
 * WAS 45 (three dead suites), THEN 65 (four), AND BOTH WENT STALE IN SILENCE.
 * The reason is worth more than the number, and it is not carelessness: each
 * fix that made the decoder easier to find also removed the only way to
 * observe its absence. #464 taught the resolver to climb out of `.worktrees/`,
 * so unsetting `KMT_IMAGE_DECODER_PYTHON` stopped producing the no-decoder
 * state; the git-common-dir step added alongside this constant closes the
 * remaining 66 worktrees of 236 that #464's marker could not describe, which
 * closes the last one. CI never reaches it either -- `fly-deploy.yml` builds a
 * venv at :94-98 and exports the variable, in the SAME job as the count check
 * at :134, so the branch that consumes this constant cannot fire there. (An
 * earlier comment claimed the opposite -- "CI has no venv and is exactly where
 * it now fires" -- and that was simply false when written.)
 *
 * A FIX THAT REMOVES A FAILURE MODE LOCALLY ALSO REMOVES THE ABILITY TO
 * EXERCISE ITS GUARD LOCALLY. Name the category, because it is not specific to
 * this constant. The answer is not to leave the failure mode in place; it is to
 * give the constant an instrument that does not depend on reproducing it, which
 * is what `DECODER_SUITE_FILES` above now is.
 *
 * HOW TO RE-MEASURE, which no longer involves renaming anything shared. Do NOT
 * rename `decoder.local` -- other sessions run tests against it concurrently.
 * Instead make `gitCommonDir()` in
 * `backend/fixtures/image-provider/decoder-fixtures.mjs` return null, from any
 * checkout that is not the main one and has no venv of its own (every agent
 * worktree qualifies), and run the baseline invocation with
 * KMT_IMAGE_DECODER_PYTHON unset. Then restore the line and run the same
 * command again: the two totals differ by the decoder and nothing else, and
 * that control is what makes the subtraction mean anything. Subtract ONE from
 * the drop for each of your own tests that fails under the edit, if any assert
 * on real resolution.
 */
export const DECODER_SUITE_DELTA = 73
