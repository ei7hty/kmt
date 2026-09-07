import { useCallback, useEffect, useState } from 'react'
import './SocialProof.css'
import SignIn from './SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import {
  NeedsSignIn, createTestimonial, deleteTestimonial, ownerSocialProof,
  saveSocialProfiles, updateTestimonial,
} from '../store.js'
import { SOCIAL_PLATFORMS } from '../social-proof.js'
import { signOut } from './session.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'

const emptyReview = { kind: 'testimonial', text: '', attribution: '', source: '', sourceUrl: '', date: '', visible: true, order: 0 }

function SocialProofScreen({ navigate }) {
  useNoIndex()
  const [profiles, setProfiles] = useState([])
  const [reviews, setReviews] = useState([])
  const [profile, setProfile] = useState({ platform: 'facebook', url: '', enabled: true })
  const [review, setReview] = useState(emptyReview)
  const [editing, setEditing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerSocialProof()
      setProfiles(data.profiles || [])
      setReviews(data.testimonials || [])
      setNeedsSignIn(false)
      setError('')
    } catch (err) {
      if (err instanceof NeedsSignIn) setNeedsSignIn(true)
      else setError(err.message)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function saveProfile(event) {
    event.preventDefault()
    setSaving(true); setError(''); setNotice('')
    try {
      const data = await saveSocialProfiles([...profiles, profile])
      setProfiles(data.profiles || [])
      setProfile({ platform: 'facebook', url: '', enabled: true })
      setNotice('Profile saved. It will appear on the next marketing page load.')
    } catch (err) { if (err instanceof NeedsSignIn) setNeedsSignIn(true); else setError(err.message) }
    finally { setSaving(false) }
  }

  async function removeProfile(platform) {
    setSaving(true); setError(''); setNotice('')
    try {
      const data = await saveSocialProfiles(profiles.filter(item => item.platform !== platform))
      setProfiles(data.profiles || [])
      setNotice('Profile removed. It is no longer public.')
    } catch (err) { if (err instanceof NeedsSignIn) setNeedsSignIn(true); else setError(err.message) }
    finally { setSaving(false) }
  }

  async function setProfileEnabled(platform, enabled) {
    setSaving(true); setError(''); setNotice('')
    try {
      const data = await saveSocialProfiles(profiles.map(item => item.platform === platform ? { ...item, enabled } : item))
      setProfiles(data.profiles || [])
      setNotice(enabled ? 'Profile enabled. It is now live on marketing pages.' : 'Profile disabled. It is saved here but hidden from marketing pages.')
    } catch (err) { if (err instanceof NeedsSignIn) setNeedsSignIn(true); else setError(err.message) }
    finally { setSaving(false) }
  }

  async function saveReview(event) {
    event.preventDefault()
    setSaving(true); setError(''); setNotice('')
    try {
      const data = editing ? await updateTestimonial(editing, review) : await createTestimonial(review)
      setReviews(data.testimonials || [])
      setReview(emptyReview)
      setEditing(null)
      setNotice(editing ? 'Review updated.' : 'Review saved.')
    } catch (err) { if (err instanceof NeedsSignIn) setNeedsSignIn(true); else setError(err.message) }
    finally { setSaving(false) }
  }

  async function removeReview(id) {
    setSaving(true); setError(''); setNotice('')
    try {
      const data = await deleteTestimonial(id)
      setReviews(data.testimonials || [])
      if (editing === id) { setEditing(null); setReview(emptyReview) }
      setNotice('Review removed. It is no longer public.')
    } catch (err) { if (err instanceof NeedsSignIn) setNeedsSignIn(true); else setError(err.message) }
    finally { setSaving(false) }
  }

  function editReview(item) {
    setEditing(item.id)
    setReview({ ...item })
    setNotice('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (needsSignIn) return <SignIn onSignedIn={load} navigate={navigate} from="social-proof" what="This screen changes your public social proof." />

  const leave = async () => {
    const { hosted } = await signOut()
    if (hosted) setNeedsSignIn(true); else navigate('/')
  }

  return <div className="app-shell owner-shell">
    <nav className="internal-nav">
      <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
      <div className="internal-nav-links"><button className="btn btn-neutral" onClick={() => navigate('/owner/site-copy')}>← Site copy</button><button className="btn btn-neutral" onClick={() => navigate('/owner/quotes')}>Quote Requests</button><button className="btn btn-neutral" onClick={leave}>Sign out</button></div>
    </nav>
    <main className="owner-content social-proof-page">
      <header className="owner-heading"><p className="eyebrow">PUBLIC TRUST</p><h1>Social proof</h1><p className="text-secondary">Add only profiles, reviews, and testimonials you have verified and permission to publish. Nothing appears publicly until it is enabled.</p></header>
      {loading && <p className="status-note status-note-wait" role="status">Loading social proof…</p>}
      {error && <p className="status-note status-note-bad" role="alert">{error}</p>}
      {notice && <p className="status-note status-note-ok" role="status">{notice}</p>}
      {!loading && <>
        <section className="panel social-proof-section"><h2>Verified profiles</h2><p className="text-secondary">Use the complete HTTPS profile URL copied from the profile page. Handles, search links, and shortened URLs are not accepted.</p>
          {profiles.length > 0 && <ul className="social-proof-list">{profiles.map(item => <li key={item.platform}><span><strong>{SOCIAL_PLATFORMS[item.platform]?.label || item.platform}</strong><small className={item.enabled ? 'social-proof-live' : 'social-proof-disabled'}>{item.enabled ? 'Live on marketing pages' : 'Saved, not live — enable to publish'}</small><small>{item.url}</small></span><div className="social-proof-actions"><button type="button" className="btn btn-neutral" onClick={() => setProfileEnabled(item.platform, !item.enabled)} disabled={saving}>{item.enabled ? 'Disable on marketing pages' : 'Enable on marketing pages'}</button><button type="button" className="btn btn-neutral" onClick={() => removeProfile(item.platform)} disabled={saving}>Remove</button></div></li>)}</ul>}
          <form className="social-proof-form" onSubmit={saveProfile}><label>Platform<select value={profile.platform} onChange={event => setProfile({ ...profile, platform: event.target.value })}>{Object.entries(SOCIAL_PLATFORMS).map(([key, value]) => <option value={key} key={key}>{value.label}</option>)}</select></label><label>Verified profile URL<input type="url" required value={profile.url} onChange={event => setProfile({ ...profile, url: event.target.value })} placeholder="https://www.example.com/your-profile/" /></label><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add profile'}</button></form>
        </section>
        <section className="panel social-proof-section"><h2>{editing ? 'Edit review' : 'Add a testimonial or external review'}</h2><p className="text-secondary">A testimonial is wording the owner entered with permission. An external review must link back to its source. Do not add ratings or endorsements that have not been supplied and verified.</p>
          <form className="social-proof-form" onSubmit={saveReview}><label>Type<select value={review.kind} onChange={event => setReview({ ...review, kind: event.target.value })}><option value="testimonial">Owner-entered testimonial</option><option value="external-review">External-platform review</option></select></label><label>Review wording<textarea required rows="5" value={review.text} onChange={event => setReview({ ...review, text: event.target.value })} /></label><label>Attribution<input required value={review.attribution} onChange={event => setReview({ ...review, attribution: event.target.value })} placeholder="Name or approved attribution" /></label><label>Source{review.kind === 'external-review' ? <input required value={review.source} onChange={event => setReview({ ...review, source: event.target.value })} placeholder="Platform or source name" /> : <input value={review.source} onChange={event => setReview({ ...review, source: event.target.value })} placeholder="Optional context" />}</label>{review.kind === 'external-review' && <label>Source URL<input type="url" required value={review.sourceUrl} onChange={event => setReview({ ...review, sourceUrl: event.target.value })} placeholder="https://…" /></label>}<label>Date (optional)<input type="date" value={review.date || ''} onChange={event => setReview({ ...review, date: event.target.value })} /></label><label>Display order<input type="number" min="0" value={review.order} onChange={event => setReview({ ...review, order: Number(event.target.value) })} /></label><label className="social-proof-check"><input type="checkbox" checked={review.visible} onChange={event => setReview({ ...review, visible: event.target.checked })} /> Publish on marketing pages</label><div className="social-proof-actions"><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add review'}</button>{editing && <button type="button" className="btn btn-neutral" onClick={() => { setEditing(null); setReview(emptyReview) }} disabled={saving}>Cancel edit</button>}</div></form>
        </section>
        <section className="social-proof-section"><h2>Saved reviews</h2>{reviews.length === 0 ? <p className="text-secondary">No reviews or testimonials saved. The marketing pages stay clear until you add verified content.</p> : <div className="social-proof-cards">{reviews.map(item => <article className="panel social-proof-owner-card" key={item.id}><div><span className="social-proof-kind">{item.kind === 'testimonial' ? 'Owner-entered testimonial' : 'External-platform review'}</span><blockquote>{item.text}</blockquote><p><strong>{item.attribution}</strong>{item.source && ` · ${item.source}`}{item.date && ` · ${item.date}`}</p><p className="text-secondary">{item.visible ? 'Public' : 'Hidden'} · order {item.order}</p></div><div className="social-proof-actions"><button type="button" className="btn btn-neutral" onClick={() => editReview(item)} disabled={saving}>Edit</button><button type="button" className="btn btn-neutral" onClick={() => removeReview(item.id)} disabled={saving}>Remove</button></div></article>)}</div>}</section>
      </>}
    </main><PrivacyFooter navigate={navigate} />
  </div>
}

export default SocialProofScreen
