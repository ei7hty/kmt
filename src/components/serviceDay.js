/**
 * Ken needs a week's notice: the earliest bookable day is seven days out.
 * The server enforces the real floor (backend/quotes.mjs); this is only
 * the number the form's own min and shortcuts are built from, so the two
 * never quietly drift apart.
 */
export const MIN_LEAD_DAYS = 7

/**
 * A calendar day, as the date input wants it, counted from today where the
 * van is. The server judges the floor on the Massachusetts calendar (t48),
 * so the floor on the input and the shortcuts are on the same calendar,
 * whatever the phone's clock says.
 */
export function serviceDay(days = 0) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
