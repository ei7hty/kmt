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
 *   node scripts/worktree.mjs remove <name>
 *   node scripts/worktree.mjs remove <path>
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
  node scripts/worktree.mjs remove <name>
  node scripts/worktree.mjs remove <path>
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
         origin/main.
link     Recreates the node_modules link in an existing worktree, for a tree
         made by hand or one whose link was removed.
list     The registered worktrees.

Never run \`git worktree remove --force\` on a tree whose node_modules is a
link: it deletes through the link into the shared install.
`.trimStart()

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { command: argv[0], name: '', branch: '', from: 'origin/main', help: false }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => { if (i + 1 >= argv.length) fail(`${arg} needs a value`); return argv[++i] }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--branch') options.branch = value()
    else if (arg === '--from') options.from = value()
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
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
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

function add({ name, branch, from }) {
  const tree = treePath(name)
  if (existsSync(tree)) fail(`${path.relative(ROOT, tree)} already exists.`)
  branch = branch || name
  git(['fetch', '--quiet', 'origin'])
  console.log(git(['worktree', 'add', tree, '-b', branch, from]).split('\n').pop())
  link(tree)
  console.log(`\n${path.relative(ROOT, tree)} is on ${branch} from ${from}. Claim it in .forge/CLAIMS.md before you start.`)
}

function remove({ name }) {
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
  // invisible to a tracked-only check. `git worktree remove` also refuses on
  // its own without --force (confirmed separately), so this is not the only
  // thing standing between an agent and lost work -- but it is not merely a
  // clearer message layered over a backstop, either: this check runs BEFORE
  // `unlink` below. Proved by removing it and rerunning the suite: with only
  // git's own refusal left, `unlink` had already torn out the node_modules
  // link by the time `git worktree remove` refused on the untracked file --
  // a worse halfway state (no dependencies, still dirty, still there) than
  // simply refusing up front.
  const dirty = git(['status', '--porcelain'], tree)
  if (dirty) fail(`${displayPath(tree)} has uncommitted changes, including possibly untracked files:\n${dirty}\nCommit or discard them first.`)

  const tip = known.branch ? git(['rev-parse', known.branch]) : ''
  const unpushed = known.branch && tip
    ? git(['log', '--oneline', `origin/main..${known.branch}`]).split('\n').filter(Boolean)
    : []

  unlink(tree)
  try {
    git(['worktree', 'remove', tree])
  } catch (error) {
    console.error(String(error.stderr || error.message).trim())
    console.error(`\ngit refused, so nothing was deleted. The node_modules link is gone; put it back with\n  node scripts/worktree.mjs link ${name}\nif you want to keep working there.`)
    process.exit(1)
  }
  console.log(`Removed ${displayPath(tree)}.`)

  if (!known.branch) return
  let merged
  try { git(['merge-base', '--is-ancestor', tip, 'origin/main']); merged = true } catch { merged = false }
  if (merged) {
    git(['branch', '-D', known.branch])
    console.log(`Deleted local branch ${known.branch}; its tip ${tip.slice(0, 7)} is in origin/main.`)
  } else {
    console.log(`Kept local branch ${known.branch}: ${unpushed.length} commit(s) on it are not in origin/main.` +
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
