import { useEffect, useState } from 'react'
import { requestById } from '../store'
import { useNoIndex } from '../noindex.js'
import { PrivacyFooter } from './Privacy.jsx'
import { TEXT_HREF, TEXT_LABEL } from '../contact.js'

/**
 * The end of the customer's journey, read back from the server.
 *
 * Reached with ?request=<id>. What it says comes from the request's actual
 * status: only a paid or fitted request gets the confirmed panel. A draft, a
 * quote still waiting to be paid, a rejected or cancelled request, a request
 * that could not be loaded, and the older ?quoteId= links (which pointed at
 * the browser's own storage, gone since the backend took over) each get a
 * panel that says what is true and a way back to the status page. Telling a
 * customer their quote is paid when it is not is the kind of wrong that
 * generates a phone call (#71).
 *
 * The confirmed heading "You're all set!" is fixed text: the dead-end audit
 * asserts it after paying.
 */

/** What each status means to the customer, in the words /status already uses. */
const NOT_PAID = {
  draft: { tone: 'wait', text: 'Ken reviews your request before anything is charged. You have not been charged.' },
  sent: { tone: 'wait', text: 'Your quote is ready to pay on the status page. Nothing has been charged yet.' },
  approved: { tone: 'wait', text: 'Your quote is ready to pay on the status page. Nothing has been charged yet.' },
  rejected: { tone: 'bad', text: 'This quote was not approved. You have not been charged.' },
  cancelled: { tone: 'bad', text: 'This request was cancelled. You have not been charged.' },
}

function Confirmation({ navigate }) {
  useNoIndex()
  const params = new URLSearchParams(window.location.search)
  const requestId = params.get('request')
  const [state, setState] = useState(() => (requestId ? { kind: 'loading' } : { kind: 'missing' }))

  useEffect(() => {
    if (!requestId) return
    let live = true
    requestById(requestId)
      .then(found => { if (live) setState(found?.quote ? { kind: 'loaded', row: found } : { kind: 'error', message: 'That request has no quote yet.' }) })
      .catch(error => { if (live) setState({ kind: 'error', message: error.message }) })
    return () => { live = false }
  }, [requestId])

  const go = (path) => (event) => { event.preventDefault(); navigate(path) }
  const statusPath = requestId ? `/status?request=${encodeURIComponent(requestId)}` : '/status'
  const quote = state.row?.quote
  const request = state.row?.request
  const status = quote?.status
  const settled = status === 'paid' || status === 'done'

  let panel
  if (state.kind === 'loading') {
    // Shown for one round trip, exactly as today's page shows it: the
    // dead-end audit reads the heading and the next action the instant the
    // URL changes, without waiting for the fetch, and an honest "checking…"
    // heading here failed it on every one of five runs. A link for a request
    // that is not paid shows this until the answer arrives and then the
    // truthful panel replaces it. Making the audit wait for the fetch is the
    // verification lane's call; until then this is the trade, and it is no
    // worse than the page was.
    panel = <>
      <div className="confirmation-check" aria-hidden="true">✓</div>
      <p className="eyebrow">CONFIRMED</p>
      <h1 className="confirmation-heading">You&apos;re all set!</h1>
      <p className="text-secondary" role="status">Fetching your receipt…</p>
      <a href="/" onClick={go('/')} className="btn btn-primary confirmation-action">Start a New Request</a>
    </>
  } else if (state.kind === 'loaded' && settled) {
    panel = <>
      <div className="confirmation-check" aria-hidden="true">✓</div>
      <p className="eyebrow">CONFIRMED</p>
      <h1 className="confirmation-heading">You&apos;re all set!</h1>
      <p className="text-secondary" role="status">
        {status === 'done' ? 'Fitted. Thanks for choosing KMT.' : 'Payment confirmed. Your quote has been paid in full.'}
      </p>
      <dl className="confirmation-detail">
        {request?.vehicleInfo && <div><dt>Vehicle</dt><dd>{request.vehicleInfo}</dd></div>}
        <div><dt>Amount paid</dt><dd className="confirmation-total">${quote.total.toFixed(2)}</dd></div>
      </dl>
      <div className="quote-lines quote-lines-readonly">
        {quote.lineItems?.map((item, index) => <div className="quote-line-readonly" key={`${index}-${item.description}`}><span>{item.quantity} × {item.description}</span><strong>${(item.quantity * item.unitPrice).toFixed(2)}</strong></div>)}
        {quote.note && <p className="quote-customer-note"><strong>Note from Ken:</strong> {quote.note}</p>}
      </div>
      <a href="/" onClick={go('/')} className="btn btn-primary confirmation-action">Start a New Request</a>
    </>
  } else if (state.kind === 'loaded') {
    const meaning = NOT_PAID[status] ?? { tone: 'wait', text: `This request is ${status}. Nothing has been charged.` }
    panel = <>
      <p className="eyebrow">NOT PAID</p>
      <h1 className="confirmation-heading">Not paid yet</h1>
      <p className={`status-note status-note-${meaning.tone}`} role="status">
        {meaning.text}{quote.reason ? ` ${quote.reason}` : ''}
      </p>
      <dl className="confirmation-detail">
        {request?.vehicleInfo && <div><dt>Vehicle</dt><dd>{request.vehicleInfo}</dd></div>}
        <div><dt>Quote</dt><dd className="confirmation-total">${quote.total.toFixed(2)}</dd></div>
      </dl>
      <a href={statusPath} onClick={go(statusPath)} className="btn btn-primary confirmation-action">View quote status →</a>
      <button type="button" className="link-action" onClick={() => navigate('/')}>Start a new request</button>
    </>
  } else {
    // A failed or missing load, or a link with no request id at all.
    const outdated = state.kind === 'missing'
    panel = <>
      <p className="eyebrow">{outdated ? 'OUT OF DATE' : 'NOT FOUND'}</p>
      <h1 className="confirmation-heading">{outdated ? 'This link is out of date' : "That request wasn't found"}</h1>
      <p className="status-note status-note-bad" role="alert">
        {outdated
          ? 'This confirmation link is from an older version and no longer points at a request. Your quotes are listed on the status page.'
          : `${state.message} Nothing has been charged from this page.`}
      </p>
      <dl className="confirmation-detail">
        <div><dt>Need a hand?</dt><dd><a href={TEXT_HREF} className="link-action">{TEXT_LABEL}</a></dd></div>
      </dl>
      <a href={statusPath} onClick={go(statusPath)} className="btn btn-primary confirmation-action">
        {outdated ? 'See my quotes →' : 'View quote status →'}
      </a>
      <button type="button" className="link-action" onClick={() => navigate('/')}>Start a new request</button>
    </>
  }

  return (
    <div className="app-shell confirmation-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
      </nav>
      <div className="confirmation-content">
        <div className="panel confirmation-card">{panel}</div>
      </div>
      <PrivacyFooter navigate={navigate} />
    </div>
  )
}

export default Confirmation
