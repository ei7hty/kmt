import { catalogFromLiveRows, getAllTires } from './catalog'

/**
 * The catalog the customer is quoted from, live where possible.
 *
 * The owner curates inventory and sets prices at /owner, and until now none of
 * that reached a customer: the flow priced everything from the static catalog
 * built at import time. This asks the backend first.
 *
 * It never rejects for a backend problem. The public site is deployed without
 * one reachable, and a customer who cannot get a quote because a server they
 * have never heard of is down is worse off than one quoted from the demo
 * catalog. So any failure is a fallback, not an error: no network, a non-2xx
 * answer, a body that is not JSON, or a shape that is not what this asked for.
 *
 * The JSON check is the one that earns its place. A dev server that does not
 * know the route answers 200 with index.html, and parsing that as JSON is a
 * confusing crash where a clean fallback belongs -- which is exactly why the
 * owner screen's api() helper checks content-type before it parses. Same
 * detection here, on purpose.
 */
export async function loadCatalog(signal) {
  try {
    const response = await fetch('/api/catalog', {
      ...(signal ? { signal } : {}),
      headers: { Accept: 'application/json' },
    })

    const type = response.headers.get('content-type') || ''
    if (!type.includes('application/json')) throw new Error('The catalog service answered with something other than JSON.')

    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || 'The catalog service refused the request.')
    if (!Array.isArray(data?.tires)) throw new Error('The catalog service answered in an unexpected shape.')

    // Composed, not substituted: the endpoint answers with what the owner
    // curated, which is a part of the catalog rather than all of it.
    return { tires: catalogFromLiveRows(data.tires), source: 'live' }
  } catch (error) {
    // An abort is the component going away, not a backend failure, and
    // answering it with a catalog nobody will read hides real cancellation.
    if (error?.name === 'AbortError') throw error
    return { tires: getAllTires(), source: 'static' }
  }
}
