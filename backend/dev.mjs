import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'
import { TIRE_CATALOG } from '../src/data/catalog.js'
import { Inventory } from './inventory.mjs'
import { Refresher } from './refresh.mjs'
import { PageImporter } from './import.mjs'
import { createApi } from './api.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filename = process.env.KMT_OWNER_DB || path.join(root, 'backend/data/owner.sqlite')
mkdirSync(path.dirname(filename), { recursive: true })
const inventory = new Inventory(filename, TIRE_CATALOG.map(tire => tire.size))
inventory.importSnapshot(JSON.parse(readFileSync(path.join(root, 'src/data/scraped-tires.json'), 'utf8')))
const refresher = new Refresher(inventory)
const api = createApi(inventory, refresher, new PageImporter(inventory))
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
  if (await api(request, response)) return
  if (request.url.startsWith('/api/')) {
    response.writeHead(404); response.end('Not found'); return
  }
  vite.middlewares(request, response)
})
server.listen(port, '127.0.0.1', () => console.log(`Owner workspace: http://127.0.0.1:${port}/owner`))

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  if (refresher.active) { refresher.cancel(); await refresher.done }
  server.close()
  await vite.close()
  inventory.close()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
