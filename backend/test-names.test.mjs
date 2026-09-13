import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTestNames, lostNames, nameCounts } from '../.forge/test-names.mjs'

/**
 * Covers `.forge/test-names.mjs`, the extractor behind
 * `.forge/test-name-diff-check.mjs`.
 *
 * Flat in `backend/`, not beside the module: `backend/**` is a baseline
 * pattern and `.forge/*.test.mjs` is not, so a test placed next to what it
 * covers would be an orphan -- the same reason `backend/claim.test.mjs` and
 * `backend/worktree.test.mjs` cover `scripts/` modules from here.
 *
 * NOTE FOR ANYONE EDITING THE FIXTURES BELOW. This file contains the literal
 * text `test('...')` inside strings, so the name-diff check counts those
 * fixture names as declarations in this file -- harmless, because it compares
 * the same extractor's output at both revisions, but it does mean that
 * RENAMING a fixture string here will be reported as a lost test name. That is
 * the check working, not a bug in it; say so in the pull request like any other
 * deliberate rename.
 */

test('extracts names in all three quote styles the repository actually uses', () => {
  // Measured across the 41 files the baseline runs: 738 single, 9 template,
  // 4 double. All three are real and all three must be read.
  const source = [
    "test('nm-single quoted', () => {})",
    'test("nm-double quoted", () => {})',
    'test(`nm-template quoted`, () => {})',
  ].join('\n')
  assert.deepEqual(extractTestNames(source), ['nm-single quoted', 'nm-double quoted', 'nm-template quoted'])
})

test('a template name keeps its ${...} as source text rather than expanding it', () => {
  // Nine real declarations look like this, and a loop around them produces
  // many runtime tests from one declaration. Source text is the right unit:
  // it is stable across revisions, which is the only thing being compared.
  const source = 'test(`nm-a token with no ${claim} is rejected`, () => {})'
  assert.deepEqual(extractTestNames(source), ['nm-a token with no ${claim} is rejected'])
})

test('reads it(), describe() and the t.test() subtest form', () => {
  const source = [
    "it('nm-an it', () => {})",
    "describe('nm-a describe', () => {})",
    "  await t.test('nm-a subtest', () => {})",
  ].join('\n')
  assert.deepEqual(extractTestNames(source), ['nm-an it', 'nm-a describe', 'nm-a subtest'])
})

test('a name built from a variable is skipped, not guessed at', () => {
  // Deliberate. Two revisions cannot be compared on a name that does not
  // exist in the source, and a check that invents one would report a loss
  // every time the variable's value changed. Skipping is the honest answer;
  // the cost is that such a test is not covered, which is stated rather than
  // hidden.
  const source = [
    'test(caseName, () => {})',
    'test(`${prefix}`, () => {})',
    "test('nm-kept', () => {})",
  ].join('\n')
  assert.deepEqual(extractTestNames(source), ['${prefix}', 'nm-kept'],
    'a bare identifier yields nothing; a template that is entirely a substitution yields its source text')
})

test('a word ending in test does not open a declaration', () => {
  // `retest('x')`, `mytest('x')` and a property access like `foo.test('x')`
  // on a regex are all real shapes in JavaScript. The regex requires a
  // boundary before the verb, so only the last of these counts -- and the
  // property form is allowed on purpose, because `t.test(...)` is how node
  // subtests are written.
  const source = [
    "retest('nm-not a test', () => {})",
    "/re/.test('nm-a regex probe')",
    "t.test('nm-a real subtest', () => {})",
  ].join('\n')
  const names = extractTestNames(source)
  assert.ok(!names.includes('nm-not a test'), 'retest( must not match')
  assert.ok(names.includes('nm-a real subtest'), 't.test( must match')
})

test('an escaped quote inside a name does not end the name early', () => {
  const source = "test('nm-it won\\'t truncate here', () => {})"
  assert.deepEqual(extractTestNames(source), ["nm-it won\\'t truncate here"])
})

test('nameCounts counts duplicates across files rather than collapsing them', () => {
  // The reason counts and not a Set: two files may legitimately declare the
  // same name, and deleting one of them is a real loss that a Set cannot see.
  const counts = nameCounts(new Map([
    ['a.test.mjs', "test('nm-shared', () => {})\ntest('nm-only-a', () => {})"],
    ['b.test.mjs', "test('nm-shared', () => {})"],
  ]))
  assert.equal(counts.get('nm-shared'), 2)
  assert.equal(counts.get('nm-only-a'), 1)
})

test('lostNames reports a deleted test, with its before and after counts', () => {
  const before = nameCounts(new Map([['a.test.mjs', "test('nm-kept', () => {})\ntest('nm-deleted', () => {})"]]))
  const after = nameCounts(new Map([['a.test.mjs', "test('nm-kept', () => {})"]]))
  assert.deepEqual(lostNames(before, after), [{ name: 'nm-deleted', before: 1, after: 0 }])
})

test('lostNames reports a swap even when the total is unchanged', () => {
  // THE CASE THE WHOLE CHECK EXISTS FOR. Three tests out, three in: the suite
  // total is identical, the file count is identical, every remaining test
  // passes, and the count guard and orphan guard both go green. Verified end
  // to end against the real repository as well -- see the pull request.
  const before = nameCounts(new Map([['a.test.mjs', "test('nm-x1', () => {})\ntest('nm-x2', () => {})\ntest('nm-x3', () => {})"]]))
  const after = nameCounts(new Map([['b.test.mjs', "test('nm-y1', () => {})\ntest('nm-y2', () => {})\ntest('nm-y3', () => {})"]]))
  assert.deepEqual(lostNames(before, after).map(l => l.name), ['nm-x1', 'nm-x2', 'nm-x3'])
})

test('a test that MOVED between files is not reported as lost', () => {
  // The granularity decision, pinned. Keying names by file would make every
  // refactor that relocates a test red, and a check that cries wolf is one
  // people learn to route around -- which costs more than the precision buys.
  const before = nameCounts(new Map([['a.test.mjs', "test('nm-moved', () => {})"]]))
  const after = nameCounts(new Map([['b.test.mjs', "test('nm-moved', () => {})"]]))
  assert.deepEqual(lostNames(before, after), [])
})

test('adding tests is not a loss', () => {
  const before = nameCounts(new Map([['a.test.mjs', "test('nm-one', () => {})"]]))
  const after = nameCounts(new Map([['a.test.mjs', "test('nm-one', () => {})\ntest('nm-two', () => {})"]]))
  assert.deepEqual(lostNames(before, after), [])
})

test('losing ONE of two same-named tests is still a loss', () => {
  // The case a Set would miss entirely, and the reason nameCounts returns
  // counts. `2 -> 1` is a deleted test even though the name survives.
  const before = nameCounts(new Map([
    ['a.test.mjs', "test('nm-twin', () => {})"],
    ['b.test.mjs', "test('nm-twin', () => {})"],
  ]))
  const after = nameCounts(new Map([['a.test.mjs', "test('nm-twin', () => {})"]]))
  assert.deepEqual(lostNames(before, after), [{ name: 'nm-twin', before: 2, after: 1 }])
})
