import { readdir, readFile } from 'node:fs/promises'
import { join, extname, relative, sep } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.jsx'])
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.worktrees', 'dist'])

/**
 * Every non-test source file under `directories`, walked recursively.
 *
 * Two boundary tests in this repo used to each carry their own hand-typed
 * directory list -- `['backend', 'src', 'src/owner', 'src/components']` --
 * copied from one to the other rather than derived from either. The OWNER
 * AGENT measured the result directly against origin/main: three real
 * directories the list never named -- `backend/fixtures/image-provider`,
 * `src/data`, and `src/routes`, EVERY PAGE THE APP RENDERS -- leaving both
 * tests passing vacuously over them. A scratch file dropped into
 * `src/routes/` referencing either guarded name was invisible to both tests
 * before this file existed; that reproduction is preserved as a mutation
 * test at each call site, not just asserted here.
 *
 * The fix is not a longer hand-typed list -- that repeats the exact mistake
 * with more entries. Walking the real tree means a fourth missed directory
 * cannot exist: there is nothing left to remember to add.
 */
async function listSourceFiles(root, directories) {
  const files = []
  async function walk(directory) {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name)) || entry.name.includes('.test.')) continue
      files.push(full)
    }
  }
  for (const directory of directories) await walk(join(root, directory))
  return files
}

/**
 * Repo-relative paths (forward-slash) of every non-test source file under
 * `directories` (default: the whole `backend/` and `src/` trees) whose
 * contents include `needle`, excluding `excludeFiles` -- the module(s) that
 * legitimately define `needle` and so contain their own name.
 */
export async function findSourceReferences(root, needle, { directories = ['backend', 'src'], excludeFiles = [] } = {}) {
  const files = await listSourceFiles(root, directories)
  const excluded = new Set(excludeFiles.map(file => join(root, file)))
  const offenders = []
  for (const file of files) {
    if (excluded.has(file)) continue
    const source = await readFile(file, 'utf8')
    if (source.includes(needle)) offenders.push(relative(root, file).split(sep).join('/'))
  }
  return offenders
}
