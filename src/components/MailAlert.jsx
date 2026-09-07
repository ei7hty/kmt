import { useEffect, useState } from 'react'
import { NeedsSignIn, unresolvedOutboxFailures } from '../store'

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
 * Two silences look identical unless kept apart on purpose: "checked, and
 * it is clean" and "could not check." The first draft of this component
 * conflated them -- a fetch failure fell through the same catch as a
 * genuinely empty result, so a broken check and a healthy outbox both
 * rendered as nothing. That is the exact false-negative shape this badge
 * exists to prevent (the PROJECT MANAGER's read caught it before it
 * shipped that way). NeedsSignIn is the one error that stays silent on
 * purpose -- a session not yet established, or one that expired mid-visit,
 * is the parent screen's own case to handle, not this badge's to narrate.
 * Anything else means the check itself did not run, and says so rather
 * than reading as clean.
 */
function MailAlert({ navigate }) {
  const [count, setCount] = useState(null) // null: not yet known (loading, or not signed in)
  const [checkFailed, setCheckFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    unresolvedOutboxFailures()
      .then(messages => {
        if (cancelled) return
        setCount(messages.length)
        setCheckFailed(false)
      })
      .catch(err => {
        if (cancelled) return
        if (err instanceof NeedsSignIn) return // silent: the screen's own sign-in gate owns this case
        setCheckFailed(true)
      })
    return () => { cancelled = true }
  }, [])

  if (checkFailed) {
    return (
      <button type="button" className="mail-alert mail-alert-unknown" data-testid="mail-alert" onClick={() => navigate('/owner/outbox')}>
        Mail: could not check
      </button>
    )
  }

  if (!count) return null

  return (
    <button type="button" className="mail-alert" data-testid="mail-alert" onClick={() => navigate('/owner/outbox')}>
      Mail: {count} unresolved failure{count === 1 ? '' : 's'}
    </button>
  )
}

export default MailAlert
