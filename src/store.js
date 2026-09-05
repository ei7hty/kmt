/**
 * Requests and quotes, over the backend that owns them.
 *
 * This was a localStorage store. It meant a request no owner could see and a
 * quote no other device could read, which is the thing phase 4 exists to fix.
 * The call sites barely change: the same names do the same jobs, they are just
 * asynchronous now and the answers come from the server.
 *
 * Only one thing is still kept in the browser, and it is the one thing that has
 * to be: the key that says which requests are this device's.
 *
 * Failure detection is the catalog loader's -- content-type before parse,
 * non-2xx is a failure -- but recovery deliberately is not. A stale catalog is
 * still useful, so that falls back. A quote drafted locally is one no owner
 * will ever see, and the customer waits for a reply that cannot come, so a
 * failed submit fails visibly (R21).
 */

const KEY_NAME = 'kmt_customer_key'
const LEGACY_STORE_KEY = 'kmt_store'

/** Thrown on a 401 so the owner screen can show sign-in instead of an error. */
export class NeedsSignIn extends Error {}

/**
 * This browser's key, made once and kept.
 *
 * randomUUID with the dashes taken out: the server wants hex, and a UUID is
 * hex with punctuation. 128 bits either way.
 */
export function customerKey() {
  try {
    // The old store held requests and quotes the backend now owns. Left behind,
    // it is dead weight that looks like state to the next reader.
    localStorage.removeItem(LEGACY_STORE_KEY)

    const existing = localStorage.getItem(KEY_NAME)
    if (existing) return existing
    const created = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(KEY_NAME, created)
    return created
  } catch {
    // A browser with storage blocked still gets to submit; it just will not
    // recognise its own requests on the next visit.
    return crypto.randomUUID().replace(/-/g, '')
  }
}

async function call(path, options = {}) {
  let response
  try {
    response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
  } catch {
    throw new Error('We could not reach the shop. Check your connection and try again.')
  }

  // A server that does not know the route answers 200 with index.html, and
  // parsing that as JSON is a confusing crash where a clear message belongs.
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) {
    throw new Error('We could not reach the shop. Please try again in a moment.')
  }

  const data = await response.json()
  if (response.status === 401) throw new NeedsSignIn(data?.error || 'Sign in to continue.')

  // A 4xx is about what was sent -- "vehicleInfo is required", "that tire is
  // not one we currently offer" -- and the customer can act on it, so it is
  // shown as written. A 5xx is about us, and "Backend unreachable" is our
  // vocabulary, not theirs.
  if (response.status >= 500) {
    throw new Error('Something went wrong at the shop. Please try again in a moment.')
  }
  if (!response.ok) throw new Error(data?.error || 'That did not go through. Please try again.')
  return data
}

/* ------------------------------------------------------------- customer */

/** Submit a request. The server drafts the quote, so nothing is priced here. */
export async function submitRequest(request) {
  return call('/api/requests', {
    method: 'POST',
    body: JSON.stringify({ ...request, customerKey: customerKey() }),
  })
}

/** Everything this device has asked for, newest first. */
export async function myRequests() {
  const data = await call(`/api/requests?customer=${encodeURIComponent(customerKey())}`)
  return data.requests ?? []
}

/** One request by id, which is what a shared link carries. */
export async function requestById(id) {
  return call(`/api/requests/${encodeURIComponent(id)}`)
}

/** Pay an approved quote. Still the fake step, recorded by the server. */
export async function payRequest(id) {
  return call(`/api/requests/${encodeURIComponent(id)}/pay`, {
    method: 'POST',
    body: JSON.stringify({ customerKey: customerKey() }),
  })
}

/* ---------------------------------------------------------------- owner */

/** Every request with its quote, for the owner's review screen. */
export async function ownerRequests() {
  const data = await call('/api/owner/requests')
  return data.requests ?? []
}

/**
 * Approve or reject a draft.
 *
 * The version goes with it: two owner windows, and the second decision would
 * otherwise quietly undo the first. A 409 comes back as a message telling the
 * owner to reload, which is what the version is for.
 */
export async function decideQuote(requestId, decision, version) {
  const action = decision === 'approved' ? 'approve' : 'reject'
  return call(`/api/owner/quotes/${encodeURIComponent(requestId)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  })
}
