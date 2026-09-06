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
 *   KMT_CANONICAL_HOST   when set, every other accepted name answers 301 to
 *                        this one (except /api/health). Unset: every name serves
 *   KMT_SESSION_HOURS    session lifetime, default 12
 *   KMT_RELEASE          the short commit SHA the image was built from, set by
 *                        the Dockerfile; answered as X-KMT-Release. Unset: no header
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
import { createApi, createCatalogApi, createHealthApi, createRequestsApi, isHostAllowed, isKnownApiPath, isPublicApiCall, readJsonBody } from './api.mjs'
import { Quotes } from './quotes.mjs'
import { describeServiceArea, readServiceAreaConfig } from './service-area.mjs'
import { createAuth, createSessionStore, readAuthConfig } from './auth.mjs'
import { LoginThrottle, RateLimiter } from './limits.mjs'
import { applySecurityHeaders, assertCanonicalIsAllowed, canonicalRedirectTarget, parseRequestUrl, readRelease } from './site.mjs'
import { createStaticHandler } from './static.mjs'
import { Outbox } from './outbox.mjs'
import { createMailer, readMailConfig } from './mail.mjs'

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

// Mail configuration is checked before the database is opened for the same
// reason as the password: a key without a sending address is a deploy that
// would look healthy and send nothing.
try {
  readMailConfig()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

// The host names are checked here too, before the database is opened. A
// canonical name the allow-list refuses would be a healthy-looking outage
// (site.mjs says why this is a crash instead), and the cutover sets both by
// secret with a restart each time: a wrong secret should fail on the first
// lines of the log before anything touches the volume, which is what the
// runbook tells the operator to expect.
const allowedHosts = (process.env.KMT_ALLOWED_HOSTS || '')
  .split(',').map(value => value.trim()).filter(Boolean)
// The one switch for the domain cutover: set it and every other name answers
// 301 to this one. site.mjs says what is exempt and why.
const canonicalHost = (process.env.KMT_CANONICAL_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
try {
  assertCanonicalIsAllowed({ canonicalHost, allowedHosts })
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
// Where the van goes (t48). ACTIVE BY DEFAULT ON THIS SERVER: with nothing
// set, this reads base 02148, a 100 mile radius and a 25 mile review band,
// and a customer beyond the radius is refused at submit from the moment
// this deploys. The lead ruled it on by default and the user gave the
// number. Only backend/dev.mjs defaults the radius to off, for a laptop
// elsewhere; that comment describes the local server, not this one. To
// accept every ZIP here, set KMT_SERVICE_RADIUS_MILES=off explicitly, and
// the boot line will say so. A base ZIP the table does not know, or a
// radius that is not a distance, is refused here at boot rather than at the
// first submit, the way a bad password is.
let serviceArea
try {
  serviceArea = readServiceAreaConfig()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
const quotes = new Quotes(inventory, { serviceArea })
// The same object Quotes and the boot line already read from -- on/off only,
// answered as X-KMT-Service-Area on every response, never the radius, base
// ZIP or review distance it also holds.
const serviceAreaOn = serviceArea.radiusMiles !== null
// Every message about a request is recorded here whether or not a provider is
// configured; the mailer decides whether anything is actually sent.
const outbox = new Outbox(inventory.db)
const mailer = createMailer({
  outbox, quotes,
  origin: (process.env.KMT_PUBLIC_ORIGIN || '').trim() ||
    (canonicalHost ? `https://${canonicalHost}` : `http://localhost:${process.env.PORT || 8080}`),
})
const api = createApi(inventory, refresher, importer, quotes, { mailer })
const catalogApi = createCatalogApi(inventory)
// The platform's health check, mounted here too so the local server and the
// hosted one answer the same routes.
const healthApi = createHealthApi(inventory)
// Requests and their quotes live in the same database as inventory. The three
// public writes are limited per address, per browser key and per email (#63).
const requestsApi = createRequestsApi(quotes, { limiter: new RateLimiter(), mailer })

const port = Number(process.env.PORT || 8080)
const bind = process.env.KMT_BIND || '0.0.0.0'
// The commit this image was built from, answered on every response as
// X-KMT-Release when the image says (KMT_RELEASE, baked in by the Dockerfile).
const release = readRelease()

// The built frontend, served the way backend/static.mjs describes: hashed
// assets forever, brand files for a day, everything else revalidated.
const serveStatic = createStaticHandler(dist)

const server = createServer(async (request, response) => {
  try {
    // A URL that does not parse is a bad link, not a server fault (#132), and
    // the browser-facing headers go on before anything can write (#67).
    const { url } = parseRequestUrl(request.url)
    // Every handler parses request.url for itself, so the collapsed path has
    // to be the one they see: with the raw one, /api//catalog passed the gate
    // as the catalog and then matched no handler.
    request.url = url.pathname + url.search
    const hostname = (request.headers.host || '').split(':')[0]
    applySecurityHeaders(request, response, { release, serviceAreaOn })

    // The health check is exempt, and isHostAllowed says why. The canonical
    // redirect below exempts it for the same reason.
    if (!isHostAllowed(hostname, url.pathname, allowedHosts)) {
      response.writeHead(403); response.end('Unrecognised host'); return
    }

    const canonical = canonicalRedirectTarget({ hostname, pathname: url.pathname, search: url.search, canonicalHost })
    if (canonical) {
      response.writeHead(301, { Location: canonical, 'Cache-Control': 'no-store' }); response.end(); return
    }

    // Login and logout have to be reachable without a session, or there is no
    // way in.
    if (await auth.handle(request, response, url, readJsonBody)) return

    if (url.pathname.startsWith('/api/')) {
      // The import endpoint is reached from a giga-tires tab, so it carries a
      // bearer token instead of the session cookie -- SameSite=Lax means the
      // cookie is deliberately not sent cross-site. Preflight carries neither.
      const importCall = url.pathname === '/api/owner/import' &&
        (request.method === 'OPTIONS' || auth.isImportAuthorized(request))

      // The catalog is what a customer is quoted from, and a customer never
      // signs in. Named in the allow-list in api.mjs rather than by relaxing
      // the check below, so every other route stays refused by default.
      const publicCall = isPublicApiCall(request.method, url.pathname)

      // A path no handler knows is nobody's, and nobody's is 404: the sign-in
      // message below is for the owner's area, not for a typo in a link.
      if (!importCall && !isKnownApiPath(url.pathname)) {
        response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: 'No such endpoint.' }))
        return
      }

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
  console.log(canonicalHost
    ? `KMT_CANONICAL_HOST=${canonicalHost}: every other name answers 301 to it, except /api/health.`
    : 'KMT_CANONICAL_HOST unset: every accepted name serves; no canonical redirect.')
  console.log(release
    ? `Release ${release}: answered as X-KMT-Release on every response.`
    : 'KMT_RELEASE unset: no X-KMT-Release header (a local build, or an image built without GIT_SHA).')
  if (!process.env.KMT_SESSION_SECRET) {
    console.log('KMT_SESSION_SECRET unset: sessions will not survive a restart.')
  }
  console.log(describeServiceArea(serviceArea))
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
