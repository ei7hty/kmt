#!/usr/bin/env node
/**
 * Push a small edit straight to main, safely -- the one call that replaces
 * the 7-line recipe at .forge/AGENTS.md:163-220 (plain worktree, edit,
 * commit, fetch, rebase, push HEAD:main, remove), generalized to any
 * direct-to-main edit, not only .forge/CLAIMS.md.
 *
 *   node scripts/claim.mjs -m <message> --file <path> [--file <path> ...] -- <command> [args...]
 *
 * <command> runs with its cwd set to a FRESH disposable worktree (never the
 * shared main checkout) and is expected to make the edit itself -- write to
 * files, not print a diff. Everything under --file is then staged (nothing
 * else -- no `git add -A`, ever) and committed with <message>.
 *
 * Two hard constraints, both from real incidents this repo has already had:
 *
 * FAIL SAFE, NOT FAIL OPEN. If the disposable worktree cannot be created,
 * this refuses loudly and exits non-zero -- it never degrades to running the
 * edit command against the shared main checkout. That fallback is not
 * hypothetical: worktree tooling failed here once and the fallback was the
 * shared checkout, which at that moment held someone else's uncommitted
 * work. A wrapper that cannot make its own tree stops; it does not reach
 * for main.
 *
 * NO --force ANYWHERE. The disposable tree is removed in a `finally` no
 * matter how the attempt ends -- it cannot outlive this call -- but a push
 * that fails after the tree is already gone must not look like success.
 * Teardown-on-failure is correct; teardown-MASKING-a-failed-push is a
 * silent lost claim, so the failure is reported, loudly, after cleanup runs,
 * never swallowed by it. That reporting has to live in a function that
 * outlives the attempt itself: `attempt()` below returns an outcome rather
 * than exiting the process directly, specifically so its caller can run the
 * `finally` teardown FIRST and still check that outcome afterward -- an
 * early `return` inside a try-with-finally only skips to the finally block,
 * not past the rest of its own function, so folding both concerns into one
 * function silently swallowed every early failure behind a clean exit 0
 * during development. Splitting them is what makes that check reachable.
 *
 * On a rejected push (someone else landed on main first, expected and
 * normal in a repo this busy): re-fetch and rebase the ALREADY-MADE commit
 * onto the new tip and push again, up to a few times. A rebase conflict is
 * never resolved automatically -- .forge/AGENTS.md is explicit that a
 * collision here means "re-apply your row to the new tip", a judgment call,
 * not a blind replay -- so a conflicting rebase aborts and fails loudly
 * instead of guessing.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from './lib/git.mjs'

const MAX_PUSH_ATTEMPTS = 5

/**
 * Derived independently rather than imported from worktree.mjs: that file's
 * exports are new (scripts/worktree.mjs remove-by-path, PR #467) and not yet
 * on every branch this can run from, and this file's only real requirement
 * of worktree.mjs is "find the main checkout the same way it does" -- three
 * lines, not worth a hard dependency on another script's export surface.
 */
const ROOT = path.dirname(path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8',
}).trim()))

function fail(message) {
  console.error(message)
  process.exit(1)
}

const HELP = `
Push a small edit straight to main, safely: a fresh disposable worktree runs
your edit command, the named files are committed, and the commit is rebased
and pushed to origin/main -- retrying on a normal rejection, refusing loudly
(never falling back to the shared main checkout) if the worktree itself
cannot be made, and never masking a failed push behind a clean teardown.

Usage:
  node scripts/claim.mjs -m <message> --file <path> [--file <path> ...] -- <command> [args...]

Example:
  node scripts/claim.mjs -m "Claim my-branch (.forge/CLAIMS.md)" \\
    --file .forge/CLAIMS.md -- node -e "require('fs').appendFileSync('.forge/CLAIMS.md', '| ...|\\n')"
`.trimStart()

function parseArgs(argv) {
  const options = { message: '', files: [] }
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') { i++; break }
    if (arg === '-m' || arg === '--message') { if (++i >= argv.length) fail(`${arg} needs a value`); options.message = argv[i] }
    else if (arg === '--file') { if (++i >= argv.length) fail(`${arg} needs a value`); options.files.push(argv[i]) }
    else if (arg === '--help' || arg === '-h') { console.log(HELP); process.exit(0) }
    else fail(`Unknown option: ${arg}. See --help.`)
  }
  options.command = argv.slice(i)
  if (!options.message) fail('Give a commit message with -m. See --help.')
  if (!options.files.length) fail('Give at least one --file that the command will change. See --help.')
  if (!options.command.length) fail('Give the edit command after --. See --help.')
  return options
}

function removeDisposableTree(tree) {
  if (git(['worktree', 'remove', tree], ROOT).ok) return
  // Windows: `git worktree remove` can fail if this directory was recently
  // this shell's cwd. A plain tree has no junction to follow (unlike a
  // worktree.mjs-managed one), so rm -rf here is safe.
  try {
    rmSync(tree, { recursive: true, force: true })
  } catch {
    console.error(`Warning: could not remove the disposable worktree at ${tree}; remove it by hand (git worktree remove ${tree}).`)
    return
  }
  git(['worktree', 'prune'], ROOT) // best-effort; the directory is already gone either way
}

/**
 * Everything that happens inside the disposable tree, as a single outcome
 * rather than a process exit -- see the module comment on why this can't be
 * folded into `main` itself. Every early return here is safe: it only ever
 * returns from THIS function, letting main's own `finally` (which removes
 * the tree) and the check after it run exactly the same way whether this
 * succeeded, failed cleanly, or failed after retries.
 */
function attempt(tree, files, message, command) {
  const edit = spawnSync(command[0], command.slice(1), { cwd: tree, stdio: 'inherit' })
  if (edit.error || edit.status !== 0) {
    return { ok: false, message: `Edit command failed (${edit.error ? edit.error.message : `exit ${edit.status}`}); nothing committed.` }
  }

  // Checks that something actually changed, not that the file exists --
  // deleting a --file is a legitimate edit, and `git status --porcelain`
  // reports it same as a modification, just with a `D ` prefix instead of
  // `M `/`??`. Existence would reject exactly the delete case.
  for (const file of files) {
    const status = git(['status', '--porcelain', '--', file], tree)
    if (!status.ok) return { ok: false, message: `Could not check ${file}'s status: ${status.error}` }
    if (!status.stdout) return { ok: false, message: `${file} is unchanged after the edit command ran; nothing committed.` }
  }
  const staged = git(['add', ...files], tree)
  if (!staged.ok) return { ok: false, message: `Could not stage ${files.join(', ')}: ${staged.error}` }
  const committed = git(['commit', '-m', message], tree)
  if (!committed.ok) return { ok: false, message: `Could not commit ${files.join(', ')}: ${committed.error}` }

  for (let pushAttempt = 1; pushAttempt <= MAX_PUSH_ATTEMPTS; pushAttempt++) {
    const fetched = git(['fetch', '--quiet', 'origin'], tree)
    if (!fetched.ok) return { ok: false, message: `Could not fetch origin -- this did NOT land on main.\n${fetched.error}` }

    const rebased = git(['rebase', 'origin/main'], tree)
    if (!rebased.ok) {
      git(['rebase', '--abort'], tree) // best effort
      return {
        ok: false,
        message: 'Rebase onto origin/main conflicted -- this needs a human/agent judgment call, not an automatic replay ' +
          `(.forge/AGENTS.md is explicit about this). Nothing was pushed. Re-run with the edit re-applied against the new tip.\n${rebased.error}`,
      }
    }

    const pushed = git(['push', 'origin', 'HEAD:main'], tree)
    if (pushed.ok) return { ok: true, message: `Pushed to main: ${message}` }
    if (pushAttempt === MAX_PUSH_ATTEMPTS) {
      return {
        ok: false,
        message: `PUSH FAILED after ${MAX_PUSH_ATTEMPTS} attempts -- this did NOT land on main. ` +
          `Re-run the same command from scratch once the board is quieter.\n${pushed.error}`,
      }
    }
    console.error(`Push rejected (attempt ${pushAttempt}/${MAX_PUSH_ATTEMPTS}) -- someone else landed on main first, as expected in a repo this busy. Re-fetching and retrying.`)
  }
}

function main() {
  const { message, files, command } = parseArgs(process.argv.slice(2))

  // FAIL SAFE, NOT FAIL OPEN: this is the only git command in this file that
  // targets ROOT for anything but worktree administration. If it fails,
  // nothing has been created for `finally` to clean up, and nothing below
  // this point -- which all runs inside the disposable tree -- ever executes.
  const tree = path.join(ROOT, '.worktrees', `claim-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  if (!git(['worktree', 'add', tree, 'origin/main'], ROOT).ok) {
    fail('\nCould not create a disposable worktree; refusing to fall back to the shared main checkout. Nothing was changed.')
  }

  let outcome
  try {
    outcome = attempt(tree, files, message, command)
  } finally {
    // The tree cannot outlive this call, win or lose -- but this must never
    // be the last thing printed on a failure; the outcome check below it
    // always runs after, so a failed push is reported, not masked.
    removeDisposableTree(tree)
  }

  if (!outcome.ok) fail(outcome.message)
  console.log(outcome.message)
}

main()
