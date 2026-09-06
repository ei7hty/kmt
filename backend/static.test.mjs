import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { TYPES, cachePolicy, createStaticHandler } from './static.mjs'

/** A dist/ the shape Vite produces, plus the public/ files that matter here. */
function buildDist(t) {
  const dist = mkdtempSync(path.join(tmpdir(), 'kmt-dist-'))
  t.after(() => rmSync(dist, { recursive: true, force: true }))
  mkdirSync(path.join(dist, 'assets'))
  mkdirSync(path.join(dist, 'brand'))
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>')
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(path.join(dist, 'brand', 'icon-192.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  writeFileSync(path.join(dist, 'brand', 'SOURCES.md'), '# Brand assets')
  writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"KMT"}')
  writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *\nDisallow: /owner\n')
  // A fixed mtime, so validators are stable across the test.
  const stamp = new Date('2026-09-06T00:00:00Z')
  for (const file of ['index.html', 'assets/index-abc123.js', 'brand/icon-192.png', 'brand/SOURCES.md', 'manifest.webmanifest', 'robots.txt']) {
    utimesSync(path.join(dist, file), stamp, stamp)
  }
  return dist
}

async function serve(t) {
  const dist = buildDist(t)
  const handler = createStaticHandler(dist)
  const server = createServer((request, response) => handler(request, response, new URL(request.url, 'http://x').pathname))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { base: `http://127.0.0.1:${server.address().port}`, dist }
}

test('the cache policy follows where a file lives, and why', () => {
  assert.equal(cachePolicy('assets/index-abc123.js', true), 'public, max-age=31536000, immutable', 'hashed names can be kept forever')
  assert.equal(cachePolicy('brand/icon-192.png', true), 'public, max-age=86400, stale-while-revalidate=604800',
    'brand files keep their names when the art is replaced, so a day, not a year')
  assert.equal(cachePolicy('index.html', true), 'no-cache')
  assert.equal(cachePolicy('manifest.webmanifest', true), 'no-cache')
  assert.equal(cachePolicy('owner/quotes', false), 'no-cache', 'the SPA fallback is never cached')
})

test('every file the brand folder and the manifest need has a real content type', () => {
  assert.equal(TYPES['.webmanifest'], 'application/manifest+json; charset=utf-8')
  assert.equal(TYPES['.md'], 'text/markdown; charset=utf-8')
  assert.equal(TYPES['.png'], 'image/png')
  assert.equal(TYPES['.webp'], 'image/webp')
  assert.equal(TYPES['.jpg'], 'image/jpeg')
})

test('a brand file is served with its type, a day of cache, validators and a length', async t => {
  const { base } = await serve(t)
  const response = await fetch(`${base}/brand/icon-192.png`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800')
  assert.equal(response.headers.get('content-length'), '8')
  assert.match(response.headers.get('etag'), /^W\/"[0-9a-f]+-[0-9a-f]+"$/)
  assert.equal(response.headers.get('last-modified'), 'Sun, 06 Sep 2026 00:00:00 GMT')
  assert.equal((await response.arrayBuffer()).byteLength, 8, 'and the body is the file')
})

test('a browser holding a copy gets a 304 and no body, by either validator', async t => {
  const { base } = await serve(t)
  const first = await fetch(`${base}/index.html`)
  const etag = first.headers.get('etag')
  const lastModified = first.headers.get('last-modified')

  const byEtag = await fetch(`${base}/index.html`, { headers: { 'If-None-Match': etag } })
  assert.equal(byEtag.status, 304)
  assert.equal(byEtag.headers.get('cache-control'), 'no-cache', 'the 304 carries the policy too')
  assert.equal((await byEtag.arrayBuffer()).byteLength, 0)

  const byDate = await fetch(`${base}/index.html`, { headers: { 'If-Modified-Since': lastModified } })
  assert.equal(byDate.status, 304)

  const stale = await fetch(`${base}/index.html`, { headers: { 'If-None-Match': 'W/"nope"' } })
  assert.equal(stale.status, 200, 'a validator that does not match gets the file')

  const older = await fetch(`${base}/index.html`, { headers: { 'If-Modified-Since': 'Sat, 05 Sep 2026 00:00:00 GMT' } })
  assert.equal(older.status, 200, 'a copy older than the file gets the file')
})

test('the manifest and the sources note are served as what they are', async t => {
  const { base } = await serve(t)
  const manifest = await fetch(`${base}/manifest.webmanifest`)
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
  assert.equal(manifest.headers.get('cache-control'), 'no-cache', 'the manifest may change when the art does')
  const sources = await fetch(`${base}/brand/SOURCES.md`)
  assert.equal(sources.headers.get('content-type'), 'text/markdown; charset=utf-8')
})

test('hashed assets are immutable; unknown routes and traversal attempts get index.html, uncached', async t => {
  const { base } = await serve(t)
  const asset = await fetch(`${base}/assets/index-abc123.js`)
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')

  for (const route of ['/owner/quotes', '/status?request=abc', '/no-such-file.png', '/brand/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
    const response = await fetch(`${base}${route}`)
    assert.equal(response.status, 200, route)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', `${route} falls back to the app shell`)
    assert.equal(response.headers.get('cache-control'), 'no-cache', `${route} is never cached`)
    assert.match(await response.text(), /id="root"/, `${route} is index.html, not something outside dist`)
  }
})

test('robots.txt is a real file served as text, not the app shell', async t => {
  const { base } = await serve(t)
  const response = await fetch(`${base}/robots.txt`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(await response.text(), /^User-agent: \*/, 'a crawler reads rules, not HTML')
})

test('the shipped robots.txt keeps the owner and customer screens out of search indexes', () => {
  const rules = readFileSync(path.join(import.meta.dirname, '..', 'public', 'robots.txt'), 'utf8')
  for (const route of ['/owner', '/status', '/confirmation', '/api/']) {
    assert.match(rules, new RegExp(`^Disallow: ${route.replaceAll('/', '\\/')}$`, 'm'), `${route} is disallowed`)
  }
  assert.match(rules, /^User-agent: \*$/m)
})

test('only GET and HEAD reach the files; anything else is 405, not the app shell', async t => {
  const { base } = await serve(t)
  for (const method of ['POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS']) {
    const response = await fetch(`${base}/`, { method })
    assert.equal(response.status, 405, `${method} /`)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.doesNotMatch(await response.text(), /id="root"/, `${method} does not get index.html`)
  }
})

test('HEAD answers the headers and no body', async t => {
  const { base } = await serve(t)
  const response = await fetch(`${base}/brand/icon-192.png`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), '8')
  assert.equal((await response.arrayBuffer()).byteLength, 0)
})
