import { useCallback, useEffect, useState } from 'react'
import { cancelRequest, myRequests, payRequest, requestById } from '../store'
import { PrivacyFooter } from './Privacy.jsx'

/**
 * What the customer sees after asking for a quote.
 *
 * Two ways in. Without a parameter it lists what this device asked for, which
 * is what the key in localStorage is for. With ?request=<id> it shows that one
 * request, so a link works on any device -- the id is the access, and it is
 * 128 bits from the server's CSPRNG rather than something a stranger guesses.
 */

/**
 * Where each status sits in the journey.
 *
 * `approved` is `sent` under the name decisions were written with before the
 * lifecycle landed; the deployed database holds one, and it is the same beat.
 */
const STAGE = { draft: 2, sent: 3, approved: 3, paid: 4, done: 4 }

/** The statuses a customer can still call their own request off from. */
const CANCELLABLE = ['draft', 'sent', 'approved']

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

  async function callOff(id) {
    // Asked for, because there is no undo from this screen: the customer would
    // have to submit the request again from the start.
    if (!window.confirm('Cancel this request? You would have to start a new one.')) return
    setBusyId(id)
    setError('')
    try {
      await cancelRequest(id)
    } catch (err) {
      setError(err.message)
    } finally {
      await load()
      setBusyId('')
    }
  }

  return (
    <div className="app-shell status-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links">
          <button className="btn btn-neutral" onClick={() => navigate('/')}>← New Request</button>
        </div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">YOUR QUOTE</p>
        <h1 className="owner-heading">Quote Status</h1>
        <p className="text-secondary" role="note">Save this link; it is how you find your quote again.</p>
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
              // The same stepper the customer saw while ordering, so the
              // journey reads as one flow rather than two products. It gained a
              // fourth beat when paid stopped being the end of it: the tires
              // still have to go on the car.
              const stage = quote ? STAGE[quote.status] ?? 1 : 1
              const stopped = quote?.status === 'rejected' || quote?.status === 'cancelled'
              const step = (number, label) => (
                <div className={stage > number ? 'order-step complete'
                  : stage === number ? 'order-step current' : 'order-step'}>
                  <span>{number}</span>{label}
                </div>
              )
              return (
                <div key={request.id} className="panel owner-request">
                  <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                  {/* A stopped request has no next beat, and a stepper pointing
                      at one would be telling the customer to wait for something
                      that is not coming. */}
                  {!stopped && <div className="order-steps status-steps">
                    {step(1, 'Requested')}
                    {step(2, 'Owner review')}
                    {step(3, 'Pay & confirm')}
                    <div className={quote?.status === 'done' ? 'order-step complete'
                      : stage === 4 ? 'order-step current' : 'order-step'}>
                      <span>4</span>Fitted
                    </div>
                  </div>}
                  {quote ? (
                    <div className="owner-quote">
                      {/* The tire line always carries how many: reading it
                          back here is how the customer sees the quantity
                          the quote was actually priced for. */}
                      {(() => {
                        const tireLine = quote.lineItems?.find(item => item.description !== 'Mobile installation service')
                        return tireLine && <p className="text-secondary owner-quote-item">{tireLine.quantity} × {tireLine.description}</p>
                      })()}
                      <div className="owner-quote-summary">
                        <div><p className="text-secondary">Your quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div>
                        <span className="owner-quote-status">{quote.status}</span>
                      </div>
                      {quote.status === 'draft' && <p className="status-note status-note-wait">This quote is awaiting owner review.</p>}
                      {(quote.status === 'sent' || quote.status === 'approved') && <div className="owner-actions"><button onClick={() => pay(request.id)} className="btn btn-primary" disabled={busyId === request.id}>{busyId === request.id ? 'Paying…' : `Pay $${quote.total.toFixed(2)}`}</button></div>}
                      {quote.status === 'paid' && <div className="status-paid"><p className="status-note status-note-ok">Payment received. Your service is confirmed.</p><button className="link-action" onClick={() => navigate(`/confirmation?request=${encodeURIComponent(request.id)}`)}>View confirmation →</button></div>}
                      {quote.status === 'done' && <div className="status-paid"><p className="status-note status-note-ok">Fitted. Thanks for choosing KMT.</p><button className="link-action" onClick={() => navigate(`/confirmation?request=${encodeURIComponent(request.id)}`)}>View confirmation →</button></div>}
                      {quote.status === 'rejected' && <p className="status-note status-note-bad">
                        This quote was declined.{quote.reason ? ` ${quote.reason}` : ''} Please submit a new request.
                      </p>}
                      {quote.status === 'cancelled' && <p className="status-note status-note-bad">
                        This request was cancelled.{quote.reason ? ` ${quote.reason}` : ''} You have not been charged.
                      </p>}
                      {CANCELLABLE.includes(quote.status) && <button className="link-action" disabled={busyId === request.id}
                        onClick={() => callOff(request.id)}>Cancel this request</button>}
                    </div>
                  ) : <p className="text-secondary">Quote is being prepared.</p>}
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

export default Status
