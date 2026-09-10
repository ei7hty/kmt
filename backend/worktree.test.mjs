import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ROOT, commonDirOf, removeTarget } from '../scripts/worktree.mjs'

/**
 * `scripts/worktree.mjs` lives in the `scripts/` lane, but CI's actual test
 * command (`fly-deploy.yml`: `"backend/*.test.mjs" "src/**\/*.test.mjs"`)
 * never looks there at all -- so this test lives here, flat in `backend/`,
 * the same reason `backend/decoder-fixtures.test.mjs` tests a `backend/`
 * fixture module from the top level rather than nested beside it.
 *
 * `remove` gained a full/relative-path form so cleanup can reach the
 * majority of registered worktrees on this machine, which live outside
 * `.worktrees/` entirely. This file proves the four things that mattered
 * about that: a registered worktree is actually removed by path, an
 * unregistered path is refused (both "not a worktree at all" and "a
 * worktree of a DIFFERENT repository" -- the sharper case), a dirty tree
 * is refused including untracked files, and -- the one that would be
 * discovered by every agent on this machine at once if it were wrong --
 * the shared `node_modules` install survives.
 *
 * These spawn the real CLI against real worktrees on disk rather than
 * calling internal functions directly: the properties being proved are
 * about what `git worktree remove` and the junction/symlink unlink
 * actually do to real state, which a unit test of isolated logic cannot
 * observe.
 */

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'worktree.mjs')
const run = (args) => {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || String(error.message) }
  }
}

/** A throwaway registered worktree of THIS repo, at an arbitrary path outside .worktrees/. */
function makeWorktree(t, { dirty = null } = {}) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'kmt-worktree-test-')), 'tree')
  const branch = `worktree-test-tmp-${path.basename(dir)}-${Math.random().toString(36).slice(2, 8)}`
  execFileSync('git', ['worktree', 'add', dir, 'origin/main', '-b', branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => {
    // Best-effort: most tests remove it themselves via the tool under test.
    // If a test fails before that, this still gets the fixture off disk and
    // the branch out of the repo's list rather than leaking either.
    try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' }) } catch { /* already gone */ }
    try { execFileSync('git', ['branch', '-D', branch], { cwd: ROOT, stdio: 'ignore' }) } catch { /* already gone */ }
    try { rmSync(path.dirname(dir), { recursive: true, force: true }) } catch { /* already gone */ }
  })
  if (dirty === 'tracked') writeFileSync(path.join(dir, 'README.md'), 'tracked mutation for the dirty-tree test\n', { flag: 'a' })
  if (dirty === 'untracked') writeFileSync(path.join(dir, 'an-untracked-file.txt'), 'unfinished work\n')
  return { dir, branch }
}

test('removeTarget resolves a bare name under .worktrees/, and anything with a path separator as a path', () => {
  assert.equal(removeTarget('some-name'), path.join(ROOT, '.worktrees', 'some-name'))
  const explicit = path.join(ROOT, '.worktrees', 'explicit-path')
  assert.equal(removeTarget(explicit), explicit)
  assert.equal(removeTarget('../elsewhere/tree'), path.resolve(process.cwd(), '../elsewhere/tree'))
})

test('commonDirOf: this repo, a different repo, and a non-repo directory', () => {
  assert.equal(commonDirOf(ROOT), path.join(ROOT, '.git'))
  assert.equal(commonDirOf(path.join(tmpdir())), null, 'the OS temp root is not inside any git repo')
})

test('removes a registered worktree by full path -- the actual new capability', t => {
  const { dir } = makeWorktree(t)
  assert.ok(existsSync(dir))

  const result = run(['remove', dir])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Removed/)
  assert.equal(existsSync(dir), false, 'the directory itself is gone')

  const stillRegistered = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  assert.doesNotMatch(stillRegistered, new RegExp(dir.replace(/\\/g, '\\\\')), 'git no longer lists it either')
})

test('refuses a path that is not a worktree at all -- nonexistent and a plain directory', t => {
  const nonexistent = path.join(tmpdir(), `kmt-worktree-test-nonexistent-${Date.now()}`)
  const notNonexistent = run(['remove', nonexistent])
  assert.equal(notNonexistent.code, 1)
  assert.match(notNonexistent.stderr, /not a registered worktree/)

  const plainDir = mkdtempSync(path.join(tmpdir(), 'kmt-worktree-test-plain-'))
  t.after(() => rmSync(plainDir, { recursive: true, force: true }))
  const notARepo = run(['remove', plainDir])
  assert.equal(notARepo.code, 1)
  assert.match(notARepo.stderr, /not a registered worktree/)
})

test('refuses a worktree that belongs to a DIFFERENT repository, and leaves it untouched', t => {
  // A real second repository, not a synthetic path -- a git worktree of the
  // wrong repo is a fundamentally different mistake from a path that is not
  // a worktree at all, and the message (and the guard) must say so.
  // No commit needed -- git-common-dir resolves on an empty repo, and the
  // guard being tested never looks at history.
  const otherRepo = mkdtempSync(path.join(tmpdir(), 'kmt-worktree-test-other-repo-'))
  t.after(() => rmSync(otherRepo, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', otherRepo])

  const result = run(['remove', otherRepo])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /belongs to a different repository/)
  assert.ok(existsSync(path.join(otherRepo, '.git')), 'the other repository is completely untouched')
})

test('refuses a dirty tree with an untracked file, and leaves both tree and file in place', t => {
  const { dir } = makeWorktree(t, { dirty: 'untracked' })
  const result = run(['remove', dir])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /uncommitted changes/)
  assert.match(result.stderr, /an-untracked-file\.txt/)
  assert.ok(existsSync(dir), 'the tree survives')
  assert.ok(existsSync(path.join(dir, 'an-untracked-file.txt')), 'the untracked file survives -- this is exactly the unfinished work the guard exists for')
})

test('refuses a dirty tree with a tracked modification', t => {
  const { dir } = makeWorktree(t, { dirty: 'tracked' })
  const result = run(['remove', dir])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /uncommitted changes/)
  assert.ok(existsSync(dir))
})

test('the shared node_modules install survives a real removal through a real link, outside .worktrees/', t => {
  // Not reasoned about: linked exactly the way `link()` would (a junction on
  // Windows, a symlink elsewhere), removed with the tool, then the shared
  // install's own package count and two specific, load-bearing entries
  // (vite, .bin) are compared before and after. Independent of `makeWorktree`
  // on purpose -- this test's own fixture setup must not share code with the
  // thing being proved, or a bug in both could cancel out.
  const shared = path.join(ROOT, 'node_modules')
  const before = { count: readdirSync(shared).length, vite: existsSync(path.join(shared, 'vite')), bin: existsSync(path.join(shared, '.bin')) }
  assert.ok(before.count > 0 && before.vite && before.bin, 'sanity: the real shared install must already look like an install, or this test proves nothing')

  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'kmt-worktree-test-junction-')), 'tree')
  const branch = `worktree-test-junction-tmp-${Math.random().toString(36).slice(2, 8)}`
  execFileSync('git', ['worktree', 'add', dir, 'origin/main', '-b', branch], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => {
    try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'ignore' }) } catch { /* removed by the test itself, normally */ }
    try { execFileSync('git', ['branch', '-D', branch], { cwd: ROOT, stdio: 'ignore' }) } catch { /* already gone */ }
    try { rmSync(path.dirname(dir), { recursive: true, force: true }) } catch { /* already gone */ }
  })

  const target = path.join(dir, 'node_modules')
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', target, shared], { stdio: ['ignore', 'pipe', 'pipe'] })
  else symlinkSync(shared, target, 'dir')
  assert.ok(existsSync(path.join(target, 'vite')), 'sanity: the junction/symlink actually resolves into the shared install before removal')

  const result = run(['remove', dir])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(dir), false)

  const after = { count: readdirSync(shared).length, vite: existsSync(path.join(shared, 'vite')), bin: existsSync(path.join(shared, '.bin')) }
  assert.deepEqual(after, before, 'the shared install must be byte-for-byte the same shape after removal as before it')
})

test('the bare-name form is unaffected -- add, then remove by name, exactly as before this change', t => {
  const name = `worktree-test-name-form-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => {
    try { execFileSync('node', [SCRIPT, 'remove', name], { cwd: ROOT, stdio: 'ignore' }) } catch { /* removed by the test itself, normally */ }
  })
  const added = run(['add', name])
  assert.equal(added.code, 0, added.stderr)
  assert.ok(existsSync(path.join(ROOT, '.worktrees', name)))

  const removed = run(['remove', name])
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(existsSync(path.join(ROOT, '.worktrees', name)), false)
})
