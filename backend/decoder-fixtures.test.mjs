import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DECODER_SUITE_FILES } from '../.forge/test-baseline.mjs'
import {
  checkoutRootFromGitCommonDir,
  defaultDecoderPython,
  resolveDecoderPython,
  venvPython,
} from './fixtures/image-provider/decoder-fixtures.mjs'

/**
 * `defaultDecoderPython` is a pure function specifically so this can assert
 * on synthetic paths -- `backend/*.test.mjs` is CI's actual glob, flat and
 * non-recursive, so a test living under `backend/fixtures/image-provider/`
 * next to the module it covers would never run there; this file is the one
 * place that actually gets executed.
 *
 * Every synthetic case below uses `path.win32` or `path.posix` explicitly to
 * build its `moduleDir` and expected result -- never the bare `path` import,
 * and never `platform: process.platform`. `defaultDecoderPython` itself
 * picks the matching module internally from the `platform` argument (see
 * its own comment), so a Windows-shaped path asserted with `platform:
 * 'win32'` means the same thing whether this suite runs on the Windows box
 * that wrote it or the Linux runner that gates it. An earlier version of
 * this file built moduleDir with the bare `path.join`, which is ambient --
 * native to whichever OS is actually running the test -- and it passed
 * locally on Windows and failed on Linux CI, silently anchored to
 * `process.cwd()` because POSIX `path.resolve` does not recognise `C:\...`
 * as absolute. Caught by CI, not by running this suite locally; that is
 * exactly the class of mistake explicit modules exist to rule out here.
 */

test('from the main checkout (Windows-shaped), the venv is looked for at the repo root', () => {
  const moduleDir = path.win32.join('C:', 'repo', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.win32.join('C:', 'repo', 'decoder.local', 'Scripts', 'python.exe'))
})

test('from the main checkout (POSIX-shaped), the venv is looked for at the repo root', () => {
  const moduleDir = path.posix.join('/', 'home', 'dev', 'repo', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'linux')
  assert.equal(found, path.posix.join('/', 'home', 'dev', 'repo', 'decoder.local', 'bin', 'python'))
})

test('from inside a .worktrees checkout (Windows-shaped), the venv is looked for in the MAIN checkout, not the worktree', () => {
  // This is the bug: the module's own directory is a real path inside the
  // worktree, and a naive import.meta.url fix (no .worktrees awareness)
  // would resolve here -- which is exactly as unreachable as decoder.local
  // was under the old cwd-relative resolve(), because nothing tracks or
  // copies an untracked venv into a fresh worktree checkout.
  const moduleDir = path.win32.join('C:', 'repo', '.worktrees', 'some-branch', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.win32.join('C:', 'repo', 'decoder.local', 'Scripts', 'python.exe'),
    'must climb past .worktrees/some-branch to the main checkout, not stop at the worktree root')
})

test('from inside a .worktrees checkout (POSIX-shaped), the venv is looked for in the MAIN checkout, not the worktree', () => {
  const moduleDir = path.posix.join('/', 'home', 'dev', 'repo', '.worktrees', 'some-branch', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'linux')
  assert.equal(found, path.posix.join('/', 'home', 'dev', 'repo', 'decoder.local', 'bin', 'python'),
    'must climb past .worktrees/some-branch to the main checkout, not stop at the worktree root')
})

test('a worktree name containing "worktrees" without the leading dot does not trigger the climb', () => {
  // The marker is literally `.worktrees`, path-separated on both sides --
  // a directory that merely contains the substring must not match, and the
  // repo root computed from three levels up (image-provider -> fixtures ->
  // backend -> here) is `myworktrees` itself, with nothing above it to climb
  // past.
  const moduleDir = path.win32.join('C:', 'repo', 'myworktrees', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.win32.join('C:', 'repo', 'myworktrees', 'decoder.local', 'Scripts', 'python.exe'),
    'no .worktrees marker present, so nothing above myworktrees should be climbed to')
})

test('against this actual repo: resolves outside .worktrees even when this test itself is running from inside one', () => {
  // Not synthetic -- this file's own real on-disk location, wherever the
  // suite happens to be invoked from (the main checkout or a worktree, per
  // AGENTS.md), and `process.platform`, which is correct here specifically
  // because this is the one test asserting against reality rather than a
  // constructed cross-platform case: real paths and the real host always
  // agree with each other by definition. The bug this guards against is
  // specifically that resolve('decoder.local', ...) answered differently
  // depending on process.cwd(); calling the real function with this test
  // file's own real moduleDir is the integration-level version of the
  // synthetic cases above, against paths nobody hand-typed.
  const moduleDir = path.join(import.meta.dirname, 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, process.platform)
  assert.ok(!found.includes(`.worktrees${path.sep}`), `must not resolve inside a worktree, got: ${found}`)
  assert.equal(path.basename(found), process.platform === 'win32' ? 'python.exe' : 'python')
  assert.equal(path.basename(path.dirname(found)), process.platform === 'win32' ? 'Scripts' : 'bin')
})

/**
 * WHAT THE SIX TESTS ABOVE CANNOT SEE, and why these exist.
 *
 * Every one of them passed, green, in a worktree where `decoderPython` was
 * `null` and 73 tests were silently not running. The real-repo test is the
 * instructive one: it asserts the answer does not contain `.worktrees/`, and
 * `C:\...\kmt\.claude\worktrees\agent-x\decoder.local\...` satisfies that
 * assertion perfectly -- there is no `.` before `worktrees` there, so the
 * marker is absent, the climb never happens, and the check written to catch
 * exactly this reports success. An absence proves nothing until the
 * instrument could have said otherwise.
 *
 * The repair is to stop asserting a property of the STRING and start
 * asserting the property anyone actually wants: the venv this resolves to is
 * the one in the main checkout, whichever of this machine's six worktree
 * layouts the suite is running from. Git is the only thing that knows that,
 * so git is what these compare against.
 */

test('the marker alone cannot describe the harness layout it now has to survive', () => {
  // `.claude/worktrees/<name>` -- five live trees on this machine, and the
  // shape this suite itself runs in. No `.worktrees` marker, so the climb
  // does not fire and the venv is looked for INSIDE the worktree, where
  // nothing has ever built one. Pinned as the documented limitation of
  // `defaultDecoderPython`, not as desired behaviour: it is the reason
  // `resolveDecoderPython` has a second step at all, and if someone later
  // "fixes" the marker to cover this case, this test tells them that the
  // git-backed step is what the other 61 unmatched trees still need.
  const moduleDir = path.win32.join('C:', 'repo', '.claude', 'worktrees', 'agent-x', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.win32.join('C:', 'repo', '.claude', 'worktrees', 'agent-x', 'decoder.local', 'Scripts', 'python.exe'),
    'documents the gap the git-common-dir step closes; it does not endorse it')
})

test('the main checkout is git common dir minus the .git (Windows-shaped)', () => {
  assert.equal(
    checkoutRootFromGitCommonDir(path.win32.join('C:', 'repo', '.git'), 'win32'),
    path.win32.join('C:', 'repo'))
})

test('the main checkout is git common dir minus the .git (POSIX-shaped)', () => {
  assert.equal(
    checkoutRootFromGitCommonDir(path.posix.join('/', 'home', 'dev', 'repo', '.git'), 'linux'),
    path.posix.join('/', 'home', 'dev', 'repo'))
})

test('a worktree in ANY layout resolves to the same venv, because git reports one common dir for all of them', () => {
  // The three shapes this machine actually has, all reporting the same
  // common dir (which is what git does -- that is the whole property being
  // relied on). The marker gets two of these wrong; this step gets all
  // three right for the same reason it will get the fourth one right.
  const commonDir = path.win32.join('C:', 'repo', '.git')
  const expected = path.win32.join('C:', 'repo', 'decoder.local', 'Scripts', 'python.exe')
  for (const label of ['.worktrees/x', '.claude/worktrees/x', 'a codex tree far outside the repo']) {
    assert.equal(venvPython(checkoutRootFromGitCommonDir(commonDir, 'win32'), 'win32'), expected,
      `layout "${label}" must resolve to the main checkout's venv`)
  }
})

test('KMT_IMAGE_DECODER_PYTHON wins outright, and costs no filesystem or git lookup', () => {
  const out = resolveDecoderPython(path.join(import.meta.dirname, 'fixtures', 'image-provider'),
    { KMT_IMAGE_DECODER_PYTHON: '/nowhere/python' })
  assert.equal(out.python, '/nowhere/python')
  assert.deepEqual(out.searched, [], 'an explicit interpreter is honoured as given, not searched for or validated')
})

test('against this actual repo: the search reaches the venv git says the main checkout holds', () => {
  // The assertion the six above could not make. `env: {}` forces the real
  // search -- no KMT_IMAGE_DECODER_PYTHON short-circuit even when the
  // ambient environment has one set, so this measures resolution rather
  // than the caller's configuration.
  //
  // Deliberately NOT "a python was found": CI builds its venv in
  // RUNNER_TEMP and points the variable at it, so no `decoder.local` exists
  // anywhere in the checkout there and the honest result is null. What must
  // hold in BOTH places is that the main checkout's venv path is among the
  // places looked -- that is the thing that was false in this worktree and
  // that no existing test could see.
  const mainCheckout = checkoutRootFromGitCommonDir(
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: import.meta.dirname, encoding: 'utf8' }).trim())
  const wanted = venvPython(mainCheckout)

  const out = resolveDecoderPython(path.join(import.meta.dirname, 'fixtures', 'image-provider'), {})
  assert.ok(out.searched.includes(wanted),
    `the main checkout's venv (${wanted}) must be among the searched paths, got: ${out.searched.join(', ')}`)
  if (out.python !== null) {
    assert.equal(out.python, wanted, 'when a venv is found it must be the main checkout\'s, never one inside a worktree')
  }
})

/**
 * The tripwire for DECODER_SUITE_DELTA.
 *
 * That constant has gone stale twice in silence -- 45 when a fourth image
 * suite was added, 65 when a fifth was -- and both times the check that
 * consumes it responded by inventing a remainder and telling a reader to go
 * find tests that did not exist. Neither staleness was carelessness: the
 * constant lived in a file that is a SCRIPT, so importing it runs the whole
 * suite, so nothing could assert against it, so nothing did.
 *
 * The fix is not vigilance. It is to notice the EVENT that invalidates the
 * number -- a sixth file gaining a module-scope `realImageFixtures()` call --
 * at the moment it happens, in a test that costs a directory read. The delta
 * itself still has to be re-measured by hand; what this removes is the part
 * where nobody knows it needs to be.
 */
test('DECODER_SUITE_FILES is exactly the set of test files that die without a decoder', () => {
  // MATCH THE IMPORT STATEMENT, NOT THE NAME. The first draft of this searched
  // for a `realImageFixtures(` call anywhere in the file, and its very first
  // run reported THIS file as a sixth decoder suite -- because the prose two
  // paragraphs up says "a module-scope `realImageFixtures()` call". A detector
  // that cannot tell a call site from a sentence about call sites will be wrong
  // again the next time someone documents it, and being wrong in the direction
  // of a false alarm is only luck: the same looseness would match a name in a
  // string, a comment saying a file no longer needs it, or commented-out code.
  //
  // The import list is the precise question. A file that dies at module load
  // without a decoder is exactly a file that imports the fixtures builder, and
  // the three other test files mentioning `decoder-fixtures` (claim, git-lib,
  // worktree -- they use its path as data) import no such thing and correctly
  // do not match.
  const importsBuilder = (source) => {
    const statement = source.match(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]*decoder-fixtures\.mjs['"]/)
    return statement !== null && /\brealImageFixtures\b/.test(statement[1])
  }

  const backendDir = import.meta.dirname
  const actual = readdirSync(backendDir)
    .filter(name => name.endsWith('.test.mjs'))
    .filter(name => importsBuilder(readFileSync(path.join(backendDir, name), 'utf8')))
    .map(name => `backend/${name}`)
    .sort()

  assert.deepEqual(actual, [...DECODER_SUITE_FILES].sort(),
    'A test file gained or lost a realImageFixtures() call, so the number of tests a missing decoder '
    + 'costs has changed. Re-MEASURE DECODER_SUITE_DELTA in .forge/test-baseline.mjs (that file says how) '
    + 'and update this list in the same commit -- updating only the list hides the very drift it exists to catch.')
})

test('every file DECODER_SUITE_FILES names still exists and still imports the fixtures module', () => {
  // The other half, and the reason it is separate: a list can also rot by
  // naming a file that was renamed away, and `deepEqual` above would then
  // fail pointing at the new name without ever saying the old one is gone.
  // This is the RUN_ELSEWHERE lesson from test-baseline.mjs applied one level
  // down -- an entry that excuses nothing while reading as deliberate coverage.
  for (const file of DECODER_SUITE_FILES) {
    const full = path.join(import.meta.dirname, '..', file)
    assert.ok(existsSync(full), `${file} is named by DECODER_SUITE_FILES but does not exist`)
    assert.match(readFileSync(full, 'utf8'), /decoder-fixtures\.mjs/,
      `${file} no longer imports the decoder fixtures, so it cannot be one of the suites a missing decoder kills`)
  }
})
