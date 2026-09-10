#!/usr/bin/env node
/**
 * Add and remove agent worktrees without breaking the shared install.
 *
 * Worktrees here live under .worktrees/ and get their dependencies as a link
 * to the main checkout's node_modules -- a junction on Windows, a symlink
 * elsewhere -- because one install serves a dozen trees. That link is also a
 * trap: `git worktree remove --force` follows it and deletes packages out of
 * the main checkout, which every other worktree shares. It happened once and
 * cost every agent on this machine a broken install. The safe order is fixed
 * here so nobody has to remember it: unlink first, then ask git to remove
 * without --force, which refuses if anything in the tree would be lost.
 *
 *   node scripts/worktree.mjs add <name> [--branch <branch>] [--from origin/main]
 *   node scripts/worktree.mjs remove <name> [--compare-ref origin/main]
 *   node scripts/worktree.mjs remove <path> [--compare-ref origin/main]
 *   node scripts/worktree.mjs link <name>
 *   node scripts/worktree.mjs list
 *
 * `remove` also takes a full or relative path, not only a `.worktrees/<name>`,
 * so cleanup can reach a worktree registered anywhere on disk -- most of the
 * ones this was built to clear live outside `.worktrees/` entirely (under
 * `~/.codex/worktrees/...` and elsewhere). Additive only: a bare name (no
 * path separator) still resolves exactly as before. Whichever form is given,
 * the target must already be a worktree `git worktree list` reports for THIS
 * repository -- checked against this file's own git-common-dir, so a path
 * belonging to some other repository on the machine is refused outright,
 * before anything is touched.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, gitProbe } from './lib/git.mjs'

/**
 * The main checkout, wherever this is run from.
 *
 * Not the script's own location: a copy of this file lives in every worktree,
 * and run from one of those it would put new trees under that worktree and
 * link them to a link. Git's common directory is the main checkout's .git
 * whichever tree asks, and the shared install sits beside it.
 */
const OUR_COMMON_DIR = path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8',
}).trim())
const ROOT = path.dirname(OUR_COMMON_DIR)
const TREES = path.join(ROOT, '.worktrees')
const SHARED = path.join(ROOT, 'node_modules')

const HELP = `
Add and remove agent worktrees, with the shared node_modules link handled in
the safe order.

Usage:
  node scripts/worktree.mjs add <name> [--branch <branch>] [--from <ref>]
  node scripts/worktree.mjs remove <name> [--compare-ref <ref>]
  node scripts/worktree.mjs remove <path> [--compare-ref <ref>]
  node scripts/worktree.mjs link <name>
  node scripts/worktree.mjs list

add      Fetches origin, creates .worktrees/<name> on a new branch (default:
         the same name) from <ref> (default: origin/main), and links the main
         checkout's node_modules into it.
remove   Takes a bare name (resolved under .worktrees/, as before) or a full
         or relative path anywhere on disk. Either way the target must be a
         worktree this repository's own git already knows about -- refused
         otherwise, before anything is touched, whether that is because the
         path belongs to a different repository or because it is not a
         worktree at all. Refuses a dirty tree, including untracked files --
         checked explicitly, not left to git's own (also real) refusal alone,
         so the reason is named up front rather than surfacing as a bare git
         error. Otherwise unlinks node_modules first, then runs
         \`git worktree remove\` without --force, so git still has the final
         say. The local branch is deleted only if its tip is already in
         --compare-ref (default: origin/main).
link     Recreates the node_modules link in an existing worktree, for a tree
         made by hand or one whose link was removed.
list     The registered worktrees.

Never run \`git worktree remove --force\` on a tree whose node_modules is a
link: it deletes through the link into the shared install.
`.trimStart()

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { command: argv[0], name: '', branch: '', from: 'origin/main', compareRef: 'origin/main', help: false }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => { if (i + 1 >= argv.length) fail(`${arg} needs a value`); return argv[++i] }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--branch') options.branch = value()
    else if (arg === '--from') options.from = value()
    else if (arg === '--compare-ref') options.compareRef = value()
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
    else if (!options.name) options.name = arg
    else fail(`Unexpected argument: ${arg}`)
  }
  if (options.command === '--help' || options.command === '-h') options.help = true
  return options
}

/** A name is a directory under .worktrees/, nothing more: no separators, no dots. */
function treePath(name) {
  if (!name) fail('Give the worktree a name. See --help.')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) fail(`Not a worktree name: ${name}. Use letters, digits, - and _.`)
  return path.join(TREES, name)
}

/**
 * What `remove` was actually pointed at: the existing `.worktrees/<name>`
 * form for a bare name (unchanged), or a full/relative path for anything
 * containing a path separator -- names never contain one, so the two forms
 * cannot be confused with each other.
 */
function removeTarget(input) {
  if (!input) fail('Give a worktree name or path. See --help.')
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input)) return treePath(input)
  return path.resolve(process.cwd(), input)
}

/**
 * The git-common-dir a directory's own worktree belongs to, or `null` if it
 * is not inside a git worktree at all (missing path, not a repo, a plain
 * directory). Never throws -- a target that fails this check is reported by
 * `remove`'s own guard, not by an uncaught exception from here.
 */
function commonDirOf(dir) {
  try {
    return path.resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim())
  } catch {
    return null
  }
}

/** What git knows about, keyed by absolute path with forward slashes. */
function registered() {
  const trees = new Map()
  let current = null
  const listed = git(['worktree', 'list', '--porcelain'], ROOT)
  if (!listed.ok) fail(listed.error)
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: path.resolve(line.slice(9)), branch: '' }; trees.set(current.path, current) }
    else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
  }
  return trees
}

const isLink = (p) => existsSync(p) && lstatSync(p).isSymbolicLink()

/** Relative to the main checkout when the path is under it, absolute otherwise -- the same rule `list` already uses. */
const displayPath = (p) => {
  const resolved = path.resolve(p)
  return resolved === path.resolve(ROOT) || resolved.startsWith(path.resolve(ROOT) + path.sep) ? path.relative(ROOT, resolved) : resolved
}

function link(tree) {
  const target = path.join(tree, 'node_modules')
  if (isLink(target)) { console.log(`node_modules is already linked in ${path.relative(ROOT, tree)}`); return }
  if (existsSync(target)) fail(`${path.relative(ROOT, target)} exists and is a real directory, not a link. Leave it, or delete it by hand first.`)
  if (!existsSync(SHARED)) fail(`No node_modules in the main checkout at ${SHARED}. Run npm install there first.`)
  if (process.platform === 'win32') {
    // A junction, not a symlink: junctions need no privilege on Windows and
    // resolve for every tool, which is why the trees here have always used one.
    execFileSync('cmd', ['/c', 'mklink', '/J', target, SHARED], { stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    symlinkSync(SHARED, target, 'dir')
  }
  console.log(`Linked ${path.relative(ROOT, target)} -> ${path.relative(ROOT, SHARED)}`)
}

/**
 * Remove the link and only the link.
 *
 * rmdir on a junction unlinks it and touches nothing behind it; the same call
 * on a real directory would fail because it is not empty, which is the right
 * failure. On other platforms a symlink is a file and unlink removes it.
 */
function unlink(tree) {
  const target = path.join(tree, 'node_modules')
  if (!isLink(target)) return false
  const resolved = path.resolve(tree, readlinkSync(target))
  if (path.resolve(resolved) !== path.resolve(SHARED)) fail(`${displayPath(target)} links to ${resolved}, not the shared install. Not touching it.`)
  if (process.platform === 'win32') rmdirSync(target)
  else unlinkSync(target)
  console.log(`Unlinked ${displayPath(target)}; the shared install is untouched.`)
  return true
}

const branchExists = (name) => gitProbe(['rev-parse', '--verify', '--quiet', name], ROOT)

/**
 * `git worktree add <tree> -b <branch> <ref>`'s two effects -- creating the
 * branch and attaching the worktree -- are not atomic with each other, and
 * this failed here once in exactly the shape that matters: the branch got
 * created, attaching the worktree did not, and the command threw an
 * uncaught exception that printed as a bare Node.js stack ending in the
 * runtime's own version banner -- no message, no clean exit code a caller
 * chaining commands could key on. The caller's very next command then ran
 * in whatever directory it already was, which on this machine is the
 * shared main checkout by default -- the one directory every session's
 * uncommitted work can be sitting in at once. A worktree tool whose
 * failure mode is "silently keep operating on the shared checkout instead"
 * is the most dangerous shape available here, worse than refusing loudly.
 *
 * Guarded two ways now. Before attempting anything: a branch of this name
 * already existing with no worktree attached is exactly the state a
 * previous failed `add` leaves behind, and retrying blindly into it used
 * to fail a second, more confusing way ("a branch named ... already
 * exists") instead of naming the actual situation. And the `git worktree
 * add` call itself is no longer unguarded: on failure this prints the
 * real git error, cleans up the branch if one was created along the way
 * (so a retry starts clean rather than compounding), and exits with a
 * message a caller can act on -- never an uncaught exception.
 */
function add({ name, branch, from }) {
  const tree = treePath(name)
  if (existsSync(tree)) fail(`${displayPath(tree)} already exists.`)
  branch = branch || name

  if (branchExists(branch)) {
    fail(`Branch ${branch} already exists with no worktree at ${displayPath(tree)} -- most likely left behind by ` +
      `a previous \`add\` that failed partway. Delete it first if it is not wanted (\`git branch -D ${branch}\`), ` +
      'or choose a different name.')
  }

  const fetched = git(['fetch', '--quiet', 'origin'], ROOT)
  const created = fetched.ok ? git(['worktree', 'add', tree, '-b', branch, from], ROOT) : fetched
  if (!created.ok) {
    if (branchExists(branch)) {
      git(['branch', '-D', branch], ROOT)
      console.error(`\nCleaned up branch ${branch}, which the failed attempt created; a retry starts clean.`)
    }
    console.error(`\n\`git worktree add\` failed; nothing was created at ${displayPath(tree)}.`)
    process.exit(1)
  }
  console.log(created.stdout.split('\n').pop())
  link(tree)
  console.log(`\n${displayPath(tree)} is on ${branch} from ${from}. Claim it in .forge/CLAIMS.md before you start.`)
}

/**
 * `compareRef` decides whether a removed branch's work has landed -- default
 * `origin/main`, matching what "landed" means for real usage. Was hardcoded
 * until this function's own tests, which spawn the real CLI to observe real
 * disk effects (deliberately, per this file's other tests), turned out to
 * need `origin/main` resolvable purely to pass a ref through -- and CI's
 * "Tests, lint, build and audits" job checks out shallow and single-ref,
 * where `origin/main` genuinely does not exist. The fix is not a deeper
 * checkout (that satisfies the test at the cost of slowing every CI run
 * forever, and leaves the assumption in place for the next caller); it is
 * this function no longer assuming the ref exists at all -- the same shape
 * as `defaultDecoderPython` no longer assuming `process.cwd()` was the repo
 * root. A test can now pass a ref it created itself (`HEAD`, or a fixed
 * fixture commit) and exercise the real merge logic without needing
 * anything about the surrounding checkout to be true first.
 */
function remove({ name, compareRef = 'origin/main' }) {
  const tree = removeTarget(name)
  if (path.resolve(tree) === path.resolve(ROOT)) fail('That is the main checkout.')

  // A more specific refusal than "not registered" below, checked first: a
  // path that resolves inside SOME git worktree, just not this repository's,
  // is a different mistake (a typo landing in an unrelated checkout on the
  // same machine) from a path that is not a worktree at all, and the message
  // should say which. `commonDirOf` never throws, so a target that does not
  // exist or is not a git repo at all simply falls through to the registered
  // check next, unaffected.
  const commonDir = commonDirOf(tree)
  if (commonDir && commonDir !== OUR_COMMON_DIR) {
    fail(`${displayPath(tree)} belongs to a different repository (git-common-dir ${commonDir}, not ${OUR_COMMON_DIR}). Refusing.`)
  }

  const known = registered().get(path.resolve(tree))
  if (!known) fail(`${displayPath(tree)} is not a registered worktree of this repository. See \`node scripts/worktree.mjs list\`.`)

  // Tracked AND untracked changes are refused explicitly, before touching
  // anything -- untracked is exactly where unfinished work lives and it is
  // invisible to a tracked-only check.
  //
  // This is NOT "a clearer message in front of git's own refusal" -- it is
  // load-bearing on its own, because it runs BEFORE `unlink` below and git's
  // refusal does not happen until after. Proved by deleting this check and
  // rerunning the suite: with only git's own `git worktree remove` refusal
  // left, `unlink` had already torn the node_modules link out by the time git
  // refused on the untracked file -- a broken worktree (no dependencies,
  // still dirty, still on disk) that git then declines to finish cleaning up,
  // which is worse than either "removed" or "untouched". Two checks that
  // both refuse the same case look redundant; they are not -- one of them is
  // the only thing standing between a dirty tree and that halfway state. If
  // this comment is ever separated from the check, say so again there.
  const status = git(['status', '--porcelain'], tree)
  if (!status.ok) fail(status.error)
  if (status.stdout) fail(`${displayPath(tree)} has uncommitted changes, including possibly untracked files:\n${status.stdout}\nCommit or discard them first.`)

  let tip = '', unpushed = []
  if (known.branch) {
    const rev = git(['rev-parse', known.branch], ROOT)
    if (!rev.ok) fail(rev.error)
    tip = rev.stdout
    const log = git(['log', '--oneline', `${compareRef}..${known.branch}`], ROOT)
    if (!log.ok) fail(log.error)
    unpushed = log.stdout.split('\n').filter(Boolean)
  }

  unlink(tree)
  const removed = git(['worktree', 'remove', tree], ROOT)
  if (!removed.ok) {
    console.error(`\ngit refused, so nothing was deleted. The node_modules link is gone; put it back with\n  node scripts/worktree.mjs link ${name}\nif you want to keep working there.`)
    process.exit(1)
  }
  console.log(`Removed ${displayPath(tree)}.`)

  if (!known.branch) return
  const merged = gitProbe(['merge-base', '--is-ancestor', tip, compareRef], ROOT)
  if (merged) {
    git(['branch', '-D', known.branch], ROOT)
    console.log(`Deleted local branch ${known.branch}; its tip ${tip.slice(0, 7)} is in ${compareRef}.`)
  } else {
    console.log(`Kept local branch ${known.branch}: ${unpushed.length} commit(s) on it are not in ${compareRef}.` +
      (unpushed.length ? `\n  ${unpushed.slice(0, 5).join('\n  ')}` : ''))
  }
}

function list() {
  for (const tree of registered().values()) {
    const inTrees = path.resolve(tree.path).startsWith(path.resolve(TREES) + path.sep)
    const linked = isLink(path.join(tree.path, 'node_modules')) ? 'linked' : existsSync(path.join(tree.path, 'node_modules')) ? 'own install' : 'no node_modules'
    console.log(`${(tree.branch || '(detached)').padEnd(36)} ${inTrees ? path.relative(ROOT, tree.path) : tree.path}  [${linked}]`)
  }
}

// Guarded so backend/worktree.test.mjs can import removeTarget/commonDirOf
// for direct checks without the CLI running on import -- the four proofs
// the rest of the suite demands (a real removal, a real refusal, a real
// junction surviving) still spawn this file as a subprocess, which is the
// only way to observe what it actually does to a real worktree on disk.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || !options.command) { console.log(HELP); process.exit(options.command ? 0 : 1) }
  if (options.command === 'add') add(options)
  else if (options.command === 'remove') remove(options)
  else if (options.command === 'link') link(treePath(options.name))
  else if (options.command === 'list') list()
  else fail(`Unknown command: ${options.command}. See --help.`)
}

export { removeTarget, commonDirOf, OUR_COMMON_DIR, TREES, ROOT }
