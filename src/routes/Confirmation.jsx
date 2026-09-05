import { getAllQuotes, getAllRequests } from '../store'

function Confirmation({ navigate }) {
  const quoteId = new URLSearchParams(window.location.search).get('quoteId')
  const quote = getAllQuotes().find(item => item.id === quoteId)
  const request = quote ? getAllRequests().find(item => item.id === quote.requestId) : null
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
