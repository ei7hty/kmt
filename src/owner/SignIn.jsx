import { useState } from 'react'
import './OwnerInventory.css'

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
export default function SignIn({ onSignedIn, navigate, what = 'this workspace' }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    <nav className="oi-nav">
      <button className="oi-brand" onClick={() => navigate('/')}>KMT<span>.</span></button>
      <span>OWNER WORKSPACE</span>
    </nav>
    <main className="oi-content">
      <form className="oi-signin" onSubmit={submit}>
        <p className="oi-kicker">OWNER ONLY</p>
        <h1>Sign in</h1>
        <p className="oi-muted">{what}</p>
        <label htmlFor="owner-password">Password</label>
        <input id="owner-password" type="password" autoComplete="current-password" value={password}
          onChange={e => setPassword(e.target.value)} disabled={busy} />
        <button type="submit" className="oi-button oi-primary" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        {error && <p role="alert" className="oi-error">{error}</p>}
      </form>
    </main>
  </div>
}
