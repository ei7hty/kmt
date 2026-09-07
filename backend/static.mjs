// Serving the built frontend out of dist/, the way backend/server.mjs does it.
//
// Moved out of server.mjs so the type map, the cache policy and the traversal
// guard can be tested without starting the whole application. server.mjs keeps
// the same behaviour and imports this; backend/dev.mjs does not use it at all,
// because Vite's middleware serves the source there. That is why a header
// added here is only ever seen against server.mjs or the deployed site.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { SITE_COPY_ELEMENT_ID } from '../src/site-copy.js'

/** Content types by extension. Anything not listed is served as bytes. */
export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

/**
 * How long a browser may keep a file before asking again, by where it lives.
 *
 * `assets/` is Vite's output: every name carries a content hash, so a changed
 * file is a new name and the old one can be cached forever.
 *
 * `brand/` is different, and the difference is the whole point of this table.
 * Brand files get reissued under the same names -- `docs/brand.md` carries the
 * rule and the reason. The names do not change when the bytes do, so
 * `immutable` would pin a superseded icon in every browser
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

/** The path decoded, or null when it is not valid percent-encoding. */
export function decodePath(pathname) {
  try { return decodeURIComponent(pathname) } catch { return null }
}

/** Weak validator from what the filesystem knows; enough for a 304. */
export function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

/**
 * The app shell with the owner's copy in it, and a validator that moves with it.
 *
 * A `type="application/json"` data block, never an executable inline script.
 * The policy in `site.mjs` is `script-src 'self'` with no `'unsafe-inline'`,
 * and `site.test.mjs` asserts it stays that way -- an executable block would
 * be refused at runtime and would break that test. A JSON block is never
 * executed, so `script-src` does not apply to it, which is why `index.html`'s
 * `application/ld+json` has always coexisted with this policy.
 *
 * `<` is escaped. Ken may legitimately type one, and a literal `</script>`
 * inside the JSON would end the block early and spill the rest into the page
 * as markup. This is the standard escape and it survives `JSON.parse`
 * unchanged, because `<` is just how JSON spells `<`.
 *
 * Injected rather than fetched because the landing page makes no network
 * request before the hero paints. A fetch-and-swap would repaint the headline
 * seconds in on a slow connection, on exactly the strings Ken cared enough to
 * edit.
 */
export function injectCopy(file, copy) {
  const html = readFileSync(file, 'utf8')
  const payload = JSON.stringify(copy ?? {}).replace(/</g, '\\u003c')
  const block = `<script type="application/json" id="${SITE_COPY_ELEMENT_ID}">${payload}</script>`
  // Before </head> where there is one, then </body>, then appended.
  //
  // The last branch is not defensive padding: `String.replace` with a missing
  // needle returns the string unchanged, so a shell with neither marker would
  // have dropped the copy silently and rendered the shipped defaults with no
  // error anywhere. Found by reading static.test.mjs's fixture, which is
  // exactly such a shell (`<!doctype html><div id="root"></div>`).
  const body = html.includes('</head>') ? html.replace('</head>', `${block}</head>`)
    : html.includes('</body>') ? html.replace('</body>', `${block}</body>`)
      : html + block
  const etag = `W/"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
  return { body, etag }
}

/**
 * A handler that serves one file out of `dist`, falling back to index.html.
 *
 * The SPA fallback is what makes a hard navigation to /owner/quotes work. It is
 * the same job vercel.json's rewrite did, and forgetting it is how this project
 * once shipped a build that passed every local check and 404'd in production.
 */
export function createStaticHandler(dist, { readCopy = null } = {}) {
  const distRoot = path.resolve(dist)

  return function serveStatic(request, response, pathname) {
    // Files are read, not written to. Anything else -- POST, TRACE, whatever
    // a scanner tries -- is refused rather than answered with the app shell.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' })
      response.end('Method Not Allowed')
      return
    }

    // A path that is not valid percent-encoding ("/%", "/brand/%E0%A4%A")
    // names no file. It gets the app shell like any other unknown path, not
    // a server fault: decodeURIComponent throws on it, and until this line
    // that throw was a 500 and a stack line in the log for every scanner
    // that tried one, which is noise under a 5xx alarm.
    const decoded = decodePath(pathname)
    const relative = (decoded ?? '').replace(/^\/+/, '')
    const candidate = path.join(distRoot, relative)

    // Never serve outside dist, whatever the URL claims. Inside means under
    // it, separator included: a sibling directory whose name merely begins
    // with "dist" would pass a bare prefix check.
    const resolved = path.resolve(candidate)
    const isFile = decoded !== null && resolved.startsWith(distRoot + path.sep) &&
      existsSync(resolved) && statSync(resolved).isFile()

    const file = isFile ? resolved : path.join(distRoot, 'index.html')
    const stat = statSync(file)
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
    // Still the file's mtime, including for the injected shell, where this
    // server deliberately will not honour it (see the 304 condition below).
    // So the shell advertises a validator the origin has opted out of keeping.
    //
    // That is safe only because nothing caches between Fly and the customer:
    // `no-cache` obliges any shared cache to revalidate with the origin, where
    // the `!shell` logic runs and answers correctly. Put a CDN or proxy in
    // front that implements `If-Modified-Since` itself and it would serve
    // stale copy from this header without ever consulting the logic that knows
    // better. Drop it for the shell on the day anything caches in front.
    const lastModified = stat.mtime.toUTCString()

    // The app shell, with the owner's copy in it. Only the shell: every other
    // file is bytes on disk and is streamed untouched.
    const shell = readCopy && path.resolve(file) === path.join(distRoot, 'index.html')
      ? injectCopy(file, readCopy())
      : null

    // The shell's validator has to move when the copy moves, and the file's
    // does not: `etagFor` is size and mtime, and injecting changes neither.
    // Left as it was, a returning browser would revalidate, match the old
    // ETag, take a 304 and keep the wording Ken had just replaced -- edits
    // reaching nobody who had ever loaded the page before, until a deploy
    // rewrote index.html. So the shell's ETag covers the bytes actually sent.
    const etag = shell ? shell.etag : etagFor(stat)

    const headers = {
      'Content-Type': type,
      'Cache-Control': cachePolicy(relative, isFile),
      'ETag': etag,
      'Last-Modified': lastModified,
    }

    // A browser holding a copy asks with one of these; when the copy is still
    // good, the answer is the headers and nothing else.
    //
    // `If-Modified-Since` is deliberately not honoured for the injected shell,
    // for the reason above: mtime is the file's, and the file does not change
    // when the copy does. For the shell the ETag is the only validator that
    // tells the truth.
    const since = request.headers['if-modified-since']
    const unchanged = request.headers['if-none-match'] === etag ||
      (!shell && since && !Number.isNaN(Date.parse(since)) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000))
    if (unchanged) {
      response.writeHead(304, headers)
      response.end()
      return
    }

    if (shell) {
      // Byte length, not `stat.size`: the body is longer than the file now,
      // and a short Content-Length truncates it.
      response.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(shell.body) })
      response.end(request.method === 'HEAD' ? undefined : shell.body)
      return
    }

    response.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (request.method === 'HEAD') { response.end(); return }
    createReadStream(file).pipe(response)
  }
}
