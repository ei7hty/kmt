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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TIRE_CATALOG } from '../src/data/catalog.js'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { PageImporter } from './import.mjs'
import { createApi, createCatalogApi, createHealthApi, createRequestsApi, isHostAllowed, isPublicApiCall, readJsonBody } from './api.mjs'
import { Quotes } from './quotes.mjs'
import { createAuth, createSessionStore, readAuthConfig } from './auth.mjs'
import { LoginThrottle, RateLimiter } from './limits.mjs'
import { createStaticHandler } from './static.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`No build found at ${dist}. Run \`npm run build\` before starting this server.`)
  process.exit(1)
}

// The password is checked before the database is opened, so a misconfigured
// deploy fails on the first line of its log rather than after a migration.
let authConfig
try {
  authConfig = readAuthConfig()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const dbPath = process.env.KMT_OWNER_DB || path.join(root, 'backend/data/owner.sqlite')
mkdirSync(path.dirname(dbPath), { recursive: true })

const inventory = new Inventory(dbPath, TIRE_CATALOG.map(tire => tire.size))
inventory.importSnapshot(JSON.parse(readFileSync(path.join(root, 'src/data/scraped-tires.json'), 'utf8')))
// Live sessions are in the database so a deploy does not sign the owner out;
// wrong passwords are slowed per address (#66). The health check is exempt
// from both by never passing through either: it is answered below on its own.
const auth = createAuth(authConfig, {
  sessions: createSessionStore(inventory.db),
  throttle: new LoginThrottle(),
})
const refresher = new Refresher(inventory)
const importer = new PageImporter(inventory)
const quotes = new Quotes(inventory)
const api = createApi(inventory, refresher, importer, quotes)
const catalogApi = createCatalogApi(inventory)
// The platform's health check, mounted here too so the local server and the
// hosted one answer the same routes.
const healthApi = createHealthApi(inventory)
// Requests and their quotes live in the same database as inventory. The three
// public writes are limited per address, per browser key and per email (#63).
const requestsApi = createRequestsApi(quotes, { limiter: new RateLimiter() })

const port = Number(process.env.PORT || 8080)
const bind = process.env.KMT_BIND || '0.0.0.0'
const allowedHosts = (process.env.KMT_ALLOWED_HOSTS || '')
  .split(',').map(value => value.trim()).filter(Boolean)

// The built frontend, served the way backend/static.mjs describes: hashed
// assets forever, brand files for a day, everything else revalidated.
const serveStatic = createStaticHandler(dist)

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    const hostname = (request.headers.host || '').split(':')[0]

    // The health check is exempt, and isHostAllowed says why. A canonical-host
    // redirect added later has to exempt it for the same reason.
    if (!isHostAllowed(hostname, url.pathname, allowedHosts)) {
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

      // The catalog is what a customer is quoted from, and a customer never
      // signs in. Named in the allow-list in api.mjs rather than by relaxing
      // the check below, so every other route stays refused by default.
      const publicCall = isPublicApiCall(request.method, url.pathname)

      if (!publicCall && !importCall && !auth.isAuthenticated(request)) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
        return
      }
      if (await healthApi(request, response)) return
      if (await catalogApi(request, response)) return
      if (await requestsApi(request, response)) return
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
