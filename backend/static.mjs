// Serving the built frontend out of dist/, the way backend/server.mjs does it.
//
// Moved out of server.mjs so the type map, the cache policy and the traversal
// guard can be tested without starting the whole application. server.mjs keeps
// the same behaviour and imports this; backend/dev.mjs does not use it at all,
// because Vite's middleware serves the source there. That is why a header
// added here is only ever seen against server.mjs or the deployed site.

import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'

/** Content types by extension. Anything not listed is served as bytes. */
export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

/**
 * How long a browser may keep a file before asking again, by where it lives.
 *
 * `assets/` is Vite's output: every name carries a content hash, so a changed
 * file is a new name and the old one can be cached forever.
 *
 * `brand/` is different, and the difference is the whole point of this table.
 * public/brand/SOURCES.md says the watermarked placeholders will be replaced
 * by the licensed art "with the same names". The names do not change when the
 * bytes do, so `immutable` would pin the watermarked icons in every browser
 * and home-screen cache for a year. One day, then revalidate: the icons stop
 * being re-downloaded on every page view (they were, ~1 MB per visit, because
 * `no-cache` with no validator is a full fetch each time), and a replaced
 * file reaches a returning visitor within a day.
 *
 * Everything else -- index.html, the manifest, the old /kmtlogo.jpg -- is
 * `no-cache`: keep a copy, but ask before using it. With the validators below
 * that ask is a 304, not a download.
 */
export function cachePolicy(relative, isFile) {
  if (!isFile) return 'no-cache'
  if (relative.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  if (relative.startsWith('brand/')) return 'public, max-age=86400, stale-while-revalidate=604800'
  return 'no-cache'
}

/** Weak validator from what the filesystem knows; enough for a 304. */
export function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

/**
 * A handler that serves one file out of `dist`, falling back to index.html.
 *
 * The SPA fallback is what makes a hard navigation to /owner/quotes work. It is
 * the same job vercel.json's rewrite did, and forgetting it is how this project
 * once shipped a build that passed every local check and 404'd in production.
 */
export function createStaticHandler(dist) {
  const distRoot = path.resolve(dist)

  return function serveStatic(request, response, pathname) {
    // Files are read, not written to. Anything else -- POST, TRACE, whatever
    // a scanner tries -- is refused rather than answered with the app shell.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' })
      response.end('Method Not Allowed')
      return
    }

    const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
    const candidate = path.join(distRoot, relative)

    // Never serve outside dist, whatever the URL claims.
    const resolved = path.resolve(candidate)
    const isFile = resolved.startsWith(distRoot) &&
      existsSync(resolved) && statSync(resolved).isFile()

    const file = isFile ? resolved : path.join(distRoot, 'index.html')
    const stat = statSync(file)
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const etag = etagFor(stat)
    const lastModified = stat.mtime.toUTCString()

    const headers = {
      'Content-Type': type,
      'Cache-Control': cachePolicy(relative, isFile),
      'ETag': etag,
      'Last-Modified': lastModified,
    }

    // A browser holding a copy asks with one of these; when the copy is still
    // good, the answer is the headers and nothing else.
    const since = request.headers['if-modified-since']
    const unchanged = request.headers['if-none-match'] === etag ||
      (since && !Number.isNaN(Date.parse(since)) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000))
    if (unchanged) {
      response.writeHead(304, headers)
      response.end()
      return
    }

    response.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (request.method === 'HEAD') { response.end(); return }
    createReadStream(file).pipe(response)
  }
}
