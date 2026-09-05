import { getAllTires } from '../data/catalog'
import { getAllQuotes, getAllRequests, updateQuoteStatus } from '../store'

function QuoteRequests({ navigate, ownerVersion, setOwnerVersion }) {
  const tires = getAllTires()
  const requests = getAllRequests()
  const quotes = getAllQuotes()
  const handleQuoteStatus = (quoteId, status) => {
    if (updateQuoteStatus(quoteId, status)) setOwnerVersion(version => version + 1)
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
        <p className="text-secondary owner-subhead">{requests.length === 1 ? '1 request waiting on you.' : `${requests.length} requests waiting on you.`}</p>
        {requests.length === 0 ? <div className="panel"><p className="text-secondary">No requests yet. Go to the customer flow and submit a request.</p></div> : (
          <div className="owner-list">
            {requests.map(request => {
              const quote = quotes.find(item => item.requestId === request.id)
              // The owner thinks in vehicles and tire names, not record ids.
              const requestedTire = tires.find(tire => tire.id === request.tireSelection)
              return (
                <div key={`${request.id}-${ownerVersion}`} className="panel owner-request">
                  <p className="owner-request-vehicle">{request.vehicleInfo}</p>
                  <dl className="owner-details">
                    <div><dt>Tire:</dt> <dd>{requestedTire ? `${requestedTire.name} · ${requestedTire.size}` : request.tireSelection}</dd></div>
                    <div><dt>Location:</dt> <dd>{request.location}</dd></div>
                    <div><dt>Preferred Date:</dt> <dd>{request.date}</dd></div>
                  </dl>
                  {quote && <div className={quote.exception ? 'owner-quote owner-quote-exception' : 'owner-quote'}>
                    <div className="owner-quote-summary"><div><p className="text-secondary">Draft Quote</p><p className="owner-quote-total">${quote.total.toFixed(2)}</p></div><span className="owner-quote-status">{quote.status}</span></div>
                    {quote.exception && <div className="owner-exception-note"><p>Owner review required</p><ul>{quote.exceptionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
                    {quote.status === 'draft' && <div className="owner-actions"><button onClick={() => handleQuoteStatus(quote.id, 'approved')} className="btn btn-approve">Approve &amp; Send</button><button onClick={() => handleQuoteStatus(quote.id, 'rejected')} className="btn btn-reject">Reject</button></div>}
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
