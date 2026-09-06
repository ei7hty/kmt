import { useCallback, useEffect, useState } from 'react'
import SignIn from '../owner/SignIn.jsx'
import { NeedsSignIn, actOnQuote, ownerRequests } from '../store'

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
    { action: 'approve', label: 'Approve & Send', busy: 'Sending…', className: 'btn btn-approve' },
    { action: 'reject', label: 'Reject', className: 'btn btn-reject' },
    { action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true },
  ],
  sent: [{ action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true }],
  approved: [{ action: 'cancel', label: 'Cancel', className: 'btn btn-neutral', asks: true }],
  paid: [{ action: 'done', label: 'Mark done', busy: 'Closing…', className: 'btn btn-approve' }],
}

/** What a closed request says about itself, before any reason it carries. */
const CLOSED_NOTE = {
  done: 'Fitted and closed.',
  rejected: 'Rejected, so the customer was not charged.',
  cancelled: 'Cancelled before payment.',
}

function QuoteRequests({ navigate, ownerVersion, setOwnerVersion }) {
  const [view, setView] = useState('open')
  const [requests, setRequests] = useState([])
  const [counts, setCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerRequests(view)
      setRequests(data.requests)
      setCounts(data.counts)
      setError('')
      setNeedsSignIn(false)
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    } finally { setLoading(false) }
  }, [view])

  // Scheduled rather than called in the effect body, the way OwnerInventory
  // does it: a synchronous setState here cascades a render.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load, ownerVersion])

  async function act(request, quote, { action, asks }) {
    // Cancelling is the one action with something to say, and the customer is
    // the one who reads it. Nothing else asks, because nothing else needs to.
    let reason = ''
    if (asks) {
      const answered = window.prompt('Why is this being cancelled? The customer will see it. Leave blank to say nothing.')
      if (answered === null) return
      reason = answered.trim()
    }

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

  if (needsSignIn) {
    return <SignIn onSignedIn={load} navigate={navigate} from="quotes"
      what="This screen holds customers' requests: their vehicle, address and preferred date." />
  }

  // What the owner is asked to do, whichever view they are looking at.
  const waiting = counts.attention ?? 0
  const summary = loading
    ? 'Loading requests…'
    : waiting === 1 ? '1 request waiting on you.' : `${waiting} requests waiting on you.`

  return (
    <div className="app-shell owner-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand-mark.svg" alt="" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/owner')}>← Inventory</button><button className="btn btn-neutral" onClick={() => navigate('/')}>Back to Customer Flow</button></div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">OWNER</p>
        <h1 className="owner-heading">Quote Requests</h1>
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
        {!loading && !error && requests.length === 0 ? <div className="panel"><p className="text-secondary">{view === 'open' ? 'No open requests. Go to the customer flow and submit one.' : 'Nothing here right now.'}</p></div> : (
          <div className="owner-list">
            {requests.map(({ request, quote, tire }) => {
              // The tire line always carries how many, drafted once and never
              // recomputed here: reading it back is how the owner sees the
              // same quantity the quote was actually priced for.
              const tireLine = quote?.lineItems?.find(item => item.description !== 'Mobile installation service')
              return (
              <div key={request.id} className="panel owner-request">
                <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                <dl className="owner-details">
                  <div><dt>Tire:</dt> <dd>{tire?.name ? `${tireLine ? `${tireLine.quantity} × ` : ''}${tire.name} · ${tire.size}` : `${tire?.id ?? request.tireSelection} (no longer in the catalog)`}</dd></div>
                  <div><dt>Location:</dt> <dd>{request.location}</dd></div>
                  <div><dt>Preferred Date:</dt> <dd>{request.date}</dd></div>
                  <div><dt>Contact:</dt> <dd>{request.customerEmail ? <>{request.customerName} · <a href={`mailto:${request.customerEmail}`}>{request.customerEmail}</a>{request.customerPhone && <> · <a href={`tel:${request.customerPhone}`}>{request.customerPhone}</a></>}</> : <span className="text-secondary">No contact on file (submitted before this was collected)</span>}</dd></div>
                </dl>
                {quote && <div className={quote.exception ? 'owner-quote owner-quote-exception' : 'owner-quote'}>
                  <div className="owner-quote-summary"><div><p className="text-secondary">Draft Quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div><span className="owner-quote-status">{quote.status}</span></div>
                  {quote.exception && <div className="owner-exception-note"><p>Owner review required</p><ul>{quote.exceptionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
                  {CLOSED_NOTE[quote.status] && <p className="status-note status-note-wait">
                    {CLOSED_NOTE[quote.status]}{quote.reason ? ` ${quote.reason}` : ''}
                  </p>}
                  {ACTIONS[quote.status] && <div className="owner-actions">
                    {ACTIONS[quote.status].map(item => (
                      <button key={item.action} className={item.className} disabled={busyId === request.id}
                        onClick={() => act(request, quote, item)}>
                        {busyId === request.id && item.busy ? item.busy : item.label}
                      </button>
                    ))}
                  </div>}
                </div>}
              </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default QuoteRequests
