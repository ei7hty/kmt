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
