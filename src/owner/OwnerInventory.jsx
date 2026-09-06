import { useCallback, useEffect, useRef, useState } from 'react'
import './OwnerInventory.css'
import SignIn from './SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { signOut } from './session.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'

const dollars = cents => cents == null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const dateLabel = value => value ? new Date(value).toLocaleString() : 'Never refreshed'

/** Thrown on a 401 so callers can show the sign-in form instead of an error. */
class NeedsSignIn extends Error {}

async function api(path, options = {}) {
  const response = await fetch(`/api/owner/${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) throw new Error('The owner backend is not connected. Start the owner server to load inventory.')
  const data = await response.json()
  if (response.status === 401) throw new NeedsSignIn(data.error || 'Sign in to continue.')
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.')
  return data
}

function SupplierLink({ url }) {
  let allowed = false
  try {
    const parsed = new URL(url)
    allowed = parsed.protocol === 'https:' && ['giga-tires.com', 'www.giga-tires.com'].includes(parsed.hostname)
  } catch { /* Missing supplier URL. */ }
  return allowed ? <a href={url} target="_blank" rel="noreferrer">View on Giga Tires ↗</a> : null
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
      <p>Tires you have not priced are offered at the supplier price plus shipping, times this number. Any price you set below wins over it.</p>
      <p className="oi-muted">
        {markup.isPlaceholder
          ? 'Still the starting values — nobody has set these yet, so those prices are provisional.'
          : `Set ${dateLabel(markup.updatedAt)}.`}
      </p>
    </div>
    <form className="oi-refresh-actions" onSubmit={save}>
      <label htmlFor="markup-rate" className="oi-kicker">× (SUPPLIER PRICE + SHIPPING)</label>
      <input id="markup-rate" value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" disabled={saving} />
      <label htmlFor="markup-shipping" className="oi-kicker">SHIPPING PER TIRE ($)</label>
      <input id="markup-shipping" value={shippingPerTire} onChange={e => setShippingPerTire(e.target.value)} inputMode="decimal" disabled={saving} />
      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save markup'}</button>
      {error && <p role="alert" className="oi-error">{error}</p>}
    </form>
  </section>
}

/**
 * The quote-side settings: the mobile fee, disposal, tax. Per
 * .forge/pricing-settings.md (#289): the mobile fee is already charged and
 * this only makes it a number Ken can change; disposal and tax both default
 * off, and turning tax on requires an answer from Ken's accountant about
 * which lines it applies to, so that field is not guessed at here either.
 */
function PricingSettings({ pricing, onSaved }) {
  const [mobileServiceFee, setMobileServiceFee] = useState(String(pricing.mobileServiceFee))
  const [disposalOn, setDisposalOn] = useState(pricing.disposalFee !== null)
  const [disposalFee, setDisposalFee] = useState(String(pricing.disposalFee ?? ''))
  const [taxOn, setTaxOn] = useState(pricing.tax !== null)
  const [taxRate, setTaxRate] = useState(String(pricing.tax ? pricing.tax.rate * 100 : ''))
  const [taxAppliesTo, setTaxAppliesTo] = useState(pricing.tax?.appliesTo ?? 'all')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save(event) {
    event.preventDefault()
    setError('')
    const parsedFee = Number(mobileServiceFee)
    if (!Number.isFinite(parsedFee) || parsedFee <= 0 || parsedFee > 1000) {
      setError('Enter a mobile service fee between $0 and $1000.'); return
    }
    let parsedDisposal = null
    if (disposalOn) {
      parsedDisposal = Number(disposalFee)
      if (!Number.isFinite(parsedDisposal) || parsedDisposal < 0 || parsedDisposal > 200) {
        setError('Enter a disposal fee between $0 and $200, or turn disposal off.'); return
      }
    }
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
      onSaved(await api('pricing', {
        method: 'PUT',
        body: JSON.stringify({ mobileServiceFee: parsedFee, disposalFee: parsedDisposal, tax }),
      }))
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return <section className="oi-refresh" aria-label="Pricing settings">
    <div>
      <h2>Pricing settings</h2>
      <p className="oi-muted">
        {pricing.mobileServiceFeeIsPlaceholder
          ? 'The mobile fee is still the starting value — nobody has set it yet.'
          : `Set ${dateLabel(pricing.updatedAt)}.`}
      </p>
    </div>
    <form className="oi-refresh-actions" onSubmit={save}>
      <label htmlFor="pricing-fee" className="oi-kicker">MOBILE SERVICE FEE ($, PER VISIT)</label>
      <input id="pricing-fee" value={mobileServiceFee} onChange={e => setMobileServiceFee(e.target.value)} inputMode="decimal" disabled={saving} />

      <label><input type="checkbox" checked={disposalOn} onChange={e => setDisposalOn(e.target.checked)} disabled={saving} /> Offer old-tire disposal to customers</label>
      {disposalOn && <>
        <label htmlFor="pricing-disposal" className="oi-kicker">DISPOSAL FEE ($, PER TIRE)</label>
        <input id="pricing-disposal" value={disposalFee} onChange={e => setDisposalFee(e.target.value)} inputMode="decimal" disabled={saving} />
      </>}

      <label><input type="checkbox" checked={taxOn} onChange={e => setTaxOn(e.target.checked)} disabled={saving} /> Charge tax</label>
      {taxOn && <>
        <label htmlFor="pricing-tax-rate" className="oi-kicker">TAX RATE (%)</label>
        <input id="pricing-tax-rate" value={taxRate} onChange={e => setTaxRate(e.target.value)} inputMode="decimal" disabled={saving} />
        <label htmlFor="pricing-tax-applies" className="oi-kicker">APPLIES TO</label>
        <select id="pricing-tax-applies" value={taxAppliesTo} onChange={e => setTaxAppliesTo(e.target.value)} disabled={saving}>
          <option value="all">Everything</option>
          <option value="goods">Tires only</option>
          <option value="services">Labour and disposal only</option>
        </select>
      </>}

      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save pricing'}</button>
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

function TireOffer({ tire, markup, onSaved }) {
  const [price, setPrice] = useState(tire.offer.priceCents == null ? '' : (tire.offer.priceCents / 100).toFixed(2))
  const [enabled, setEnabled] = useState(tire.offer.enabled)
  const [notes, setNotes] = useState(tire.offer.notes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const stock = tire.source?.stock
  const stockLabel = !tire.supplierActive ? 'No longer listed' : stock == null ? 'Stock unconfirmed' : !tire.inStock || stock === 0 ? 'Out of stock' : `${stock.toLocaleString()} in stock`
  const isAvailable = tire.supplierActive && tire.inStock && stock > 0
  const parsedPrice = /^\d+(\.\d{1,2})?$/.test(price) ? Math.round(Number(price) * 100) : null
  const spread = parsedPrice == null ? null : parsedPrice - Math.round(tire.price * 100)
  // What this tire costs a customer today if the owner never touches it.
  const suggestedCents = markup?.rate ? Math.round(tire.price * markup.rate * 100) : null

  async function save(event) {
    event.preventDefault()
    setError('')
    if ((price !== '' && (parsedPrice == null || parsedPrice <= 0)) || (enabled && parsedPrice == null)) {
      setError('Enter a positive KMT price with up to two decimal places.'); return
    }
    setSaving(true)
    try {
      const offer = await api(`offers/${encodeURIComponent(tire.id)}`, {
        method: 'PUT', body: JSON.stringify({ priceCents: parsedPrice, enabled, notes, version: tire.offer.version }),
      })
      onSaved(tire.id, offer)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  return <article className={`oi-tire ${tire.offer.enabled ? 'oi-tire-offered' : ''}`}>
    <div className="oi-tire-main">
      <div className="oi-tire-tags"><span>{tire.size}</span><span className={isAvailable ? 'oi-stock' : 'oi-attention'}>{stockLabel}</span><span className="oi-tire-price">Giga {dollars(Math.round(tire.price * 100))} / tire</span></div>
      <h2>{tire.name}</h2>
      <details className="oi-tire-more"><summary>Details</summary>
      <p className="oi-description">{tire.description}</p>
      <dl className="oi-specs">
        <div><dt>Giga list price</dt><dd>{tire.source?.listPrice == null ? 'Not provided' : dollars(Math.round(tire.source.listPrice * 100))}</dd></div>
        <div><dt>Category</dt><dd>{tire.category}</dd></div>
        <div><dt>Segment</dt><dd>{tire.source?.segment || 'Not provided'}</dd></div>
      </dl>
      <details><summary>Supplier details</summary><dl className="oi-source">
        <div><dt>SKU</dt><dd>{tire.source?.sku}</dd></div>
        <div><dt>Last seen</dt><dd>{dateLabel(tire.lastSeen)}</dd></div>
        <div><dt>Listing</dt><dd><SupplierLink url={tire.source?.url} /></dd></div>
      </dl><details><summary>All imported fields</summary><pre>{JSON.stringify({ id: tire.id, name: tire.name, size: tire.size, price: tire.price, inStock: tire.inStock, category: tire.category, description: tire.description, source: tire.source }, null, 2)}</pre></details></details>
      </details>
    </div>
    <form className="oi-offer" onSubmit={save}>
      <p className="oi-kicker">KMT OFFER</p>
      <div className="oi-offer-row">
        <label className="oi-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={saving} />Offer this tire</label>
        <div><label htmlFor={`price-${tire.id}`}>Your price per tire ($)</label>
        <input id={`price-${tire.id}`} value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" placeholder="Set your price" disabled={saving} /></div>
      </div>
      <p className={spread != null && spread < 0 ? 'oi-attention oi-spread' : 'oi-spread'}>{spread == null ? 'Set independently from Giga’s price.' : `${dollars(spread)} ${spread < 0 ? 'below' : 'above'} Giga’s listed price`.replace('-$', '$')}</p>
      {suggestedCents != null && tire.offer.priceCents == null && <p className="oi-spread oi-muted">
        Markup offers this at {dollars(suggestedCents)} until you set a price.
        <button type="button" className="oi-button oi-inline" onClick={() => setPrice((suggestedCents / 100).toFixed(2))} disabled={saving}>Use {dollars(suggestedCents)}</button>
      </p>}
      <label htmlFor={`notes-${tire.id}`}>Owner notes</label>
      <textarea id={`notes-${tire.id}`} value={notes} onChange={e => setNotes(e.target.value)} maxLength={2000} rows={1} placeholder="Why this tire, pricing notes…" disabled={saving} />
      <button type="submit" className="oi-button oi-primary" disabled={saving}>{saving ? 'Saving…' : 'Save offer'}</button>
      {error && <p role="alert" className="oi-error">{error}</p>}
      {tire.offer.enabled && !isAvailable && <p className="oi-attention">Selected by KMT, but supplier availability needs review.</p>}
    </form>
  </article>
}

export default function OwnerInventory({ navigate }) {
  useNoIndex()
  const [data, setData] = useState(null)
  const [search, setSearch] = useState('')
  const [size, setSize] = useState('')
  // What the owner has typed into the size filter. `size` is only ever a
  // supported size or '', because it flows into the inventory query and the
  // refresh request; the typed text commits to it on an exact match or a pick.
  const [sizeQuery, setSizeQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // The refresh, import and markup tools sit folded above the list so the
  // first tire is within a screen of the top on a phone; whether the owner
  // left them open is remembered on this device only.
  const [toolsOpen, setToolsOpen] = useState(() => { try { return localStorage.getItem('kmt_owner_tools') === 'open' } catch { return false } })
  const toggleTools = () => {
    const open = !toolsOpen
    setToolsOpen(open)
    try { localStorage.setItem('kmt_owner_tools', open ? 'open' : 'closed') } catch { /* storage unavailable: forget, do not fail */ }
  }
  const sequence = useRef(0)
  const invalidate = useCallback(() => { sequence.current++ }, [])
  const jobRunning = data?.summary.job?.status === 'running'

  const load = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try {
      const result = await api(`inventory?${new URLSearchParams({ search, size, filter, page })}`)
      if (request !== sequence.current) return
      setData(result); setError(''); setNeedsSignIn(false)
    } catch (err) {
      if (request !== sequence.current) return
      // A 401 is not an error to report, it is a door to open.
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    }
    finally { if (request === sequence.current) setLoading(false) }
  }, [search, size, filter, page])

  useEffect(() => {
    const timer = setTimeout(load, 200)
    return () => { clearTimeout(timer); invalidate() }
  }, [load, invalidate])

  useEffect(() => {
    if (!jobRunning) return
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [jobRunning, load])

  async function refresh() {
    setBusy(true); setError(''); setNotice('')
    try {
      // One size from the filter may be anything the catalog supports. "Refresh
      // all" is the sizes that already have supplier data, which is the only
      // list the backend accepts in bulk; the full walk is a local scrape.
      await api('refresh', { method: 'POST', body: JSON.stringify({ sizes: size ? [size] : data.summary.refreshableSizes }) })
      await load()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function cancel() {
    setBusy(true)
    try {
      const result = await api('refresh/cancel', { method: 'POST', body: '{}' })
      setNotice(result.message)
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  function markupSaved(markup) {
    invalidate()
    setData(previous => ({ ...previous, summary: { ...previous.summary, markup } }))
    setNotice(`Default markup saved. Tires you have not priced are now offered at ${markup.rate}× (supplier price + $${markup.shippingPerTire} shipping).`)
  }

  function pricingSaved(pricing) {
    setData(previous => ({ ...previous, summary: { ...previous.summary, pricing } }))
    setNotice('Pricing settings saved.')
  }

  function saved(id, offer) {
    invalidate()
    setData(previous => ({ ...previous, items: previous.items.map(tire => tire.id === id ? { ...tire, offer } : tire),
      summary: { ...previous.summary, offeredCount: previous.summary.offeredCount + Number(offer.enabled) - Number(previous.items.find(t => t.id === id).offer.enabled) } }))
    setNotice('Offer saved. Your selection and price are stored in the owner database.')
  }

  // Sign out ends the session on this device. Hosted, the cookie is cleared
  // and the gate comes straight back; the local server has no session and
  // answers 404, so there is nothing to leave but the page (#96).
  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) { setData(null); setNeedsSignIn(true) } else navigate('/')
  }

  if (needsSignIn) return <SignIn onSignedIn={load} navigate={navigate}
    what="This workspace holds supplier costs and your prices." />

  const summary = data?.summary
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
    setPage(1)
  }
  function pickSize(value) {
    setSizeQuery(value)
    setSize(value)
    setPage(1)
  }
  return <div className="oi-shell">
    <nav className="oi-nav"><button className="oi-brand" onClick={() => navigate('/')}><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button><span>OWNER WORKSPACE</span><button className="oi-button" onClick={() => navigate('/owner/quotes')}>Quote requests →</button><button className="oi-button" onClick={leave}>Sign out</button></nav>
    <main className="oi-content">
      <header className="oi-heading"><div><p className="oi-kicker">YOUR INVENTORY. YOUR PRICES.</p><h1>Build your tire offering</h1><p>Explore Giga Tires, choose what you want to offer, and set your price.</p></div><span className="oi-owner-badge">Owner only</span></header>
      <div className="oi-metrics">
        <div><strong>{summary?.supplierCount ?? '—'}</strong><span>Supplier tires saved</span></div>
        <div><strong>{summary?.offeredCount ?? '—'}</strong><span>Chosen for KMT</span></div>
        <div><strong>{summary ? summary.fullSizeCount + summary.importedSizeCount : '—'}</strong><span>Sizes with supplier tires</span>{summary && <small title="The deep pass reads the rest.">Read to the last page: {summary.fullSizeCount} of {summary.fullSizeCount + summary.importedSizeCount}</small>}</div>
      </div>
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
      {summary?.pricing && <PricingSettings pricing={summary.pricing} onSaved={pricingSaved} />}
      {summary?.brands?.length > 0 && <BrandOffers brands={summary.brands} onChanged={load} />}
        </div>
      </div>
      {job && <div className={`oi-job ${['failed', 'interrupted'].includes(job.status) ? 'oi-attention' : ''}`} role="status"><strong>{job.status.toUpperCase()}</strong><span>{job.message}</span><span>{job.completed} / {job.sizes.length} sizes · {job.tiresRead} tires · {job.pagesRead} pages</span>{job.failed?.length > 0 && <span>Earlier saved inventory and offers are preserved. Choose the failed size to retry.</span>}</div>}
      <div className="oi-filters">
        <label>Search tires or SKU<input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Brand, model, supplier SKU…" /></label>
        <label>Tire size<input aria-label="Tire size" value={sizeQuery} onChange={e => typeSize(e.target.value)} placeholder="Any size · type to find, e.g. 205/55R16" autoComplete="off" spellCheck={false} /></label>
        <label>Show<select aria-label="Show tires" value={filter} onChange={e => { setFilter(e.target.value); setPage(1) }}><option value="all">All supplier tires</option><option value="offered">Chosen for KMT</option><option value="unselected">Not yet chosen</option><option value="available">Supplier in stock</option></select></label>
        <button className="oi-button" onClick={load} disabled={loading}>Reload inventory</button>
      </div>
      {sizePending && <div className="oi-size-matches" role="status" aria-live="polite">
        {sizeMatches.length === 0
          ? <span>No KMT size matches “{sizeQuery}”. Sizes read width/ratio R rim, like 205/55R16.</span>
          : <>
            <span>{sizeMatches.length} of {sizes.length} sizes match{sizeMatches.length > SHOWN_MATCHES ? `, showing ${SHOWN_MATCHES} — keep typing` : ''}:</span>
            {sizeMatches.slice(0, SHOWN_MATCHES).map(value => <button type="button" key={value} className="oi-size-match" onClick={() => pickSize(value)}>{value}</button>)}
          </>}
      </div>}
      {error && <div className="oi-error oi-notice" role="alert">{error}</div>}
      {notice && <div className="oi-notice" role="status">{notice}</div>}
      <div className="oi-results-heading"><p>{data ? `${data.total} matching tires · page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}` : 'Loading inventory…'}</p><span>{loading ? 'Updating…' : 'Selections and prices are saved, and offered tires reach the customer catalog.'}</span></div>
      <div className="oi-results" aria-busy={loading}>
        {data?.items.map(tire => <TireOffer key={`${tire.id}:${tire.offer.version}`} tire={tire} markup={summary?.markup} onSaved={saved} />)}
        {data && !data.items.length && <div className="oi-empty"><h2>No tires to show yet</h2><p>{size && !coverage ? 'Refresh this size to load supplier inventory.' : 'Try another search or filter, or refresh a size to add supplier inventory.'}</p></div>}
      </div>
      {data && data.total > data.pageSize && <nav className="oi-pagination" aria-label="Inventory pages"><button className="oi-button" disabled={data.page <= 1 || loading} onClick={() => setPage(data.page - 1)}>← Previous</button><span>Page {data.page} of {Math.ceil(data.total / data.pageSize)}</span><button className="oi-button" disabled={data.page * data.pageSize >= data.total || loading} onClick={() => setPage(data.page + 1)}>Next →</button></nav>}
    </main>
    <PrivacyFooter navigate={navigate} />
  </div>
}
