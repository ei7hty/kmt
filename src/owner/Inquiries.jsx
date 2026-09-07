import { useCallback, useEffect, useState } from 'react'
import { NeedsSignIn, moveInquiry, ownerInquiries } from '../store.js'
import { useNoIndex } from '../noindex.js'
import SignIn from './SignIn.jsx'
import { signOut } from './session.js'
import { exactTime, timeAgo } from './timeAgo.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'
import MailAlert from '../components/MailAlert.jsx'

const NEXT = {
  new: [{ status: 'replied', label: 'Mark replied' }, { status: 'closed', label: 'Close' }],
  replied: [{ status: 'closed', label: 'Close' }],
  closed: [],
}

export function InquiryNavButton({ navigate, className = 'btn btn-neutral' }) {
  const [count, setCount] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    ownerInquiries().then(result => { if (current) setCount(result.counts.new ?? 0) }).catch(error => {
      if (current && !(error instanceof NeedsSignIn)) setFailed(true)
    })
    return () => { current = false }
  }, [])
  const suffix = failed ? ' ?' : count ? ` ${count}` : ''
  return <button className={className} data-testid="nav-inquiries" aria-label={failed ? 'Inquiries, count unavailable' : `Inquiries, ${count ?? 0} new`} onClick={() => navigate('/owner/inquiries')}>Inquiries{suffix}</button>
}

export default function Inquiries({ navigate }) {
  useNoIndex()
  const [data, setData] = useState({ counts: {}, inquiries: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await ownerInquiries()); setError(''); setNeedsSignIn(false) }
    catch (failure) {
      if (failure instanceof NeedsSignIn) { setNeedsSignIn(true); setError('') }
      else setError(failure.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer) }, [load])

  const advance = async (id, status) => {
    setBusyId(id); setError('')
    try { await moveInquiry(id, status); await load() }
    catch (failure) { setError(failure.message) }
    finally { setBusyId('') }
  }

  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) { setData({ counts: {}, inquiries: [] }); setNeedsSignIn(true) } else navigate('/')
  }

  if (needsSignIn) return <SignIn onSignedIn={load} navigate={navigate} from="inquiries" what="This screen holds customers' names, contact details and messages." />

  return <div className="app-shell owner-shell">
    <nav className="internal-nav"><button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button><div className="internal-nav-links"><MailAlert navigate={navigate} /><button className="btn btn-neutral" onClick={() => navigate('/owner')}>Inventory</button><button className="btn btn-neutral" onClick={() => navigate('/owner/quotes')}>Quote requests</button><button className="btn btn-neutral" onClick={leave}>Sign out</button></div></nav>
    <main className="owner-content owner-inquiries">
      <p className="eyebrow">OWNER</p><h1 className="owner-heading">Inquiries</h1>
      <p className="text-secondary owner-subhead" role="status">{loading ? 'Loading inquiries…' : `${data.counts.new ?? 0} new · ${data.counts.replied ?? 0} replied · ${data.counts.closed ?? 0} closed`}</p>
      {error && <section className="panel"><p className="status-note status-note-bad" role="alert">{error}</p><button className="btn btn-neutral" onClick={load}>Try again</button></section>}
      {!loading && !error && data.inquiries.length === 0 && <section className="panel" data-testid="inquiries-empty"><h2>No inquiries yet</h2><p className="text-secondary">Messages from the “more than tires” form will appear here.</p></section>}
      <div className="owner-list">{data.inquiries.map(inquiry => <article className="panel inquiry-card" key={inquiry.id} data-status={inquiry.status}>
        <div className="inquiry-card-head"><div><p className="eyebrow">{inquiry.status}</p><h2>{inquiry.name}</h2></div><time dateTime={inquiry.createdAt} title={exactTime(inquiry.createdAt)}>{timeAgo(inquiry.createdAt)}</time></div>
        <a className="inquiry-contact" href={inquiry.contact.includes('@') ? `mailto:${inquiry.contact}` : `tel:${inquiry.contact}`}>{inquiry.contact}</a>
        {inquiry.vehicleInfo && <p><strong>Vehicle:</strong> {inquiry.vehicleInfo}</p>}
        <p className="inquiry-message">{inquiry.message}</p>
        {NEXT[inquiry.status]?.length > 0 && <div className="owner-actions">{NEXT[inquiry.status].map(action => <button key={action.status} className={action.status === 'replied' ? 'btn btn-approve' : 'btn btn-neutral'} disabled={busyId === inquiry.id} onClick={() => advance(inquiry.id, action.status)}>{busyId === inquiry.id ? 'Saving…' : action.label}</button>)}</div>}
      </article>)}</div>
    </main><PrivacyFooter navigate={navigate} />
  </div>
}
