import { getAllQuotes, getAllRequests, updateQuoteStatus } from '../store'

function Status({ navigate }) {
  const requests = getAllRequests()
  const quotes = getAllQuotes()
  const handlePayment = (quoteId) => { if (updateQuoteStatus(quoteId, 'paid')) navigate(`/confirmation?quoteId=${quoteId}`) }
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
        <p className="text-secondary owner-subhead">Track your request and the shop&apos;s decision.</p>
        {requests.length === 0 ? <div className="panel"><p className="text-secondary">No quote requests yet. Start one from the home page.</p></div> : (
          <div className="owner-list">
            {[...requests].reverse().map(request => {
              const quote = quotes.find(item => item.requestId === request.id)
              // Same three-beat stepper the customer already saw while ordering,
              // so the journey reads as one flow rather than two products.
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
                      {quote.status === 'approved' && <div className="owner-actions"><button onClick={() => handlePayment(quote.id)} className="btn btn-primary">Pay ${quote.total.toFixed(2)}</button></div>}
                      {quote.status === 'paid' && <div className="status-paid"><p className="status-note status-note-ok">Payment received. Your service is confirmed.</p><button className="link-action" onClick={() => navigate(`/confirmation?quoteId=${quote.id}`)}>View confirmation →</button></div>}
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
