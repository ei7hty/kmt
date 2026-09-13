import { useEffect, useState, useSyncExternalStore } from 'react'
import './OwnerInventory.css'
import SignIn from './SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { signOut } from './session.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'
import MailAlert from '../components/MailAlert.jsx'
import { InquiryNavButton } from './Inquiries.jsx'
import OwnerInventoryGrid from './OwnerInventoryGrid.jsx'
import { createInventoryGrid } from './inventory-grid.js'

const dateLabel = value => value ? new Date(value).toLocaleString() : 'Never refreshed'

/** Thrown on a 401 so callers can show the sign-in form instead of an error. */
class NeedsSignIn extends Error {}

/**
 * Every error carries the status it came from.
 *
 * The grid distinguishes a 409 from a 404 from a rejected value when it marks
 * a row, and a reason code the owner can act on -- "changed in another window"
 * against "no longer listed" -- cannot be recovered from the message text.
 */
async function api(path, options = {}) {
  const response = await fetch(`/api/owner/${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) throw new Error('The owner backend is not connected. Start the owner server to load inventory.')
  const data = await response.json()
  if (response.status === 401) {
    const error = new NeedsSignIn(data.error || 'Sign in to continue.')
    error.status = 401
    throw error
  }
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.')
    error.status = response.status
    throw error
  }
  return data
}

/**
 * The bookmarklet, built around a freshly issued import token.
 *
 * Minified deliberately -- it has to survive being a `javascript:` URL in a
 * bookmark. `src/owner/bookmarklet.js` is the same code written to be read;
 * change that first, then mirror it here.
 */
function buildBookmarklet(base, token) {
  const source = `(async()=>{try{
var m=location.pathname.match(/\\/tires\\/(?:.*\\/)?(\\d{3})-(\\d{2})-(\\d{2})(?:$|[\\/?])/);
if(!m){alert('Open a giga-tires size listing first, e.g. /tires/215-60-16');return}
var sz=m[1]+'/'+m[2]+'R'+m[3],sp=m[1]+'-'+m[2]+'-'+m[3];
var id='imp'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
var post=async function(p,t,h){var r=await fetch('${base}/api/owner/import',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ${token}'},body:JSON.stringify({sessionId:id,size:sz,page:p,totalPages:t,html:h})});var d=await r.json().catch(function(){return{}});if(!r.ok)throw new Error(d.error||'Import failed ('+r.status+')');return d};
var h1=document.documentElement.outerHTML;
var ls=[].map.call(h1.match(/[?&]page=(\\d+)/g)||[],function(s){return +s.split('=')[1]});
var tp=ls.length?Math.max.apply(null,ls):1;
var res=await post(1,tp,h1);
for(var p=2;p<=tp;p++){await new Promise(function(r){setTimeout(r,1500)});
var rr=await fetch('/tires/'+sp+'?page='+p,{credentials:'include'});
if(!rr.ok)throw new Error('Supplier returned '+rr.status+' for page '+p);
res=await post(p,tp,await rr.text())}
alert(res.message)}catch(e){alert('KMT import: '+e.message)}})()`
  return `javascript:${encodeURIComponent(source.replace(/\n/g, ''))}`
}

/**
 * Import supplier pages from the owner's own browser.
 *
 * The server cannot be relied on to fetch giga-tires -- a datacenter IP may be
 * refused -- and this page cannot fetch it either: cross-origin requests return
 * an empty 202 with no CORS headers. A giga-tires page fetching its own further
 * pages is same-origin and allowed, so the work happens there and the HTML
 * comes back here.
 */
function BrowserImport({ sizes }) {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [size, setSize] = useState(sizes?.[0] || '215/60R16')

  async function generate() {
    setError('')
    setBusy(true)
    try {
      const { token } = await api('import-token', { method: 'POST', body: '{}' })
      setLink(buildBookmarklet(window.location.origin, token))
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  const sizePath = size.replace('/', '-').replace('R', '-')

  return <section className="oi-refresh" aria-label="Import from your browser">
    <div>
      <h2>Import from your browser</h2>
      <p>Refreshes run from this server, and the supplier may refuse it. This route runs from your own connection instead: open a size on Giga Tires, click the bookmark, and every page of that listing is sent back here.</p>
      <ol className="oi-import-steps">
        <li>Generate the bookmark below and drag it to your bookmarks bar.</li>
        <li>Open <a href={`https://www.giga-tires.com/tires/${sizePath}`} target="_blank" rel="noreferrer">giga-tires.com/tires/{sizePath} ↗</a></li>
        <li>Click the bookmark and wait for the &ldquo;Imported…&rdquo; message.</li>
      </ol>
      <p className="oi-muted">The bookmark carries a key that expires in two hours and can do nothing but import tires. Generate a new one whenever it stops working.</p>
    </div>
    <div className="oi-refresh-actions">
      <label htmlFor="import-size" className="oi-kicker">SIZE TO OPEN</label>
      <select id="import-size" value={size} onChange={e => setSize(e.target.value)}>
        {(sizes || []).map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <button type="button" className="oi-button oi-primary" onClick={generate} disabled={busy}>
        {busy ? 'Generating…' : link ? 'Generate a new bookmark' : 'Generate bookmark'}
      </button>
      {link && <a className="oi-bookmarklet" href={link} onClick={e => e.preventDefault()} draggable>
        ⇱ Send to KMT — drag me to your bookmarks bar
      </a>}
      {error && <p role="alert" className="oi-error">{error}</p>}
    </div>
  </section>
}

/**
 * The markup rule: what a tire is priced at until the owner prices it himself.
 *
 * It is a fallback, not a policy. Every price set below overrides it, and this
 * only decides what a tire nobody has reached costs -- which matters because
 * there are hundreds of supported sizes and pricing each one by hand does not
 * finish.
 */
/**
 * A size as typed, reduced to what identifies it: "205/55R16", "205 55 16"
 * and "2055516" are the same size to the owner, and the filter should agree.
 * Every supported size is width/ratio R rim, so the digits are the identity
 * and the separators, R included, are punctuation.
 */
const compactSize = value => String(value).replace(/\D/g, '')

function MarkupRule({ markup, onSaved }) {
  const [rate, setRate] = useState(String(markup.rate))
  const [shippingPerTire, setShippingPerTire] = useState(String(markup.shippingPerTire ?? 0))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(event) {
    event.preventDefault()
    setError('')
    const parsedRate = Number(rate)
    if (!Number.isFinite(parsedRate) || parsedRate < 1 || parsedRate > 10) {
      setError('Enter a markup between 1 and 10 times the supplier price.'); return
    }
    const parsedShipping = Number(shippingPerTire)
    if (!Number.isFinite(parsedShipping) || parsedShipping < 0 || parsedShipping > 200) {
      setError('Enter a per-tire shipping cost between $0 and $200.'); return
    }
    setSaving(true)
    try { onSaved(await api('markup', { method: 'PUT', body: JSON.stringify({ rate: parsedRate, shippingPerTire: parsedShipping }) })) }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return <section className="oi-refresh" aria-label="Markup rule">
    <div>
      <h2>Default markup</h2>
      <p>Tires you have not priced are offered at the supplier price times this number, plus shipping. Any price you set below wins over it.</p>
      <p className="oi-muted">
        {markup.isPlaceholder
          ? 'Still the starting values — nobody has set these yet, so those prices are provisional.'
          : `Set ${dateLabel(markup.updatedAt)}.`}
      </p>
    </div>
    <form className="oi-refresh-actions" onSubmit={save}>
      <label htmlFor="markup-rate" className="oi-kicker">SUPPLIER PRICE × MARKUP, THEN + SHIPPING</label>
      <input id="markup-rate" value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" disabled={saving} />
      <label htmlFor="markup-shipping" className="oi-kicker">SHIPPING PER TIRE ($)</label>
      <input id="markup-shipping" value={shippingPerTire} onChange={e => setShippingPerTire(e.target.value)} inputMode="decimal" disabled={saving} />
      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save markup'}</button>
      {error && <p role="alert" className="oi-error">{error}</p>}
    </form>
  </section>
}

/**
 * Tax only. Per .forge/pricing-settings.md (#289): tax defaults off, and
 * turning it on requires an answer from Ken's accountant about which lines
 * it applies to, so that field is not guessed at here either.
 *
 * The mobile fee and disposal used to live on this form too. #354 (stage 2)
 * moved both into the catalogue below them -- PricingLines -- because they
 * are quote lines Ken can rename, retire or add siblings to, not fixed
 * settings. mobileServiceFee/disposalFee are omitted from this save
 * entirely now: the API treats an omitted fee as "not changing it" (the
 * same shape saveMarkup already used for shippingPerTire), so this form
 * only ever asks about tax.
 */
function PricingSettings({ pricing, onSaved }) {
  const [taxOn, setTaxOn] = useState(pricing.tax !== null)
  const [taxRate, setTaxRate] = useState(String(pricing.tax ? pricing.tax.rate * 100 : ''))
  const [taxAppliesTo, setTaxAppliesTo] = useState(pricing.tax?.appliesTo ?? 'all')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(event) {
    event.preventDefault()
    setError('')
    let tax = null
    if (taxOn) {
      const parsedRate = Number(taxRate)
      if (!Number.isFinite(parsedRate) || parsedRate <= 0 || parsedRate >= 25) {
        setError('Enter a tax rate between 0 and 25%.'); return
      }
      tax = { rate: parsedRate / 100, appliesTo: taxAppliesTo }
    }
    setSaving(true)
    try {
      onSaved(await api('pricing', { method: 'PUT', body: JSON.stringify({ tax }) }))
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return <section className="oi-refresh" aria-label="Tax settings">
    <div>
      <h2>Tax</h2>
      <p className="oi-muted">{pricing.tax ? `Set ${dateLabel(pricing.updatedAt)}.` : 'Off. Nothing is charged until your accountant gives you a rate.'}</p>
    </div>
    <form className="oi-refresh-actions" onSubmit={save}>
      <label><input type="checkbox" checked={taxOn} onChange={e => setTaxOn(e.target.checked)} disabled={saving} /> Charge tax</label>
      {taxOn && <>
        <label htmlFor="pricing-tax-rate" className="oi-kicker">TAX RATE (%)</label>
        <input id="pricing-tax-rate" value={taxRate} onChange={e => setTaxRate(e.target.value)} inputMode="decimal" disabled={saving} />
        <label htmlFor="pricing-tax-applies" className="oi-kicker">APPLIES TO</label>
        <select id="pricing-tax-applies" value={taxAppliesTo} onChange={e => setTaxAppliesTo(e.target.value)} disabled={saving}>
          <option value="all">Everything</option>
          <option value="goods">Tires only</option>
          <option value="services">Labour and everything else on the quote</option>
        </select>
      </>}

      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save tax'}</button>
      {error && <p role="alert" className="oi-error">{error}</p>}
    </form>
  </section>
}

/** A blank row for "Add line" -- enabled by default, since a line Ken just added is one he means to charge. */
const BLANK_CATALOGUE_LINE = { label: '', amountCents: 0, basis: 'perJob', mode: 'automatic', taxable: false, enabled: true }

/**
 * The owner's own quote lines (#354): installation, and anything else Ken
 * wants beyond it. One form over the whole ordered list -- saveCatalogueLines
 * replaces it wholesale, the same shape TireOffer's per-tire save uses for a
 * single record, widened to an array here because array order is the
 * invoice's order (stage 2's own ruling: no rule beyond how Ken arranges
 * them).
 *
 * `isPlaceholder` lines (seeded from the old mobile-fee/disposal settings,
 * never confirmed by Ken) are marked so, and the flag is preserved by
 * default and only actually cleared server-side once its amount changes --
 * this form does not send the flag at all, letting the API's own "did the
 * amount actually change" rule decide, the same way it always has.
 */
function PricingLines({ lines: initialLines, onSaved }) {
  const [lines, setLines] = useState(initialLines)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const change = (index, field, value) => setLines(rows => rows.map((row, i) => i === index ? { ...row, [field]: value } : row))
  const remove = index => setLines(rows => rows.filter((_, i) => i !== index))
  const add = () => setLines(rows => [...rows, { ...BLANK_CATALOGUE_LINE }])

  async function save(event) {
    event.preventDefault()
    setError('')
    const payload = []
    for (const [index, row] of lines.entries()) {
      const label = row.label.trim()
      if (!label) { setError(`Line ${index + 1} needs a label.`); return }
      const amountCents = Math.round(Number(row.amountCents) * 100) / 100
      if (!Number.isFinite(amountCents) || amountCents < 0) { setError(`Line ${index + 1} needs a valid amount.`); return }
      payload.push({ id: row.id, label, amountCents, basis: row.basis, mode: row.mode, taxable: row.taxable, enabled: row.enabled })
    }
    setSaving(true)
    try {
      const saved = await api('pricing-lines', { method: 'PUT', body: JSON.stringify({ lines: payload }) })
      setLines(saved.lines)
      onSaved(saved.lines)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return <section className="oi-refresh oi-lines" aria-label="Pricing lines">
    <div>
      <h2>Pricing lines</h2>
      <p className="oi-muted">Every line a customer's quote can carry, in the order it prints. Automatic lines are on every quote; optional ones the customer chooses.</p>
    </div>
    <form className="oi-refresh-actions oi-lines-form" onSubmit={save}>
      {lines.map((row, index) => (
        <div className="oi-line-row" key={row.id ?? `new-${index}`}>
          <label className="oi-kicker" htmlFor={`line-label-${index}`}>LABEL</label>
          <input id={`line-label-${index}`} value={row.label} onChange={e => change(index, 'label', e.target.value)} maxLength={200} placeholder="What the customer sees" disabled={saving} />
          {row.isPlaceholder && <p className="oi-muted oi-line-note">The starting value — nobody has confirmed this amount yet.</p>}

          <label className="oi-kicker" htmlFor={`line-amount-${index}`}>AMOUNT ($)</label>
          <input id={`line-amount-${index}`} value={row.amountCents / 100} onChange={e => change(index, 'amountCents', Number(e.target.value) * 100)} inputMode="decimal" disabled={saving} />

          <label className="oi-kicker" htmlFor={`line-basis-${index}`}>CHARGED</label>
          <select id={`line-basis-${index}`} value={row.basis} onChange={e => change(index, 'basis', e.target.value)} disabled={saving}>
            <option value="perTire">Per tire</option>
            <option value="perJob">Per visit</option>
          </select>

          <label className="oi-kicker" htmlFor={`line-mode-${index}`}>WHEN</label>
          <select id={`line-mode-${index}`} value={row.mode} onChange={e => change(index, 'mode', e.target.value)} disabled={saving}>
            <option value="automatic">Every quote</option>
            <option value="optional">Customer chooses</option>
          </select>

          <label className="oi-check"><input type="checkbox" checked={row.taxable} onChange={e => change(index, 'taxable', e.target.checked)} disabled={saving} /> Taxable</label>
          <label className="oi-check"><input type="checkbox" checked={row.enabled} onChange={e => change(index, 'enabled', e.target.checked)} disabled={saving} /> Enabled</label>

          <button type="button" className="oi-button oi-inline" onClick={() => remove(index)} disabled={saving}>Remove</button>
        </div>
      ))}
      <button type="button" className="oi-button" onClick={add} disabled={saving}>Add line</button>
      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save pricing lines'}</button>
      {error && <p role="alert" className="oi-error">{error}</p>}
    </form>
  </section>
}

/**
 * Enable or disable every tire from one brand at once.
 *
 * `brand` is not stored data -- it is derived server-side from the
 * supplier's own listing URL (src/data/brand.js), which is why this reads
 * `summary.brands` rather than deriving anything here. The confirmation
 * numbers are the feature: nothing enables until the owner has seen how
 * many tires, across how many sizes, and how many will fall through to
 * the markup rule rather than a price he set -- so the button only
 * appears after `brand` resolves to a real summary row, never before.
 */
function BrandOffers({ brands, onChanged }) {
  const [selected, setSelected] = useState('')
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const brand = brands.find(b => b.brand === selected)

  function pick(value) {
    setSelected(value)
    setConfirming(null)
    setError('')
  }

  async function apply(enabled) {
    setBusy(true)
    setError('')
    try {
      await api(`offers/by-brand/${encodeURIComponent(selected)}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
      setConfirming(null)
      await onChanged()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  return <section className="oi-refresh" aria-label="Offer tires by brand">
    <div>
      <h2>Offer tires by brand</h2>
      <p>Enable or disable every tire from one brand at once, instead of finding and tapping each row.</p>
      <label htmlFor="brand-picker" className="oi-kicker">BRAND</label>
      <select id="brand-picker" value={selected} onChange={e => pick(e.target.value)}>
        <option value="">Choose a brand…</option>
        {brands.map(item => <option key={item.brand} value={item.brand}>{item.label} ({item.count})</option>)}
      </select>
    </div>
    {brand && <div className="oi-brand-summary">
      <p>
        {brand.count} tire{brand.count === 1 ? '' : 's'} across {brand.sizeCount} size{brand.sizeCount === 1 ? '' : 's'}.{' '}
        {brand.enabledCount} of them offered today.{' '}
        {brand.missingPriceCount > 0 && <span className="oi-attention">{brand.missingPriceCount} {brand.missingPriceCount === 1 ? 'has' : 'have'} no price set and will be priced by markup if offered.</span>}
      </p>
      {confirming
        ? <p className="oi-brand-confirm">
          {confirming === 'enable' ? `Offer all ${brand.count} ${brand.label} tires?` : `Stop offering all ${brand.count} ${brand.label} tires?`}
          <button type="button" className="oi-button oi-primary" onClick={() => apply(confirming === 'enable')} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</button>
          <button type="button" className="oi-button" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
        </p>
        : <div className="oi-refresh-actions">
          <button type="button" className="oi-button oi-primary" onClick={() => setConfirming('enable')}>Offer all {brand.count}</button>
          <button type="button" className="oi-button" onClick={() => setConfirming('disable')}>Stop offering all {brand.count}</button>
        </div>}
      {error && <p role="alert" className="oi-error">{error}</p>}
    </div>}
  </section>
}

export default function OwnerInventory({ navigate }) {
  useNoIndex()
  // The grid owns the list: the query it sends, the sort and page it asks for,
  // the rows it got back, the selection, the uncommitted cell edits and every
  // per-row result. It is a plain store rather than component state so those
  // decisions can be tested against a stubbed API -- see inventory-grid.js.
  const [grid] = useState(() => createInventoryGrid({ api }))
  const state = useSyncExternalStore(grid.subscribe, grid.getState)

  const [search, setSearch] = useState('')
  const [size, setSize] = useState('')
  // What the owner has typed into the size filter. `size` is only ever a
  // supported size or '', because it flows into the inventory query and the
  // refresh request; the typed text commits to it on an exact match or a pick.
  const [sizeQuery, setSizeQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  // The refresh, import and markup tools sit folded above the list so the
  // first tire is within a screen of the top on a phone; whether the owner
  // left them open is remembered on this device only.
  const [toolsOpen, setToolsOpen] = useState(() => { try { return localStorage.getItem('kmt_owner_tools') === 'open' } catch { return false } })
  const toggleTools = () => {
    const open = !toolsOpen
    setToolsOpen(open)
    try { localStorage.setItem('kmt_owner_tools', open ? 'open' : 'closed') } catch { /* storage unavailable: forget, do not fail */ }
  }

  const data = state.data
  const summary = data?.summary
  const jobRunning = summary?.job?.status === 'running'

  useEffect(() => { grid.load() }, [grid])

  useEffect(() => {
    const timer = setTimeout(() => grid.setQuery({ search, size, filter }), 200)
    return () => clearTimeout(timer)
  }, [grid, search, size, filter])

  useEffect(() => {
    if (!jobRunning) return
    const timer = setInterval(() => grid.reload(), 2000)
    return () => clearInterval(timer)
  }, [grid, jobRunning])

  async function refresh() {
    setBusy(true); setNotice('')
    try {
      // One size from the filter may be anything the catalog supports. "Refresh
      // all" is the sizes that already have supplier data, which is the only
      // list the backend accepts in bulk; the full walk is a local scrape.
      await api('refresh', { method: 'POST', body: JSON.stringify({ sizes: size ? [size] : summary.refreshableSizes }) })
      await grid.reload()
    } catch (err) { setNotice(err.message) }
    finally { setBusy(false) }
  }

  async function cancel() {
    setBusy(true)
    try {
      const result = await api('refresh/cancel', { method: 'POST', body: '{}' })
      setNotice(result.message)
    } catch (err) { setNotice(err.message) }
    finally { setBusy(false) }
  }

  function markupSaved(markup) {
    grid.patchSummary({ markup })
    setNotice(`Default markup saved. Tires you have not priced are now offered at supplier price × ${markup.rate}, plus $${markup.shippingPerTire} shipping.`)
  }

  function pricingSaved(pricing) {
    grid.patchSummary({ pricing })
    setNotice('Tax settings saved.')
  }

  function pricingLinesSaved(pricingLines) {
    grid.patchSummary({ pricingLines })
    setNotice('Pricing lines saved.')
  }

  // Sign out ends the session on this device. Hosted, the cookie is cleared
  // and the gate comes straight back; the local server has no session and
  // answers 404, so there is nothing to leave but the page (#96).
  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) grid.signedOut(); else navigate('/')
  }

  if (state.needsSignIn) return <SignIn onSignedIn={() => grid.load()} navigate={navigate}
    what="This workspace holds supplier costs and your prices." />

  const job = summary?.job
  const coverage = summary?.coverage.find(item => item.size === size)

  // 910 supported sizes is too many for a dropdown to be usable, and the owner
  // knows the size they are after. Type-to-find: the text filters the list as
  // it is typed, an exact match commits on its own, and anything short of one
  // offers the matches to pick from. Until it commits, the list shows every size.
  const sizes = summary?.sizes ?? []
  const sizePending = Boolean(sizeQuery) && !size
  const sizeDigits = compactSize(sizeQuery)
  const sizeMatches = sizePending && sizeDigits ? sizes.filter(value => compactSize(value).includes(sizeDigits)) : []
  const SHOWN_MATCHES = 24
  function typeSize(text) {
    setSizeQuery(text)
    const exact = sizes.find(value => compactSize(value) === compactSize(text))
    setSize(exact || '')
  }
  function pickSize(value) {
    setSizeQuery(value)
    setSize(value)
  }
  return <div className="oi-shell">
    <nav className="oi-nav"><button className="oi-brand" onClick={() => navigate('/')}><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button><span>OWNER WORKSPACE</span><MailAlert navigate={navigate} /><InquiryNavButton navigate={navigate} className="oi-button" /><button className="oi-button" data-testid="nav-quote-requests" onClick={() => navigate('/owner/quotes')}>Quote requests →</button><button className="oi-button" onClick={() => navigate('/owner/social-proof')}>Social proof</button><button className="oi-button" data-testid="nav-images" onClick={() => navigate('/owner/images')}>Product photos</button><button className="oi-button" onClick={leave}>Sign out</button></nav>
    <main className="oi-content">
      <header className="oi-heading"><div><p className="oi-kicker">YOUR INVENTORY. YOUR PRICES.</p><h1>Build your tire offering</h1><p>Explore Giga Tires, choose what you want to offer, and set your price.</p></div><span className="oi-owner-badge">Owner only</span></header>
      <div className="oi-metrics">
        <div><strong>{summary?.supplierCount ?? '—'}</strong><span>Supplier tires saved</span></div>
        <div><strong>{summary?.offeredCount ?? '—'}</strong><span>Chosen for KMT</span></div>
        <div><strong>{summary ? summary.fullSizeCount + summary.importedSizeCount : '—'}</strong><span>Sizes with supplier tires</span>{summary && <small title="The deep pass reads the rest.">Read to the last page: {summary.fullSizeCount} of {summary.fullSizeCount + summary.importedSizeCount}</small>}</div>
      </div>
      {/* Outside `.oi-metrics` on purpose: that grid is three fixed columns and
          this is not a fourth statistic, it is a warning. Shown only when there
          are any -- on a healthy database it is zero, and a permanent zero is
          furniture. These are tires Ken put a price on that customers cannot
          buy, which is the state the grid had no way to show at all until this
          change, and the reason it went unnoticed. It reports; it repairs
          nothing. */}
      {summary?.pricedNotOfferedCount > 0 && <p className="oi-priced-off oi-attention" role="status" data-testid="oi-priced-not-offered">
        <strong>{summary.pricedNotOfferedCount.toLocaleString()}{' '}
          {summary.pricedNotOfferedCount === 1 ? 'tire is' : 'tires are'} priced but not for sale.</strong>{' '}
        You set a price on {summary.pricedNotOfferedCount === 1 ? 'it' : 'them'} and customers cannot buy
        {summary.pricedNotOfferedCount === 1 ? ' it' : ' them'}. Choose &ldquo;Priced but not for sale&rdquo; under Show to see which,
        then select the ones you do want to sell and use Offer all.
      </p>}
      <div className={toolsOpen ? 'oi-tools is-open' : 'oi-tools'}>
        <button type="button" className="oi-tools-toggle" aria-expanded={toolsOpen} aria-controls="owner-tools" onClick={toggleTools}>Supplier refresh, browser import, markup rule and offers by brand</button>
        <div id="owner-tools" className="oi-tools-body" inert={!toolsOpen}>
      {/* What the supplier data for the selected size is: state about the
          data, so it sits with the refresh controls rather than above the
          list, where it cost the one-screen target 2 px once a size was set. */}
      {size && <p className="oi-coverage">{size}: {coverage ? `${coverage.completeness === 'full' ? 'Full refresh' : coverage.completeness === 'snapshot' ? 'Limited snapshot' : 'Not refreshed'} · ${dateLabel(coverage.last_success)}` : 'Not refreshed yet. Select Refresh below to fetch its tires.'}{coverage?.error && ` · Last attempt failed: ${coverage.error}`}</p>}
      <section className="oi-refresh" aria-label="Supplier refresh">
        <div><h2>Supplier inventory</h2><p>{summary?.importedSizeCount ? `${summary.importedSizeCount} sizes started from a limited snapshot. ` : ''}Refresh reads every results page for the selected size and opens a browser on this computer. Refresh all covers the {summary?.refreshableSizes.length ?? '…'} sizes that already have supplier data, not the {summary?.sizes.length ?? '…'} sizes a customer can choose. To walk every size, run the scrape from a home connection (npm run scrape-tires -- --from-catalog), then push it in with npm run import-tires.</p><p className="oi-muted">Supplier prices and stock are last-seen listings, not guaranteed quotes. Your saved KMT prices stay under your control.</p></div>
        <div className="oi-refresh-actions"><button className="oi-button oi-primary" onClick={refresh} disabled={!data || busy || jobRunning || sizePending || (!size && !summary?.refreshableSizes.length)}>{size ? `Refresh ${size}` : sizePending ? 'Finish choosing a size to refresh it' : summary && !summary.refreshableSizes.length ? 'No sizes with supplier data to refresh yet' : `Refresh all ${summary?.refreshableSizes.length ?? '…'} sizes with supplier data`}</button>{jobRunning && <button className="oi-button" onClick={cancel} disabled={busy}>Stop refresh</button>}</div>
      </section>
      <BrowserImport sizes={summary?.sizes} />
      {summary?.markup && <MarkupRule markup={summary.markup} onSaved={markupSaved} />}
      {summary?.pricingLines && <PricingLines lines={summary.pricingLines} onSaved={pricingLinesSaved} />}
      {summary?.pricing && <PricingSettings pricing={summary.pricing} onSaved={pricingSaved} />}
      {/* onChanged reloads rather than patching: the by-brand endpoint takes no
          expected version and bumps every row it touches, so every `version`
          on screen for that brand is stale the moment it returns. At 200 rows
          a page that saved against them would be a guaranteed conflict storm. */}
      {summary?.brands?.length > 0 && <BrandOffers brands={summary.brands} onChanged={() => grid.afterBrandToggle()} />}
        </div>
      </div>
      {job && <div className={`oi-job ${['failed', 'interrupted'].includes(job.status) ? 'oi-attention' : ''}`} role="status"><strong>{job.status.toUpperCase()}</strong><span>{job.message}</span><span>{job.completed} / {job.sizes.length} sizes · {job.tiresRead} tires · {job.pagesRead} pages</span>{job.failed?.length > 0 && <span>Earlier saved inventory and offers are preserved. Choose the failed size to retry.</span>}</div>}
      <div className="oi-filters">
        <label>Search tires or SKU<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Brand, model, supplier SKU…" /></label>
        <label>Tire size<input aria-label="Tire size" value={sizeQuery} onChange={e => typeSize(e.target.value)} placeholder="Any size · type to find, e.g. 205/55R16" autoComplete="off" spellCheck={false} /></label>
        <label>Show<select aria-label="Show tires" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All supplier tires</option><option value="offered">Chosen for KMT</option><option value="unselected">Not yet chosen</option><option value="priced-not-offered">Priced but not for sale</option><option value="available">Supplier in stock</option><option value="photo">Has a photo</option><option value="no-photo">No photo yet</option></select></label>
      </div>
      {sizePending && <div className="oi-size-matches" role="status" aria-live="polite">
        {sizeMatches.length === 0
          ? <span>No KMT size matches &ldquo;{sizeQuery}&rdquo;. Sizes read width/ratio R rim, like 205/55R16.</span>
          : <>
            <span>{sizeMatches.length} of {sizes.length} sizes match{sizeMatches.length > SHOWN_MATCHES ? `, showing ${SHOWN_MATCHES} — keep typing` : ''}:</span>
            {sizeMatches.slice(0, SHOWN_MATCHES).map(value => <button type="button" key={value} className="oi-size-match" onClick={() => pickSize(value)}>{value}</button>)}
          </>}
      </div>}
      {state.error && <div className="oi-error oi-notice" role="alert">{state.error}</div>}
      {notice && <div className="oi-notice" role="status">{notice}</div>}
      <OwnerInventoryGrid grid={grid} state={state} markup={summary?.markup} />
    </main>
    <PrivacyFooter navigate={navigate} />
  </div>
}
