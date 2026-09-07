import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import { TYPES, cachePolicy, createStaticHandler, decodePath, injectCopy } from './static.mjs'

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

test('a malformed percent-encoding is an unknown path, not a server fault', async t => {
  const { base } = await serve(t)
  assert.equal(decodePath('/%'), null)
  assert.equal(decodePath('/brand/icon-192.png'), '/brand/icon-192.png')
  for (const route of ['/%', '/%E0%A4%A', '/brand/%', '/%zz/%']) {
    const response = await fetch(`${base}${route}`)
    assert.equal(response.status, 200, `${route} is the app shell, not a 500`)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', route)
    assert.equal(response.headers.get('cache-control'), 'no-cache', route)
    assert.match(await response.text(), /id="root"/, route)
  }
})

test('a sibling directory whose name begins with "dist" is outside dist', async t => {
  const dist = buildDist(t)
  // The URL parser normalises dot segments before a real request reaches the
  // handler, so this calls the handler directly with the path it would never
  // otherwise see, and the guard has to hold on its own.
  const sibling = `${dist}-sibling`
  mkdirSync(sibling)
  t.after(() => rmSync(sibling, { recursive: true, force: true }))
  writeFileSync(path.join(sibling, 'secret.txt'), 'not yours')
  const handler = createStaticHandler(dist)
  const chunks = []
  let head = null
  const response = new PassThrough()
  response.writeHead = (status, headers) => { head = { status, headers } }
  response.on('data', chunk => chunks.push(chunk))
  const done = new Promise(resolve => response.on('end', resolve))
  handler({ method: 'GET', headers: {} }, response, `/../${path.basename(sibling)}/secret.txt`)
  await done
  assert.equal(head.status, 200)
  assert.equal(head.headers['Content-Type'], 'text/html; charset=utf-8', 'the app shell')
  assert.match(Buffer.concat(chunks).toString(), /id="root"/, 'and never the sibling file')
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
  assert.match(rules, /^Allow: \/$/m, 'the customer flow is allowed explicitly')
  assert.match(rules, /^Sitemap: https:\/\/kensmobiletire\.com\/sitemap\.xml$/m, 'and the sitemap is named')
})

test('the shipped sitemap lists only pages meant for an index, none of which 404', () => {
  const sitemap = readFileSync(path.join(import.meta.dirname, '..', 'public', 'sitemap.xml'), 'utf8')
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])
  assert.deepEqual(locs, ['https://kensmobiletire.com/', 'https://kensmobiletire.com/privacy'], 'the customer flow and the privacy notice, never a page that belongs to one customer')
  assert.equal(TYPES['.xml'], 'application/xml; charset=utf-8', 'and it is served as XML, not bytes')
})

test('only GET and HEAD reach the files; anything else is 405, not the app shell', async t => {
  const { base } = await serve(t)
  // node:http rather than fetch: fetch refuses to send TRACE at all, and TRACE
  // answering 200 HTML is the exact finding this guards against.
  const send = method => new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/`, { method }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, allow: response.headers.allow, body }))
    })
    request.on('error', reject)
    request.end()
  })
  for (const method of ['POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS', 'PATCH']) {
    const response = await send(method)
    assert.equal(response.status, 405, `${method} /`)
    assert.equal(response.allow, 'GET, HEAD')
    assert.doesNotMatch(response.body, /id="root"/, `${method} does not get index.html`)
  }
})

test('HEAD answers the headers and no body', async t => {
  const { base } = await serve(t)
  const response = await fetch(`${base}/brand/icon-192.png`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), '8')
  assert.equal((await response.arrayBuffer()).byteLength, 0)
})

// --- The owner's copy, injected into the shell -------------------------------
//
// These live here rather than in site-copy.test.mjs because the mechanism is
// this file's: what the shell carries, and what validator goes with it.

/** The same server as `serve`, but with copy injection wired in. */
async function serveWithCopy(t, readCopy) {
  const dist = buildDist(t)
  const handler = createStaticHandler(dist, { readCopy })
  const server = createServer((request, response) => handler(request, response, new URL(request.url, 'http://x').pathname))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { base: `http://127.0.0.1:${server.address().port}`, dist }
}

test('the copy block reaches a shell with no head and no body, rather than vanishing', () => {
  // String.replace with a missing needle returns the string unchanged, so both
  // earlier branches are no-ops here. Without the append the copy would be
  // dropped in silence and the page would render defaults with nothing wrong
  // anywhere to find.
  const dist = mkdtempSync(path.join(tmpdir(), 'kmt-shell-'))
  try {
    const file = path.join(dist, 'index.html')
    writeFileSync(file, '<!doctype html><div id="root"></div>')
    const { body } = injectCopy(file, { 'hero.eyebrow': 'PRESENT' })
    assert.match(body, /id="site-copy"/)
    assert.match(body, /PRESENT/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('the block is a data block, never an executable script', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'kmt-shell-'))
  try {
    const file = path.join(dist, 'index.html')
    writeFileSync(file, '<!doctype html><head></head><body></body>')
    const { body } = injectCopy(file, { 'hero.eyebrow': 'X' })
    // script-src 'self' with no 'unsafe-inline' refuses an executable inline
    // script, and site.test.mjs asserts the policy stays that way. A JSON data
    // block is never executed, so the policy does not apply to it.
    assert.match(body, /<script type="application\/json" id="site-copy">/)
    assert.doesNotMatch(body, /<script>/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('a "<" in the copy cannot end the block early', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'kmt-shell-'))
  try {
    const file = path.join(dist, 'index.html')
    writeFileSync(file, '<!doctype html><head></head><body></body>')
    const { body } = injectCopy(file, { 'hero.eyebrow': 'a </script> b <b>' })
    // The literal sequence must not survive into the markup, or everything
    // after it spills into the page as HTML.
    assert.ok(!body.includes('a </script> b'), 'the raw closing tag is escaped')
    const payload = body.match(/id="site-copy">(.*?)<\/script>/s)[1]
    assert.equal(JSON.parse(payload)['hero.eyebrow'], 'a </script> b <b>', 'and it round-trips through JSON.parse')
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('the shell carries the copy, and its ETag moves when the copy does', async t => {
  let copy = { 'hero.eyebrow': 'FIRST' }
  const { base } = await serveWithCopy(t, () => copy)

  const first = await fetch(base + '/')
  const firstBody = await first.text()
  const firstTag = first.headers.get('etag')
  assert.match(firstBody, /FIRST/)

  // Unchanged copy: a revalidation is a 304, so caching still works.
  const revalidated = await fetch(base + '/', { headers: { 'If-None-Match': firstTag } })
  assert.equal(revalidated.status, 304)

  copy = { 'hero.eyebrow': 'SECOND' }
  const second = await fetch(base + '/')
  const secondTag = second.headers.get('etag')
  assert.notEqual(secondTag, firstTag, 'the validator must move with the copy')
  assert.match(await second.text(), /SECOND/)

  // The one that matters. etagFor is size and mtime, and injecting changes
  // neither -- so with the file's own validator a returning browser would
  // match, take a 304, and keep the wording Ken had just replaced.
  const stale = await fetch(base + '/', { headers: { 'If-None-Match': firstTag } })
  assert.equal(stale.status, 200, 'an old validator must not win a 304 after an edit')
  assert.match(await stale.text(), /SECOND/)
})

test('Content-Length counts the injected bytes, not the file on disk', async t => {
  const { base, dist } = await serveWithCopy(t, () => ({ 'hero.eyebrow': 'PADDING PADDING PADDING' }))
  const response = await fetch(base + '/')
  const body = await response.text()
  const onDisk = readFileSync(path.join(dist, 'index.html'), 'utf8')
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body))
  assert.ok(Buffer.byteLength(body) > Buffer.byteLength(onDisk), 'the body really is longer than the file')
})

test('If-Modified-Since cannot win a 304 on the injected shell', async t => {
  // mtime belongs to the file, and the file does not change when the copy
  // does, so this validator can only ever be wrong for the shell.
  const { base } = await serveWithCopy(t, () => ({ 'hero.eyebrow': 'LIVE' }))
  const response = await fetch(base + '/', { headers: { 'If-Modified-Since': new Date('2030-01-01T00:00:00Z').toUTCString() } })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /LIVE/)
})

test('without a readCopy the shell is served exactly as before', async t => {
  const { base } = await serve(t)
  const response = await fetch(base + '/')
  assert.equal(response.status, 200)
  assert.doesNotMatch(await response.text(), /site-copy/)
})

test('only the shell is injected; other files are streamed untouched', async t => {
  const { base } = await serveWithCopy(t, () => ({ 'hero.eyebrow': 'SHELL ONLY' }))
  const asset = await fetch(base + '/assets/index-abc123.js')
  assert.equal(await asset.text(), 'console.log(1)')
  const manifest = await fetch(base + '/manifest.webmanifest')
  assert.equal(await manifest.text(), '{"name":"KMT"}')
})
