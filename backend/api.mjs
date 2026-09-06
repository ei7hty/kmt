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

/**
 * A scraped snapshot is about 500 bytes per tire, so this is room for some
 * sixteen thousand -- every page of every supported size, several times over.
 */
const SNAPSHOT_BODY_LIMIT = 8 * 1024 * 1024

/** The owner's four actions on one quote, as one pattern the route reads twice. */
const QUOTE_ACTION = /^\/api\/owner\/quotes\/([^/]+)\/(approve|reject|done|cancel)$/

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

/**
 * Public request paths, which a customer reaches without signing in.
 *
 * A prefix rather than a list of ids, because a request path carries one. Still
 * closed by method: GET for reading a request, and POST only for the three
 * calls a customer makes -- submitting, paying an approved quote, and calling
 * their own request off before they have paid for it. Everything else under the
 * prefix, including anything added later, stays behind the session.
 *
 * Each POST is written out rather than matched by a wildcard. That is the point
 * of the list: adding a route under this prefix should not make it public, and
 * `cancel` is public only because this line says so.
 */
const PUBLIC_REQUEST_PREFIX = '/api/requests'
const PUBLIC_POST_PATHS = [
  /^\/api\/requests$/,
  /^\/api\/requests\/[^/]+\/pay$/,
  /^\/api\/requests\/[^/]+\/cancel$/,
]

/** The action suffixes a GET must not answer, whatever else the prefix allows. */
const REQUEST_ACTIONS = ['/pay', '/cancel']

/** Whether this request is one of the public calls, by path and by method. */
export function isPublicApiCall(method, pathname) {
  if (method === 'GET') {
    return PUBLIC_API_PATHS.has(pathname) ||
      pathname === PUBLIC_REQUEST_PREFIX ||
      (pathname.startsWith(PUBLIC_REQUEST_PREFIX + '/') &&
        !REQUEST_ACTIONS.some(action => pathname.endsWith(action)))
  }
  if (method === 'POST') return PUBLIC_POST_PATHS.some(pattern => pattern.test(pathname))
  return false
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
    // Its own path, not "any public path". isPublicApiCall answers a different
    // question -- may this be reached without a session -- and using it here
    // made this handler answer every route later added to that list: a POST to
    // /api/requests came back as the catalog.
    if (request.method !== 'GET' || url.pathname !== '/api/catalog') return false

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

/**
 * The customer's own requests and quotes.
 *
 * Its own handler, for the reason createCatalogApi is: createApi serves a
 * signed-in owner, with CORS for the import page and a same-origin check on
 * everything else, and a public route hanging off it would inherit every future
 * change to those rules.
 *
 * Nothing here lists anything without a customer key or a request id. A key
 * that does not match is answered exactly as a request that does not exist,
 * because "not yours" tells the asker the request is real.
 */
export function createRequestsApi(quotes) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/requests')) return false

    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }

    try {
      if (request.method === 'POST' && url.pathname === '/api/requests') {
        send(201, quotes.submit(await readJsonBody(request)))
        return true
      }

      if (request.method === 'GET' && url.pathname === '/api/requests') {
        const customer = url.searchParams.get('customer')
        if (!customer) throw new InputError('Pass the customer key this browser was given.')
        send(200, { requests: quotes.listForCustomer(customer) })
        return true
      }

      const payMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/pay$/)
      if (request.method === 'POST' && payMatch) {
        const body = await readJsonBody(request)
        send(200, quotes.pay(decodeURIComponent(payMatch[1]), body?.customerKey))
        return true
      }

      const cancelMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        const body = await readJsonBody(request)
        send(200, quotes.cancelByCustomer(decodeURIComponent(cancelMatch[1]), body?.customerKey, body?.reason))
        return true
      }

      const oneMatch = url.pathname.match(/^\/api\/requests\/([^/]+)$/)
      if (request.method === 'GET' && oneMatch) {
        const found = quotes.get(decodeURIComponent(oneMatch[1]))
        if (!found) throw new InputError('No such request.', 404)
        send(200, found)
        return true
      }

      throw new InputError('No such request endpoint.', 404)
    } catch (error) {
      if (!error.status) console.error(error)
      send(error.status || 500, {
        error: error.status ? error.message : 'Could not complete the request. Nothing was changed.',
      })
      return true
    }
  }
}

export function createApi(inventory, refresher, importer = null, quotes = null) {
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
      // The owner's side of the requests customers submit. Inside createApi
      // rather than beside it, because these are exactly what that handler is
      // for: routes that require the owner session.
      if (request.method === 'GET' && url.pathname === '/api/owner/requests') {
        if (!quotes) throw new InputError('Owner endpoint not found', 404)
        send(200, quotes.viewForOwner(url.searchParams.get('view')))
      } else if (request.method === 'POST' && QUOTE_ACTION.test(url.pathname)) {
        if (!quotes) throw new InputError('Owner endpoint not found', 404)
        const [, raw, action] = url.pathname.match(QUOTE_ACTION)
        const id = decodeURIComponent(raw)
        const body = await readJsonBody(request)
        // One route per act, dispatched here rather than inside the store: the
        // store's methods say what each transition is allowed to do, and this
        // line only says which one the owner asked for.
        if (action === 'done') send(200, quotes.finish(id, body?.version))
        else if (action === 'cancel') send(200, quotes.cancel(id, body?.version, body?.reason))
        else send(200, quotes.decide(id, action === 'approve' ? 'sent' : 'rejected', body?.version))
      } else if (request.method === 'GET' && url.pathname === '/api/owner/inventory') {
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
      } else if (request.method === 'POST' && url.pathname === '/api/owner/import-snapshot') {
        // A snapshot scraped elsewhere, pushed in by scripts/import-tires.mjs.
        // Behind the session like every other write here; a CLI signs in with
        // the owner password and sends the cookie. Refused mid-refresh, because
        // both write the same sizes and the job status can only tell one story.
        const input = await readJsonBody(request, SNAPSHOT_BODY_LIMIT)
        if (refresher.active) throw new InputError('A supplier refresh is running. Wait for it to finish before importing.', 409)
        send(200, inventory.applySnapshot(input.snapshot, { complete: input.complete === true, dryRun: input.dryRun === true }))
      } else { send(404, { error: 'Owner endpoint not found' }) }
    } catch (error) {
      if (!error.status) console.error(error)
      send(error.status || 500, { error: error.status ? error.message : 'Could not complete the request. Your saved data is unchanged.' })
    }
    return true
  }
}
