/**
 * The "Send to KMT" bookmarklet, as readable source.
 *
 * This is not imported by the app. It is the source of truth for the one-liner
 * the owner drags to his bookmarks bar; `buildBookmarklet` in OwnerInventory
 * holds the minified equivalent, and this file is here so the next person has
 * something to read and edit rather than a wall of semicolons.
 *
 * It runs on a giga-tires listing page, where fetching further pages of that
 * listing is same-origin and therefore allowed. That is the entire reason this
 * approach exists: the same fetch from kmt.fly.dev comes back as an empty 202,
 * and the server's own IP may be refused by the supplier's WAF. The owner's
 * browser is the one place with both permission and a residential address.
 *
 * It sends HTML, not parsed rows. Parsing lives on the server so there is one
 * implementation of the part most likely to break when the supplier changes
 * their markup.
 */

export async function sendToKmt({ base, token, notify = console.log }) {
  const match = location.pathname.match(/\/tires\/(?:.*\/)?(\d{3})-(\d{2})-(\d{2})(?:$|[/?])/)
  if (!match) {
    notify('Open a tire size listing on giga-tires.com first, for example /tires/215-60-16.')
    return
  }
  const size = `${match[1]}/${match[2]}R${match[3]}`
  const sizePath = `${match[1]}-${match[2]}-${match[3]}`
  const sessionId = `imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

  const post = async (page, totalPages, html) => {
    const response = await fetch(`${base}/api/owner/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, size, page, totalPages, html }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `Import failed (${response.status})`)
    return data
  }

  // Page one is the document already on screen: it is what the owner looked at,
  // and re-fetching it would be a second request for something already here.
  const firstHtml = document.documentElement.outerHTML
  const pageLinks = [...firstHtml.matchAll(/[?&]page=(\d+)/g)].map(m => Number(m[1]))
  const totalPages = pageLinks.length ? Math.max(...pageLinks) : 1

  notify(`Sending ${size}: ${totalPages} page${totalPages === 1 ? '' : 's'}…`)
  let result = await post(1, totalPages, firstHtml)

  for (let page = 2; page <= totalPages; page++) {
    // The same pause the server-side refresher uses. Being on the owner's
    // connection is not a licence to hammer them.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const response = await fetch(`/tires/${sizePath}?page=${page}`, { credentials: 'include' })
    if (!response.ok) throw new Error(`Supplier returned ${response.status} for page ${page}`)
    result = await post(page, totalPages, await response.text())
    notify(result.message)
  }

  notify(result.message)
  return result
}
