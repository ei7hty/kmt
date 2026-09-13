#!/usr/bin/env node
/**
 * Wrap a PNG as public/favicon.ico, so the path Google fetches first is an image.
 *
 *   node scripts/build-favicon.mjs public/brand/icon-192.png public/favicon.ico
 *
 * WHY THIS EXISTS. Measured against the live site 2026-09-13:
 * `GET /favicon.ico` answered **200 with `content-type: text/html`** -- the
 * SPA catch-all returns index.html for any path it does not recognise, and
 * `/favicon.ico` is one of those. Google requests that path directly, before
 * and regardless of the `<link rel="icon">` tags in the head, and got back a
 * web page. An image URL serving HTML is worse than a 404: there is nothing to
 * fall back to, and the result was the default placeholder in search.
 *
 * THE ARTWORK WAS NEVER THE PROBLEM. `/brand/icon-192.png` is a valid 192x192
 * PNG -- square, a multiple of 48 as Google asks, crawlable, correctly linked.
 * So this changes nothing about the icon and only puts it where the request
 * lands.
 *
 * A SCRIPT RATHER THAN A COMMITTED BINARY NOBODY CAN REGENERATE. The .ico it
 * writes is committed (it has to be served as a static file), but the day the
 * logo changes, this regenerates it from the same source the rest of the icons
 * come from, and its test proves the bytes still describe the image they
 * claim to. A binary checked in with no way to rebuild it is one nobody dares
 * touch.
 *
 * NO IMAGE LIBRARY, because there is none in this tree and adding one to
 * write a 22-byte header would be a poor trade. An ICO is a container: a
 * 6-byte directory, one 16-byte entry, then the image bytes. Since Windows
 * Vista those bytes may be a PNG as-is, which is what every modern browser and
 * crawler reads.
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** PNG dimensions, read from the IHDR chunk that must start every PNG. */
export function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) throw new Error('Not a PNG')
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('PNG has no IHDR where one must be')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * One PNG, wrapped as a single-image ICO.
 *
 * The width and height bytes are the ICO format's oldest trap: they are ONE
 * byte each, and 256 is written as 0 because it does not fit. Anything above
 * 256 cannot be expressed at all, which is why that is refused here rather
 * than silently truncated to a lie about the image that follows.
 */
export function icoFromPng(png) {
  const { width, height } = pngSize(png)
  if (width !== height) throw new Error(`Favicon must be square; got ${width}x${height}`)
  if (width > 256) throw new Error(`ICO cannot describe ${width}px; 256 is the maximum`)

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)  // reserved
  header.writeUInt16LE(1, 2)  // 1 = icon
  header.writeUInt16LE(1, 4)  // one image

  const entry = Buffer.alloc(16)
  entry.writeUInt8(width === 256 ? 0 : width, 0)
  entry.writeUInt8(height === 256 ? 0 : height, 1)
  entry.writeUInt8(0, 2)               // palette colours: 0 for a PNG
  entry.writeUInt8(0, 3)               // reserved
  entry.writeUInt16LE(1, 4)            // colour planes
  entry.writeUInt16LE(32, 6)           // bits per pixel
  entry.writeUInt32LE(png.length, 8)   // bytes of image data
  entry.writeUInt32LE(22, 12)          // offset: 6 header + 16 entry

  return Buffer.concat([header, entry, png])
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [source, output] = process.argv.slice(2)
  if (!source || !output) {
    console.error('Use: node scripts/build-favicon.mjs SOURCE_PNG OUTPUT_ICO')
    process.exit(1)
  }
  const png = readFileSync(source)
  const ico = icoFromPng(png)
  writeFileSync(output, ico)
  const { width } = pngSize(png)
  console.log(JSON.stringify({ source, output, size: `${width}x${width}`, bytes: ico.length }))
}
