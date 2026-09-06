import { useEffect, useState } from 'react'
import { requestById } from '../store'

/**
 * The end of the customer's journey, read back from the server.
 *
 * Reached with ?request=<id>. The older ?quoteId= links pointed at a row in the
 * browser's own storage, which no longer exists; a link like that now shows the
 * confirmation without the detail rather than a blank screen, because the
 * payment it is confirming did happen.
 */
function Confirmation({ navigate }) {
  const params = new URLSearchParams(window.location.search)
  const requestId = params.get('request')
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(Boolean(requestId))

  useEffect(() => {
    if (!requestId) return
    let live = true
    requestById(requestId)
      .then(found => { if (live) setRow(found) })
      .catch(() => { if (live) setRow(null) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [requestId])

  const quote = row?.quote
  const request = row?.request

  return (
    <div className="app-shell confirmation-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home">KMT<span>.</span></button>
      </nav>
      <div className="confirmation-content">
        <div className="panel confirmation-card">
          <div className="confirmation-check" aria-hidden="true">✓</div>
          <p className="eyebrow">CONFIRMED</p>
          <h1 className="confirmation-heading">You&apos;re all set!</h1>
          <p className="text-secondary" role="status">Payment confirmed. Your quote has been paid in full.</p>
          {loading && <p className="text-secondary">Fetching your receipt…</p>}
          {quote && <dl className="confirmation-detail">
            {request && <div><dt>Vehicle</dt><dd>{request.vehicleInfo}</dd></div>}
            <div><dt>Amount paid</dt><dd className="confirmation-total">${quote.total.toFixed(2)}</dd></div>
          </dl>}
          <a href="/" onClick={(event) => { event.preventDefault(); navigate('/') }} className="btn btn-primary confirmation-action">Start a New Request</a>
        </div>
      </div>
    </div>
  )
}

export default Confirmation
