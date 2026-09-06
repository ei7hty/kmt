// The messages the shop sends, one per event (R25), as data plus a renderer.
//
// Each template does two things and keeps them apart. `data()` picks, from the
// owner-audience request and its quote, exactly the fields the message is
// rendered from -- that object is what the outbox stores, structure not prose,
// with the personal keys under the names `OUTBOX_PERSONAL_DATA_KEYS` expects
// so a removal request can blank them by name. `render()` turns that data
// into a subject, a plain-text body and an HTML body at send time; nothing
// rendered is persisted, so a failed send is reproduced from the row's data
// and this file, and a redaction is a WHERE clause rather than a search.
//
// These renderings are functional, not designed: plain text and a thin HTML
// wrapper. The designed templates are LEAD UI ENGINEER's and arrive after
// t61; they replace `render()` here and nothing else changes. Bump `version`
// when a template's data shape changes, so an old row says which shape it is.

const MOBILE = 'Ken\'s Mobile Tire'

export const MAIL_TYPES = ['request-received', 'request-arrived', 'quote-sent', 'payment-recorded']

const money = value => `$${Number(value).toFixed(2)}`

/** The quote's lines and total, as the customer will read them. */
function invoice(lines, total) {
  const rows = lines.map(line => `${line.description} × ${line.quantity} @ ${money(line.unitPrice)} = ${money(line.quantity * line.unitPrice)}`)
  return `${rows.join('\n')}\nTotal: ${money(total)}`
}

function htmlOf(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111"><pre style="font:inherit;white-space:pre-wrap">${escaped}</pre></body></html>`
}

/**
 * What every message is rendered from. Personal fields carry the outbox's
 * names (`to_name`, `to_email`, `customerPhone`, `location`, `locationNotes`);
 * the business fields sit beside them. `tire` is resolved by the caller from
 * the catalog, because the request stores the tire's id, not its name.
 */
function baseData({ request, quote, tire, origin, to, toName }) {
  return {
    to_name: toName,
    to_email: to,
    customerPhone: request.customerPhone ?? null,
    location: request.location ?? null,
    locationNotes: request.locationNotes ?? null,
    // t64's "Anything else I should know?": free text the customer wrote, so
    // it belongs with the personal keys if the request's redaction takes it.
    customerNotes: request.customerNotes ?? null,
    requestId: request.id,
    vehicleInfo: request.vehicleInfo ?? null,
    tireName: tire?.name ?? quote?.lines?.[0]?.description ?? null,
    tireSize: tire?.size ?? null,
    quantity: request.quantity ?? quote?.lines?.[0]?.quantity ?? null,
    locationType: request.locationType ?? null,
    serviceZip: request.serviceZip ?? null,
    date: request.date ?? null,
    lines: quote?.lines ?? [],
    total: quote?.total ?? null,
    note: quote?.note ?? null,
    statusUrl: `${origin}/status?request=${encodeURIComponent(request.id)}`,
    ownerUrl: `${origin}/owner/quotes?request=${encodeURIComponent(request.id)}`,
  }
}

const signoff = `\n\n${MOBILE}\nReply to this email and it reaches the shop.`

export const TEMPLATES = {
  'request-received': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      const text = `Hi ${d.to_name},\n\nWe have your request for ${d.quantity} × ${d.tireName}${d.tireSize ? ` (${d.tireSize})` : ''} on your ${d.vehicleInfo}, to be fitted at ${d.locationType?.toLowerCase() || 'your location'} on ${d.date}.\n\nKen reviews every request before anything is charged. You will get a second email with the quote itself. Until then, your request is here:\n${d.statusUrl}${signoff}`
      return { subject: `We have your tire request, ${d.to_name}`, text, html: htmlOf(text) }
    },
  },
  'request-arrived': {
    version: 1,
    audience: 'owner',
    data: baseData,
    render: d => {
      const notes = d.customerNotes && String(d.customerNotes).trim() ? `\n\nAnything else I should know?\n${String(d.customerNotes).trim()}` : ''
      const text = `A new request is waiting for you.\n\n${d.quantity} × ${d.tireName}${d.tireSize ? ` (${d.tireSize})` : ''}\nVehicle: ${d.vehicleInfo}\nWhere: ${d.locationType || ''} ${d.serviceZip || ''}\nWhen: ${d.date}${notes}\n\nDraft total: ${d.total == null ? '(none)' : money(d.total)}\n\nReview it here:\n${d.ownerUrl}`
      return { subject: `New request: ${d.quantity} × ${d.tireName}${d.tireSize ? ` ${d.tireSize}` : ''}`, text, html: htmlOf(text) }
    },
  },
  'quote-sent': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      const text = `Hi ${d.to_name},\n\nYour quote is ready.\n\n${invoice(d.lines, d.total)}${d.note ? `\n\nA note from Ken:\n${d.note}` : ''}\n\nView it and pay here:\n${d.statusUrl}${signoff}`
      return { subject: `Your quote from ${MOBILE}: ${money(d.total)}`, text, html: htmlOf(text) }
    },
  },
  'payment-recorded': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      const text = `Hi ${d.to_name},\n\nPayment received. Thank you.\n\n${invoice(d.lines, d.total)}\n\nYour receipt and the service details are here:\n${d.statusUrl}${signoff}`
      return { subject: `Receipt from ${MOBILE}: ${money(d.total)}`, text, html: htmlOf(text) }
    },
  },
}
