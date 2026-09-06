/**
 * A calendar day, as the date input wants it, counted from today where the
 * van is. The server judges "today or later" on the Massachusetts calendar
 * (t48), so the floor on the input and the shortcuts are on the same
 * calendar, whatever the phone's clock says.
 */
export function serviceDay(days = 0) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
