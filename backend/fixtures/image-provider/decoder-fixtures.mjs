import { spawnSync } from 'node:child_process'
import path, { resolve } from 'node:path'
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
 */
export function defaultDecoderPython(moduleDir, platform = process.platform) {
  const repoRoot = path.resolve(moduleDir, '..', '..', '..')
  const worktreeMarker = `${path.sep}.worktrees${path.sep}`
  const worktreeIndex = repoRoot.indexOf(worktreeMarker)
  const mainCheckoutRoot = worktreeIndex === -1 ? repoRoot : repoRoot.slice(0, worktreeIndex)
  return resolve(mainCheckoutRoot, 'decoder.local', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

const local = defaultDecoderPython(path.dirname(fileURLToPath(import.meta.url)))
export const decoderPython = process.env.KMT_IMAGE_DECODER_PYTHON || (existsSync(local) ? local : null)
export function realImageFixtures() {
  if (!decoderPython) {
    throw new Error(
      'Real decoder tests require a Python interpreter with scripts/image-decoder-requirements.txt ' +
      `installed. Looked for the shared venv at ${local} and found none. Either build it there ` +
      '(docs/image-mirroring.md: `python -m venv decoder.local` in the main checkout, then ' +
      'install the pinned requirements) so every worktree finds the same one, or set ' +
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
