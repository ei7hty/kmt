/**
 * The screen for a path the app does not have.
 *
 * Routing is an exact match on the pathname, so anything unknown used to fall
 * through to the customer home with no sign that anything was wrong: an owner
 * who typed a wrong path landed on the order form (#76). This says so, shows
 * the path, and offers the three places a person here could have meant. It
 * changes no route: a known path never reaches it.
 */
import { PrivacyFooter } from './Privacy.jsx'

function NotFound({ navigate, path }) {
  const go = (to) => (event) => { event.preventDefault(); navigate(to) }
  return (
    <div className="app-shell status-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">NOT FOUND</p>
        <h1 className="owner-heading">That page isn&apos;t here</h1>
        <div className="panel">
          <p className="status-note status-note-bad" role="alert">There is nothing at <code>{path}</code>.</p>
          <p className="text-secondary">If you followed a link, it may be out of date. These are the pages that exist:</p>
          <div className="tire-empty-actions">
            <a href="/" onClick={go('/')} className="btn btn-primary">Order tires</a>
            <a href="/status" onClick={go('/status')} className="btn btn-neutral">My quote</a>
            <a href="/owner" onClick={go('/owner')} className="btn btn-neutral">Owner review</a>
          </div>
        </div>
      </div>
      <PrivacyFooter navigate={navigate} />
    </div>
  )
}

export default NotFound
