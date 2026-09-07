import { useEffect, useState } from 'react'
import { unresolvedOutboxFailures } from '../store'

/**
 * A failed-mail count in the nav of a screen Ken actually opens, since
 * Outbox is not one of them (measured, not assumed -- see
 * .forge/NOTES.md). Silent when clean: this exists to be noticed exactly
 * when there is something to notice, not to reassure on every load that
 * nothing is wrong.
 *
 * The honest limit, worth carrying here in one line since the PR body is
 * not visible from the app: this only helps while Ken is looking at the
 * screen. It narrows "how long can this go unnoticed" to "until he next
 * opens the portal" -- it does not close that window the way a channel
 * outside the app (SMS, not built) would.
 *
 * Fails silently on purpose: a session that has not signed in yet, or one
 * that has expired mid-visit, should not turn a small nav badge into a
 * visible error on a screen whose main content already handles that case
 * properly.
 */
function MailAlert({ navigate }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    unresolvedOutboxFailures()
      .then(messages => { if (!cancelled) setCount(messages.length) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (count === 0) return null

  return (
    <button type="button" className="mail-alert" data-testid="mail-alert" onClick={() => navigate('/owner/outbox')}>
      Mail: {count} unresolved failure{count === 1 ? '' : 's'}
    </button>
  )
}

export default MailAlert
