import { useEffect, useState } from 'react'
import './OwnerInventory.css'
import { PrivacyFooter } from '../routes/Privacy.jsx'

/**
 * The owner's sign-in gate, shared by both owner screens.
 *
 * It lived inside OwnerInventory when inventory was the only thing on this
 * server worth guarding. Quote requests are now here too -- a customer's
 * vehicle, address and preferred date -- so that screen needs the same gate,
 * and a copy of this form is a second thing to keep in step with auth.
 *
 * The local server has no password: it binds loopback, so whoever reaches it is
 * already at the keyboard, and nothing there returns 401. This is what a hosted
 * owner sees.
 */
export default function SignIn({ onSignedIn, navigate, what = 'this workspace', from = 'inventory' }) {
  // Whichever owner screen this is not, so the nav always offers the other one.
  const other = from === 'quotes'
    ? { path: '/owner', label: 'Inventory →' }
    : { path: '/owner/quotes', label: 'Quote requests →' }

  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Whether this server has an OAuth client at all. The button appears only
  // where pressing it would work: a local server and any deployment without
  // the two Google variables set answer `google: false`, and offering a door
  // that 404s is worse than not offering it.
  const [googleOffered, setGoogleOffered] = useState(false)
  // Default on preserves the existing door while the capability request is in
  // flight or fails. A server that explicitly answers `password: false` is the
  // only thing allowed to remove the form.
  const [passwordOffered, setPasswordOffered] = useState(true)
  useEffect(() => {
    let live = true
    fetch('/api/owner/session')
      .then(response => (response.ok ? response.json() : {}))
      .then(data => {
        if (!live) return
        setGoogleOffered(Boolean(data.google))
        if (typeof data.password === 'boolean') setPasswordOffered(data.password)
      })
      // A failure here leaves the established password path visible and hides
      // the unconfirmed Google path. Capability removal requires an explicit
      // server answer, never a network failure.
      .catch(() => {})
    return () => { live = false }
  }, [])

  // The callback sends every refusal here with the same flag -- a wrong
  // domain, an unverified address, a token minted for another application and
  // a replayed callback are one answer to whoever is holding them. The reason
  // is in the server log, where it can be acted on, and not in the browser,
  // where it would only tell someone which door to try next.
  const refused = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('signin') === 'refused'

  async function submit(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const response = await fetch('/api/owner/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const type = response.headers.get('content-type') || ''
      const data = type.includes('application/json') ? await response.json() : {}
      if (!response.ok) throw new Error(data.error || 'That password was not accepted.')
      setPassword('')
      onSignedIn()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  return <div className="oi-shell">
    {/* The way across stays on the page while the password is being asked for.
        Both owner screens are gated now, so this is not a way around the
        password -- it is a way not to be stranded on the one screen you did not
        want. Dropping it left an owner on /owner with no route to the quote
        list at all, which the dead-end audit caught. */}
    <nav className="oi-nav">
      <button className="oi-brand" onClick={() => navigate('/')}><img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
      <span>OWNER WORKSPACE</span>
      <button className="oi-button" onClick={() => navigate(other.path)}>{other.label}</button>
    </nav>
    <main className="oi-content">
      <form className="oi-signin" onSubmit={submit}>
        <p className="oi-kicker">OWNER ONLY</p>
        <h1>Sign in</h1>
        <p className="oi-muted">{what}</p>
        {refused && <p role="alert" className="oi-error">That account cannot open this workspace. Ask Ken.</p>}
        {googleOffered && <>
          {/* Primary, on the user's instruction: "PUSH GOOGLE LOGIN RETIRE
              BUILT IN PASSWORD IT IS INSECURE." A shared password proves only
              that someone knew a string -- no per-person identity, no
              revocation for one person, and no honest answer to "who approved
              this quote", which quotes.decided_by is about to start recording.
              So Google is the way in and the password is the fallback until
              the secret is unset. */}
          <a className="oi-button oi-primary oi-signin-google" href="/api/owner/session/google/start" data-testid="owner-signin-google">
            Sign in with Google
          </a>
          <p className="oi-muted oi-signin-hint">Use your @kensmobiletire.com account.</p>
          {passwordOffered && <p className="oi-signin-or">or use the password until it is switched off</p>}
        </>}
        {passwordOffered && <>
          <label htmlFor="owner-password">Password</label>
          <input id="owner-password" data-testid="owner-password" type="password" autoComplete="current-password"
            value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
          {/* Red marks the one primary action on a screen. Where Google is
              configured that is Google; where it is not, the password is the
              only way in and stays primary. */}
          <button type="submit" data-testid="owner-signin-submit" disabled={busy || !password}
            className={googleOffered ? 'oi-button' : 'oi-button oi-primary'}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </>}
        {error && <p role="alert" className="oi-error">{error}</p>}
      </form>
    </main>
    <PrivacyFooter navigate={navigate} />
  </div>
}
