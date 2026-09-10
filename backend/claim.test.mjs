import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * `scripts/claim.mjs` lives in the `scripts/` lane, but CI's actual test
 * command (`fly-deploy.yml`: `"backend/*.test.mjs" "src/**\/*.test.mjs"`)
 * never looks there at all -- so this test lives here, flat in `backend/`,
 * the same reason `backend/worktree.test.mjs` and `backend/decoder-fixtures.test.mjs`
 * both do.
 *
 * These tests never touch the real kmt repo's origin. `claim.mjs` derives
 * its `ROOT` from its own on-disk location (the git-common-dir of wherever
 * the file physically sits), not from `process.cwd()` -- so each test here
 * builds a completely throwaway bare "origin" repo plus a checkout with its
 * own copy of `claim.mjs`, and runs the CLI from inside that copy. Pushes,
 * rebases and even a broken-origin failure are all real git operations
 * against that throwaway remote, never against the shared kmt repo.
 */

function makeSandbox(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'kmt-claim-test-'))
  t.after(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* best effort on Windows locks */ } })

  const origin = path.join(base, 'origin.git')
  const checkout = path.join(base, 'checkout')
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['clone', '--quiet', origin, checkout])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: checkout })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: checkout })
  writeFileSync(path.join(checkout, 'seed.txt'), 'seed\n')
  execFileSync('git', ['add', 'seed.txt'], { cwd: checkout })
  execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: checkout })
  execFileSync('git', ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: checkout })

  mkdirSync(path.join(checkout, 'scripts'), { recursive: true })
  cpSync(path.resolve(import.meta.dirname, '..', 'scripts', 'claim.mjs'), path.join(checkout, 'scripts', 'claim.mjs'))

  const script = path.join(checkout, 'scripts', 'claim.mjs')
  const run = (args) => {
    try {
      const stdout = execFileSync('node', [script, ...args], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      return { code: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || String(error.message) }
    }
  }
  const showOnOrigin = (file) => {
    try { return execFileSync('git', ['show', `HEAD:${file}`], { cwd: origin, encoding: 'utf8' }) } catch { return null }
  }
  const registeredWorktrees = () => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: checkout, encoding: 'utf8' })

  return { base, origin, checkout, run, showOnOrigin, registeredWorktrees }
}

test('happy path: appends a new file and pushes it to origin/main, disposable tree cleaned up', t => {
  const { run, showOnOrigin, registeredWorktrees } = makeSandbox(t)

  const result = run(['-m', 'add greeting', '--file', 'greeting.txt', '--',
    'node', '-e', "require('fs').writeFileSync('greeting.txt', 'hello\\n')"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Pushed to main: add greeting/)
  assert.equal(showOnOrigin('greeting.txt'), 'hello\n')
  assert.doesNotMatch(registeredWorktrees(), /claim-tmp-/, 'the disposable worktree must not still be registered')
})

test('deleting a tracked file is a legitimate edit, not blocked by an existence check', t => {
  const { run, showOnOrigin } = makeSandbox(t)
  assert.ok(showOnOrigin('seed.txt'), 'sanity: seed.txt exists on origin before the deletion under test (makeSandbox seeds and pushes it)')

  const result = run(['-m', 'remove seed.txt', '--file', 'seed.txt', '--', 'node', '-e', "require('fs').unlinkSync('seed.txt')"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(showOnOrigin('seed.txt'), null, 'the deletion must land on origin, not be refused as "does not exist"')
})

test('refuses when the edit command exits non-zero -- nothing committed, nothing pushed', t => {
  const { run, showOnOrigin } = makeSandbox(t)
  const result = run(['-m', 'should not land', '--file', 'never.txt', '--', 'node', '-e', 'process.exit(3)'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Edit command failed \(exit 3\)/)
  assert.equal(showOnOrigin('never.txt'), null)
})

test('refuses when the named --file is unchanged after the edit command runs', t => {
  const { run, showOnOrigin } = makeSandbox(t)
  const result = run(['-m', 'should not land', '--file', 'seed.txt', '--', 'node', '-e', '1+1'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /seed\.txt is unchanged/)
  assert.equal(showOnOrigin('seed.txt'), 'seed\n', 'unchanged on origin too')
})

test('FAIL SAFE: if the disposable worktree cannot be created, refuses loudly and never touches the checkout', t => {
  const { run, checkout, showOnOrigin } = makeSandbox(t)
  // .worktrees must exist as a FILE, not a directory, so `git worktree add`
  // cannot create anything under it -- forces exactly the failure this
  // guard exists for, without needing a real environmental fault.
  writeFileSync(path.join(checkout, '.worktrees'), 'not a directory\n')
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' })

  const result = run(['-m', 'must never land', '--file', 'danger.txt', '--',
    'node', '-e', "require('fs').writeFileSync('danger.txt', 'DANGER\\n')"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /refusing to fall back to the shared main checkout/)
  assert.equal(showOnOrigin('danger.txt'), null)
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' })
  assert.equal(after, before, 'the shared checkout itself must be byte-for-byte unchanged -- the edit command must never have run there')
  assert.equal(existsSync(path.join(checkout, 'danger.txt')), false)
})

test('a broken origin fails cleanly (no raw stack trace) rather than crashing the fetch retry loop', t => {
  const { run, checkout, origin } = makeSandbox(t)
  // Point origin at a path that does not exist -- `git worktree add` and the
  // local commit still work (no network needed for those), but the fetch
  // inside the push/retry loop must fail, and must fail CLEANLY.
  execFileSync('git', ['remote', 'set-url', 'origin', path.join(path.dirname(origin), 'nonexistent.git')], { cwd: checkout })

  const result = run(['-m', 'should not land', '--file', 'unreachable.txt', '--',
    'node', '-e', "require('fs').writeFileSync('unreachable.txt', 'x\\n')"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Could not fetch origin/)
  assert.doesNotMatch(result.stderr, /\bat \S+ \(/, 'must not be a raw Node.js stack trace')
})

test('a rejected push retries by re-fetching and rebasing, and eventually gives up loudly if it never clears', t => {
  const { run, checkout, origin } = makeSandbox(t)
  // Simulate permanent contention: a bare repo with `receive.denyCurrentBranch`
  // aside, the simplest deterministic way to make EVERY push attempt fail the
  // same way is a pre-receive hook that always rejects.
  const hookPath = path.join(origin, 'hooks', 'pre-receive')
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n')
  try { execFileSync('chmod', ['+x', hookPath]) } catch { /* not needed/available on all platforms */ }

  const result = run(['-m', 'contended', '--file', 'contended.txt', '--',
    'node', '-e', "require('fs').writeFileSync('contended.txt', 'x\\n')"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Push rejected \(attempt 1\/5\)/)
  assert.match(result.stderr, /Push rejected \(attempt 4\/5\)/)
  assert.match(result.stderr, /PUSH FAILED after 5 attempts -- this did NOT land on main/)
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: checkout, encoding: 'utf8' })
  assert.doesNotMatch(worktrees, /claim-tmp-/, 'the disposable tree must still be torn down even though the push never succeeded')
})
