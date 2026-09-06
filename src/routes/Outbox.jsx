import { useCallback, useEffect, useState } from 'react'
import SignIn from '../owner/SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { NeedsSignIn, ownerOutbox } from '../store'
import { signOut } from '../owner/session.js'
import { exactTime, timeAgo } from '../owner/timeAgo.js'
import { PrivacyFooter } from './Privacy.jsx'

/**
 * What each message type reads as to Ken, rather than the taxonomy name
 * `mail.mjs` uses internally. A type this screen has never heard of (the
 * templates gain one before this file is updated) still needs to render as
 * something legible, not blank -- hence the fallback below rather than an
 * unlabelled lookup miss.
 */
const TYPE_LABELS = {
  'request-received': 'Request received (to customer)',
  'request-arrived': 'New request (to Ken)',
  'quote-sent': 'Quote sent (to customer)',
  'payment-recorded': 'Payment receipt (to customer)',
}

/**
 * Every status `OUTBOX_STATUSES` (backend/outbox.mjs) actually holds, mapped
 * to the amber/green/red vocabulary the rest of the owner screens already
 * use. A status this screen has never heard of falls back to neutral rather
 * than rendering nothing -- the whole point of this panel is that a failure
 * is never invisible.
 */
const STATUS_LABELS = {
  queued: { label: 'Queued', note: 'status-note-wait' },
  sent: { label: 'Sent', note: 'status-note-ok' },
  failed: { label: 'Failed', note: 'status-note-bad' },
  bounced: { label: 'Bounced', note: 'status-note-bad' },
}

function statusOf(status) {
  return STATUS_LABELS[status] ?? { label: status || 'Unknown', note: 'status-note-wait' }
}

function Outbox({ navigate }) {
  useNoIndex()
  const [provider, setProvider] = useState('none')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerOutbox()
      setProvider(data.provider)
      setMessages(data.messages)
      setError('')
      setNeedsSignIn(false)
    } catch (err) {
      if (err instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(err.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  if (needsSignIn) {
    return <SignIn onSignedIn={load} navigate={navigate} from="outbox"
      what="This screen holds a record of every message the app has sent, or tried to, on Ken's behalf." />
  }

  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) { setMessages([]); setNeedsSignIn(true) } else navigate('/')
  }

  return (
    <div className="app-shell owner-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/owner/quotes')}>← Quote Requests</button><button className="btn btn-neutral" onClick={() => navigate('/')}>Back to Customer Flow</button><button className="btn btn-neutral" onClick={leave}>Sign out</button></div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">OWNER</p>
        <h1 className="owner-heading">Outbox</h1>
        {/* The one line that matters most on this screen: with no provider
            configured every row below sits at Queued forever, and that is
            the app working as designed, not a fault. Said plainly so nobody
            reads a wall of "Queued" as email being broken. */}
        <p className="text-secondary owner-subhead" role="status">
          {provider === 'none'
            ? 'Email sending is not turned on yet. Nothing below has actually gone out -- these are the messages the app would send once a mailbox is connected.'
            : `Sending through ${provider}. This is every message the app has tried to send on your behalf.`}
        </p>
        {error && <div className="panel"><p className="status-note status-note-bad" role="alert">{error}</p><button className="btn btn-neutral" onClick={load}>Try again</button></div>}
        {!loading && !error && messages.length === 0 ? (
          <div className="panel"><p className="text-secondary">Nothing sent yet. This fills in as customers submit requests and quotes go out.</p></div>
        ) : (
          <div className="owner-list">
            {messages.map(message => {
              const status = statusOf(message.status)
              return (
                <div key={message.id} className="panel owner-request">
                  <div className="owner-request-head">
                    <p className="owner-request-vehicle">{TYPE_LABELS[message.type] ?? message.type}</p>
                    <span className={`status-note ${status.note}`}>{status.label}</span>
                  </div>
                  <p className="owner-request-age" title={exactTime(message.createdAt)}>
                    To {message.toName} &lt;{message.to}&gt; · {timeAgo(message.createdAt)}
                  </p>
                  {message.error && <p className="status-note status-note-bad" role="alert">{message.error}</p>}
                  <button className="btn btn-neutral" onClick={() => navigate(`/owner/quotes?request=${encodeURIComponent(message.requestId)}`)}>View request</button>
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

export default Outbox
