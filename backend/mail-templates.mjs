// The messages Ken sends, one per event (R25), as data plus a renderer.
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

// The number and its sms: link come from the one place that owns them, so the
// email and the screens can never offer different ones (t63, src/contact.js).
import { SHOP_NUMBER, TEXT_HREF } from '../src/contact.js'

const MOBILE = 'Ken\'s Mobile Tire'
const PHONE = SHOP_NUMBER

export const MAIL_TYPES = ['request-received', 'request-arrived', 'quote-sent', 'payment-recorded', 'quote-declined']

const money = value => `$${Number(value).toFixed(2)}`

/**
 * The quote's lines, subtotal, tax and total, as the customer will read them.
 *
 * Lines always sum to the subtotal; when tax is off, `total` equals it and
 * this prints exactly what it always has. Once tax is on, `total` is larger
 * than the visible line arithmetic -- a customer doing their own addition
 * would land on the subtotal, not the total, and read the gap as an
 * overcharge rather than tax, so the subtotal and tax get their own line
 * (finding 2, the scrutiny agent's third pass: this used to print lines and
 * a bare total with no explanation for the difference).
 */
function invoice(lines, subtotal, tax, total) {
  const rows = lines.map(line => `${line.description} × ${line.quantity} @ ${money(line.unitPrice)} = ${money(line.quantity * line.unitPrice)}`)
  const taxLines = tax ? `\nSubtotal: ${money(subtotal)}\nTax (${Math.round(tax.rate * 10000) / 100}%): ${money(tax.amount)}` : ''
  return `${rows.join('\n')}${taxLines}\nTotal: ${money(total)}`
}

/**
 * The HTML part, which is the one a mail client actually shows when both are
 * present. It used to escape the body into a `<pre>` and stop there, so the
 * two things every message asks the reader to do -- open their status page,
 * text Ken -- arrived as bare text. Whether either was tappable depended on
 * the client guessing, and `sms:` is never guessed. t63 had already made
 * texting the only way to reach him, so the email offered no working route
 * at all: a person at hour six could read the number and not dial it.
 *
 * Both patterns are our own content and are matched after escaping: the
 * status URL the template built from `origin`, and the number `src/contact.js`
 * owns. The plain-text part is deliberately left alone -- a client showing
 * that part linkifies bare URLs itself, and an anchor there would be markup
 * the reader can see.
 */
function htmlOf(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const smsHref = TEXT_HREF.replace(/&/g, '&amp;')
  const number = SHOP_NUMBER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linked = escaped
    .replace(/https:\/\/\S+/g, url => `<a href="${url}">${url}</a>`)
    .replace(new RegExp(number, 'g'), match => `<a href="${smsHref}">${match}</a>`)
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111"><pre style="font:inherit;white-space:pre-wrap">${linked}</pre></body></html>`
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
    // t64's "Anything else I should know?": free text the customer wrote, in
    // OUTBOX_PERSONAL_DATA_KEYS with the rest so a removal request blanks it.
    customerNotes: request.customerNotes ?? null,
    requestId: request.id,
    vehicleInfo: request.vehicleInfo ?? null,
    tireName: tire?.name ?? quote?.lineItems?.[0]?.description ?? null,
    tireSize: tire?.size ?? null,
    quantity: request.quantity ?? quote?.lineItems?.[0]?.quantity ?? null,
    locationType: request.locationType ?? null,
    serviceZip: request.serviceZip ?? null,
    date: request.date ?? null,
    // The quote's own field is lineItems everywhere else in the codebase
    // (quotes.mjs, the API, the owner and customer screens). This read the
    // wrong name from the day it shipped -- always undefined, so `invoice()`
    // below rendered zero rows on every quote-sent and payment-recorded
    // email ever sent, and the two fallbacks above never once fired.
    lines: quote?.lineItems ?? [],
    subtotal: quote?.subtotal ?? null,
    tax: quote?.tax ?? null,
    total: quote?.total ?? null,
    note: quote?.note ?? null,
    statusUrl: `${origin}/status?request=${encodeURIComponent(request.id)}`,
    ownerUrl: `${origin}/owner/quotes?request=${encodeURIComponent(request.id)}`,
  }
}

const signoff = `\n\nText me at ${PHONE} if anything changes.\n\n— Ken\n${MOBILE}`

export const TEMPLATES = {
  'request-received': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      // The vehicle is optional at intake, so the phrase is too: without this
      // the line read "... (225/50R17) on your , to be fitted at home".
      const onYour = d.vehicleInfo ? ` on your ${d.vehicleInfo}` : ''
      const text = `Hi ${d.to_name},\n\nGot your request for ${d.quantity} × ${d.tireName}${d.tireSize ? ` (${d.tireSize})` : ''}${onYour}, to be fitted at ${d.locationType?.toLowerCase() || 'your location'} on ${d.date}.\n\nI'll look it over and send you a quote. Nothing is charged until I do. Your request is here:\n${d.statusUrl}${signoff}`
      return { subject: `Got your tire request, ${d.to_name}`, text, html: htmlOf(text) }
    },
  },
  'request-arrived': {
    version: 1,
    audience: 'owner',
    data: baseData,
    render: d => {
      const notes = d.customerNotes && String(d.customerNotes).trim() ? `\n\nAnything else I should know?\n${String(d.customerNotes).trim()}` : ''
      const text = `A new request is waiting for you.\n\n${d.quantity} × ${d.tireName}${d.tireSize ? ` (${d.tireSize})` : ''}\nVehicle: ${d.vehicleInfo || 'not given'}\nWhere: ${d.locationType || ''} ${d.serviceZip || ''}\nWhen: ${d.date}${notes}\n\nDraft total: ${d.total == null ? '(none)' : money(d.total)}\n\nReview it here:\n${d.ownerUrl}`
      return { subject: `New request: ${d.quantity} × ${d.tireName}${d.tireSize ? ` ${d.tireSize}` : ''}`, text, html: htmlOf(text) }
    },
  },
  'quote-sent': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      const text = `Hi ${d.to_name},\n\nYour quote is ready.\n\n${invoice(d.lines, d.subtotal, d.tax, d.total)}${d.note ? `\n\nA note from me:\n${d.note}` : ''}\n\nView it and pay here:\n${d.statusUrl}${signoff}`
      return { subject: `Your quote from ${MOBILE}: ${money(d.total)}`, text, html: htmlOf(text) }
    },
  },
  'payment-recorded': {
    version: 1,
    audience: 'customer',
    data: baseData,
    render: d => {
      const text = `Hi ${d.to_name},\n\nPayment received. Thank you.\n\n${invoice(d.lines, d.subtotal, d.tax, d.total)}\n\nYour receipt and the service details are here:\n${d.statusUrl}${signoff}`
      return { subject: `Receipt from ${MOBILE}: ${money(d.total)}`, text, html: htmlOf(text) }
    },
  },
  // The decline, in Ken's first person (t62-voice.md part F as corrected by
  // #258; decisions.md, 2026-09-06). The reason is carried only when Ken
  // wrote one: the colon and the reason appear together or neither appears,
  // and a blank is Ken choosing to say nothing, never a guess made for him.
  // That is the shape the screen already uses (QuoteRequests.jsx, the closed
  // note), so the email and the screen describe the same event the same way.
  // It names the request by size and date so the customer knows which one,
  // gives one way back (text him), and carries no payment link and no
  // invitation to reply by email: nothing is owed, nothing reads that mailbox.
  'quote-declined': {
    version: 1,
    audience: 'customer',
    data: ctx => {
      const written = typeof ctx.quote?.reason === 'string' ? ctx.quote.reason.trim() : ''
      return { ...baseData(ctx), reason: written || null }
    },
    render: d => {
      const size = d.tireSize ? ` (${d.tireSize})` : ''
      const which = `${d.quantity} × ${d.tireName}${size} for ${d.date}`
      const line = d.reason ? `I can't take this one on: ${d.reason}.` : `I can't take this one on.`
      const text = `Hi ${d.to_name},\n\nAbout your request for ${which}.\n\n${line} You haven't been charged. Text me at ${PHONE} if you'd like to talk it through.\n\n— Ken`
      return { subject: `About your tire request${d.tireSize ? `, ${d.tireSize}` : ''}`, text, html: htmlOf(text) }
    },
  },
}
