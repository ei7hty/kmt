import { getAllTires } from './catalog.js'

/**
 * The catalog for one size, asked for after the customer has chosen it.
 *
 * ONE SIZE IS THE ONLY WAY THIS MODULE FETCHES. There was a `loadCatalog()`
 * beside it that asked for the whole catalogue, kept as the pre-#154 shape --
 * and it had no caller anywhere in `src`, and had not had one since #154 moved
 * the flow to per-size. It is deleted rather than kept for symmetry: while it
 * existed, the one thing standing between a customer's phone and 2.5MB of
 * JSON was that nobody happened to import it. Measured live 2026-09-13, the
 * whole catalogue is 6,103 rows and ~325,000 bytes over the wire; one size is
 * 23,319 bytes in 0.17s.
 *
 * The unsized route no longer answers at all: it refuses unless a caller asks
 * with `?all=1`, which the handful of audits that read every row now do. This
 * comment said the route "stays" because at the time it did; the cap landed
 * one change later and made the sentence false.
 *
 * After the supplier import the whole catalog is about 170 KB compressed, and
 * the flow used to download all of it on first paint, before the size step,
 * on a phone at a roadside. Nothing on that screen needs it: the size selector
 * runs on the static fitment ranges. So the flow asks for one size once one
 * is chosen (#154: a few hundred bytes, a millisecond), and composes it into
 * the live rows for that size. A successful server answer is authoritative:
 * built-in demo rows have no supplier cost and cannot be priced by the owner.
 *
 * A server from before #154 ignores `?size=` and answers everything; the
 * rows are filtered to the size here as well, so this works, only bigger,
 * against either.
 *
 * IT NEVER REJECTS FOR A BACKEND PROBLEM. The public site is deployed without
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

    // A successful live answer is substituted, not composed. Static seed and
    // generated rows have fixed display prices but no supplier cost, so adding
    // them here would let a customer select a tire the server cannot apply
    // owner markup or internal shipping to. They remain the failure fallback
    // below, useful for an offline/demo screen but never accepted by Quotes.
    // disposalFee rides along the same way markup rides along the owner
    // screen's summary (#289): one round trip, not two. `null` -- Ken has not
    // set one -- means the wizard does not offer the opt-in at all.
    return { tires: select(data.tires), source: 'live', disposalFee: data.disposalFee ?? null }
  } catch (error) {
    // An abort is the component going away, not a backend failure, and
    // answering it with a catalog nobody will read hides real cancellation.
    if (error?.name === 'AbortError') throw error
    // No live answer means no confirmed price for anything, disposal included.
    return { tires: getAllTires(), source: 'static', disposalFee: null }
  }
}
