/**
 * Run git without ever throwing, and without ever hiding a failure.
 *
 * Four times in one night, in two files, one author: an `execFileSync('git',
 * ...)` call sat outside its own try/catch, or inside someone else's, and a
 * git failure there surfaced as a raw uncaught Node.js stack trace instead
 * of a message a caller could act on -- the sharpest instance a `branch -D`
 * cleanup call INSIDE an existing catch block, where its own failure threw
 * a second, unrelated raw error while already handling the first. Four
 * instances by one author in one night is not carelessness; it is a
 * missing abstraction -- a throwing `git()` that individual call sites had
 * to remember to wrap, and remembering is exactly the thing that failed.
 *
 * `git()` below never throws. On failure it prints the real git error to
 * stderr UNCONDITIONALLY, before the caller gets a chance to do anything
 * (or nothing) with the result, and returns `{ ok: false, error }` -- no
 * `stdout` key. That absence is deliberate and was itself a caught defect:
 * an earlier draft returned `{ ok: false, stdout: '' }`, so a caller that
 * forgot to check `.ok` and read `.stdout` anyway got a falsy-but-valid-
 * looking empty string and silently kept going -- a silent wrong answer,
 * the exact class this file exists to end, sitting in the file meant to
 * end it. Omitting `stdout` on failure means that same forgetful call site
 * gets `undefined` instead, and the next line that treats it as a string
 * throws immediately, with the real git error already printed above it.
 * Nothing to remember, because there is no try/catch to remember.
 */
import { execFileSync } from 'node:child_process'

export function git(args, cwd) {
  try {
    return { ok: true, stdout: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (error) {
    const message = String(error.stderr || error.message).trim()
    console.error(message)
    return { ok: false, error: message }
  }
}

/**
 * For the git commands whose EXIT CODE is the answer, not a failure signal:
 * `merge-base --is-ancestor A B` exits non-zero to mean "no, not an
 * ancestor" -- that is the answer, not breakage. `rev-parse --verify` on a
 * ref that does not exist is the same shape. Running those through `git()`
 * would print a scary-looking git error for every legitimate "no", turning
 * this into a noise source that someone later "fixes" by muting the
 * helper -- which undoes the whole point of printing unconditionally.
 *
 * `gitProbe()` prints nothing and returns a boolean instead. Deliberately a
 * separate function rather than an option on `git()`: an option is
 * something a call site has to remember to pass for the right commands,
 * which is the exact shape of mistake this file exists to make impossible.
 * A separate verb cannot be reached for by accident.
 */
export function gitProbe(args, cwd) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}
