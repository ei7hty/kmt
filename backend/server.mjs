/**
 * Production owner server: the built frontend and the API from one origin.
 *
 * `dev.mjs` stays the local entry point and is unchanged -- it runs Vite in
 * middleware mode, binds loopback and needs no password, which is right for a
 * workspace only you can reach. This is the other half: it serves the built
 * `dist/`, binds a real interface, and refuses to start without a password.
 *
 * Everything it needs comes from the environment, so the same image runs on
 * Fly, Render, Railway, a VPS or `docker run` with no host-specific code:
 *
 *   KMT_OWNER_PASSWORD   required; the server exits without it
 *   KMT_SESSION_SECRET   recommended; random per boot otherwise, which signs
 *                        everyone out on restart
 *   KMT_OWNER_DB         SQLite path. Point it at a mounted volume -- the
 *                        default lives inside the container and dies with it
 *   PORT                 defaults to 8080; most hosts set this for you
 *   KMT_BIND             defaults to 0.0.0.0
 *   KMT_ALLOWED_HOSTS    comma-separated hostnames to accept. Unset means any,
 *                        which is fine behind a host that terminates its own TLS
 *   KMT_SESSION_HOURS    session lifetime, default 12
 *
 * One origin is a deliberate choice, not a convenience: the API's same-origin
 * check keeps working as written, so there is no CORS surface and no token to
 * hand a separate frontend.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TIRE_CATALOG } from '../src/data/catalog.js'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { PageImporter } from './import.mjs'
import { createApi, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`No build found at ${dist}. Run \`npm run build\` before starting this server.`)
  process.exit(1)
}

let auth
try {
  auth = createAuth(readAuthConfig())
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const dbPath = process.env.KMT_OWNER_DB || path.join(root, 'backend/data/owner.sqlite')
mkdirSync(path.dirname(dbPath), { recursive: true })

const inventory = new Inventory(dbPath, TIRE_CATALOG.map(tire => tire.size))
inventory.importSnapshot(JSON.parse(readFileSync(path.join(root, 'src/data/scraped-tires.json'), 'utf8')))
const refresher = new Refresher(inventory)
const importer = new PageImporter(inventory)
const api = createApi(inventory, refresher, importer)

const port = Number(process.env.PORT || 8080)
const bind = process.env.KMT_BIND || '0.0.0.0'
const allowedHosts = (process.env.KMT_ALLOWED_HOSTS || '')
  .split(',').map(value => value.trim()).filter(Boolean)

/**
 * Serve one file out of dist, falling back to index.html.
 *
 * The SPA fallback is what makes a hard navigation to /owner/quotes work. It is
 * the same job vercel.json's rewrite does, and forgetting it is how this project
 * shipped a build that passed every local check and 404'd in production.
 */
function serveStatic(request, response, pathname) {
  const relative = pathname.replace(/^\/+/, '')
  const candidate = path.join(dist, relative)

  // Never serve outside dist, whatever the URL claims.
  const resolved = path.resolve(candidate)
  const isFile = resolved.startsWith(path.resolve(dist)) &&
    existsSync(resolved) && statSync(resolved).isFile()

  const file = isFile ? resolved : path.join(dist, 'index.html')
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'

  // Hashed asset filenames are safe to cache hard; index.html never is.
  const cache = isFile && relative.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'

  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache })
  createReadStream(file).pipe(response)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    const hostname = (request.headers.host || '').split(':')[0]

    if (allowedHosts.length && !allowedHosts.includes(hostname)) {
      response.writeHead(403); response.end('Unrecognised host'); return
    }

    // Login and logout have to be reachable without a session, or there is no
    // way in.
    if (await auth.handle(request, response, url, readJsonBody)) return

    if (url.pathname.startsWith('/api/')) {
      // The import endpoint is reached from a giga-tires tab, so it carries a
      // bearer token instead of the session cookie -- SameSite=Strict means the
      // cookie is deliberately not sent cross-site. Preflight carries neither.
      const importCall = url.pathname === '/api/owner/import' &&
        (request.method === 'OPTIONS' || auth.isImportAuthorized(request))

      if (!importCall && !auth.isAuthenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
        return
      }
      if (await api(request, response)) return
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Owner endpoint not found' }))
      return
    }

    // The frontend itself is not secret -- the customer flow is public, and the
    // owner screen renders a login prompt when its API says 401. Guarding the
    // data is what matters, and that is done above.
    serveStatic(request, response, url.pathname)
  } catch (error) {
    console.error(error)
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'Something went wrong.' }))
  }
})

server.listen(port, bind, () => {
  console.log(`KMT owner workspace listening on ${bind}:${port}`)
  console.log(`Database: ${dbPath}`)
  if (!allowedHosts.length) console.log('KMT_ALLOWED_HOSTS unset: accepting any Host header.')
  if (!process.env.KMT_SESSION_SECRET) {
    console.log('KMT_SESSION_SECRET unset: sessions will not survive a restart.')
  }
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  // Let an in-flight refresh stop cleanly rather than leaving a job row that
  // claims to be running forever.
  if (refresher.active) { refresher.cancel(); await refresher.done }
  server.close()
  inventory.close()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
