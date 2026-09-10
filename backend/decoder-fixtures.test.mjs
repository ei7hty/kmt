import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defaultDecoderPython } from './fixtures/image-provider/decoder-fixtures.mjs'

/**
 * `defaultDecoderPython` is a pure function specifically so this can assert
 * on synthetic paths -- `backend/*.test.mjs` is CI's actual glob, flat and
 * non-recursive, so a test living under `backend/fixtures/image-provider/`
 * next to the module it covers would never run there; this file is the one
 * place that actually gets executed.
 */

test('from the main checkout, the venv is looked for at the repo root', () => {
  const moduleDir = path.join('C:', 'repo', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.join('C:', 'repo', 'decoder.local', 'Scripts', 'python.exe'))
})

test('from inside a .worktrees checkout, the venv is looked for in the MAIN checkout, not the worktree', () => {
  // This is the bug: the module's own directory is a real path inside the
  // worktree, and a naive import.meta.url fix (no .worktrees awareness)
  // would resolve here -- which is exactly as unreachable as decoder.local
  // was under the old cwd-relative resolve(), because nothing tracks or
  // copies an untracked venv into a fresh worktree checkout.
  const moduleDir = path.join('C:', 'repo', '.worktrees', 'some-branch', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.join('C:', 'repo', 'decoder.local', 'Scripts', 'python.exe'),
    'must climb past .worktrees/some-branch to the main checkout, not stop at the worktree root')
})

test('a worktree name containing "worktrees" without the leading dot does not trigger the climb', () => {
  // The marker is literally `.worktrees`, path-separated on both sides --
  // a directory that merely contains the substring must not match, and the
  // repo root computed from three levels up (image-provider -> fixtures ->
  // backend -> here) is `myworktrees` itself, with nothing above it to climb
  // past.
  const moduleDir = path.join('C:', 'repo', 'myworktrees', 'backend', 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, 'win32')
  assert.equal(found, path.join('C:', 'repo', 'myworktrees', 'decoder.local', 'Scripts', 'python.exe'),
    'no .worktrees marker present, so nothing above myworktrees should be climbed to')
})

test('platform controls only the interpreter subpath, not the path-separator logic above it', () => {
  // node:path is native to whichever OS runs this suite (win32, here), so a
  // POSIX-STYLE absolute path string like "/home/dev/repo/..." would be
  // reparsed as Windows drive-relative and prove nothing real about POSIX
  // behaviour from this machine. What the `platform` argument controls is
  // narrower and machine-independent to test: Scripts/python.exe vs
  // bin/python, holding the moduleDir (and therefore path.sep/resolve)
  // fixed and native.
  const moduleDir = path.join('C:', 'repo', 'backend', 'fixtures', 'image-provider')
  const windows = defaultDecoderPython(moduleDir, 'win32')
  const posix = defaultDecoderPython(moduleDir, 'linux')
  assert.equal(path.basename(windows), 'python.exe')
  assert.equal(path.basename(path.dirname(windows)), 'Scripts')
  assert.equal(path.basename(posix), 'python')
  assert.equal(path.basename(path.dirname(posix)), 'bin')
})

test('against this actual repo: resolves outside .worktrees even when this test itself is running from inside one', () => {
  // Not synthetic -- this file's own real on-disk location, wherever the
  // suite happens to be invoked from (the main checkout or a worktree, per
  // AGENTS.md). The bug this guards against is specifically that
  // resolve('decoder.local', ...) answered differently depending on
  // process.cwd(); calling the real function with this test file's own
  // real moduleDir is the integration-level version of the synthetic cases
  // above, against paths nobody hand-typed.
  const moduleDir = path.join(import.meta.dirname, 'fixtures', 'image-provider')
  const found = defaultDecoderPython(moduleDir, process.platform)
  assert.ok(!found.includes(`.worktrees${path.sep}`), `must not resolve inside a worktree, got: ${found}`)
  assert.equal(path.basename(found), process.platform === 'win32' ? 'python.exe' : 'python')
  assert.equal(path.basename(path.dirname(found)), process.platform === 'win32' ? 'Scripts' : 'bin')
})
