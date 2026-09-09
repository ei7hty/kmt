import { IMAGE_PUBLIC_PATH, IMAGE_DIGEST } from './image-manifest.mjs'
import { readJsonBody } from './api.mjs'

export function createImageApi(images, auth) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), pathname = url.pathname
    const publicImage = IMAGE_PUBLIC_PATH.test(pathname)
    const ownerPath = '/api/owner/images'
    if (!publicImage && pathname !== ownerPath && !pathname.startsWith(ownerPath + '/')) return false
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    try {
      if (publicImage) {
        if (!['GET', 'HEAD'].includes(request.method) || url.search) { send(404, { error: 'Image unavailable' }); return true }
        const { metadata, bytes } = images.readPublic(pathname)
        // No browser/CDN retention: revocation must be checked on every fetch.
        response.writeHead(200, { 'Content-Type': metadata.contentType, 'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" })
        response.end(request.method === 'HEAD' ? undefined : bytes)
        return true
      }
      // Also enforce authentication here: mounting this handler incorrectly
      // cannot accidentally make owner provenance or approval public.
      if (!auth?.isAuthenticated(request)) { send(401, { error: 'Sign in to review images' }); return true }
      const tail = pathname.slice(ownerPath.length + 1)
      if (request.method === 'GET') {
        if (pathname === ownerPath) send(200, { packets: images.list() })
        else if (IMAGE_DIGEST.test(tail)) send(200, images.review(tail))
        else send(404, { error: 'Image packet unavailable' })
      } else if (request.method === 'POST' && IMAGE_DIGEST.test(tail)) {
        const scheme = (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (request.socket.encrypted ? 'https' : 'http')
        if (request.headers.origin !== `${scheme}://${request.headers.host}` ||
            request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {
          send(403, { error: 'Same-origin owner action required' }); return true
        }
        const input = await readJsonBody(request)
        if (Object.keys(input).sort().join(',') !== 'action,expectedVersion') { send(400, { error: 'Invalid image decision' }); return true }
        send(200, images.decide(tail, input, auth.actorFor(request)))
      } else send(404, { error: 'Image endpoint unavailable' })
    } catch (error) {
      send(publicImage ? 404 : error.status ?? 409, { error: publicImage ? 'Image unavailable' : 'Image packet unavailable, stale or invalid' })
    }
    return true
  }
}
