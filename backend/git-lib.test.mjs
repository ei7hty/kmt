import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git, gitProbe } from '../scripts/lib/git.mjs'

/**
 * `scripts/lib/git.mjs` lives in the `scripts/` lane, but CI's actual test
 * command (`fly-deploy.yml`: `"backend/*.test.mjs" "src/**\/*.test.mjs"`)
 * never looks there at all -- so this test lives here, flat in `backend/`,
 * the same reason `backend/worktree.test.mjs`, `backend/claim.test.mjs` and
 * `backend/decoder-fixtures.test.mjs` all do.
 *
 * `git()` replaces a throwing helper that had been independently redefined
 * in scripts/worktree.mjs and scripts/claim.mjs, each of which had exactly
 * one call site nobody wrapped in try/catch -- crashing with a raw Node
 * stack instead of a clean message. These tests exist to pin the two
 * properties that make that structurally impossible here: a failure always
 * prints (never silent) and always comes back as `{ ok: false }` with NO
 * `stdout` key (never a falsy-but-valid-looking empty string a forgetful
 * caller could silently propagate).
 */

function sandboxRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmt-git-lib-test-'))
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort on Windows locks */ } })
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'seed'], { cwd: dir })
  return dir
}

test('git(): a successful command returns { ok: true, stdout }', t => {
  const dir = sandboxRepo(t)
  const result = git(['log', '--oneline'], dir)
  assert.equal(result.ok, true)
  assert.match(result.stdout, /seed/)
  assert.equal('error' in result, false)
})

test('git(): a failing command prints the real git error AND returns ok:false', t => {
  const dir = sandboxRepo(t)
  const originalError = console.error
  const printed = []
  console.error = (...args) => printed.push(args.join(' '))
  try {
    const result = git(['log', 'this-ref-does-not-exist'], dir)
    assert.equal(result.ok, false)
    assert.match(result.error, /unknown revision|bad revision/)
    assert.ok(printed.length > 0, 'the real git error must be printed, not only returned')
    assert.match(printed.join('\n'), /unknown revision|bad revision/)
  } finally {
    console.error = originalError
  }
})

test('git(): failure has NO stdout key -- a caller that ignores .ok and reads .stdout throws instead of silently proceeding on undefined', t => {
  // This is the test that pins the corrected property. An earlier draft
  // returned `stdout: ''` on failure, which is falsy but a VALID-LOOKING
  // string -- a caller that forgot to check `.ok` and did
  // `const sha = git([...], cwd).stdout` would silently keep going with an
  // empty string, exactly the "loud failure" claim this helper makes but
  // that design broke. `stdout` must be absent, not empty, so the same
  // forgetful call site gets `undefined` and the next use of it throws.
  const dir = sandboxRepo(t)
  const originalError = console.error
  console.error = () => {} // silence the (already-covered-above) unconditional print for this assertion's own output
  let result
  try {
    result = git(['log', 'this-ref-does-not-exist'], dir)
  } finally {
    console.error = originalError
  }
  assert.equal(result.ok, false)
  assert.equal('stdout' in result, false, 'stdout must be entirely absent on failure, not an empty string')
  assert.throws(() => result.stdout.trim(), /Cannot read propert/, 'a caller ignoring .ok and using .stdout as a string must throw, not proceed on a falsy empty string')
})

test('gitProbe(): a true answer (is an ancestor) returns true and prints nothing', t => {
  const dir = sandboxRepo(t)
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const originalError = console.error
  const printed = []
  console.error = (...args) => printed.push(args.join(' '))
  let ok
  try {
    ok = gitProbe(['merge-base', '--is-ancestor', sha, sha], dir)
  } finally {
    console.error = originalError
  }
  assert.equal(ok, true)
  assert.equal(printed.length, 0)
})

test('gitProbe(): a legitimate "no" (rev-parse --verify on an absent ref) returns false and prints NOTHING -- this is an answer, not a failure', t => {
  const dir = sandboxRepo(t)
  const originalError = console.error
  const printed = []
  console.error = (...args) => printed.push(args.join(' '))
  let ok
  try {
    ok = gitProbe(['rev-parse', '--verify', '--quiet', 'this-branch-does-not-exist'], dir)
  } finally {
    console.error = originalError
  }
  assert.equal(ok, false)
  assert.equal(printed.length, 0, 'a legitimate negative answer must not print a scary git error -- that is what would turn this into a noise source')
})
