/**
 * A timestamp as the owner reads it on a card.
 *
 * Relative while it is recent, because "3 hours ago" answers the question a
 * request list asks (how long has this person been waiting?); a date once it
 * is older than two days, because "51 hours ago" does not. The exact moment
 * belongs in a title, which is what `exactTime` is for.
 */
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const minutes = Math.round((now - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function exactTime(iso) {
  const then = Date.parse(iso)
  return Number.isFinite(then) ? new Date(then).toLocaleString() : ''
}
