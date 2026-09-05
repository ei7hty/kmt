import { InputError } from './inventory.mjs'

/**
 * Exported as `readJsonBody` so the auth routes parse request bodies the same
 * way the API does -- same content-type rule, same 32KB ceiling, same errors.
 */
export async function readJsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new InputError('Expected JSON', 415)
  let data = ''
  for await (const chunk of request) {
    data += chunk
    if (Buffer.byteLength(data) > 32768) throw new InputError('Request is too large', 413)
  }
  try { const parsed = JSON.parse(data); if (!parsed || typeof parsed !== 'object') throw new Error(); return parsed }
  catch { throw new InputError('Invalid JSON') }
}

export function createApi(inventory, refresher) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/owner/')) return false
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    try {
      // Same-origin only. The scheme has to come from the request rather than
      // being assumed http: behind TLS the browser sends `https://host` and a
      // hardcoded `http://host` rejects every save the owner makes.
      const origin = request.headers.origin
      const scheme = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
        (request.socket.encrypted ? 'https' : 'http')
      if (origin && origin !== `${scheme}://${request.headers.host}`) {
        throw new InputError('Cross-origin access refused', 403)
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
