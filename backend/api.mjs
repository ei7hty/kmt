import { InputError } from './inventory.mjs'
import { PUBLIC_BODY_LIMIT, clientIp, refuse } from './limits.mjs'

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
export const PUBLIC_API_PATHS = new Set(['/api/catalog', '/api/health'])

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

/**
 * Whether an `/api/` path is one the server has any handler for.
 *
 * Every unmatched `/api/*` path used to answer 401 with the owner sign-in
 * message, because the session gate ran before anything asked whether the
 * path existed: a customer with a typo in a link was told to sign in to a
 * workspace they do not have. The gate is for the owner's area; a path that
 * is neither public nor under it is nobody's, and nobody's is 404. An
 * unknown path under /api/owner/ still reads 401 when signed out, because
 * saying which owner endpoints exist is the owner's business.
 *
 * By path, not by method: a public path asked with a method it does not
 * take (a POST to the health check, a DELETE on a request) is still a real
 * place, and the gate's 401 for it is what the baseline records and what
 * keeps "does this endpoint exist" and "may you call it this way" apart.
 */
export function isKnownApiPath(pathname) {
  return PUBLIC_API_PATHS.has(pathname) ||
    pathname === PUBLIC_REQUEST_PREFIX ||
    pathname.startsWith(PUBLIC_REQUEST_PREFIX + '/') ||
    pathname.startsWith('/api/owner/')
}

/** Whether this request is one of the public calls, by path and by method. */
export function isPublicApiCall(method, pathname) {
  // HEAD is public for the health check alone: uptime tools send it, and it
  // is what the platform's own check would read as. Nothing HEADs a JSON
  // data endpoint, so /api/catalog stays GET-only on purpose.
  if (method === 'HEAD') return pathname === '/api/health'
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
 *
 * Cached for five minutes (#84): the cost of this endpoint was never SQLite's
 * query time -- measured on a table sized for tonight's import, the full
 * catalog is tens of milliseconds -- it is the size of the response, sent
 * uncached on every visit. A price the owner just saved can be up to five
 * minutes stale on someone's screen; the draft it produces is server-computed
 * from the live row at submit time regardless (src/pricing.js never trusts a
 * client-supplied price), so a stale display corrects itself the moment a
 * quote is actually drafted. `?size=<size>` narrows the response to one size,
 * for the customer flow to fetch after a size is chosen rather than the whole
 * catalog on first paint; omitting it answers everything, unchanged, for the
 * audits and anything else that still wants the full list.
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
      const size = url.searchParams.get('size') || ''
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      })
      response.end(JSON.stringify({ tires: inventory.catalog({ size }) }))
    } catch (error) {
      console.error(error)
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Could not load the catalog.' }))
    }
    return true
  }
}

/**
 * May a request with this Host header be served?
 *
 * The rule itself is server.mjs's, but the decision lives here so it can be
 * tested: server.mjs starts listening the moment it is imported, so nothing in
 * the suite can reach a branch written inline there.
 *
 * `/api/health` is exempt. The platform's check reaches this process on the
 * internal network, so its Host header is never the public hostname; refusing
 * it would answer 403 to the one caller whose job is to say whether this
 * machine is well, and monitoring would read a healthy machine as sick. The
 * exemption is safe only because that endpoint discloses nothing but `ok` --
 * anything reachable this way has to stay that boring.
 */
export function isHostAllowed(hostname, pathname, allowedHosts) {
  if (pathname === '/api/health') return true
  if (!allowedHosts.length) return true
  // Hostnames are case-insensitive. Browsers lowercase them, so no customer
  // meets this; a hand-typed curl or a monitor could, and the redirect
  // already compares without case.
  const wanted = (hostname || '').toLowerCase()
  return allowedHosts.some(host => host.toLowerCase() === wanted)
}

/**
 * Is this machine actually serving?
 *
 * Its own handler, for the reason createCatalogApi is, and public for a reason
 * of its own: the platform health check arrives with no cookie, so a route
 * behind the session gate answers 401, the check never passes, and the machine
 * is marked unhealthy for as long as it runs. `/api/health` is in
 * PUBLIC_API_PATHS beside `/api/catalog` and nowhere near `/api/owner`.
 *
 * It asks SQLite one question rather than returning a constant. A process that
 * is listening but cannot read its database is exactly the failure worth
 * restarting for -- a missing volume mount, a file the container cannot open --
 * and a health check that answers 200 through it is worse than none, because it
 * reports healthy while every real request fails. The query reads the schema:
 * cheap enough for a 15-second interval, and it touches the file.
 *
 * It says nothing but `ok`. A health endpoint is unauthenticated by necessity,
 * so it is not the place for a version, a row count, or a path on disk.
 */
export function createHealthApi(inventory) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/api/health') return false
    // Answered here rather than falling through: a POST to this path must not
    // reach another handler, and 405 says which part was wrong. HEAD is what
    // uptime tools send, and it answers the same status with no body: the
    // baseline recorded HEAD as 401 and a monitor reading that sees a healthy
    // machine as refusing.
    const head = request.method === 'HEAD'
    if (request.method !== 'GET' && !head) {
      response.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, HEAD' })
      response.end(JSON.stringify({ ok: false, error: 'Health is a GET.' }))
      return true
    }

    try {
      inventory.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(head ? undefined : JSON.stringify({ ok: true }))
    } catch (error) {
      // Logged, because this is the one endpoint whose failure nobody is
      // watching a screen for.
      console.error('health check failed:', error.message)
      response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(head ? undefined : JSON.stringify({ ok: false }))
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
 *
 * The three POSTs are the only public writes, so they are the ones limited
 * (#63): per address before the body is read, per browser key once it is, and
 * a submission per email address in a day, which is the cap that matters the
 * day the email seam sends. A refusal is a 429 with the wait named, before
 * anything is stored. Reads are not limited: they cost a lookup and disclose
 * nothing without the id or the key. Without a limiter, as in most tests,
 * nothing is counted.
 */
export function createRequestsApi(quotes, { limiter = null, mailer = null } = {}) {
  /** Count one hit; answer 429 and return true if it was over. */
  const over = (response, rule, id, message) => {
    if (!limiter || !id) return false
    const taken = limiter.take(rule, id)
    if (taken.allowed) return false
    refuse(response, taken.retryAfterSeconds, message)
    return true
  }
  const TOO_MANY = 'Too many requests from this connection. Wait a few minutes and try again.'
  const TOO_MANY_KEY = 'Too many requests from this browser. Wait a few minutes and try again.'
  const TOO_MANY_EMAIL = 'That email address has been used for too many requests today. Text me instead.'
  const keyOf = body => (typeof body?.customerKey === 'string' ? body.customerKey.trim().toLowerCase() : '')
  const emailOf = body => (typeof body?.customerEmail === 'string' ? body.customerEmail.trim().toLowerCase() : '')

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/requests')) return false

    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }

    try {
      if (request.method === 'POST' && isPublicApiCall('POST', url.pathname)) {
        if (over(response, 'publicPerIp', clientIp(request), TOO_MANY)) return true
      }

      if (request.method === 'POST' && url.pathname === '/api/requests') {
        const body = await readJsonBody(request, PUBLIC_BODY_LIMIT)
        if (over(response, 'publicPerKey', keyOf(body), TOO_MANY_KEY)) return true
        if (over(response, 'submitPerEmail', emailOf(body), TOO_MANY_EMAIL)) return true
        const submitted = quotes.submit(body)
        send(201, submitted)
        // After the answer, never before it, and never awaited: the customer's
        // acknowledgement and the owner's alert go out on the seam in mail.mjs,
        // and a provider outage is a failed outbox row, not a failed submit.
        if (mailer) {
          mailer.after('request-received', submitted.request.id)
          mailer.after('request-arrived', submitted.request.id)
        }
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
        const body = await readJsonBody(request, PUBLIC_BODY_LIMIT)
        if (over(response, 'publicPerKey', keyOf(body), TOO_MANY_KEY)) return true
        const paid = quotes.pay(decodeURIComponent(payMatch[1]), body?.customerKey)
        send(200, paid)
        if (mailer && paid?.quote?.status === 'paid') mailer.after('payment-recorded', paid.request.id)
        return true
      }

      const cancelMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        const body = await readJsonBody(request, PUBLIC_BODY_LIMIT)
        if (over(response, 'publicPerKey', keyOf(body), TOO_MANY_KEY)) return true
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

export function createApi(inventory, refresher, importer = null, quotes = null, { mailer = null } = {}) {
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
        else {
          const decided = quotes.decide(id, action === 'approve' ? 'sent' : 'rejected', body?.version)
          send(200, decided)
          // The quote itself, itemised, once the owner has sent it (R25).
          if (mailer && decided?.quote?.status === 'sent') mailer.after('quote-sent', decided.request.id)
        }
      } else if (request.method === 'GET' && url.pathname === '/api/owner/outbox') {
        // What was sent, or would have been, about every request: the outbox
        // the owner screen shows (R25). Session-gated like everything here.
        if (!mailer) throw new InputError('Owner endpoint not found', 404)
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
        send(200, { provider: mailer.adapter.name, interim: Boolean(mailer.config?.interim), messages: mailer.outbox.list({ limit }) })
      } else if (request.method === 'GET' && url.pathname === '/api/owner/inventory') {
        send(200, { ...inventory.list(Object.fromEntries(url.searchParams)), summary: inventory.summary() })
      } else if (request.method === 'PUT' && url.pathname.startsWith('/api/owner/offers/by-brand/')) {
        // Checked before the single-offer route below: that one treats
        // everything after 'offers/' as one id, and 'by-brand/hankook' would
        // otherwise be read as a (nonexistent) supplier id named that.
        const brand = decodeURIComponent(url.pathname.slice('/api/owner/offers/by-brand/'.length))
        const { enabled } = await readJsonBody(request)
        send(200, inventory.setBrandEnabled(brand, enabled))
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
