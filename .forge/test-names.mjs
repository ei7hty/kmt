/**
 * Read the NAMES of the tests a source file declares.
 *
 * Split out from `test-name-diff-check.mjs` so it can be tested directly, on
 * strings, with no repository and no git -- the same reason
 * `defaultDecoderPython` is a pure function of a path.
 *
 * ---------------------------------------------------------------------------
 * WHY A REGEX IS THE RIGHT TOOL HERE, WHICH IS NOT USUALLY TRUE
 *
 * This is a lexical approximation of a thing a parser would answer exactly, and
 * normally that trade lands the wrong way. It is safe here for one specific
 * reason: THE SAME EXTRACTOR RUNS ON BOTH SIDES OF THE COMPARISON. The
 * consumer diffs the names at `git merge-base HEAD origin/main` against the
 * names in the working tree, using this function for both. Any name this
 * function mis-reads, it mis-reads identically at both revisions, so the
 * mistake cancels and the DIFFERENCE -- the only thing anyone acts on -- stays
 * correct.
 *
 * That property is what makes the imprecision tolerable, and it is also the
 * thing to preserve: do not "improve" one side of the comparison alone, and do
 * not make extraction depend on anything outside the source text handed in
 * (file position, git state, the platform), because then the two sides stop
 * being the same measurement.
 *
 * Measured against the 41 test files this repository runs: 738 `test('`, 9
 * `test(\``, 4 `test("`. Template literals with `${...}` inside are captured as
 * their SOURCE TEXT, not expanded -- `a token with no ${claim} is rejected` --
 * which is exactly right for this purpose: one declaration in the source is one
 * name here, whether it produces one test at runtime or twelve.
 */

/**
 * `test`, `it` and `describe` -- declared, or awaited, or nested one level in
 * as `t.test(...)`. The name must be the first argument and a literal; a name
 * built from a variable is not something two revisions can be compared on, and
 * is deliberately not matched rather than matched badly.
 */
const DECLARATION = /(?:^|[\s;{(])(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?(test|it|describe)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g

/**
 * Every test name declared in `source`, in order, duplicates included.
 *
 * Duplicates are kept on purpose: two files can legitimately declare the same
 * name, and if one of them is deleted a SET would show no loss while a count
 * would. The consumer compares counts for this reason.
 */
export function extractTestNames(source) {
  const names = []
  for (const match of source.matchAll(DECLARATION)) names.push(match[3])
  return names
}

/**
 * How many times each name appears across a whole revision's test files.
 * `Map<name, count>`.
 */
export function nameCounts(filesToSources) {
  const counts = new Map()
  for (const source of filesToSources.values()) {
    for (const name of extractTestNames(source)) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/**
 * Names that exist fewer times at head than at base.
 *
 * Returns `[{ name, before, after }]`. A name that merely MOVED between files
 * is not reported: the count is unchanged, and a refactor that relocates a test
 * has lost nothing. That is the deliberate granularity -- file-keyed would cry
 * wolf on every reorganisation, and a check that cries wolf is a check people
 * learn to pass with `--no-verify`.
 */
export function lostNames(before, after) {
  const lost = []
  for (const [name, count] of before) {
    const now = after.get(name) ?? 0
    if (now < count) lost.push({ name, before: count, after: now })
  }
  return lost.sort((a, b) => a.name.localeCompare(b.name))
}

