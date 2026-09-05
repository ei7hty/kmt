import { useCallback, useEffect, useState } from 'react'
import SignIn from '../owner/SignIn.jsx'
import { NeedsSignIn, decideQuote, ownerRequests } from '../store'

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
function QuoteRequests({ navigate, ownerVersion, setOwnerVersion }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRequests(await ownerRequests())
      setError('')
      setNeedsSignIn(false)
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    } finally { setLoading(false) }
  }, [])

  // Scheduled rather than called in the effect body, the way OwnerInventory
  // does it: a synchronous setState here cascades a render.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load, ownerVersion])

  async function decide(request, quote, decision) {
    setBusyId(request.id)
    setError('')
    try {
      await decideQuote(request.id, decision, quote.version)
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
    return <SignIn onSignedIn={load} navigate={navigate}
      what="This screen holds customers' requests: their vehicle, address and preferred date." />
  }

  return (
    <div className="app-shell owner-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home">KMT<span>.</span></button>
        <div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/owner')}>← Inventory</button><button className="btn btn-neutral" onClick={() => navigate('/')}>Back to Customer Flow</button></div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">OWNER</p>
        <h1 className="owner-heading">Quote Requests</h1>
        <p className="text-secondary owner-subhead" role="status">
          {loading ? 'Loading requests…' : requests.length === 1 ? '1 request waiting on you.' : `${requests.length} requests waiting on you.`}
        </p>
        {error && <div className="panel"><p className="status-note status-note-bad" role="alert">{error}</p><button className="btn btn-neutral" onClick={load}>Try again</button></div>}
        {!loading && !error && requests.length === 0 ? <div className="panel"><p className="text-secondary">No requests yet. Go to the customer flow and submit a request.</p></div> : (
          <div className="owner-list">
            {requests.map(({ request, quote, tire }) => (
              <div key={request.id} className="panel owner-request">
                <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                <dl className="owner-details">
                  <div><dt>Tire:</dt> <dd>{tire?.name ? `${tire.name} · ${tire.size}` : `${tire?.id ?? request.tireSelection} (no longer in the catalog)`}</dd></div>
                  <div><dt>Location:</dt> <dd>{request.location}</dd></div>
                  <div><dt>Preferred Date:</dt> <dd>{request.date}</dd></div>
                </dl>
                {quote && <div className={quote.exception ? 'owner-quote owner-quote-exception' : 'owner-quote'}>
                  <div className="owner-quote-summary"><div><p className="text-secondary">Draft Quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div><span className="owner-quote-status">{quote.status}</span></div>
                  {quote.exception && <div className="owner-exception-note"><p>Owner review required</p><ul>{quote.exceptionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
                  {quote.status === 'draft' && <div className="owner-actions">
                    <button onClick={() => decide(request, quote, 'approved')} className="btn btn-approve" disabled={busyId === request.id}>
                      {busyId === request.id ? 'Sending…' : 'Approve & Send'}
                    </button>
                    <button onClick={() => decide(request, quote, 'rejected')} className="btn btn-reject" disabled={busyId === request.id}>Reject</button>
                  </div>}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default QuoteRequests
