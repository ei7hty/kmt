import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { TIRE_CATALOG } from '../src/data/catalog.js'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { PageImporter } from './import.mjs'
import { createApi, createCatalogApi, createHealthApi, createMailStatusApi, createRequestsApi, createSiteCopyApi } from './api.mjs'
import { isMonitorAuthorized, readMonitorConfig } from './auth.mjs'
import { Quotes } from './quotes.mjs'
import { Outbox } from './outbox.mjs'
import { createMailer, describeMail, drainMail } from './mail.mjs'
import { RateLimiter } from './limits.mjs'
import { describeServiceArea, readServiceAreaConfig } from './service-area.mjs'
import { Inquiries } from './inquiries.mjs'
import { createInquiriesApi } from './inquiries-api.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filename = process.env.KMT_OWNER_DB || path.join(root, 'backend/data/owner.sqlite')
mkdirSync(path.dirname(filename), { recursive: true })
const inventory = new Inventory(filename, TIRE_CATALOG.map(tire => tire.size))
inventory.importSnapshot(JSON.parse(readFileSync(path.join(root, 'src/data/scraped-tires.json'), 'utf8')))
const refresher = new Refresher(inventory)
// The service-area check is off here unless the environment says otherwise:
// this is the only place off is a default, so a laptop debugging the form in
// another state is not refused. The boot line below says which it is.
const serviceArea = readServiceAreaConfig({ ...process.env, KMT_SERVICE_RADIUS_MILES: process.env.KMT_SERVICE_RADIUS_MILES ?? 'off' })
const quotes = new Quotes(inventory, { serviceArea })
const outbox = new Outbox(inventory.db)
const mailer = createMailer({ outbox, quotes, origin: `http://127.0.0.1:${process.env.KMT_OWNER_PORT || 4180}` })
const api = createApi(inventory, refresher, new PageImporter(inventory), quotes, { mailer })
// The customer catalog, served here too so the local flow matches the hosted one.
const catalogApi = createCatalogApi(inventory)
const siteCopyApi = createSiteCopyApi(inventory)
// The platform's health check, mounted here too so the local server and the
// hosted one answer the same routes.
const healthApi = createHealthApi(inventory)
// Mounted here too, so KMT_MONITOR_TOKEN can be exercised against the local
// server the same way it is against the hosted one -- see server.mjs.
const monitorConfig = readMonitorConfig()
const mailStatusApi = createMailStatusApi(mailer, monitorConfig, {
  isAuthorized: (request) => isMonitorAuthorized(monitorConfig, request),
})
const smtpProbeTimer = mailer.startSmtpProbe()
// Requests and their quotes live in the same database as inventory. The same
// limits as the hosted server, so a local run trips over them before a deploy does.
const publicLimiter = new RateLimiter()
const requestsApi = createRequestsApi(quotes, { limiter: publicLimiter, mailer })
const inquiriesApi = createInquiriesApi(new Inquiries(inventory.db), { limiter: publicLimiter })
const port = Number(process.env.KMT_OWNER_PORT || 4180)
const vite = await createViteServer({ root, server: {
  middlewareMode: true,
  fs: { deny: ['.env', '.env.*', '**/.git/**', '**/*.sqlite*', '**/backend/data/**'] },
}, appType: 'spa' })

const server = createHttpServer(async (request, response) => {
  // This initial backend is deliberately local-only. Reject DNS rebinding hosts.
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host)) {
    response.writeHead(403); response.end('Local owner workspace only'); return
  }
  if (await healthApi(request, response)) return
  if (await mailStatusApi(request, response)) return
  if (await catalogApi(request, response)) return
  if (await siteCopyApi(request, response)) return
  if (await requestsApi(request, response)) return
  if (await inquiriesApi(request, response)) return
  if (await api(request, response)) return
  if (request.url.startsWith('/api/')) {
    response.writeHead(404); response.end('Not found'); return
  }
  vite.middlewares(request, response)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Owner workspace: http://127.0.0.1:${port}/owner`)
  console.log(describeServiceArea(serviceArea))
  for (const line of describeMail(mailer.config)) console.log(line)
})

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(smtpProbeTimer)
  // Same ordering as backend/server.mjs's shutdown, and for the same reasons
  // (#285): stop accepting work, drain in-flight mail under a bound, then let
  // the refresher stop at a page boundary, then close the database. No Fly
  // grace period applies locally, but a local server that drains differently
  // from the hosted one is a difference nobody would think to look for.
  server.close()
  await drainMail(mailer)
  if (refresher.active) { refresher.cancel(); await refresher.done }
  await vite.close()
  inventory.close()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
