import { useState } from 'react'
import {
  GRID_COLUMNS, PAGE_SIZES, dollars, headerSortState, sortArrow,
  showEmptyState, supplierCostCents, sellingPriceCents, sellingSource,
} from './inventory-grid.js'

/**
 * The inventory matrix.
 *
 * A dense table over the same rows the card list used to show, because the
 * owner prices his stock here and there are 6,169 supplier rows behind it: at
 * 24 per page with no sorting and one Save button per row, seeing the table
 * once took 258 pages and repricing forty tires took forty requests.
 *
 * Every decision this renders -- arrow direction, whether the empty state may
 * appear, what a bulk response did to which row -- is made in
 * `inventory-grid.js`, which is the file the tests drive. This one is markup.
 */

const dateLabel = value => value ? new Date(value).toLocaleDateString() : '—'

function SupplierLink({ url, children }) {
  let allowed = false
  try {
    const parsed = new URL(url)
    allowed = parsed.protocol === 'https:' && ['giga-tires.com', 'www.giga-tires.com'].includes(parsed.hostname)
  } catch { /* Missing supplier URL. */ }
  return allowed ? <a href={url} target="_blank" rel="noreferrer">{children} ↗</a> : <span>{children}</span>
}

/**
 * What each photo state says to the owner, in his words.
 *
 * Six states, and the two that matter most are the ones a shorter version
 * would collapse into "no photo": STALE means an approved photo stopped being
 * served because the supplier row changed under it, and HIDDEN means he turned
 * it off himself. Both look identical to a customer and mean completely
 * different things to him.
 */
const PHOTO_LABELS = {
  none: { text: 'None', hint: 'No photo has been brought in for this tire.' },
  pending: { text: 'Waiting', hint: 'Imported and waiting for you to approve it on the Product photos screen.' },
  revoked: { text: 'Revoked', hint: 'The batch this came from was revoked. It needs a fresh one.' },
  hidden: { text: 'Off', hint: 'You switched this photo off. Customers do not see it.' },
  stale: { text: 'Out of date', hint: 'This tire changed since the photo was approved, so it stopped showing. Bring in a new photo.' },
  live: { text: 'Showing', hint: 'Customers see this photo now.' },
}

/**
 * The photo cell: what state this product's photo is in, and the one control
 * that changes it.
 *
 * The toggle appears only for `live` and `hidden` -- the two states the owner
 * can actually move between. Offering it on `none` or `revoked` would be a
 * button that cannot work, and on `stale` it would imply the photo comes back,
 * which it does not until a new one is brought in.
 */
function PhotoCell({ item, grid }) {
  const photo = item.photo || { state: 'none', url: null }
  const label = PHOTO_LABELS[photo.state] || PHOTO_LABELS.none
  const togglable = photo.state === 'live' || photo.state === 'hidden'
  const busy = grid.isPhotoBusy?.(item.id)
  return <td className={`oi-g-cell-photo oi-g-photo-${photo.state}`}>
    {photo.url
      ? <img className="oi-g-thumb" src={photo.url} alt="" width="40" height="40" loading="lazy" />
      : <span className="oi-g-thumb oi-g-thumb-empty" aria-hidden="true" />}
    <span className="oi-g-photo-state" title={label.hint}>{label.text}</span>
    {togglable && <button type="button" className="oi-g-photo-toggle" disabled={busy}
      data-testid={`oi-photo-toggle-${item.id}`}
      onClick={() => grid.setPhotoHidden(item.id, photo.state === 'live')}>
      {busy ? '…' : photo.state === 'live' ? 'Turn off' : 'Turn on'}
      <span className="oi-g-sr"> photo for {item.size} {item.name}</span>
    </button>}
  </td>
}

/**
 * A sortable header.
 *
 * `aria-sort` and the arrow both come from the sort the SERVER said it applied.
 * An unknown key falls back to the default order without an error, so a header
 * drawn from the request would claim an ordering the rows are not in.
 */
function HeaderCell({ column, echoed, onSort, disabled }) {
  const state = headerSortState(echoed, column.sort)
  const className = `oi-g-th${column.numeric ? ' oi-g-num' : ''}`
  if (!column.sort) return <th scope="col" className={className}>{column.label || <span className="oi-g-sr">Select</span>}</th>
  return <th scope="col" className={className} aria-sort={state === 'asc' ? 'ascending' : state === 'desc' ? 'descending' : 'none'}>
    <button type="button" className="oi-g-sort" onClick={() => onSort(column.sort)} disabled={disabled}
      data-testid={`oi-sort-${column.sort}`} data-sorted={state || 'none'}>
      {column.label}<span aria-hidden="true" className="oi-g-arrow">{sortArrow(state)}</span>
      <span className="oi-g-sr">{state === 'asc' ? ', sorted ascending' : state === 'desc' ? ', sorted descending' : ', not sorted'}</span>
    </button>
  </th>
}

/**
 * What the owner is asked before a bulk write runs.
 *
 * The price form shows a count and real before/after rows off his own data. It
 * is a destructive write over his livelihood at up to 200 rows at a time, and
 * a row count on its own is not enough to decide on.
 */
function BulkConfirm({ pending, busy, onConfirm, onCancel }) {
  if (!pending) return null
  const title = pending.kind === 'price'
    ? `Set the price on ${pending.preview.count} tire${pending.preview.count === 1 ? '' : 's'}?`
    : pending.kind === 'shipping'
      ? `Set shipping to ${pending.shippingCents == null ? 'the default' : dollars(pending.shippingCents)} on ${pending.count} tire${pending.count === 1 ? '' : 's'}?`
      : `${pending.enabled ? 'Offer' : 'Stop offering'} ${pending.count} tire${pending.count === 1 ? '' : 's'}?`
  return <div className="oi-g-confirm" role="alertdialog" aria-label="Confirm bulk change" data-testid="oi-bulk-confirm">
    <p className="oi-g-confirm-title">{title}</p>
    {pending.kind === 'price' && <>
      <p className="oi-muted">This overwrites the price you already set on each of these rows. Showing {pending.preview.sample.length} of {pending.preview.count}:</p>
      <table className="oi-g-sample"><thead><tr><th scope="col">Tire</th><th scope="col">Now</th><th scope="col">After</th></tr></thead>
        <tbody>{pending.preview.sample.map(row => <tr key={row.id}>
          <td>{row.size} · {row.name}</td>
          <td className="oi-g-num">{dollars(row.before)}</td>
          <td className="oi-g-num oi-g-after">{dollars(row.after)}</td>
        </tr>)}</tbody></table>
    </>}
    <div className="oi-g-confirm-actions">
      <button type="button" className="oi-button oi-primary" onClick={onConfirm} disabled={busy} data-testid="oi-bulk-confirm-yes">
        {busy ? 'Saving…' : 'Apply to all of them'}
      </button>
      <button type="button" className="oi-button" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  </div>
}

/** Set offered, shipping, or a price from the supplier cost, over the selection. */
function BulkBar({ grid, state, markup }) {
  const [multiplier, setMultiplier] = useState(String(markup?.rate ?? 1.4))
  const [addShipping, setAddShipping] = useState(true)
  const [shipping, setShipping] = useState('')
  const count = state.selected.length
  if (!count) return null
  const defaultShippingCents = Math.round(Number(markup?.shippingPerTire ?? 0) * 100)
  const disabled = state.busy || Boolean(state.pending)

  return <div className="oi-g-bulk" role="group" aria-label="Change the selected tires" data-testid="oi-bulk-bar">
    <p className="oi-g-bulk-count"><strong>{count}</strong> selected on this page
      <button type="button" className="oi-button oi-inline" onClick={() => grid.selectAllOnPage(false)}>Clear</button></p>

    <div className="oi-g-bulk-group">
      <button type="button" className="oi-button" disabled={disabled} onClick={() => grid.requestBulk('offered', { enabled: true })}>Offer all {count}</button>
      <button type="button" className="oi-button" disabled={disabled} onClick={() => grid.requestBulk('offered', { enabled: false })}>Stop offering</button>
    </div>

    <div className="oi-g-bulk-group">
      <label htmlFor="oi-bulk-shipping">Shipping ($)</label>
      <input id="oi-bulk-shipping" value={shipping} onChange={e => setShipping(e.target.value)} inputMode="decimal" placeholder="Blank = default" disabled={disabled} />
      <button type="button" className="oi-button" disabled={disabled} onClick={() => grid.requestBulk('shipping', { shipping })}>Set shipping</button>
    </div>

    <div className="oi-g-bulk-group">
      <label htmlFor="oi-bulk-multiplier">Supplier cost ×</label>
      <input id="oi-bulk-multiplier" value={multiplier} onChange={e => setMultiplier(e.target.value)} inputMode="decimal" disabled={disabled} />
      <label className="oi-g-check"><input type="checkbox" checked={addShipping} onChange={e => setAddShipping(e.target.checked)} disabled={disabled} />
        <span>+ shipping</span></label>
      <button type="button" className="oi-button oi-primary" disabled={disabled} data-testid="oi-bulk-price"
        onClick={() => grid.requestBulk('price', { multiplier: Number(multiplier), addShipping, defaultShippingCents })}>
        Set price on {count}
      </button>
    </div>
  </div>
}

function GridRow({ item, grid, state, expanded, onExpand }) {
  const values = grid.rowValues(item)
  const status = state.rowStatus[item.id]
  const dirty = Boolean(state.drafts[item.id])
  const selected = state.selected.includes(item.id)
  const stock = item.source?.stock
  const available = item.supplierActive && item.inStock && stock > 0
  const marginStale = dirty || status?.kind === 'saved'
  // The rule's price, shown only where it is the one in force: `source` is
  // 'markup' exactly when Ken has not priced the tire himself, so this is
  // null the moment he has. Read from the server's answer rather than
  // recomputed here -- the markup rule belongs to markup.js and one copy of
  // it is the whole point.
  const ruled = sellingSource(item) === 'markup' ? sellingPriceCents(item) : null

  const commit = () => grid.commitRow(item.id)
  const onKey = event => { if (event.key === 'Enter') { event.preventDefault(); commit() } }

  return <>
    <tr className={`oi-g-row${selected ? ' is-selected' : ''}${status?.kind === 'error' ? ' has-error' : ''}${values.enabled ? ' is-offered' : ''}`}>
      <td className="oi-g-cell-select">
        <label className="oi-g-check"><input type="checkbox" checked={selected} onChange={() => grid.toggleSelected(item.id)} />
          <span className="oi-g-sr">Select {item.size} {item.name}</span></label>
      </td>
      <PhotoCell item={item} grid={grid} />
      <td className="oi-g-cell-size">{item.size}</td>
      <th scope="row" className="oi-g-cell-name">
        <span className="oi-g-name">{item.name}</span>
        <span className={available ? 'oi-stock oi-g-stock' : 'oi-attention oi-g-stock'}>
          {!item.supplierActive ? 'No longer listed' : stock == null ? 'Stock unconfirmed' : !item.inStock || stock === 0 ? 'Out of stock' : `${stock.toLocaleString()} in stock`}
        </span>
      </th>
      <td className="oi-g-num">{dollars(supplierCostCents(item))}</td>
      {/* The input is Ken's own price. Under it, only while he has not set
          one, is the price a customer is being charged right now by the
          markup rule -- the number this column used to render as an em-dash
          on every row he had never touched, which was all 1,083 of them on a
          freshly seeded database. Once he sets a price the input IS the
          selling price, so the line goes away rather than restating it. */}
      <td className="oi-g-cell-input">
        <input aria-label={`Your price for ${item.size} ${item.name} ($)`} className="oi-g-input" inputMode="decimal"
          value={values.price} placeholder={ruled == null ? '—' : 'By rule'} onKeyDown={onKey} onBlur={commit}
          onChange={e => grid.editRow(item.id, { price: e.target.value })} />
        {ruled != null && <span className="oi-g-ruled" data-testid={`oi-ruled-price-${item.id}`}>
          {dollars(ruled)}<span className="oi-g-ruled-tag"> by rule</span>
          <span className="oi-g-sr">. This is what a customer pays today, set by the markup rule because you have not priced this tire.</span>
        </span>}
      </td>
      <td className={`oi-g-num oi-g-margin${marginStale ? ' is-stale' : ''}`}
        title={marginStale ? 'Margin is a server figure; it refreshes on the next load.' : undefined}>
        {dollars(item.marginCents)}{marginStale && <span aria-hidden="true"> *</span>}
        {marginStale && <span className="oi-g-sr"> (stale until reload)</span>}
      </td>
      <td className="oi-g-cell-input">
        <input aria-label={`Shipping for ${item.size} ${item.name} ($)`} className="oi-g-input" inputMode="decimal"
          value={values.shipping} placeholder="Default" onKeyDown={onKey} onBlur={commit}
          onChange={e => grid.editRow(item.id, { shipping: e.target.value })} />
      </td>
      <td className="oi-g-cell-check">
        <label className="oi-g-check"><input type="checkbox" checked={values.enabled}
          onChange={e => { grid.editRow(item.id, { enabled: e.target.checked }); grid.commitRow(item.id) }} />
          <span className="oi-g-sr">Offer {item.size} {item.name}</span></label>
      </td>
      <td className="oi-g-cell-notes">
        <button type="button" className={values.notes ? 'oi-g-notes-toggle has-notes' : 'oi-g-notes-toggle'} aria-expanded={expanded} onClick={onExpand}>
          <span aria-hidden="true">{values.notes ? '●' : '○'}</span>
          <span className="oi-g-sr">{values.notes ? 'Notes set. ' : 'No notes. '}Show details for {item.size} {item.name}</span>
        </button>
      </td>
      <td className="oi-g-cell-sku"><SupplierLink url={item.source?.url}>{item.source?.sku || item.id}</SupplierLink></td>
      {/* `offerUpdatedAt`, top level -- stage 1 deliberately kept it OUT of
          `offer`, which is the object this screen submits back. Reading it
          from `offer.updatedAt` silently fell through to the supplier's
          last-seen date instead, on a column headed "Updated". */}
      <td className="oi-g-cell-updated">{item.offerUpdatedAt ? dateLabel(item.offerUpdatedAt) : '—'}</td>
    </tr>
    {status && <tr className={`oi-g-statusrow ${status.kind === 'error' ? 'is-error' : 'is-saved'}`}>
      <td colSpan={GRID_COLUMNS.length}>
        <span role={status.kind === 'error' ? 'alert' : 'status'} data-testid={status.kind === 'error' ? 'oi-row-error' : 'oi-row-saved'}>
          {status.kind === 'error' ? '✕ ' : '✓ '}{status.text}
        </span>
        <button type="button" className="oi-button oi-inline" onClick={() => grid.reload()}>Reload</button>
      </td>
    </tr>}
    {expanded && <tr className="oi-g-detailrow"><td colSpan={GRID_COLUMNS.length}>
      <div className="oi-g-detail">
        <label htmlFor={`oi-notes-${item.id}`}>Owner notes</label>
        <textarea id={`oi-notes-${item.id}`} value={values.notes} maxLength={2000} rows={2}
          placeholder="Why this tire, pricing notes…" onBlur={commit}
          onChange={e => grid.editRow(item.id, { notes: e.target.value })} />
        <dl className="oi-source">
          <div><dt>Supplier SKU</dt><dd>{item.source?.sku}</dd></div>
          <div><dt>Giga list price</dt><dd>{item.source?.listPrice == null ? 'Not provided' : dollars(Math.round(item.source.listPrice * 100))}</dd></div>
          <div><dt>Category</dt><dd>{item.category}</dd></div>
          <div><dt>Last seen</dt><dd>{dateLabel(item.lastSeen)}</dd></div>
        </dl>
        <p className="oi-description">{item.description}</p>
      </div>
    </td></tr>}
  </>
}

export default function OwnerInventoryGrid({ grid, state, markup }) {
  const [expanded, setExpanded] = useState('')
  const data = state.data
  const echoed = grid.echoed()
  const items = data?.items ?? []
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const allSelected = items.length > 0 && state.selected.length === items.length

  return <>
    <div className="oi-g-controls">
      <p className="oi-g-count">{data
        ? `${data.total.toLocaleString()} matching tires · page ${data.page} of ${pages.toLocaleString()}`
        : state.error ? 'Inventory could not be loaded.' : 'Loading inventory…'}</p>
      <label className="oi-g-pagesize" htmlFor="oi-page-size">Rows per page
        <select id="oi-page-size" value={state.pageSize} onChange={e => grid.setPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <button type="button" className="oi-button" onClick={() => grid.reload()} disabled={state.loading}>Reload inventory</button>
    </div>

    {state.notice && <div className={state.notice.tone === 'error' ? 'oi-notice oi-error' : 'oi-notice'}
      role={state.notice.tone === 'error' ? 'alert' : 'status'} data-testid="oi-save-notice">
      {state.notice.text}
      <button type="button" className="oi-button oi-inline" onClick={() => grid.clearNotice()}>Dismiss</button>
    </div>}

    <BulkBar grid={grid} state={state} markup={markup} />
    <BulkConfirm pending={state.pending} busy={state.busy} onConfirm={() => grid.confirmBulk()} onCancel={() => grid.cancelBulk()} />

    {/* `.oi-results` is what four other audit scripts wait for on this screen;
        the class stays on the container even though what is inside it changed. */}
    <div className="oi-results" aria-busy={state.loading}>
      <div className="oi-g-scroll">
        <table className="oi-g-table" aria-label="Supplier tires and your prices">
          <thead><tr>
            <th scope="col" className="oi-g-th oi-g-cell-select">
              <label className="oi-g-check"><input type="checkbox" checked={allSelected} disabled={!items.length}
                onChange={e => grid.selectAllOnPage(e.target.checked)} />
                <span className="oi-g-sr">Select every tire on this page</span></label>
            </th>
            {GRID_COLUMNS.slice(1).map(column =>
              <HeaderCell key={column.key} column={column} echoed={echoed} disabled={state.loading}
                onSort={key => grid.sortBy(key)} />)}
          </tr></thead>
          <tbody>
            {items.map(item => <GridRow key={item.id} item={item} grid={grid} state={state}
              expanded={expanded === item.id} onExpand={() => setExpanded(expanded === item.id ? '' : item.id)} />)}
          </tbody>
        </table>
      </div>

      {/* Gated on `!error`: telling the owner his inventory is empty when the
          request failed is a defect that already shipped on the images screen. */}
      {showEmptyState(state) && <div className="oi-empty" data-testid="oi-empty-state">
        <h2>No tires to show yet</h2>
        <p>Try another search or filter, or refresh a size to add supplier inventory.</p>
      </div>}
    </div>

    {data && data.total > data.pageSize && <nav className="oi-pagination" aria-label="Inventory pages">
      <button className="oi-button" disabled={data.page <= 1 || state.loading} onClick={() => grid.goToPage(data.page - 1)}>← Previous</button>
      <span>Page {data.page} of {pages}</span>
      <button className="oi-button" disabled={data.page >= pages || state.loading} onClick={() => grid.goToPage(data.page + 1)}>Next →</button>
    </nav>}
  </>
}
