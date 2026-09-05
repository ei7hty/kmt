import { useCallback, useEffect, useState } from 'react'
import { myRequests, payRequest, requestById } from '../store'

/**
 * What the customer sees after asking for a quote.
 *
 * Two ways in. Without a parameter it lists what this device asked for, which
 * is what the key in localStorage is for. With ?request=<id> it shows that one
 * request, so a link works on any device -- the id is the access, and it is
 * 128 bits from the server's CSPRNG rather than something a stranger guesses.
 */
function Status({ navigate }) {
  const requested = new URLSearchParams(window.location.search).get('request')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(requested ? [await requestById(requested)] : await myRequests())
      setError('')
    } catch (err) {
      setError(err.message)
      setRows([])
    } finally { setLoading(false) }
  }, [requested])

  // Scheduled rather than called in the effect body, the way OwnerInventory
  // does it: a synchronous setState here cascades a render.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function pay(id) {
    setBusyId(id)
    setError('')
    try {
      await payRequest(id)
      navigate(`/confirmation?request=${encodeURIComponent(id)}`)
    } catch (err) {
      setError(err.message)
      await load()
    } finally { setBusyId('') }
  }

  return (
    <div className="app-shell status-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home">KMT<span>.</span></button>
        <div className="internal-nav-links">
          <button className="btn btn-neutral" onClick={() => navigate('/')}>← New Request</button>
          <button className="btn btn-neutral" onClick={() => navigate('/owner')}>Owner Review →</button>
        </div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">YOUR QUOTE</p>
        <h1 className="owner-heading">Quote Status</h1>
        <p className="text-secondary owner-subhead" role="status">
          {loading ? 'Checking with the shop…' : 'Track your request and the shop’s decision.'}
        </p>
        {error && <div className="panel">
          <p className="status-note status-note-bad" role="alert">{error}</p>
          <div className="tire-empty-actions">
            <button className="btn btn-neutral" onClick={load}>Try again</button>
            <a className="btn btn-primary" href="tel:6174108319">Call (617) 410-8319</a>
          </div>
        </div>}
        {!loading && !error && rows.length === 0 ? <div className="panel"><p className="text-secondary">No quote requests yet. Start one from the home page.</p></div> : (
          <div className="owner-list">
            {rows.filter(Boolean).map(({ request, quote }) => {
              // The same three-beat stepper the customer saw while ordering, so
              // the journey reads as one flow rather than two products.
              const stage = !quote ? 1 : quote.status === 'draft' ? 2 : 3
              return (
                <div key={request.id} className="panel owner-request">
                  <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                  <div className="order-steps status-steps">
                    <div className={stage > 1 ? 'order-step complete' : 'order-step current'}><span>1</span>Requested</div>
                    <div className={stage > 2 ? 'order-step complete' : stage === 2 ? 'order-step current' : 'order-step'}><span>2</span>Owner review</div>
                    <div className={stage === 3 ? 'order-step current' : 'order-step'}><span>3</span>Pay &amp; confirm</div>
                  </div>
                  {quote ? (
                    <div className="owner-quote">
                      <div className="owner-quote-summary">
                        <div><p className="text-secondary">Your quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div>
                        <span className="owner-quote-status">{quote.status}</span>
                      </div>
                      {quote.status === 'draft' && <p className="status-note status-note-wait">This quote is awaiting owner review.</p>}
                      {quote.status === 'approved' && <div className="owner-actions"><button onClick={() => pay(request.id)} className="btn btn-primary" disabled={busyId === request.id}>{busyId === request.id ? 'Paying…' : `Pay $${quote.total.toFixed(2)}`}</button></div>}
                      {quote.status === 'paid' && <div className="status-paid"><p className="status-note status-note-ok">Payment received. Your service is confirmed.</p><button className="link-action" onClick={() => navigate(`/confirmation?request=${encodeURIComponent(request.id)}`)}>View confirmation →</button></div>}
                      {quote.status === 'rejected' && <p className="status-note status-note-bad">This quote was declined. Please submit a new request.</p>}
                    </div>
                  ) : <p className="text-secondary">Quote is being prepared.</p>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default Status
