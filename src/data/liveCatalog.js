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
  return loadLive('/api/catalog', signal, rows => rows)
}

/**
 * The catalog for one size, asked for after the customer has chosen it.
 *
 * After the supplier import the whole catalog is about 170 KB compressed, and
 * the flow used to download all of it on first paint, before the size step,
 * on a phone at a roadside. Nothing on that screen needs it: the size selector
 * runs on the static fitment ranges. So the flow asks for one size once one
 * is chosen (#154: a few hundred bytes, a millisecond), and composes it into
 * the static catalog exactly as the whole answer was composed -- seeds, then
 * the live rows for that size, then generated coverage for every other size.
 *
 * A server from before #154 ignores `?size=` and answers everything; the
 * rows are filtered to the size here as well, so this works, only bigger,
 * against either.
 */
export async function loadCatalogForSize(size, signal) {
  return loadLive(`/api/catalog?size=${encodeURIComponent(size)}`, signal, rows => rows.filter(tire => tire.size === size))
}

async function loadLive(path, signal, select) {
  try {
    const response = await fetch(path, {
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
    // disposalFee rides along the same way markup rides along the owner
    // screen's summary (#289): one round trip, not two. `null` -- Ken has not
    // set one -- means the wizard does not offer the opt-in at all.
    return { tires: catalogFromLiveRows(select(data.tires)), source: 'live', disposalFee: data.disposalFee ?? null }
  } catch (error) {
    // An abort is the component going away, not a backend failure, and
    // answering it with a catalog nobody will read hides real cancellation.
    if (error?.name === 'AbortError') throw error
    // No live answer means no confirmed price for anything, disposal included.
    return { tires: getAllTires(), source: 'static', disposalFee: null }
  }
}
