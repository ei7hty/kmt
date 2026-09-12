/**
 * The inventory matrix, with no React in it.
 *
 * Everything the grid *decides* lives here: which way a header arrow points,
 * whether the empty state may be shown, what a bulk response did to which
 * rows, and whether an action needs confirming before a request is sent. The
 * component in `OwnerInventoryGrid.jsx` renders this and nothing more.
 *
 * It is split out because none of those decisions can be tested through the
 * component: there is no JSX runner, no jsdom and no testing-library in this
 * repository, and adding three dependencies to assert an arrow direction is a
 * worse trade than keeping the decisions in a file `node --test` can import.
 * `inventory-grid.test.mjs` drives `createInventoryGrid` against a stub of
 * `api()` that implements the stage-1 contract strictly, so the tests exercise
 * request shape and response handling, not just pure helpers.
 *
 * THE CONTRACT THIS IS BUILT AGAINST (stage 1, `backend/inventory.mjs`):
 *
 *   GET  /api/owner/inventory?search=&size=&filter=&page=&sort=&dir=&pageSize=
 *        -> { items[], total, page, pageSize, summary, sort, dir }
 *   PUT  /api/owner/offers   { offers: [{id, priceCents, shippingCents,
 *                                        enabled, notes, version}] }, max 200
 *        -> { results: [{id, ok:true, version} |
 *                       {id, ok:false, reason, message}] } in request order
 *   PUT  /api/owner/offers/:id  (unchanged, single row)
 *
 * The server ECHOES the sort and dir it actually applied, because an unknown
 * sort key falls back to the default order without erroring. Every arrow in
 * this file is derived from the echo, never from what was requested: a header
 * that claims a sort the server ignored is a UI that lies.
 */

/** What the server's pageSize allow-list accepts. Anything else is refused. */
export const PAGE_SIZES = [24, 50, 100, 200]

/** The bulk endpoint's cap. Selection is per page, so a full page fits. */
export const BULK_LIMIT = 200

/**
 * The columns, left to right, and which of them the server can order by.
 *
 * `updated` is in the contract's sort allow-list but was not in the column
 * list, and a sort key with no header is a sort the owner cannot reach — so
 * it gets a column of its own at the right-hand end.
 */
export const GRID_COLUMNS = [
  { key: 'select', label: '', sort: null },
  // Not sortable, deliberately. `photo` is derived per row -- part SQL, part a
  // revision hash computed in JS -- so there is no single column the server
  // could ORDER BY. A header that sorts nothing while looking sortable is the
  // screen lying about what it did; the two photo FILTERS do this job honestly.
  { key: 'photo', label: 'Photo', sort: null },
  { key: 'size', label: 'Size', sort: 'size' },
  { key: 'name', label: 'Tire', sort: 'name' },
  { key: 'supplierCost', label: 'Supplier cost', sort: 'supplierPrice', numeric: true },
  { key: 'price', label: 'Your price', sort: 'price', numeric: true },
  { key: 'margin', label: 'Margin', sort: 'margin', numeric: true },
  { key: 'shipping', label: 'Shipping', sort: null, numeric: true },
  { key: 'enabled', label: 'Offered', sort: 'enabled' },
  { key: 'notes', label: 'Notes', sort: null },
  { key: 'sku', label: 'SKU', sort: null },
  { key: 'updated', label: 'Updated', sort: 'updated' },
]

export const dollars = cents => cents == null || Number.isNaN(cents)
  ? '—'
  : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/** A money field as typed, in cents. '' is "not set"; anything malformed is NaN. */
export function parseMoney(text) {
  const value = String(text ?? '').trim()
  if (value === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return NaN
  return Math.round(Number(value) * 100)
}

export const moneyField = cents => cents == null ? '' : (cents / 100).toFixed(2)

/**
 * Which way this column's arrow points, read from what the SERVER said it did.
 *
 * `echoed` is the `{sort, dir}` off the last successful response. A column the
 * server is not ordering by gets no arrow at all, including the column that was
 * just clicked — if the server ignored the request, the header must not claim it.
 */
export function headerSortState(echoed, columnSortKey) {
  if (!columnSortKey || !echoed || echoed.sort !== columnSortKey) return null
  return echoed.dir === 'desc' ? 'desc' : 'asc'
}

export const sortArrow = state => state === 'asc' ? '↑' : state === 'desc' ? '↓' : ''

/**
 * What clicking this header should ask the server for next.
 *
 * Also computed from the echo: clicking a header the server is already sorting
 * ascending asks for descending, and everything else asks for ascending. Were
 * this read from the requested sort instead, a click on a column the server
 * rejected would toggle a direction that was never applied.
 */
export function nextSortRequest(echoed, columnSortKey) {
  const current = headerSortState(echoed, columnSortKey)
  return { sort: columnSortKey, dir: current === 'asc' ? 'desc' : 'asc' }
}

/**
 * May the "nothing here" panel be shown?
 *
 * `!error` is the load-bearing clause. Claiming an empty list when the request
 * failed is a defect that already shipped on the images screen: the owner is
 * told he has no inventory when in fact the server did not answer.
 */
export function showEmptyState({ loading, error, data }) {
  if (error) return false
  if (loading || !data) return false
  return data.items.length === 0
}

/** What a per-row failure reason means, in the owner's words. Distinct per code. */
export function reasonLabel(reason, message) {
  if (reason === 'version-conflict') return 'Changed in another window since this page loaded. Reload before saving this row.'
  if (reason === 'not-found') return 'No longer in the supplier list, so nothing was saved.'
  if (reason === 'invalid') return message ? `Rejected: ${message}` : 'Rejected as invalid, so nothing was saved.'
  // Stage 1 shipped a fourth code the agreed contract did not name: 'failed',
  // for anything that is neither bad input nor a stale version -- a disk
  // error, say. It is not the owner's mistake and there is nothing for him to
  // correct, so it says to try again rather than blaming the row.
  if (reason === 'failed') return message ? `Not saved: ${message} Try again.` : 'Not saved because of a server problem. Try again.'
  return message || 'Not saved.'
}

/**
 * What a version-conflict row says once the grid has re-read it for him.
 *
 * `reasonLabel`'s version-conflict text ends "Reload before saving this row",
 * which is right on the single-row path, where nothing reloads for him. A bulk
 * save now reloads itself, so leaving that text up would be instructing the
 * owner to do the thing that just happened -- and he would go looking for a
 * control to do it with. The mark stays; only the words change.
 */
export const RELOADED_AFTER_CONFLICT =
  'Changed in another window, so this row was re-read and your change was not applied. Check it and save again.'

/**
 * Fold a bulk response back into the rows it came from.
 *
 * Partial success is the normal case, so this never speaks about the batch as a
 * whole: each result lands on its own row. A saved row's `version` is taken from
 * the response, because the next save on that row will be rejected without it.
 */
export function applyBulkResults(items, results, patchOf) {
  const byId = new Map(results.map(result => [result.id, result]))
  const saved = [], failed = []
  const nextItems = items.map(item => {
    const result = byId.get(item.id)
    if (!result) return item
    if (!result.ok) {
      failed.push({ id: item.id, reason: result.reason, message: result.message })
      return item
    }
    saved.push(item.id)
    const patch = patchOf ? patchOf(item) : {}
    return { ...item, offer: { ...item.offer, ...patch, version: result.version } }
  })
  return { items: nextItems, saved, failed }
}

/**
 * The one line above the grid after a bulk write.
 *
 * A batch with any failure is never announced as a success, however many rows
 * did save — the count of what did save is said inside the failure notice
 * instead, so the owner learns both facts from one sentence.
 */
export function bulkNotice({ saved, failed }) {
  if (failed.length) {
    return {
      tone: 'error',
      text: `${failed.length} of ${saved.length + failed.length} row${saved.length + failed.length === 1 ? '' : 's'} did not save. ` +
        `${saved.length} saved. The rows that failed are marked below with why.`,
    }
  }
  return { tone: 'success', text: `${saved.length} row${saved.length === 1 ? '' : 's'} saved.` }
}

/** What one row's supplier cost is, in cents. `price` is the supplier's, in dollars. */
export const supplierCostCents = item => item?.price == null ? null : Math.round(item.price * 100)

/**
 * Supplier cost × multiplier, optionally plus that row's shipping.
 *
 * The shipping added is the row's own override where it has one and the default
 * markup shipping otherwise, which is the same precedence the customer price
 * already uses.
 */
export function priceFromFormula(item, { multiplier, addShipping, defaultShippingCents = 0 }) {
  const cost = supplierCostCents(item)
  if (cost == null || !Number.isFinite(multiplier) || multiplier <= 0) return null
  const shipping = item.offer?.shippingCents ?? defaultShippingCents
  return Math.round(cost * multiplier) + (addShipping ? shipping : 0)
}

/**
 * The before/after the owner is shown before a price write runs.
 *
 * It is a sample plus a count, not the whole list: 200 rows do not fit in a
 * confirmation, and the point is that he sees real numbers from his own data
 * rather than a row count on its own.
 */
export function previewPriceChange(items, formula, sampleSize = 3) {
  const rows = items.map(item => ({
    id: item.id,
    name: item.name,
    size: item.size,
    before: item.offer?.priceCents ?? null,
    after: priceFromFormula(item, formula),
  }))
  return { count: rows.length, sample: rows.slice(0, sampleSize), rows }
}

/** Reduce a selection to ids that are actually on screen. */
export const intersectSelection = (selected, items) => {
  const present = new Set(items.map(item => item.id))
  return selected.filter(id => present.has(id))
}

const EMPTY = Object.freeze({})

/**
 * The grid's whole state and every action on it.
 *
 * A plain store rather than React state so the decisions above are reachable
 * from a test with a stubbed `api`. The component subscribes and renders; it
 * holds no grid state of its own.
 */
export function createInventoryGrid({ api }) {
  let state = {
    query: { search: '', size: '', filter: 'all' },
    sort: 'size', dir: 'asc',
    page: 1, pageSize: 24,
    data: null,
    loading: true,
    error: '',
    needsSignIn: false,
    selected: [],
    drafts: EMPTY,
    rowStatus: EMPTY,
    notice: null,
    pending: null,
    busy: false,
    // Ids whose photo toggle is in flight. Per row rather than one global flag:
    // the owner works down a page turning photos off, and a single `busy` would
    // freeze every other row while one request was out.
    photoBusy: EMPTY,
  }
  const listeners = new Set()
  let sequence = 0

  const getState = () => state
  const set = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn()) }
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }

  /** The sort and dir the SERVER last said it applied. Null until a load lands. */
  const echoed = () => state.data ? { sort: state.data.sort, dir: state.data.dir } : null

  const items = () => state.data?.items ?? []
  const selectedItems = () => items().filter(item => state.selected.includes(item.id))

  function rowValues(item) {
    const draft = state.drafts[item.id]
    if (draft) return draft
    return {
      price: moneyField(item.offer.priceCents),
      shipping: moneyField(item.offer.shippingCents),
      enabled: item.offer.enabled,
      notes: item.offer.notes ?? '',
      baseVersion: item.offer.version,
    }
  }

  const withDraft = (id, patch) => {
    const item = items().find(row => row.id === id)
    if (!item) return
    set({ drafts: { ...state.drafts, [id]: { ...rowValues(item), ...patch } } })
  }

  const clearDraft = id => {
    const drafts = { ...state.drafts }
    delete drafts[id]
    return drafts
  }

  const setRowStatus = (id, status) => {
    const rowStatus = { ...state.rowStatus }
    if (status) rowStatus[id] = status
    else delete rowStatus[id]
    return rowStatus
  }

  /**
   * Load a page.
   *
   * Every load carries an explicit sort, dir and pageSize; the echo comes back
   * on `data` and the headers read it from there. A draft whose row came back
   * at a different version is dropped and the row flagged, because keeping it
   * would let the owner save over a change he never saw.
   */
  async function load() {
    const request = ++sequence
    set({ loading: true })
    try {
      const params = new URLSearchParams({
        search: state.query.search, size: state.query.size, filter: state.query.filter,
        page: String(state.page), sort: state.sort, dir: state.dir, pageSize: String(state.pageSize),
      })
      const result = await api(`inventory?${params}`)
      if (request !== sequence) return
      const drafts = {}
      const rowStatus = { ...state.rowStatus }
      for (const item of result.items) {
        const draft = state.drafts[item.id]
        if (!draft) continue
        if (draft.baseVersion === item.offer.version) drafts[item.id] = draft
        else rowStatus[item.id] = { kind: 'error', text: 'This row changed elsewhere; your unsaved edit was dropped.' }
      }
      set({
        data: result, error: '', needsSignIn: false, loading: false,
        drafts, rowStatus, selected: intersectSelection(state.selected, result.items),
      })
    } catch (err) {
      if (request !== sequence) return
      // A 401 is not an error to report, it is a door to open.
      if (err.status === 401) set({ needsSignIn: true, error: '', loading: false })
      else set({ error: err.message, loading: false })
    }
  }

  /** Anything that changes which rows are on screen drops the selection with it. */
  function reset(patch) {
    set({ ...patch, page: patch.page ?? 1, selected: [], notice: null, pending: null })
    return load()
  }

  return {
    getState, subscribe,
    echoed, rowValues,
    items,
    selectedItems,

    load,
    /** A fresh load that keeps the page and the selection: the reload button, and the job poll. */
    reload: load,

    setQuery(query) {
      const next = { ...state.query, ...query }
      if (next.search === state.query.search && next.size === state.query.size && next.filter === state.query.filter) return
      return reset({ query: next })
    },

    /**
     * Sort at the server, over all rows, not the ones on screen.
     *
     * Selection is dropped, the same as a page change: a server sort replaces
     * every row in the grid, so a selection carried across it would be a
     * selection of rows the owner is no longer looking at.
     */
    sortBy(columnSortKey) {
      if (!columnSortKey) return
      return reset(nextSortRequest(echoed(), columnSortKey))
    },

    goToPage(page) {
      if (page === state.page) return
      return reset({ page })
    },

    setPageSize(pageSize) {
      if (!PAGE_SIZES.includes(pageSize)) return
      return reset({ pageSize })
    },

    /**
     * A summary field saved by one of the tools above the grid (markup, tax,
     * pricing lines). The sequence bump is what the old `invalidate` did: an
     * inventory load already in flight carries the pre-save summary, and must
     * not be allowed to land on top of what was just saved. `loading` is
     * cleared with it, because the discarded load will never clear it itself.
     */
    patchSummary(patch) {
      sequence++
      if (!state.data) { set({ loading: false }); return }
      set({ loading: false, data: { ...state.data, summary: { ...state.data.summary, ...patch } } })
    },

    /** Signing out on a hosted deployment: the gate comes straight back. */
    signedOut() { set({ data: null, needsSignIn: true, drafts: EMPTY, rowStatus: EMPTY, selected: [], notice: null, pending: null }) },

    editRow: withDraft,

    isPhotoBusy: id => Boolean(state.photoBusy[id]),

    /**
     * Turn one product's photo off or on.
     *
     * NOT OPTIMISTIC, deliberately, and this is the one place in the grid where
     * that is the right call. Price edits are optimistic because the owner is
     * typing and needs the field to keep up. A photo toggle changes what a
     * CUSTOMER sees; showing "Off" before the server has agreed would mean the
     * screen and the shop disagree about a live page, and the owner would move
     * on believing something that had not happened.
     *
     * The row is patched from the SERVER's answer, not from what was asked for
     * -- the same rule the rest of this file follows for sort and for saves.
     */
    async setPhotoHidden(id, hidden) {
      if (state.photoBusy[id]) return
      set({ photoBusy: { ...state.photoBusy, [id]: true }, notice: null })
      try {
        const result = await api(`images/product/${encodeURIComponent(id)}`, {
          method: 'POST', body: JSON.stringify({ hidden }),
        })
        const items = state.data?.items?.map(item => item.id === id
          ? { ...item, photo: { ...item.photo, state: result.hidden ? 'hidden' : 'live' } }
          : item)
        const rest = { ...state.photoBusy }; delete rest[id]
        set({ photoBusy: rest, ...(items ? { data: { ...state.data, items } } : {}) })
      } catch (error) {
        const rest = { ...state.photoBusy }; delete rest[id]
        // Named, and the row is left exactly as the server still has it. A
        // toggle that silently does nothing is worse than one that says so.
        set({ photoBusy: rest, notice: { tone: 'error',
          text: error?.status === 404
            ? 'That tire has no photo to switch off. Reload to see its current state.'
            : 'That photo could not be changed. Nothing was altered; try again.' } })
      }
    },

    toggleSelected(id) {
      const selected = state.selected.includes(id)
        ? state.selected.filter(value => value !== id)
        : [...state.selected, id]
      set({ selected })
    },

    selectAllOnPage(on) { set({ selected: on ? items().map(item => item.id) : [] }) },

    clearNotice() { set({ notice: null }) },

    /**
     * Commit one row: Enter, or blur, or the offered checkbox changing.
     *
     * Uses the unchanged single-row endpoint, which returns the new version.
     * The margin is a server-derived figure and the response does not carry a
     * new one, so the cell is marked stale rather than showing a number this
     * screen guessed.
     */
    async commitRow(id) {
      const item = items().find(row => row.id === id)
      if (!item) return
      const draft = state.drafts[id]
      if (!draft) return
      const priceCents = parseMoney(draft.price)
      const shippingCents = parseMoney(draft.shipping)
      if (Number.isNaN(priceCents) || (priceCents !== null && priceCents <= 0)) {
        set({ rowStatus: setRowStatus(id, { kind: 'error', text: 'Enter a price above $0 with up to two decimals, or leave it blank.' }) })
        return
      }
      if (Number.isNaN(shippingCents) || (shippingCents !== null && shippingCents > 20000)) {
        set({ rowStatus: setRowStatus(id, { kind: 'error', text: 'Enter shipping from $0 to $200, or leave it blank for the default.' }) })
        return
      }
      const body = { priceCents, shippingCents, enabled: draft.enabled, notes: draft.notes, version: draft.baseVersion }
      try {
        const offer = await api(`offers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) })
        const enabledDelta = Number(offer.enabled) - Number(item.offer.enabled)
        set({
          drafts: clearDraft(id),
          rowStatus: setRowStatus(id, { kind: 'saved', text: 'Saved. Margin refreshes on the next load.' }),
          data: {
            ...state.data,
            items: state.data.items.map(row => row.id === id ? { ...row, offer: { ...row.offer, ...offer } } : row),
            summary: { ...state.data.summary, offeredCount: (state.data.summary?.offeredCount ?? 0) + enabledDelta },
          },
        })
      } catch (err) {
        // Only a 400 is the owner's input being refused. A 500, or a fetch that
        // never landed (no `status` at all -- `api()` throws the "backend is not
        // connected" error before it reads one), is not: telling him his entry
        // was "Rejected" attributes a server outage to something he typed, and
        // there is nothing on the row for him to correct. That is the exact
        // collapse the fourth reason code exists to prevent, and this is the
        // single-row path where it was not being used.
        const reason = err.status === 409 ? 'version-conflict'
          : err.status === 404 ? 'not-found'
            : err.status === 400 ? 'invalid' : 'failed'
        set({ rowStatus: setRowStatus(id, { kind: 'error', reason, text: reasonLabel(reason, err.message) }) })
      }
    },

    /**
     * Stage a bulk action. NOTHING is sent from here.
     *
     * A price change over up to 200 rows is a destructive write over the
     * owner's livelihood, so it is shown back to him with a count and real
     * before/after numbers off his own rows, and waits. Offered and shipping
     * confirm too, matching the brand-wide toggle above the grid, which has
     * always asked first.
     */
    requestBulk(kind, params = {}) {
      const rows = selectedItems()
      if (!rows.length) return
      if (rows.length > BULK_LIMIT) {
        set({ notice: { tone: 'error', text: `The bulk endpoint takes at most ${BULK_LIMIT} rows at a time.` } })
        return
      }
      if (kind === 'price') {
        const multiplier = Number(params.multiplier)
        if (!Number.isFinite(multiplier) || multiplier <= 0) {
          set({ notice: { tone: 'error', text: 'Enter a multiplier above 0 to price from supplier cost.' } })
          return
        }
        const formula = { multiplier, addShipping: !!params.addShipping, defaultShippingCents: params.defaultShippingCents ?? 0 }
        set({ pending: { kind, formula, preview: previewPriceChange(rows, formula) } })
        return
      }
      if (kind === 'shipping') {
        const shippingCents = parseMoney(params.shipping)
        if (Number.isNaN(shippingCents)) {
          set({ notice: { tone: 'error', text: 'Enter shipping from $0 to $200, or leave it blank to clear the override.' } })
          return
        }
        set({ pending: { kind, shippingCents, count: rows.length } })
        return
      }
      if (kind === 'offered') set({ pending: { kind, enabled: !!params.enabled, count: rows.length } })
    },

    cancelBulk() { set({ pending: null }) },

    /** Run the staged action. The only path that reaches the bulk endpoint. */
    async confirmBulk() {
      const pending = state.pending
      if (!pending) return
      const rows = selectedItems()
      const patchOf = item => {
        if (pending.kind === 'price') return { priceCents: priceFromFormula(item, pending.formula) }
        if (pending.kind === 'shipping') return { shippingCents: pending.shippingCents }
        return { enabled: pending.enabled }
      }
      const offers = rows.map(item => ({
        id: item.id,
        priceCents: item.offer.priceCents,
        shippingCents: item.offer.shippingCents,
        enabled: item.offer.enabled,
        notes: item.offer.notes ?? '',
        version: item.offer.version,
        ...patchOf(item),
      }))
      set({ busy: true, pending: null })
      try {
        const response = await api('offers', { method: 'PUT', body: JSON.stringify({ offers }) })
        const { items: nextItems, saved, failed } = applyBulkResults(state.data.items, response.results, patchOf)
        const rowStatus = { ...state.rowStatus }
        for (const id of saved) rowStatus[id] = { kind: 'saved', text: 'Saved. Margin refreshes on the next load.' }
        for (const failure of failed) rowStatus[failure.id] = { kind: 'error', reason: failure.reason, text: reasonLabel(failure.reason, failure.message) }
        const offeredDelta = nextItems.reduce((sum, row, index) =>
          sum + Number(row.offer.enabled) - Number(state.data.items[index].offer.enabled), 0)
        set({
          busy: false,
          data: {
            ...state.data, items: nextItems,
            summary: { ...state.data.summary, offeredCount: (state.data.summary?.offeredCount ?? 0) + offeredDelta },
          },
          rowStatus,
          // The rows that failed stay selected so a retry needs no re-picking.
          selected: failed.map(failure => failure.id),
          notice: bulkNotice({ saved, failed }),
        })
        // ...but a version-conflict row is stale BY DEFINITION, and the line
        // above leaves it selected while `applyBulkResults` leaves its version
        // at the value the server just rejected. Together those made the retry
        // this selection invites rebuild a byte-identical body and fail
        // identically, forever: an affordance saying "press me again" over data
        // guaranteeing the press fails, which presents as a broken Save button
        // rather than as data that moved. So reload. `load()` preserves
        // `rowStatus` and leaves `notice` alone, and `intersectSelection`
        // preserves the selection -- the marks and the picks survive, and only
        // the versions change, to the true ones a retry needs.
        const conflicts = failed.filter(failure => failure.reason === 'version-conflict')
        if (conflicts.length) {
          await load()
          const reloaded = { ...state.rowStatus }
          for (const conflict of conflicts) {
            // Not any row the load has since said something newer about -- a
            // dropped draft is a fresher fact about that row than this is.
            if (reloaded[conflict.id]?.reason !== 'version-conflict') continue
            reloaded[conflict.id] = { kind: 'error', reason: 'version-conflict', text: RELOADED_AFTER_CONFLICT }
          }
          set({ rowStatus: reloaded })
        }
      } catch (err) {
        set({ busy: false, notice: { tone: 'error', text: err.message } })
      }
    },

    /**
     * After the brand-wide toggle above the grid.
     *
     * `PUT /api/owner/offers/by-brand/:brand` takes no expected version and
     * bumps every matched row's, so every `version` on screen for that brand is
     * stale the moment it returns — and at 200 rows the next save would be a
     * guaranteed conflict storm. Drafts go, the selection goes, and the page is
     * re-read, so nothing on screen is saving against a version that no longer
     * exists. (Invisible today only because 24 rows fit on screen.)
     */
    afterBrandToggle() {
      set({
        drafts: EMPTY, rowStatus: EMPTY, selected: [], pending: null,
        notice: { tone: 'success', text: 'Brand offers updated. The grid was reloaded, because that change bumps every affected row.' },
      })
      return load()
    },
  }
}
