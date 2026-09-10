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
 * the line that runs it, because the whole value of the orphan check is the
 * claim "every test file in this tree runs somewhere", and an entry without a
 * runner turns that claim into "every test file is either run or listed here",
 * which is worth nothing.
 *
 * If you are about to add a row because a new test is reported as an orphan:
 * that report is almost certainly correct, and the fix is a pattern above or a
 * workflow line, not a row here. A row here is only honest once the workflow
 * line exists and you can cite it.
 *
 * These two are genuine: both run in earlier jobs, against a built release
 * rather than the source tree, and both would run TWICE if a `.forge/*.test.mjs`
 * glob picked them up alongside the baseline invocation.
 */
export const RUN_ELSEWHERE = [
  { file: '.forge/release-check.test.mjs', runBy: '.github/workflows/fly-deploy.yml:101' },
  { file: '.forge/release-browser.test.mjs', runBy: '.github/workflows/fly-deploy.yml:250' },
]
