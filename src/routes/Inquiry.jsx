import { useState } from 'react'
import { submitInquiry } from '../store.js'
import { PrivacyFooter } from './Privacy.jsx'

export default function Inquiry({ navigate }) {
  const [form, setForm] = useState({ name: '', contact: '', vehicleInfo: '', message: '' })
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const change = event => setForm(previous => ({ ...previous, [event.target.name]: event.target.value }))
  const submit = async event => {
    event.preventDefault(); setError(''); setSending(true)
    try { await submitInquiry(form); setSent(true) } catch (failure) { setError(failure.message) } finally { setSending(false) }
  }
  return <div className="app-shell status-shell"><nav className="internal-nav"><button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button><div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/')}>← Order tires</button></div></nav><main className="owner-content inquiry-page"><p className="eyebrow">MORE THAN TIRES</p><h1 className="owner-heading">Tell me what you need</h1>{sent ? <section className="panel inquiry-received" role="status"><h2>I got your message.</h2><p>I&apos;ll read it and text you back using the contact you left.</p><button className="btn btn-primary" onClick={() => navigate('/')}>Order tires instead</button></section> : <form className="panel inquiry-form" onSubmit={submit} noValidate><p>Flat repairs, roadside help and anything else that keeps you moving.</p><label>Name<input name="name" value={form.name} onChange={change} autoComplete="name" required /></label><label>Phone or email<input name="contact" value={form.contact} onChange={change} autoComplete="email" required /></label><label>Vehicle (optional)<input name="vehicleInfo" value={form.vehicleInfo} onChange={change} /></label><label>What do you need?<textarea name="message" value={form.message} onChange={change} required rows="5" /></label>{error && <p className="status-note status-note-bad" role="alert">{error}</p>}<button className="btn btn-primary" disabled={sending}>{sending ? 'Sending…' : 'Send message'}</button></form>}</main><PrivacyFooter navigate={navigate} /></div>
}
