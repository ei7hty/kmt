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
    throw new Error("Couldn't reach the shop. Check your connection and try again.")
  }

  // A server that does not know the route answers 200 with index.html, and
  // parsing that as JSON is a confusing crash where a clear message belongs.
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) {
    throw new Error("The shop's site isn't answering right now. Please try again in a moment.")
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

/** A non-tire service message is deliberately separate from a quote request. */
export async function submitInquiry(inquiry) {
  return call('/api/inquiries', { method: 'POST', body: JSON.stringify(inquiry) })
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

/**
 * Call off a request from the customer's side, before it is paid for.
 *
 * A reason is optional: a customer who has changed their mind does not owe
 * anyone an explanation. `customerKey` is sent but no longer authorises this
 * (#284/#316): the server accepts the id alone, the same as reading it. The
 * field survives here only as the rate-limit bucket `publicPerIp`'s sibling
 * check reads (backend/api.mjs) -- a hint for throttling, not a credential.
 */
export async function cancelRequest(id, reason) {
  return call(`/api/requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(reason ? { customerKey: customerKey(), reason } : { customerKey: customerKey() }),
  })
}

/**
 * Pay an approved quote. Still the fake step, recorded by the server.
 *
 * `customerKey` is sent but no longer authorises this (#284/#316) -- see
 * `cancelRequest` above.
 */
export async function payRequest(id) {
  return call(`/api/requests/${encodeURIComponent(id)}/pay`, {
    method: 'POST',
    body: JSON.stringify({ customerKey: customerKey() }),
  })
}

/* ---------------------------------------------------------------- owner */

/**
 * One view of the owner's list, with the size of every view.
 *
 * The counts come back for all of them, not just the one asked for, so the
 * filters can carry their own numbers without the screen fetching five lists.
 */
export async function ownerRequests(view) {
  const query = view ? `?view=${encodeURIComponent(view)}` : ''
  const data = await call(`/api/owner/requests${query}`)
  return { view: data.view ?? 'open', counts: data.counts ?? {}, requests: data.requests ?? [] }
}

/**
 * Act on one quote as the owner: send it, reject it, close it, call it off.
 *
 * One function because every one of these is the same request with the same
 * version: two owner windows, and the second action would otherwise quietly
 * undo the first. A 409 comes back as a message telling the owner to reload,
 * which is what the version is for. What each action is allowed to do is the
 * server's rule, not this file's.
 */
export async function actOnQuote(requestId, action, version, reason) {
  return call(`/api/owner/quotes/${encodeURIComponent(requestId)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(reason ? { version, reason } : { version }),
  })
}

/** Every message the app has tried to send, or would have, newest first. */
export async function ownerOutbox() {
  const data = await call('/api/owner/outbox')
  return { provider: data.provider ?? 'none', messages: data.messages ?? [] }
}

/** Save editable draft lines and the customer-facing note before sending. */
export async function adjustQuote(requestId, lineItems, note, version) {
  return call(`/api/owner/quotes/${encodeURIComponent(requestId)}`, {
    method: 'PUT',
    body: JSON.stringify({ lineItems, note, version }),
  })
}

