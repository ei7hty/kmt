/**
 * The favicon wrapper, and the one byte in the format that lies if you let it.
 *
 * WHY THERE IS A FAVICON SCRIPT AT ALL. Measured on the live site 2026-09-13:
 * `GET /favicon.ico` answered 200 with `content-type: text/html`, because the
 * SPA catch-all returns index.html for any unrecognised path. Google fetches
 * that path directly and got a web page, which is why search showed a
 * placeholder rather than the logo. The artwork was never at fault --
 * `/brand/icon-192.png` is a square 192x192 PNG, a multiple of 48 as Google
 * asks for, crawlable and correctly linked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { icoFromPng, pngSize } from './build-favicon.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'public', 'brand', 'icon-192.png')
const BUILT = path.join(ROOT, 'public', 'favicon.ico')

/** A real PNG of a given square size, built by hand -- no image library here. */
function png(size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(size, 8)
  ihdr.writeUInt32BE(size, 12)
  return Buffer.concat([signature, ihdr])
}

test('the committed favicon.ico really is the committed icon, byte for byte', () => {
  // The file is committed because it has to be served as a static asset, and a
  // committed binary nobody can regenerate is one nobody dares touch. This
  // asserts the two are still the same image, so the day the logo changes and
  // only one of them is rebuilt, it says so.
  const ico = readFileSync(BUILT)
  const source = readFileSync(SOURCE)
  assert.deepEqual(ico, icoFromPng(source),
    'public/favicon.ico is not what build-favicon.mjs makes from public/brand/icon-192.png -- rebuild it')
  assert.deepEqual(ico.subarray(22), source, 'the payload is the PNG itself, unmodified')
})

test('the icon Google will fetch is square and a multiple of 48, which is what it asks for', () => {
  const { width, height } = pngSize(readFileSync(SOURCE))
  assert.equal(width, height, `Google wants a square favicon; this is ${width}x${height}`)
  assert.equal(width % 48, 0, `Google documents 48px or a multiple of it; this is ${width}px`)
  assert.ok(width >= 48, `${width}px is below the size Google will use`)
})

test('the ICO header describes the image that follows it', () => {
  const ico = icoFromPng(png(192))
  assert.equal(ico.readUInt16LE(0), 0, 'reserved')
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 is an icon, 2 would be a cursor')
  assert.equal(ico.readUInt16LE(4), 1, 'one image')
  assert.equal(ico.readUInt8(6), 192, 'width')
  assert.equal(ico.readUInt8(7), 192, 'height')
  assert.equal(ico.readUInt32LE(14), ico.length - 22, 'the declared byte count is the payload actually present')
  assert.equal(ico.readUInt32LE(18), 22, 'the payload starts after the 6-byte header and one 16-byte entry')
})

test('256 is written as zero, because one byte cannot hold it', () => {
  // The format's oldest trap. Width and height are a single byte each, so 256
  // is encoded as 0 by convention -- and anything above 256 cannot be said at
  // all. Truncating it would ship a header that describes a different image
  // from the one attached.
  const ico = icoFromPng(png(256))
  assert.equal(ico.readUInt8(6), 0, '256 is written as 0')
  assert.equal(ico.readUInt8(7), 0)
  assert.throws(() => icoFromPng(png(512)), /256 is the maximum/,
    '512 was accepted; one byte would have silently stored 0, claiming 256')

  // The control: a size that DOES fit is written as itself, so the assertion
  // above is the convention and not every size collapsing to zero.
  assert.equal(icoFromPng(png(48)).readUInt8(6), 48)
})

test('a non-square or non-PNG source is refused rather than wrapped', () => {
  const oblong = png(64)
  oblong.writeUInt32BE(32, 20) // height only
  assert.throws(() => icoFromPng(oblong), /must be square/)
  assert.throws(() => icoFromPng(Buffer.from('not a png at all, not even close')), /Not a PNG/)
  assert.throws(() => pngSize(Buffer.alloc(40)), /Not a PNG/)

  // The control: the real source passes all of it.
  assert.doesNotThrow(() => icoFromPng(readFileSync(SOURCE)))
})
