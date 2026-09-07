import { useCallback, useEffect, useState } from 'react'
import SignIn from '../owner/SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { NeedsSignIn, actOnQuote, adjustQuote, ownerRequests } from '../store'
import { signOut } from '../owner/session.js'
import { exactTime, timeAgo } from '../owner/timeAgo.js'
import { PrivacyFooter } from './Privacy.jsx'
import MailAlert from '../components/MailAlert.jsx'
import { InquiryNavButton } from '../owner/Inquiries.jsx'

/** A stored US number, +16174108319, as a person reads it: (617) 410-8319. Anything else as stored. */
const formatPhone = (phone) => {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone || '')
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone
}

/**
 * The owner's review screen, over the backend.
 *
 * It read the browser's own storage, which meant it could only ever show
 * requests submitted on the same device. It now lists what the server holds, so
 * the owner sees a customer's request from any device -- which is the point of
 * the milestone.
 *
 * The tire is resolved by the server against the catalog the quote was drafted
 * over, so this screen no longer loads the catalog to name it.
 */

/**
 * The filters, in the order work moves through them.
 *
 * Labelled by what the owner would do next rather than by status, because that
 * is what the tabs are for: "Needs you" is a decision to make, "With customer"
 * is nothing to do but wait, "To fit" is a van to drive somewhere.
 */
const VIEWS = [
  { key: 'open', label: 'Open' },
  { key: 'attention', label: 'Needs you' },
  { key: 'awaiting', label: 'With customer' },
  { key: 'paid', label: 'To fit' },
  { key: 'closed', label: 'Closed' },
]

/** What the screen offers to do with a request in each state. */
const ACTIONS = {
  draft: [
    { action: 'reject', label: 'Decline', className: 'btn btn-reject', asks: true },
    { action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true },
  ],
  sent: [{ action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true }],
  approved: [{ action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true }],
  paid: [{ action: 'done', label: 'Mark done', busy: 'Closing…', className: 'btn btn-approve' }],
}

/**
 * The one reason box (#264's cancelDraft, reused for reject/#78's sibling):
 * the owner's typed text is a promise the customer reads, on a decline as
 * much as on a cancellation, so the copy names the actual act rather than a
 * generic "why". Keyed by ACTIONS' own action name.
 */
const REASON_PROMPT = {
  cancel: { question: 'Why is this being cancelled?', confirmLabel: 'Cancel request', confirmBusy: 'Cancelling…' },
  reject: { question: 'Why is this being declined?', confirmLabel: 'Decline request', confirmBusy: 'Declining…' },
}

const money = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00'

function QuoteEditor({ request, quote, busy, onSave }) {
  const [lineItems, setLineItems] = useState(() => quote.lineItems.map(item => ({ ...item })))
  const [note, setNote] = useState(quote.note ?? '')
  const total = lineItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), 0)
  const change = (index, field, value) => setLineItems(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item))

  return <div className="quote-editor">
    <div className="quote-lines">
      {lineItems.map((item, index) => <div className="quote-line-edit" key={index}>
        <label>Description<input aria-label={`Line ${index + 1} description`} value={item.description} maxLength={200} disabled={busy} onChange={event => change(index, 'description', event.target.value)} /></label>
        <label>Qty<input aria-label={`Line ${index + 1} quantity`} type="number" min="1" max="100" step="1" value={item.quantity} disabled={busy} onChange={event => change(index, 'quantity', event.target.value)} /></label>
        <label>Unit price<input aria-label={`Line ${index + 1} unit price`} type="number" min="0" max="100000" step="0.01" value={item.unitPrice} disabled={busy} onChange={event => change(index, 'unitPrice', event.target.value)} /></label>
        <strong>${money((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))}</strong>
        <button type="button" className="link-action quote-line-remove" disabled={busy || lineItems.length === 1} onClick={() => setLineItems(items => items.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
      </div>)}
    </div>
    <button type="button" className="btn btn-neutral quote-add-line" disabled={busy || lineItems.length >= 25} onClick={() => setLineItems(items => [...items, { description: '', quantity: 1, unitPrice: 0 }])}>Add line</button>
    <label className="quote-note">Note for customer <span className="optional">optional</span><textarea rows="3" maxLength={1000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Anything the customer should know about this quote" /></label>
    <div className="owner-quote-summary quote-editor-total"><p>Total</p><p className="owner-quote-total">${money(total)}</p></div>
    <div className="owner-actions">
      <button type="button" className="btn btn-neutral" disabled={busy} onClick={() => onSave(request, quote, lineItems, note, false)}>{busy ? 'Saving…' : 'Save changes'}</button>
      <button type="button" className="btn btn-approve" disabled={busy} onClick={() => onSave(request, quote, lineItems, note, true)}>{busy ? 'Sending…' : 'Approve & Send'}</button>
    </div>
  </div>
}

/** What a closed request says about itself, before any reason it carries. */
const CLOSED_NOTE = {
  done: 'Fitted and closed.',
  rejected: 'Declined, so the customer was not charged.',
  cancelled: 'Cancelled before payment.',
}

/**
 * The status badge in Ken's words: he's declining a job, not rejecting a
 * person, and the internal status name ('rejected', the value the database
 * and the API keep -- renaming it would touch the schema, the mail
 * templates and every test that asserts it) is not the word for that.
 */
const STATUS_LABEL = { rejected: 'declined' }

/**
 * A request opened from a link (the Outbox panel, or one mailed to Ken)
 * rather than by browsing. Read once at mount: the query string is not part
 * of this screen's own navigation, so nothing here needs it to react to
 * later changes.
 */
function linkedRequestId() {
  return new URLSearchParams(window.location.search).get('request') || ''
}

function QuoteRequests({ navigate, ownerVersion, setOwnerVersion }) {
  useNoIndex()
  const [view, setView] = useState('open')
  const [requests, setRequests] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [busyId, setBusyId] = useState('')
  // The reason box for whichever action asks for one (cancel, decline): which
  // request it belongs to, which action, and what's typed so far. Not
  // window.prompt (#78) -- Playwright cannot drive a native prompt, so
  // nothing had ever exercised this path, and the promise the text makes
  // ("the customer will see it") has to stay visible at the point of typing,
  // not live in a placeholder that vanishes on the first keystroke.
  const [reasonDraft, setReasonDraft] = useState(null)
  // Which drafts have their editor open. Collapsed by default (sprint item
  // 4): most quotes need no adjustment, so a screen whose primary action is
  // "approve as drafted" should not present seven fields as though every one
  // did. A request id, not a boolean, so opening one card's editor never
  // affects another's.
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const expandEditor = (id) => setExpandedIds(ids => new Set(ids).add(id))
  const collapseEditor = (id) => setExpandedIds(ids => { const next = new Set(ids); next.delete(id); return next })
  const [linkedId] = useState(linkedRequestId)
  // 'open' (draft/sent/paid) and 'closed' (done/rejected/cancelled) between
  // them cover every request, so a linked id missing from 'open' -- the
  // screen's default -- needs exactly one more look, at 'closed', before
  // concluding it truly is not there. Sits outside `requests`/`view` so it
  // survives the owner switching tabs by hand afterwards.
  const [linkedSearch, setLinkedSearch] = useState(linkedId ? 'pending' : 'none')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerRequests(view)
      // Newest first everywhere, except that what needs the owner is shown
      // longest-waiting first: the API returns every view newest first.
      const list = view === 'attention' ? [...data.requests].reverse() : data.requests
      setRequests(list)
      setCounts(data.counts)
      setError('')
      setNeedsSignIn(false)

      if (linkedId && linkedSearch === 'pending') {
        if (list.some(({ request }) => request.id === linkedId)) setLinkedSearch('found')
        else if (view === 'open') setView('closed')
        else setLinkedSearch('missing')
      }
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    } finally { setLoading(false) }
  }, [view, linkedId, linkedSearch])

  // Once found, scroll the owner straight to the card a link promised them,
  // rather than leaving them to find it in a list that may run to two screens.
  useEffect(() => {
    if (linkedSearch !== 'found') return
    document.getElementById(`request-${linkedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [linkedSearch, linkedId])

  // Scheduled rather than called in the effect body, the way OwnerInventory
  // does it: a synchronous setState here cascades a render.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load, ownerVersion])

  async function runAction(request, quote, action, reason = '') {
    setBusyId(request.id)
    setError('')
    try {
      await actOnQuote(request.id, action, quote.version, reason)
      // Straight back to the server rather than patching the row here: the
      // version this screen holds is exactly what goes stale.
      await load()
      setOwnerVersion?.(version => version + 1)
    } catch (err) {
      setError(err.message)
      if (/reload/i.test(err.message)) await load()
    } finally { setBusyId('') }
  }

  /** Cancelling and declining are the two actions with something to say, and
      the customer is the one who reads it. Approving and marking done don't
      ask, because there is nothing to explain. */
  function act(request, quote, { action, asks }) {
    if (asks) { setReasonDraft({ requestId: request.id, action, reason: '' }); return }
    runAction(request, quote, action)
  }

  function confirmReason(request, quote) {
    const reason = reasonDraft.reason.trim()
    const action = reasonDraft.action
    setReasonDraft(null)
    runAction(request, quote, action, reason)
  }

  async function saveAdjustment(request, quote, lineItems, note, send) {
    setBusyId(request.id)
    setError('')
    try {
      const adjusted = await adjustQuote(request.id, lineItems, note, quote.version)
      if (send) await actOnQuote(request.id, 'approve', adjusted.quote.version)
      await load()
      setOwnerVersion?.(version => version + 1)
    } catch (err) {
      setError(err.message)
      if (/reload/i.test(err.message)) await load()
    } finally { setBusyId('') }
  }

  if (needsSignIn) {
    return <SignIn onSignedIn={load} navigate={navigate} from="quotes"
      what="This screen holds customers' requests: their vehicle, address and preferred date." />
  }

  // What the owner is asked to do, whichever view they are looking at.
  const waiting = counts.attention ?? 0
  // Sign out ends the session on this device (#96); see OwnerInventory.
  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) { setRequests([]); setNeedsSignIn(true) } else navigate('/')
  }

  const summary = loading
    ? 'Loading requests…'
    : waiting === 1 ? '1 request waiting on you.' : `${waiting} requests waiting on you.`

  return (
    <div className="app-shell owner-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links"><MailAlert navigate={navigate} /><InquiryNavButton navigate={navigate} /><button className="btn btn-neutral" data-testid="nav-inventory" onClick={() => navigate('/owner')}>← Inventory</button><button className="btn btn-neutral" onClick={() => navigate('/owner/outbox')}>Outbox</button><button className="btn btn-neutral" onClick={() => navigate('/')}>Back to Customer Flow</button><button className="btn btn-neutral" onClick={leave}>Sign out</button></div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">OWNER</p>
        <h1 className="owner-heading" data-testid="quote-requests-heading">Quote Requests</h1>
        <p className="text-secondary owner-subhead" role="status">{summary}</p>
        {/* The count sits on every tab, so what needs a decision is visible
            without first switching to the tab that would say so. */}
        <div className="owner-views" role="tablist" aria-label="Which requests to show">
          {VIEWS.map(({ key, label }) => (
            <button key={key} role="tab" aria-selected={view === key}
              className={view === key ? 'btn btn-neutral owner-view is-current' : 'btn btn-neutral owner-view'}
              onClick={() => setView(key)}>
              {label} <span className="owner-view-count">{counts[key] ?? 0}</span>
            </button>
          ))}
        </div>
        {error && <div className="panel"><p className="status-note status-note-bad" role="alert">{error}</p><button className="btn btn-neutral" onClick={load}>Try again</button></div>}
        {linkedSearch === 'missing' && <div className="panel"><p className="status-note status-note-bad" role="alert">Could not find request #{linkedId.slice(0, 8)}. It may have come from a different environment.</p></div>}
        {!loading && !error && requests.length === 0 ? <div className="panel"><p className="text-secondary">{view === 'open' ? 'No open requests. Go to the customer flow and submit one.' : 'Nothing here right now.'}</p></div> : (
          <div className="owner-list">
            {requests.map(({ request, quote, tire }) => {
              // The tire line always carries how many, drafted once and never
              // recomputed here: reading it back is how the owner sees the
              // same quantity the quote was actually priced for.
              const tireLine = quote?.lineItems?.find(item => item.description !== 'Mobile installation service')
              return (
              <div key={request.id} id={`request-${request.id}`}
                className={request.id === linkedId && linkedSearch === 'found' ? 'panel owner-request owner-request-linked' : 'panel owner-request'}>
                <div className="owner-request-head">
                  <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                  <code className="owner-request-ref" title={`Request ${request.id}`}>#{request.id.slice(0, 8)}</code>
                </div>
                {request.createdAt && <p className="owner-request-age" title={exactTime(request.createdAt)}>Submitted {timeAgo(request.createdAt)}</p>}
                <dl className="owner-details">
                  <div><dt>Tire:</dt> <dd>{tire?.name ? `${tireLine ? `${tireLine.quantity} × ` : ''}${tire.name} · ${tire.size}` : `${tire?.id ?? request.tireSelection} (no longer in the catalog)`}</dd></div>
                  {/* #105: what the supplier last showed for this tire, read off the
                      supplier row rather than the customer catalog, so Ken approves
                      against stock as it was seen, not as the catalog assumes. The
                      zero-stock warning is a separate line, by design. */}
                  {tire && tire.supplierActive !== null && tire.supplierActive !== undefined && (
                    <div className="owner-request-supplier" data-stock={tire.supplierStock ?? ''}><dt>Supplier:</dt> <dd>
                      {tire.supplierActive === false
                        ? <>No longer lists this tire{tire.supplierLastSeen && <> · last seen <span title={exactTime(tire.supplierLastSeen)}>{timeAgo(tire.supplierLastSeen)}</span></>}</>
                        : <>{tire.supplierStock === null || tire.supplierStock === undefined ? 'stock not shown' : `${tire.supplierStock} in stock`}{tire.supplierLastSeen && <> · seen <span title={exactTime(tire.supplierLastSeen)}>{timeAgo(tire.supplierLastSeen)}</span></>}</>}
                    </dd></div>
                  )}
                  <div><dt>Location:</dt> <dd>{request.location}</dd></div>
                  <div><dt>Preferred Date:</dt> <dd>{request.date}</dd></div>
                  <div><dt>Contact:</dt> <dd>{request.customerEmail ? <>{request.customerName} · <a href={`mailto:${request.customerEmail}`}>{request.customerEmail}</a>{request.customerPhone && <> · <a href={`tel:${request.customerPhone}`}>{formatPhone(request.customerPhone)}</a></>}</> : <span className="text-secondary">No contact on file (submitted before this was collected)</span>}</dd></div>
                </dl>
                {/* The supplier's count is a fact the card shows (#170); this is the judgement on it (#105):
                    shown only while the supplier still lists the tire and shows none, never for a
                    delisted tire, whose own row already says so. A note after the list, like the
                    card's other judgements, not a labelled fact inside it. */}
                {tire?.supplierStock === 0 && tire?.supplierActive !== false && <p className="status-note status-note-wait owner-stock-warning" role="status">Supplier shows none in stock. Check before sending.</p>}
                {quote && (() => {
                  // A draft with its editor closed: most quotes need no
                  // adjustment, so the default view is the read-only lines
                  // and Approve & Send, not seven input fields (sprint item
                  // 4). Opening the editor is a deliberate second step.
                  const draftCollapsed = quote.status === 'draft' && reasonDraft?.requestId !== request.id && !expandedIds.has(request.id)
                  const draftExpanded = quote.status === 'draft' && reasonDraft?.requestId !== request.id && expandedIds.has(request.id)
                  return (
                  <div className={quote.exception ? 'owner-quote owner-quote-exception' : 'owner-quote'}>
                    <div className="owner-quote-summary"><div><p className="text-secondary">{quote.status === 'draft' ? 'Draft Quote' : ['sent', 'approved', 'paid', 'done'].includes(quote.status) ? 'Sent Quote' : 'Quote'}</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div><span className="owner-quote-status">{STATUS_LABEL[quote.status] ?? quote.status}</span></div>
                    {quote.exception && quote.status === 'draft' && <div className="owner-exception-note"><p>Owner review required</p><ul>{quote.exceptionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
                    {/* Editing and confirming a decision (cancel or decline) both
                        want this card's attention at once, so while a reason
                        prompt is open for this request the editor steps aside
                        for the read-only lines -- otherwise two textareas
                        ("Note for customer" and "Why is this being cancelled/
                        declined?") sit on screen together, and price fields the
                        owner is about to close out of stay editable underneath
                        a confirmation asking whether to do that. */}
                    {draftExpanded && <>
                      <QuoteEditor key={quote.version} request={request} quote={quote} busy={busyId === request.id} onSave={saveAdjustment} />
                      <button type="button" className="link-action quote-editor-collapse" disabled={busyId === request.id} onClick={() => collapseEditor(request.id)}>Cancel adjusting</button>
                    </>}
                    {(quote.status !== 'draft' || reasonDraft?.requestId === request.id || draftCollapsed) && <div className="quote-lines quote-lines-readonly">
                      {quote.lineItems?.map((item, index) => <div className="quote-line-readonly" key={`${index}-${item.description}`}><span>{item.quantity} × {item.description}</span><strong>${money(item.quantity * item.unitPrice)}</strong></div>)}
                      {quote.note && <p className="quote-customer-note"><strong>Customer note:</strong> {quote.note}</p>}
                    </div>}
                    {CLOSED_NOTE[quote.status] && <p className="status-note status-note-wait">
                      {CLOSED_NOTE[quote.status]}{quote.reason ? ` ${quote.reason}` : ''}
                    </p>}
                    {ACTIONS[quote.status] && <div className="owner-actions">
                      {reasonDraft?.requestId === request.id ? (
                        <div className="owner-cancel-draft">
                          <label htmlFor={`cancel-reason-${request.id}`}>{REASON_PROMPT[reasonDraft.action].question} <span className="optional">The customer will see this. Leave blank to say nothing.</span></label>
                          <textarea id={`cancel-reason-${request.id}`} rows={2} value={reasonDraft.reason}
                            onChange={event => setReasonDraft(draft => ({ ...draft, reason: event.target.value }))} />
                          <div className="owner-cancel-draft-actions">
                            <button type="button" className="btn btn-neutral" disabled={busyId === request.id} onClick={() => setReasonDraft(null)}>Back</button>
                            <button type="button" className="btn btn-reject" disabled={busyId === request.id} onClick={() => confirmReason(request, quote)}>
                              {busyId === request.id ? REASON_PROMPT[reasonDraft.action].confirmBusy : REASON_PROMPT[reasonDraft.action].confirmLabel}
                            </button>
                          </div>
                        </div>
                      ) : (<>
                        {draftCollapsed && <>
                          <button type="button" className="btn btn-approve" disabled={busyId === request.id} onClick={() => runAction(request, quote, 'approve')}>
                            {busyId === request.id ? 'Sending…' : 'Approve & Send'}
                          </button>
                          <button type="button" className="btn btn-neutral" disabled={busyId === request.id} onClick={() => expandEditor(request.id)}>Adjust quote</button>
                        </>}
                        {ACTIONS[quote.status].map(item => (
                          <button key={item.action} className={item.className} disabled={busyId === request.id}
                            onClick={() => act(request, quote, item)}>
                            {busyId === request.id && item.busy ? item.busy : item.label}
                          </button>
                        ))}
                      </>)}
                    </div>}
                  </div>
                  )
                })()}
              </div>
              )
            })}
          </div>
        )}
      </div>
      <PrivacyFooter navigate={navigate} />
    </div>
  )
}

export default QuoteRequests
