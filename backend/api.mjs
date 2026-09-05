import { InputError } from './inventory.mjs'

/**
 * Exported as `readJsonBody` so the auth routes parse request bodies the same
 * way the API does -- same content-type rule, same 32KB ceiling, same errors.
 */
export async function readJsonBody(request, limitBytes = 32768) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new InputError('Expected JSON', 415)
  let data = ''
  for await (const chunk of request) {
    data += chunk
    if (Buffer.byteLength(data) > limitBytes) throw new InputError('Request is too large', 413)
  }
  try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object') throw new Error(); return parsed }
  catch { throw new InputError('Invalid JSON') }
}

/**
 * A supplier listing page is around 700KB of HTML, so the import endpoint gets
 * its own ceiling. Everything else keeps the 32KB one -- a quote or an offer
 * that size is a mistake or an attack, not a request.
 */
const IMPORT_BODY_LIMIT = 4 * 1024 * 1024

/** The only origins allowed to post pages back. Nothing else gets CORS at all. */
const IMPORT_ORIGINS = new Set(['https://www.giga-tires.com', 'https://giga-tires.com'])

/**
 * API paths a customer may reach without signing in.
 *
 * An allow-list, not a loosened check. Everything under /api/ is refused
 * without a session, and the way to make one route public is to name it here
 * -- so adding a route never quietly makes it reachable, and the set of things
 * the public can call is one line to read.
 */
export const PUBLIC_API_PATHS = new Set(['/api/catalog'])

/** Whether this request is one of the public calls, by path and by method. */
export function isPublicApiCall(method, pathname) {
  return method === 'GET' && PUBLIC_API_PATHS.has(pathname)
}

/**
 * The customer-facing catalog.
 *
 * Separate from createApi rather than another branch inside it: that handler
 * exists to serve a signed-in owner, with CORS for the import page and a
 * same-origin check on everything else, and hanging a public route off it
 * would mean every future change to those rules silently applies to the
 * public one too.
 */
export function createCatalogApi(inventory) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (!isPublicApiCall(request.method, url.pathname)) return false

    try {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        // Prices change the moment the owner saves one. A cached catalog quotes
        // a price he has already changed his mind about.
        'Cache-Control': 'no-store',
      })
      response.end(JSON.stringify({ tires: inventory.catalog() }))
    } catch (error) {
      console.error(error)
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Could not load the catalog.' }))
    }
    return true
  }
}

export function createApi(inventory, refresher, importer = null) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/owner/')) return false
    const origin = request.headers.origin

    // The import endpoint is the one thing a giga-tires page may talk to, and
    // only that one. Its CORS headers are set here and nowhere else, so no
    // other route can accidentally inherit them.
    const isImport = url.pathname === '/api/owner/import'
    const corsHeaders = isImport && IMPORT_ORIGINS.has(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : {}

    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders })
      response.end(JSON.stringify(value))
    }

    // Preflight. Answered before the same-origin check below, which would
    // otherwise reject the very request that asks permission to be cross-origin.
    if (request.method === 'OPTIONS' && isImport) {
      response.writeHead(Object.keys(corsHeaders).length ? 204 : 403, corsHeaders)
      response.end()
      return true
    }

    try {
      // Same-origin only, except the import endpoint, which exists precisely to
      // be called from a supplier page. The scheme has to come from the request
      // rather than being assumed http: behind TLS the browser sends
      // `https://host` and a hardcoded `http://host` rejects every save.
      const scheme = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
        (request.socket.encrypted ? 'https' : 'http')
      const sameOrigin = origin === `${scheme}://${request.headers.host}`
      if (origin && !sameOrigin && !(isImport && IMPORT_ORIGINS.has(origin))) {
        throw new InputError('Cross-origin access refused', 403)
      }

      if (isImport) {
        if (request.method !== 'POST') throw new InputError('Owner endpoint not found', 404)
        if (!importer) throw new InputError('Page import is not available', 404)
        send(200, importer.addPage(await readJsonBody(request, IMPORT_BODY_LIMIT)))
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/owner/inventory') {
        send(200, { ...inventory.list(Object.fromEntries(url.searchParams)), summary: inventory.summary() })
      } else if (request.method === 'PUT' && url.pathname.startsWith('/api/owner/offers/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/owner/offers/'.length))
        send(200, inventory.saveOffer(id, await readJsonBody(request)))
      } else if (request.method === 'GET' && url.pathname === '/api/owner/markup') {
        send(200, inventory.getMarkup())
      } else if (request.method === 'PUT' && url.pathname === '/api/owner/markup') {
        send(200, inventory.saveMarkup(await readJsonBody(request)))
      } else if (request.method === 'POST' && url.pathname === '/api/owner/refresh') {
        const input = await readJsonBody(request)
        send(202, refresher.start(input.sizes))
      } else if (request.method === 'POST' && url.pathname === '/api/owner/refresh/cancel') {
        await readJsonBody(request)
        send(200, refresher.cancel())
      } else { send(404, { error: 'Owner endpoint not found' }) }
    } catch (error) {
      if (!error.status) console.error(error)
      send(error.status || 500, { error: error.status ? error.message : 'Could not complete the request. Your saved data is unchanged.' })
    }
    return true
  }
}
