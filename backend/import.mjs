/**
 * Supplier pages posted back from the owner's own browser.
 *
 * Why this exists: the server cannot reliably fetch giga-tires from a
 * datacenter, and a page on kmt.fly.dev cannot fetch it either -- cross-origin
 * requests come back as an empty 202 with no Access-Control-Allow-Origin, which
 * is the same-origin policy doing its job. The one place the fetch is allowed
 * is a giga-tires page itself, where it is same-origin. So a bookmarklet runs
 * there, walks the pages of a size, and posts each one's HTML here.
 *
 * The parsing stays on this side. It would be smaller to extract rows in the
 * browser and post JSON, but that means two implementations of the thing most
 * likely to break when the supplier changes their markup. One parser.
 *
 * Pages accumulate in memory and only reach the database when a size is
 * complete, which is the same rule the server-side refresher follows: a
 * half-read size must never replace a whole one.
 */

import { parseListingPage } from '../scripts/giga-tires.mjs'
import { InputError } from './inventory.mjs'

/** A partial import is worthless if it is stale; drop it rather than resume it. */
const SESSION_TTL_MS = 15 * 60_000
const MAX_PAGES = 60
const MAX_SESSIONS = 8

export class PageImporter {
  constructor(inventory, { now = () => Date.now() } = {}) {
    this.inventory = inventory
    this.now = now
    this.sessions = new Map()
  }

  /** Drop anything older than the TTL so a forgotten import cannot leak memory. */
  prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() - session.touched > SESSION_TTL_MS) this.sessions.delete(id)
    }
  }

  /**
   * Accept one page.
   *
   * Returns progress while a size is incomplete, and applies it once every page
   * has arrived. Pages may arrive in any order; what matters is that the set is
   * complete and internally consistent.
   */
  addPage({ sessionId, size, page, totalPages, html }) {
    this.prune()

    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
      throw new InputError('Invalid import session')
    }
    if (!this.inventory.sizes.includes(size)) {
      throw new InputError(`${size} is not a size KMT supports`)
    }
    if (!Number.isInteger(page) || !Number.isInteger(totalPages) ||
        page < 1 || totalPages < 1 || totalPages > MAX_PAGES || page > totalPages) {
      throw new InputError('Invalid page numbering')
    }
    if (typeof html !== 'string' || !html.length) throw new InputError('Empty page')

    const parsed = parseListingPage(html, size)
    if (!parsed.rows.length) {
      // Most often this is the WAF challenge page rather than a listing: it is
      // a real response, just not one with tires in it.
      throw new InputError(`No tires found on ${size} page ${page}. Is that a supplier listing page?`)
    }
    if (parsed.skipped.length) {
      throw new InputError(`${parsed.skipped.length} tire(s) on page ${page} had no price; previous inventory kept`)
    }

    let session = this.sessions.get(sessionId)
    if (session && session.size !== size) throw new InputError('This import is already collecting another size')
    if (!session) {
      if (this.sessions.size >= MAX_SESSIONS) throw new InputError('Too many imports in progress')
      session = { size, totalPages, pages: new Map(), touched: this.now() }
      this.sessions.set(sessionId, session)
    }
    if (session.totalPages !== totalPages) {
      // The listing changed underneath the import. Applying a mix of both is
      // how a size ends up with tires that were never on one page together.
      this.sessions.delete(sessionId)
      throw new InputError('The supplier listing changed while importing. Start the import again.')
    }

    session.touched = this.now()
    session.pages.set(page, parsed.rows)

    const received = session.pages.size
    if (received < totalPages) {
      return { size, received, totalPages, complete: false,
        message: `Received ${received} of ${totalPages} pages for ${size}.` }
    }

    const rows = new Map()
    for (let n = 1; n <= totalPages; n++) {
      for (const row of session.pages.get(n) || []) rows.set(row.id, row)
    }
    this.sessions.delete(sessionId)

    // refreshSize validates every row and writes the size in one transaction,
    // exactly as a server-side refresh does. Same door, different courier.
    this.inventory.refreshSize(size, [...rows.values()])
    this.inventory.setMeta('job', {
      id: sessionId, status: 'completed', sizes: [size], completed: 1, failed: [],
      tiresRead: rows.size, pagesRead: totalPages, currentSize: null,
      startedAt: new Date(this.now()).toISOString(), finishedAt: new Date(this.now()).toISOString(),
      message: `Imported ${rows.size} tires for ${size} from your browser.`,
    })

    return { size, received, totalPages, complete: true, tires: rows.size,
      message: `Imported ${rows.size} tires for ${size}.` }
  }
}
