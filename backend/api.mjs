import { InputError } from './inventory.mjs'

async function body(request) {
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
      const origin = request.headers.origin
      if (origin && origin !== `http://${request.headers.host}`) throw new InputError('Cross-origin access refused', 403)
      if (request.method === 'GET' && url.pathname === '/api/owner/inventory') {
        send(200, { ...inventory.list(Object.fromEntries(url.searchParams)), summary: inventory.summary() })
      } else if (request.method === 'PUT' && url.pathname.startsWith('/api/owner/offers/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/owner/offers/'.length))
        send(200, inventory.saveOffer(id, await body(request)))
      } else if (request.method === 'POST' && url.pathname === '/api/owner/refresh') {
        const input = await body(request)
        send(202, refresher.start(input.sizes))
      } else if (request.method === 'POST' && url.pathname === '/api/owner/refresh/cancel') {
        await body(request)
        send(200, refresher.cancel())
      } else { send(404, { error: 'Owner endpoint not found' }) }
    } catch (error) {
      if (!error.status) console.error(error)
      send(error.status || 500, { error: error.status ? error.message : 'Could not complete the request. Your saved data is unchanged.' })
    }
    return true
  }
}
