import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * The default `decoder.local` venv, found without `KMT_IMAGE_DECODER_PYTHON`.
 *
 * Was `resolve('decoder.local', ...)` -- resolved against `process.cwd()`,
 * not this file, so it only ever found a venv when node happened to be
 * invoked from the repo root. Every agent here works from a `.worktrees/`
 * checkout per AGENTS.md, so `process.cwd()` is the worktree, `decoder.local`
 * is untracked (`.gitignore`'s `*.local`) and does not exist there, and
 * `decoderPython` came back `null` -- silently, since a missing default is
 * not itself an error. Two agents independently built their own venv the
 * same night, in two different places, because neither could see the
 * other's: not carelessness, the documented practice (a worktree, a
 * cwd-relative default) producing the failure.
 *
 * Resolved from `import.meta.url` instead, which fixes the cwd dependency
 * but -- on its own -- would still land inside whichever worktree this file
 * is running from, since a worktree is a real checkout with its own path.
 * So: if this file is running from inside `.worktrees/<name>/` (this repo's
 * own convention, `AGENTS.md`), the search continues past it to the main
 * checkout one level up, where `docs/image-mirroring.md` documents creating
 * the venv. One `decoder.local`, built once in the main checkout, is then
 * found by every worktree without anyone exporting
 * `KMT_IMAGE_DECODER_PYTHON` by hand -- the sharing both agents were
 * building toward, from the location the docs already name.
 *
 * A pure function of this file's own directory (never `process.cwd()`) and
 * the platform, so `backend/decoder-fixtures.test.mjs` can check it against
 * synthetic worktree-shaped paths without touching the filesystem or
 * spawning a process -- `backend/*.test.mjs` is CI's actual glob
 * (`fly-deploy.yml`), non-recursive, so a test nested under this directory
 * would never run; this stays a plain export for that test to import flat
 * from `backend/`.
 *
 * The `platform` argument picks `path.win32` or `path.posix` for the WHOLE
 * computation -- resolve, `sep`, the `.worktrees` marker -- not only the
 * `Scripts/python.exe` vs `bin/python` suffix at the end. In production
 * `platform` defaults to `process.platform`, so the module picked always
 * matches the ambient `node:path` the host would have used anyway; nothing
 * changes there. What this buys is genuine testability: a synthetic
 * Windows-shaped path asserted with `platform: 'win32'` now means the same
 * thing on any CI runner, because it is parsed by `path.win32` rather than
 * by whichever OS happens to be running the test. The first version of this
 * mixed ambient `node:path` (host-native) with a platform-keyed suffix --
 * correct in production, where the two always agree, and wrong the moment a
 * test asserted a Windows-shaped path against Linux CI's POSIX-native
 * `path.resolve`, which does not recognise `C:\...` as absolute and silently
 * anchors it to `process.cwd()` instead. Found by CI itself, not by local
 * testing, which is exactly the failure mode this note exists to prevent
 * the next reader from reintroducing.
 */
export function defaultDecoderPython(moduleDir, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const repoRoot = p.resolve(moduleDir, '..', '..', '..')
  const worktreeMarker = `${p.sep}.worktrees${p.sep}`
  const worktreeIndex = repoRoot.indexOf(worktreeMarker)
  const mainCheckoutRoot = worktreeIndex === -1 ? repoRoot : repoRoot.slice(0, worktreeIndex)
  return venvPython(mainCheckoutRoot, platform)
}

/**
 * Where the venv lives inside a checkout root. The one place that spelling
 * exists, so the two resolvers above and below cannot disagree about it.
 */
export function venvPython(checkoutRoot, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  return p.resolve(checkoutRoot, 'decoder.local', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

/**
 * The main checkout, from git's own common directory: `<main checkout>/.git`
 * whichever worktree asks, so its parent is the main checkout every time.
 *
 * WHY THE MARKER ABOVE IS NOT ENOUGH, measured rather than assumed. #464
 * climbed past a literal `.worktrees/` segment because that is the layout
 * `AGENTS.md` prescribes. It is not the layout this machine has:
 * `git worktree list` reports 236 worktrees registered against this repository
 * in SIX different path shapes, and only 170 of them contain that marker.
 *
 *   170  <main>/.worktrees/<name>                     marker matches
 *    31  ~/.codex/worktrees/<h>/kmt/.worktrees/<name>  marker matches the WRONG root
 *    17  ~/.codex/worktrees/<h>/kmt                    no marker
 *     5  <main>/.claude/worktrees/<name>               no marker (the agent harness)
 *     3  ~/.codex/worktrees/<other>                    no marker
 *    10  %TEMP%/<name>, and one checkout beside <main> no marker
 *
 * Every shape without a matching marker resolves `decoder.local` against its
 * own root, where nothing has ever created one, so `decoderPython` comes back
 * null and 73 tests vanish while five more suites fail at module load looking
 * exactly like broken code. The 31 nested codex trees are worse than a miss:
 * the marker fires and climbs to `~/.codex/worktrees/<h>/kmt`, which is itself
 * a worktree with no venv, so the answer is confidently wrong rather than
 * absent.
 *
 * ADDING A SECOND LITERAL MARKER WOULD FIX 5 OF THOSE 66. That is the reason
 * this asks git instead: a marker encodes a guess about where somebody put a
 * checkout, and any such guess is a fact that can stop being true without
 * anything going red. Git already knows the answer and cannot be wrong about
 * it. `scripts/worktree.mjs` reached the same conclusion independently and for
 * the same reason -- see its `OUR_COMMON_DIR` -- so this is the established
 * shape in this repository, not a new one.
 *
 * Pure, and takes the common dir as an argument, so the tests can assert on
 * synthetic paths for either platform without a repository or a subprocess --
 * the property #464's comment argues for, kept.
 */
export function checkoutRootFromGitCommonDir(gitCommonDir, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix
  return p.dirname(p.resolve(gitCommonDir))
}

/**
 * Ask git where the common directory is. Returns null rather than throwing:
 * a tarball with no `.git`, or a machine with no git on PATH, is a legitimate
 * place to run these tests with KMT_IMAGE_DECODER_PYTHON set by hand.
 */
function gitCommonDir(cwd) {
  try {
    const run = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (run.status !== 0 || !run.stdout) return null
    return run.stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * The search, in cost order, and the order is the point.
 *
 * The subprocess runs ONLY when the two free answers miss. CI sets the
 * environment variable (`fly-deploy.yml`'s "Install isolated image decoder test
 * runtime" step, in the same job as the count check), and the main checkout and
 * every `.worktrees/` tree are answered by the pure path -- so the ~40 test
 * processes a run spawns pay nothing for this on the paths that already worked.
 * Only a layout the marker cannot describe reaches git.
 */
export function resolveDecoderPython(moduleDir, env = process.env) {
  if (env.KMT_IMAGE_DECODER_PYTHON) return { python: env.KMT_IMAGE_DECODER_PYTHON, searched: [] }
  const searched = []

  const byMarker = defaultDecoderPython(moduleDir)
  searched.push(byMarker)
  if (existsSync(byMarker)) return { python: byMarker, searched }

  const common = gitCommonDir(moduleDir)
  if (common) {
    const byGit = venvPython(checkoutRootFromGitCommonDir(common))
    if (byGit !== byMarker) {
      searched.push(byGit)
      if (existsSync(byGit)) return { python: byGit, searched }
    }
  }
  return { python: null, searched }
}

const resolved = resolveDecoderPython(path.dirname(fileURLToPath(import.meta.url)))
export const decoderPython = resolved.python
export function realImageFixtures() {
  if (!decoderPython) {
    throw new Error(
      'Real decoder tests require a Python interpreter with scripts/image-decoder-requirements.txt ' +
      `installed. Looked for the shared venv at ${resolved.searched.join(' and at ')} and found none. ` +
      'Either build it in the MAIN checkout (docs/image-mirroring.md: `python -m venv decoder.local`, ' +
      'then install the pinned requirements) so every worktree finds the same one, or set ' +
      'KMT_IMAGE_DECODER_PYTHON to an absolute interpreter path of your own.',
    )
  }
  const script = `import io,json,base64
from PIL import Image
result = {}
for fmt in ['PNG','JPEG','GIF','WEBP','BMP']:
 b=io.BytesIO(); Image.new('RGB',(4,3),'red').save(b,format=fmt)
 result[fmt.lower()]=base64.b64encode(b.getvalue()).decode()
b=io.BytesIO(); Image.new('RGB',(4,3),'red').save(b,format='GIF',save_all=True,append_images=[Image.new('RGB',(4,3),'blue')],duration=10,loop=0)
result['animated']=base64.b64encode(b.getvalue()).decode()
b=io.BytesIO(); Image.new('RGB',(4096,4096),'red').save(b,format='PNG')
result['large']=base64.b64encode(b.getvalue()).decode()
for mode in ['1','L','LA','P','RGBA','I;16']:
 b=io.BytesIO(); Image.new(mode,(4,3)).save(b,format='PNG')
 result['valid-png-'+mode]=base64.b64encode(b.getvalue()).decode()
b=io.BytesIO(); Image.new('RGB',(4,3),'red').save(b,format='JPEG',progressive=True)
result['valid-progressive-jpeg']=base64.b64encode(b.getvalue()).decode()
print(json.dumps(result))`
  const run = spawnSync(decoderPython, ['-I', '-B', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  if (run.status !== 0) throw new Error('Unable to generate local decoder fixtures')
  const fixtures = Object.fromEntries(Object.entries(JSON.parse(run.stdout)).map(([key, value]) => [key, Buffer.from(value, 'base64')]))
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const png = fixtures.png, header = Buffer.from(png.subarray(16, 29)), idat = png.indexOf('IDAT')
  const compressed = png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4))
  const makePng = (ihdr, payload) => Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', payload), chunk('IEND', Buffer.alloc(0))])
  // Independent 4x3 RGB Adam7 fixture: six rows across nonempty passes.
  const adam7 = Buffer.concat([1, 1, 2, 2, 2, 4].map(width => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [255, 0, 0]).flat())])))
  const interlaced = Buffer.from(header); interlaced[12] = 1
  fixtures['valid-adam7'] = makePng(interlaced, deflateSync(adam7))
  fixtures['png-short-rows'] = makePng(header, deflateSync(Buffer.from([0, 255, 0, 0])))
  fixtures['png-extra-rows'] = makePng(header, deflateSync(Buffer.concat([inflateSync(compressed), Buffer.from([0])])))
  fixtures['png-extra-stream'] = makePng(header, Buffer.concat([compressed, deflateSync(Buffer.from([0]))]))
  return fixtures
}

export function incompletePayloads(fixtures) {
  const variants = []
  for (let missing = 1; missing <= 7; missing++) {
    variants.push({ format: 'jpeg', missing, bytes: Buffer.concat([fixtures.jpeg.subarray(0, -2 - missing), Buffer.from([0xff, 0xd9])]) })
  }
  const png = fixtures.png, idat = png.indexOf('IDAT'), size = png.readUInt32BE(idat - 4)
  for (let missing = 1; missing <= 7; missing++) {
    const payload = png.subarray(idat + 4, idat + 4 + size - missing)
    const length = Buffer.alloc(4); length.writeUInt32BE(payload.length)
    const chunk = Buffer.concat([Buffer.from('IDAT'), payload])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(chunk))
    variants.push({ format: 'png', missing, bytes: Buffer.concat([png.subarray(0, idat - 4), length, chunk, crc, png.subarray(idat + size + 8)]) })
  }
  const gif = fixtures.gif, blockSizeOffset = gif.length - 11
  for (let missing = 1; missing <= 7; missing++) {
    const size = gif[blockSizeOffset] - missing
    variants.push({ format: 'gif', missing, bytes: Buffer.concat([gif.subarray(0, blockSizeOffset), Buffer.from([size]), gif.subarray(blockSizeOffset + 1, blockSizeOffset + 1 + size), Buffer.from([0, 0x3b])]) })
  }
  const webp = fixtures.webp, webpSize = webp.readUInt32LE(16)
  for (let missing = 1; missing <= 7; missing++) {
    const size = webpSize - missing, header = Buffer.from(webp.subarray(0, 20))
    header.writeUInt32LE(size, 16); header.writeUInt32LE(12 + size + size % 2, 4)
    variants.push({ format: 'webp', missing, bytes: Buffer.concat([header, webp.subarray(20, 20 + size), Buffer.alloc(size % 2)]) })
  }
  return variants
}
