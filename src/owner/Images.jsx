import { useCallback, useEffect, useState } from 'react'
import './Images.css'
import SignIn from './SignIn.jsx'
import { useNoIndex } from '../noindex.js'
import { NeedsSignIn, decideImagePacket, ownerImagePackets } from '../store.js'
import { signOut } from './session.js'
import { PrivacyFooter } from '../routes/Privacy.jsx'

// A packet moves imported -> approved -> revoked, one step each way, and the
// server enforces it. The screen only ever offers the step the packet is
// actually at: an approved packet has no Approve button, so a mis-click cannot
// ask for a transition the server will refuse.
const NEXT_ACTION = { imported: 'approved', approved: 'revoked' }
const STATE_LABEL = { imported: 'Waiting for you', approved: 'Live on the site', revoked: 'Taken down' }
const ACTION_LABEL = { approved: 'Approve', revoked: 'Take down' }

const shortDigest = digest => (typeof digest === 'string' ? digest.slice(0, 12) : '')

function ImagesScreen({ navigate }) {
  useNoIndex()
  const [packets, setPackets] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await ownerImagePackets()
      setPackets(data.packets || [])
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

  async function decide(packet) {
    const action = NEXT_ACTION[packet.action]
    if (!action || busy) return
    setBusy(packet.digest)
    setError(''); setNotice('')
    try {
      const updated = await decideImagePacket(packet.digest, action, packet.version)
      setPackets(current => current.map(row => (row.digest === updated.digest ? updated : row)))
      setNotice(action === 'approved'
        ? 'Approved. These photos are on the site now.'
        : 'Taken down. Customers see the plain card again.')
    } catch (err) {
      if (err instanceof NeedsSignIn) setNeedsSignIn(true)
      // A refusal here is usually the packet having moved in another tab, so
      // reload rather than leave a stale version on screen to be retried.
      else { setError(err.message); load() }
    } finally { setBusy('') }
  }

  const leave = () => signOut(navigate)

  if (needsSignIn) return <SignIn onSignedIn={load} />

  return (
    <div className="oi-shell">
      <nav className="oi-nav">
        <button className="oi-brand" onClick={() => navigate('/')}>
          <img src="/brand/icon-64.png?v=2" alt="" width="64" height="64" className="brand-mark-icon" />
          KEN&apos;S<span> MOBILE TIRE</span>
        </button>
        <span>PRODUCT PHOTOS</span>
        <button className="oi-button" data-testid="nav-inventory" onClick={() => navigate('/owner')}>← Inventory</button>
        <button className="oi-button" onClick={leave}>Sign out</button>
      </nav>

      <main className="ip-main">
        <header className="ip-heading">
          <h1>Product photos</h1>
          <p>Photos you approve here show on the tire cards customers pick from. Nothing appears until you approve it.</p>
        </header>

        {error && <p className="ip-error" role="alert" data-testid="images-error">{error}</p>}
        {notice && <p className="ip-notice" role="status" data-testid="images-notice">{notice}</p>}

        {loading && <p className="ip-empty">Loading…</p>}

        {/* Only claim the list is empty when it was actually read. A failed load
            also leaves `packets` empty, and "no photos have been imported yet"
            is then a statement about the server we never got an answer from. */}
        {!loading && !error && !packets.length && (
          <p className="ip-empty" data-testid="images-empty">
            No photos have been imported yet. When a batch is brought in it appears here for you to approve.
          </p>
        )}

        {!loading && packets.map(packet => {
          const action = NEXT_ACTION[packet.action]
          const working = busy === packet.digest
          return (
            <section className="ip-packet" key={packet.digest} data-testid="image-packet">
              <div className="ip-packet-head">
                <div>
                  <h2>{packet.assets?.length || 0} photo{packet.assets?.length === 1 ? '' : 's'}</h2>
                  <p className={`ip-state ip-state-${packet.action}`} data-testid="image-packet-state">
                    {STATE_LABEL[packet.action] || packet.action}
                  </p>
                </div>
                {action && (
                  <button
                    className={action === 'approved' ? 'btn btn-primary' : 'btn btn-neutral'}
                    data-testid={`image-${action}`}
                    disabled={working}
                    onClick={() => decide(packet)}
                  >
                    {working ? 'Saving…' : ACTION_LABEL[action]}
                  </button>
                )}
              </div>

              <ul className="ip-grid">
                {(packet.assets || []).map((asset, index) => {
                  const candidate = packet.candidates?.[index]
                  return (
                    <li className="ip-tile" key={asset.sha256}>
                      {/* Every packet shows its real photos, whatever state it is
                          in. Approving a picture you cannot see is not a
                          decision, and this screen exists to make the decision.
                          The bytes come from the owner-only route, which is
                          keyed by packet and ordinal and answers for imported,
                          approved and revoked alike -- deliberately not the
                          public `/api/images/...` path, which releases approved
                          bytes only and stops answering the moment the supplier
                          row moves underneath it. Using it here would leave the
                          owner looking at a broken frame on a packet he had
                          just approved. */}
                      <img className="ip-photo" loading="lazy" decoding="async"
                        src={`/api/owner/images/${packet.digest}/assets/${index}`}
                        alt={candidate?.supplierSku ? `Photo for ${candidate.supplierSku}` : 'Product photo'} />
                      <p className="ip-sku">{candidate?.supplierSku || shortDigest(asset.sha256)}</p>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </main>
      <PrivacyFooter />
    </div>
  )
}

export default ImagesScreen
