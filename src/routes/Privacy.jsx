/**
 * The privacy notice (t50): what KMT collects, why, who sees it, how long
 * it is kept, how to have it removed, and what the status link is.
 *
 * The wording matches docs/data-policy.md on purpose -- "your name, contact
 * details and address" is what a removal request redacts, and the quote
 * itself stays as the record of what was sold. If the policy narrows, this
 * page changes with it, not the other way round.
 */
function Privacy({ navigate }) {
  const go = (to) => (event) => { event.preventDefault(); navigate(to) }
  return (
    <div className="app-shell status-shell">
      <nav className="internal-nav">
        <button className="brand-word" onClick={() => navigate('/')} aria-label="KMT home"><img src="/brand/icon-64.png" alt="" width="64" height="64" className="brand-mark-icon" />KEN&apos;S<span> MOBILE TIRE</span></button>
        <div className="internal-nav-links"><a href="/" onClick={go('/')} className="btn btn-neutral">← Order tires</a></div>
      </nav>
      <div className="owner-content">
        <p className="eyebrow">PRIVACY</p>
        <h1 className="owner-heading">How KMT handles your details</h1>
        <div className="panel privacy-panel">
          <h2>What Ken&apos;s Mobile Tire collects</h2>
          <p>Your name, your email address, your mobile number if you give one, the address where the vehicle is, any notes on finding it, and the vehicle and tires you chose.</p>
          <h2>Why</h2>
          <p>To draft your quote, to reach you about it, and to come to the right place with the right tires.</p>
          <h2>Who sees it</h2>
          <p>Ken does. The tire supplier never does; it only ever hears which sizes are wanted.</p>
          <h2>How long it is kept</h2>
          <p>Your request and quote are kept as the record of what was quoted, approved and paid. They are not deleted automatically.</p>
          <h2>Removing your details</h2>
          <p>To ask for your name, contact details and address to be removed, call <span className="privacy-number">(617) 410-8319</span>. The quote itself stays, as the record of what was sold.</p>
          <h2>Your status link</h2>
          <p>The link to your quote is private to whoever holds it. Anyone with the link can see the quote, so keep it to yourself.</p>
          <h2>Analytics</h2>
          <p>This page and the homepage use Google Analytics to count visits. It is never used on the page that shows your own request or receipt, or on Ken&apos;s review screen, and it is never linked to your name, email or phone number.</p>
        </div>
      </div>
      <PrivacyFooter navigate={navigate} />
    </div>
  )
}

/** The one link every screen carries at its foot. */
export function PrivacyFooter({ navigate }) {
  return <footer className="page-footer"><a href="/privacy" onClick={(event) => { event.preventDefault(); navigate('/privacy') }}>Privacy</a></footer>
}

export default Privacy
