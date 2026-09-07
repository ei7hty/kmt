import { useCallback, useEffect, useState } from 'react'
import SignIn from '../owner/SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { NeedsSignIn, ownerOutbox, resendOutboxMessage, resolveOutboxMessage } from '../store'
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

/**
 * A resolved row reads differently depending on what it was resolved from.
 * A `failed` row's resolution means the attempt really was rejected and Ken
 * has since dealt with it -- rotated a credential, told a customer by hand.
 * A `queued` row's means the opposite: nothing was ever attempted and
 * nothing will be, and resolving it only records that the gap is accounted
 * for. The two must never share one word (the OWNER AGENT's ruling); this
 * is the one place that word gets chosen.
 */
function resolvedLabel(status) {
  return status === 'failed' ? 'Resolved' : 'Abandoned'
}

/** The note field's own limit, kept beside the control that shows it rather than only in the backend that enforces it. */
const NOTE_LIMIT = 500
const RESENDABLE_STATUSES = new Set(['queued', 'failed', 'sent'])

function Outbox({ navigate }) {
  useNoIndex()
  const [provider, setProvider] = useState('none')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // Which failed row is mid-way through "mark resolved", and the note typed
  // for it. One draft, not one per row: only one resolve control is ever
  // open at a time, the same as Status.jsx's cancel-confirm.
  const [resolvingId, setResolvingId] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [resolveBusyId, setResolveBusyId] = useState('')
  const [confirmingResendId, setConfirmingResendId] = useState('')
  const [resendBusyId, setResendBusyId] = useState('')

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

  async function resolve(id) {
    setResolveBusyId(id)
    try {
      await resolveOutboxMessage(id, noteDraft)
      setResolvingId('')
      setNoteDraft('')
    } catch (err) {
      setError(err.message)
    } finally {
      setResolveBusyId('')
      await load()
    }
  }

  async function resend(id) {
    if (resendBusyId) return
    setResendBusyId(id)
    setError('')
    try {
      const updated = await resendOutboxMessage(id)
      setMessages(current => current.map(message => message.id === id ? updated : message))
      setConfirmingResendId('')
    } catch (err) {
      setError(err.message)
    } finally {
      setResendBusyId('')
    }
  }

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
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
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
              const canResend = RESENDABLE_STATUSES.has(message.status)
              const needsDuplicateConfirmation = message.deliveryRisk === 'possible-duplicate'
              return (
                <div key={message.id} className="panel owner-request">
                  <div className="owner-request-head">
                    <p className="owner-request-vehicle">{TYPE_LABELS[message.type] ?? message.type}</p>
                    <span className={`status-note ${status.note}`}>{status.label}</span>
                  </div>
                  <p className="owner-request-age" title={exactTime(message.createdAt)}>
                    To {message.toName} &lt;{message.to}&gt; · {timeAgo(message.createdAt)}
                  </p>
                  {/* error and resolutionNote are separate columns on the server for a
                      reason (backend/outbox.mjs): error is the provider's own diagnostic --
                      the thing that turns "mail is failing" into "the credential is dead" --
                      and resolutionNote is what Ken typed about it later. Shown as two
                      distinctly labelled lines, never merged into one, so neither can be
                      mistaken for the other. */}
                  {message.error && <p className="status-note status-note-bad" role="alert"><strong>Error:</strong> {message.error}</p>}
                  {message.resolvedAt && (
                    <p className="status-note status-note-ok">
                      <strong>{resolvedLabel(message.status)}</strong>
                      {message.resolutionNote ? `: ${message.resolutionNote}` : ''}
                    </p>
                  )}
                  {needsDuplicateConfirmation && canResend && (
                    <p className="status-note status-note-wait">
                      <strong>Delivery uncertain:</strong> this message may already have arrived. Resending could send a duplicate.
                    </p>
                  )}
                  {message.status === 'failed' && !message.resolvedAt && (
                    resolvingId === message.id ? (
                      <div className="owner-cancel-draft">
                        <label htmlFor={`resolve-note-${message.id}`}>What happened? <span className="optional">Optional -- read by whoever looks at this months from now.</span></label>
                        <textarea id={`resolve-note-${message.id}`} rows={2} value={noteDraft}
                          onChange={event => setNoteDraft(event.target.value)} />
                        {/* No maxLength on the textarea: capping input length silently
                            drops whatever was typed past it on paste, which is exactly the
                            truncation the server refuses to do -- a truncated note looks
                            complete, and half a note is a small lie with a timestamp. The
                            wall is shown, never hidden: the count goes visibly bad past the
                            limit and submitting is refused, but nothing typed is ever cut. */}
                        <p className={noteDraft.length > NOTE_LIMIT ? 'text-secondary status-note-bad' : 'text-secondary'}>
                          {noteDraft.length} / {NOTE_LIMIT}{noteDraft.length > NOTE_LIMIT ? ' -- too long, shorten it' : ''}
                        </p>
                        <div className="owner-cancel-draft-actions">
                          <button type="button" className="btn btn-neutral" disabled={resolveBusyId === message.id}
                            onClick={() => { setResolvingId(''); setNoteDraft('') }}>Back</button>
                          <button type="button" className="btn btn-primary"
                            disabled={resolveBusyId === message.id || noteDraft.length > NOTE_LIMIT}
                            onClick={() => resolve(message.id)}>
                            {resolveBusyId === message.id ? 'Resolving…' : 'Mark resolved'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="link-action" onClick={() => { setResolvingId(message.id); setNoteDraft('') }}>Mark resolved</button>
                    )
                  )}
                  {canResend && (
                    confirmingResendId === message.id ? (
                      <div className="owner-cancel-draft">
                        <p><strong>Send this exact message again?</strong></p>
                        <p className="text-secondary">The earlier attempt may already have reached the recipient, so this can create a duplicate.</p>
                        <div className="owner-cancel-draft-actions">
                          <button type="button" className="btn btn-neutral" disabled={resendBusyId === message.id}
                            onClick={() => setConfirmingResendId('')}>Back</button>
                          <button type="button" className="btn btn-primary" disabled={Boolean(resendBusyId)}
                            onClick={() => resend(message.id)}>
                            {resendBusyId === message.id ? 'Resending…' : 'Resend anyway'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="link-action" disabled={Boolean(resendBusyId)}
                        onClick={() => needsDuplicateConfirmation ? setConfirmingResendId(message.id) : resend(message.id)}>
                        {resendBusyId === message.id ? 'Resending…' : 'Resend'}
                      </button>
                    )
                  )}
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
