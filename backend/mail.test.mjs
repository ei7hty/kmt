import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS } from './outbox.mjs'
import { Mailer, NullAdapter, SmtpAdapter, addressLabel, describeMail, readMailConfig } from './mail.mjs'
import { MAIL_TYPES, TEMPLATES } from './mail-templates.mjs'
import { createApi, createRequestsApi } from './api.mjs'

const SIZE = '215/60R16'
const tire = (id = 'giga-a') => ({ id, name: 'Test Touring', size: SIZE, price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' } })
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })
const KEY = 'a'.repeat(32)
/** Well clear of the server's 7-day date floor (t48), always ahead of today. */
const SOON = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
const form = () => ({ customerKey: KEY, tireSize: SIZE, tireSelection: 'giga-a', quantity: 4, vehicleInfo: '2020 Toyota Corolla',
  location: '456 Demo Ave, Everett, MA 02149', locationType: 'Home', serviceZip: '02149', locationNotes: 'Blue sedan, gate code 1234',
  date: SOON, customerName: 'Jamie Rivera', customerEmail: 'Jamie@Example.com', customerPhone: '6175550100' })
const CONFIG = { provider: 'smtp', host: 'smtp-relay.gmail.com', port: 587, user: 'quotes@kensmobiletire.com', password: 'app-password',
  from: 'quotes@kensmobiletire.com', ownerEmail: 'owner@example.com', ownerName: 'Ken' }

function world(t, { adapter, log } = {}) {
  const inventory = new Inventory(':memory:', [SIZE])
  t.after(() => inventory.close())
  inventory.importSnapshot(snapshot([tire()]))
  const quotes = new Quotes(inventory)
  const outbox = new Outbox(inventory.db)
  const lines = []
  const mailer = new Mailer({ outbox, quotes, adapter, config: CONFIG, origin: 'https://kensmobiletire.com/', log: log || (line => lines.push(line)) })
  return { inventory, quotes, outbox, mailer, lines }
}

/** A transporter that remembers what it was asked and answers as told; no socket is ever opened. */
function fakeSmtp(reply = { messageId: '<msg1@kensmobiletire.com>' }) {
  const calls = []
  const transporter = { async sendMail(message) { calls.push(message); if (reply instanceof Error) throw reply; return reply } }
  return { calls, adapter: new SmtpAdapter({ host: 'smtp-relay.gmail.com', port: 587, user: 'u', password: 'p', transporter }) }
}

test('the configuration is the environment: nothing set means the outbox-only mode; SMTP settings need their two addresses', () => {
  assert.equal(readMailConfig({}).provider, 'none')
  const relay = readMailConfig({ KMT_MAIL_SMTP_HOST: 'smtp-relay.gmail.com', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' })
  assert.equal(relay.provider, 'smtp', 'an allow-listed relay needs no credential')
  assert.equal(relay.port, 587)
  const mailbox = readMailConfig({ KMT_MAIL_SMTP_HOST: 'smtp.gmail.com', KMT_MAIL_SMTP_USER: 'q@x.com', KMT_MAIL_SMTP_PASSWORD: 'app', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' })
  assert.equal(mailbox.provider, 'smtp')
  assert.equal(mailbox.user, 'q@x.com')
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_OWNER_EMAIL: 'o@x.com' }), /KMT_MAIL_FROM.*authenticates on the sending server/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_OWNER_EMAIL: 'o@x.com' }), /SPF and DKIM/, 'the trap is named where the value is typed')
  try { readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_OWNER_EMAIL: 'o@x.com' }) } catch (error) { assert.doesNotMatch(error.message, /@kensmobiletire\.com/, 'and no domain address is offered as an example') }
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_MAIL_FROM: 'q@x.com' }), /KMT_OWNER_EMAIL/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_USER: 'u', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' }), /go together/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_MAIL_SMTP_PORT: 'lots', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' }), /port number/)
})

test('the boot warning fires on exactly one shape: a from-domain that differs from the authenticating mailbox', () => {
  const base = { KMT_MAIL_SMTP_HOST: 'smtp.gmail.com', KMT_OWNER_EMAIL: 'owner@x.com', KMT_CANONICAL_HOST: 'kensmobiletire.com' }
  const trap = readMailConfig({ ...base, KMT_MAIL_SMTP_USER: 'interim@gmail.com', KMT_MAIL_SMTP_PASSWORD: 'p', KMT_MAIL_FROM: 'quotes@kensmobiletire.com' })
  assert.equal(trap.warnings.length, 1)
  assert.match(trap.warnings[0], /kensmobiletire\.com.*SPF and DKIM.*filed as spam while the outbox records it sent/)
  const interim = readMailConfig({ ...base, KMT_MAIL_SMTP_USER: 'interim@gmail.com', KMT_MAIL_SMTP_PASSWORD: 'p', KMT_MAIL_FROM: 'interim@gmail.com' })
  assert.deepEqual(interim.warnings, [], 'the interim setup is silent')
  assert.equal(interim.interim, true, 'and flagged as interim, not the end state')
  const endState = readMailConfig({ ...base, KMT_MAIL_SMTP_USER: 'ken@kensmobiletire.com', KMT_MAIL_SMTP_PASSWORD: 'p', KMT_MAIL_FROM: 'quotes@kensmobiletire.com' })
  assert.deepEqual(endState.warnings, [], 'the end state is silent')
  assert.equal(endState.interim, false)
  const relay = readMailConfig({ ...base, KMT_MAIL_SMTP_HOST: 'smtp-relay.gmail.com', KMT_MAIL_FROM: 'quotes@kensmobiletire.com' })
  assert.deepEqual(relay.warnings, [], 'an allow-listed relay has no mailbox to compare against')
  assert.equal(readMailConfig({}).warnings.length, 0)
  assert.equal(readMailConfig({}).interim, false)
  const lines = describeMail(interim)
  assert.match(lines[0], /INTERIM sender/)
  assert.match(describeMail(trap).join('\n'), /WARNING:/)
  assert.match(describeMail(readMailConfig({}))[0], /nothing is sent/)
})

test('the SMTP adapter is STARTTLS on 587 and implicit TLS on 465, with auth only when a user is given', () => {
  const relay = new SmtpAdapter({ host: 'smtp-relay.gmail.com', port: 587 })
  assert.equal(relay.options.secure, false)
  assert.equal(relay.options.auth, undefined)
  const mailbox = new SmtpAdapter({ host: 'smtp.gmail.com', port: 465, user: 'q@x.com', password: 'app' })
  assert.equal(mailbox.options.secure, true)
  assert.deepEqual(mailbox.options.auth, { user: 'q@x.com', pass: 'app' })
  assert.throws(() => new SmtpAdapter({}), /needs a host/)
})

test('every template names its personal fields the way the outbox redacts them, and every type has one', () => {
  for (const type of MAIL_TYPES) assert.ok(TEMPLATES[type], `${type} has a template`)
  const data = TEMPLATES['quote-sent'].data({
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', vehicleInfo: 'v', quantity: 4 },
    quote: { lineItems: [{ description: 'T', quantity: 4, unitPrice: 50 }], total: 250 }, tire: { name: 'T', size: SIZE },
    origin: 'https://x', to: 'a@b.c', toName: 'A',
  })
  for (const key of OUTBOX_PERSONAL_DATA_KEYS) assert.ok(key in data, `${key} is a top-level key of the stored data`)
  const rendered = TEMPLATES['quote-sent'].render(data)
  assert.match(rendered.subject, /\$250\.00/)
  assert.match(rendered.text, /T × 4 @ \$50\.00 = \$200\.00/)
  assert.match(rendered.text, /https:\/\/x\/status\?request=r1/)
  assert.doesNotMatch(rendered.html, /<script/)
})

test('a taxed quote-sent email names the tax, not just the final total (owner-agent scrutiny finding 2)', () => {
  // baseData() used to pick lineItems/total off the quote and stop there;
  // subtotal and tax are real fields on a taxed quote (calculateDraftQuote,
  // src/pricing.js) but never reached the template, and invoice() only knew
  // how to print lines plus one flat total. A customer paying tax should
  // not have to do their own arithmetic against the line items to find out
  // whether -- or how much -- tax was charged. (Adapted from QA ENGINEER's
  // #317 regression test; the payload shape there predates the lines ->
  // lineItems fix in #320.)
  const data = TEMPLATES['quote-sent'].data({
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', vehicleInfo: 'v', quantity: 4 },
    quote: {
      lineItems: [{ description: 'T', quantity: 4, unitPrice: 50 }],
      subtotal: 200, tax: { rate: 0.1, appliesTo: 'all', amount: 20 }, total: 220,
    },
    tire: { name: 'T', size: SIZE },
    origin: 'https://x', to: 'a@b.c', toName: 'A',
  })
  const rendered = TEMPLATES['quote-sent'].render(data)
  assert.match(rendered.text, /Subtotal: \$200\.00/i, 'the email must name a subtotal separately from the total once tax is on')
  assert.match(rendered.text, /Tax \(10%\): \$20\.00/i, 'and how much tax, and at what rate')
  assert.match(rendered.text, /Total: \$220\.00/)
})

test('a quote with no tax renders exactly as it always has -- no subtotal line, no empty tax line', () => {
  const data = TEMPLATES['quote-sent'].data({
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', vehicleInfo: 'v', quantity: 4 },
    quote: { lineItems: [{ description: 'T', quantity: 4, unitPrice: 50 }], subtotal: 200, tax: null, total: 200 },
    tire: { name: 'T', size: SIZE },
    origin: 'https://x', to: 'a@b.c', toName: 'A',
  })
  const rendered = TEMPLATES['quote-sent'].render(data)
  assert.doesNotMatch(rendered.text, /subtotal/i)
  assert.doesNotMatch(rendered.text, /tax/i)
  assert.match(rendered.text, /Total: \$200\.00/)
})

test('the decline carries the reason only when Ken wrote one, names the request, and offers no payment link or email reply', () => {
  const declined = TEMPLATES['quote-declined']
  const ctx = {
    request: { id: 'r1', vehicleInfo: 'v', quantity: 4, date: '2026-09-10' },
    quote: { lines: [], total: 250, reason: null }, tire: { name: 'Test Touring', size: SIZE },
    origin: 'https://x', to: 'a@b.c', toName: 'Jamie',
  }
  const withReason = reason => declined.render(declined.data({ ...ctx, quote: { ...ctx.quote, reason } }))
  const blank = withReason(null)
  assert.match(blank.text, /I can't take this one on\. You haven't been charged\./, 'no reason: no colon and no hole')
  assert.doesNotMatch(blank.text, /on:/)
  assert.doesNotMatch(withReason('   ').text, /on:/, 'whitespace is no reason')
  assert.doesNotMatch(withReason(undefined).text, /on:/, 'a quote without the field is no reason')
  const spoken = withReason('that size is back-ordered until October')
  assert.match(spoken.text, /I can't take this one on: that size is back-ordered until October\. You haven't been charged\./, 'the colon and the reason appear together')
  for (const rendered of [blank, spoken]) {
    assert.match(rendered.text, /4 × Test Touring \(215\/60R16\) for 2026-09-10/, 'names the request by size and date')
    assert.match(rendered.text, /Text me at \(617\) 410-8319/, 'one way back')
    assert.match(rendered.text, /— Ken$/, "Ken's first person, and nothing after his name")
    assert.doesNotMatch(rendered.text, /status\?request=|\bpay\b|payment/i, 'no payment link: nothing is owed')
    assert.doesNotMatch(rendered.text, /reply/i, 'no invitation to reply by email: nothing reads that mailbox')
    assert.doesNotMatch(rendered.text, /\bwe\b|\bour\b/i, 'no "we"')
    assert.doesNotMatch(rendered.text, /sorry|apolog|call you|get back to you/i, 'no apology theatre, no callback promise')
    assert.doesNotMatch(rendered.html, /<script/)
  }
  assert.equal(declined.data({ ...ctx, quote: { ...ctx.quote, reason: ' as written ' } }).reason, 'as written', 'stored as its own key, trimmed, never rewritten')
  assert.equal(declined.data(ctx).reason, null)
  for (const key of OUTBOX_PERSONAL_DATA_KEYS) assert.ok(key in declined.data(ctx), `${key} is a top-level key of the stored data`)
  assert.equal(declined.audience, 'customer')
  assert.ok(MAIL_TYPES.includes('quote-declined'))
})

test('the owner alert shows what the customer added under "Anything else I should know?", and nothing when they added nothing', () => {
  const ctx = { request: { id: 'r1', vehicleInfo: 'v', quantity: 4, date: 'd' }, quote: { lines: [], total: 1 }, tire: { name: 'T', size: SIZE }, origin: 'https://x', to: 'o@x.com', toName: 'Ken' }
  const arrived = TEMPLATES['request-arrived']
  assert.doesNotMatch(arrived.render(arrived.data(ctx)).text, /Anything else/)
  assert.doesNotMatch(arrived.render(arrived.data({ ...ctx, request: { ...ctx.request, customerNotes: '   ' } })).text, /Anything else/)
  const spoken = arrived.render(arrived.data({ ...ctx, request: { ...ctx.request, customerNotes: 'Spare is on already, please hurry' } }))
  assert.match(spoken.text, /Anything else I should know\?\nSpare is on already, please hurry/)
  assert.equal(arrived.data({ ...ctx, request: { ...ctx.request, customerNotes: 'x' } }).customerNotes, 'x', 'stored as its own key, ready for redaction')
})

test('with the null adapter a message is recorded queued, with the data the template renders from, and nothing is sent', async t => {
  const { quotes, outbox, mailer, lines } = world(t, { adapter: new NullAdapter() })
  const { request } = quotes.submit(form())
  const row = await mailer.notify('request-received', request.id)
  assert.equal(row.status, 'queued')
  assert.equal(row.providerId, null)
  assert.equal(row.to, 'jamie@example.com')
  assert.equal(row.toName, 'Jamie Rivera')
  assert.equal(row.type, 'request-received')
  assert.equal(row.data.to_email, 'jamie@example.com')
  assert.equal(row.data.locationNotes, 'Blue sedan, gate code 1234', 'the personal keys are stored under the names redaction expects')
  assert.equal(row.data.tireName, 'Test Touring')
  assert.equal(row.data.tireSize, SIZE)
  assert.equal(row.data.total, quotes.get(request.id).quote.total)
  assert.equal(outbox.forRequest(request.id).length, 1)
  assert.ok(lines.some(line => line.includes(`queued ${row.id} request-received`)))
})

test('the owner message goes to the configured owner address, the customer message to the customer', async t => {
  const { quotes, mailer } = world(t, { adapter: new NullAdapter() })
  const { request } = quotes.submit(form())
  const owner = await mailer.notify('request-arrived', request.id)
  assert.equal(owner.to, 'owner@example.com')
  assert.equal(owner.toName, 'Ken')
  assert.match(TEMPLATES['request-arrived'].render(owner.data).text, /\/owner\/quotes\?request=/)
  const customer = await mailer.notify('quote-sent', request.id)
  assert.equal(customer.to, 'jamie@example.com')
})

test('over SMTP the message is one sendMail, the server\'s message id comes back onto the row, and the row is sent', async t => {
  const { calls, adapter } = fakeSmtp()
  const { quotes, mailer } = world(t, { adapter })
  const { request } = quotes.submit(form())
  const row = await mailer.notify('request-received', request.id)
  assert.equal(row.status, 'sent')
  assert.equal(row.providerId, '<msg1@kensmobiletire.com>')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].from, 'quotes@kensmobiletire.com')
  assert.deepEqual(calls[0].to, { name: 'Jamie Rivera', address: 'jamie@example.com' })
  assert.equal(calls[0].replyTo, 'owner@example.com')
  assert.match(calls[0].subject, /Jamie/)
  assert.match(calls[0].text, /Test Touring/)
  assert.match(calls[0].html, /<!doctype html>/)
})

test('a provider failure is a failed row with the server\'s words, and nothing else changes', async t => {
  const { adapter } = fakeSmtp(new Error('535-5.7.8 Username and Password not accepted'))
  const { quotes, mailer } = world(t, { adapter })
  const { request } = quotes.submit(form())
  const row = await mailer.notify('quote-sent', request.id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /535.*not accepted/)
  assert.equal(quotes.get(request.id).quote.status, 'draft', 'the request is untouched')
})

test('no log line ever carries an address; correlation is the keyed hash', async t => {
  const { adapter } = fakeSmtp(new Error('connection refused'))
  const { quotes, mailer, lines } = world(t, { adapter })
  const { request } = quotes.submit(form())
  await mailer.notify('request-received', request.id)
  await mailer.notify('request-arrived', request.id)
  const all = lines.join('\n')
  assert.doesNotMatch(all, /example\.com/i)
  assert.doesNotMatch(all, /jamie/i)
  assert.doesNotMatch(all, /owner@/i)
  assert.match(all, new RegExp(`to=${addressLabel('jamie@example.com')}`), 'the customer appears only as the hash')
  assert.equal(addressLabel('Jamie@Example.com'), addressLabel('jamie@example.com'), 'the hash is of the normalised address')
  assert.notEqual(addressLabel('jamie@example.com'), 'jamie@example.com')
})

test('a message about a request that does not exist, or a type nobody defined, records nothing', async t => {
  const { mailer, outbox } = world(t, { adapter: new NullAdapter() })
  assert.equal(await mailer.notify('request-received', 'no-such-request'), null)
  await assert.rejects(() => mailer.notify('made-up', 'x'), /No mail template/)
  assert.equal(outbox.list({ limit: 10 }).length, 0)
})

test('the API sends after it answers: submit records two messages, sending the quote records one, paying records one', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const requestsApi = createRequestsApi(quotes, { mailer })
  const ownerApi = createApi(quotes.inventory, null, null, quotes, { mailer })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; if (await ownerApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const submitted = await (await post('/api/requests', form())).json()
  await mailer.idle()
  assert.deepEqual(outbox.forRequest(submitted.request.id).map(row => row.type).sort(), ['request-arrived', 'request-received'])

  const { version } = quotes.get(submitted.request.id).quote
  const decided = await (await post(`/api/owner/quotes/${submitted.request.id}/approve`, { version })).json()
  assert.equal(decided.quote.status, 'sent')
  await mailer.idle()
  const sentRow = outbox.forRequest(submitted.request.id).find(row => row.type === 'quote-sent')
  assert.ok(sentRow)
  // Rendered from this row's own stored data, not a hand-built fixture: a
  // fixture that types { lines: [...] } passes whether the template reads
  // lineItems or lines, because it supplies both keys by never testing the
  // one that matters. The real quote's field is lineItems (quotes.mjs,
  // #302), and mail-templates.mjs read `quote?.lines` -- always undefined --
  // so every quote-sent and payment-recorded email ever sent rendered an
  // empty invoice, with no test catching it, until this assertion.
  const sentText = TEMPLATES['quote-sent'].render(sentRow.data).text
  assert.match(sentText, /Test Touring/, 'the invoice names the tire actually quoted')
  assert.match(sentText, /Test Touring × 4 @ \$\d+\.\d\d = \$\d+\.\d\d/, 'and shows real quantity, price and line total, not an empty invoice')

  const paid = await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  assert.equal(paid.quote.status, 'paid')
  await mailer.idle()
  assert.deepEqual(outbox.forRequest(submitted.request.id).map(row => row.type).sort(), ['payment-recorded', 'quote-sent', 'request-arrived', 'request-received'])
  const receiptRow = outbox.forRequest(submitted.request.id).find(row => row.type === 'payment-recorded')
  const receiptText = TEMPLATES['payment-recorded'].render(receiptRow.data).text
  assert.match(receiptText, /Test Touring/, 'the receipt -- the document the customer keeps -- also itemises what was paid for')
  assert.match(receiptText, /Test Touring × 4 @ \$\d+\.\d\d = \$\d+\.\d\d/)

  const refused = await post(`/api/owner/quotes/${submitted.request.id}/reject`, { version: quotes.get(submitted.request.id).quote.version })
  assert.equal(refused.status, 409, 'a rejection after payment is refused')
  await mailer.idle()
  assert.equal(outbox.forRequest(submitted.request.id).length, 4, 'and sends nothing')

  const listed = await (await fetch(base + '/api/owner/outbox?limit=10')).json()
  assert.equal(listed.provider, 'none')
  assert.equal(listed.interim, false, 'the owner route says whether the sender is interim')
  assert.equal(listed.messages.length, 4)
  assert.equal(listed.messages[0].status, 'queued')
})

test('rejecting a draft records a quote-declined message, the sibling of quote-sent', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const requestsApi = createRequestsApi(quotes, { mailer })
  const ownerApi = createApi(quotes.inventory, null, null, quotes, { mailer })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; if (await ownerApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const submitted = await (await post('/api/requests', form())).json()
  await mailer.idle()

  const { version } = quotes.get(submitted.request.id).quote
  const decided = await (await post(`/api/owner/quotes/${submitted.request.id}/reject`, { version })).json()
  assert.equal(decided.quote.status, 'rejected')
  await mailer.idle()
  assert.ok(outbox.forRequest(submitted.request.id).some(row => row.type === 'quote-declined'), 'a decline sends the sibling of quote-sent, not silence')
  assert.equal(outbox.forRequest(submitted.request.id).filter(row => row.type === 'quote-sent').length, 0, 'and never both for the same decision')
})

test('a decline reason typed through the API actually reaches the customer email (#78: the reason box was dead code without this)', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const requestsApi = createRequestsApi(quotes, { mailer })
  const ownerApi = createApi(quotes.inventory, null, null, quotes, { mailer })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; if (await ownerApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const submitted = await (await post('/api/requests', form())).json()
  await mailer.idle()
  const { version } = quotes.get(submitted.request.id).quote
  const decided = await (await post(`/api/owner/quotes/${submitted.request.id}/reject`, { version, reason: '  Out of stock by the time I checked  ' })).json()
  assert.equal(decided.quote.reason, 'Out of stock by the time I checked', 'the API response carries the trimmed reason')
  await mailer.idle()
  const declined = outbox.forRequest(submitted.request.id).find(row => row.type === 'quote-declined')
  assert.equal(declined.data.reason, 'Out of stock by the time I checked', "the reason typed in the owner's reason box reaches the outbox row the email renders from")
  assert.match(TEMPLATES['quote-declined'].render(declined.data).text, /Out of stock by the time I checked/, 'and the rendered email actually says it')
})

test('a provider outage never reaches the customer: the submit still answers 201', async t => {
  const adapter = { name: 'broken', async send() { throw new Error('provider down') } }
  const { quotes, outbox, mailer } = world(t, { adapter })
  const requestsApi = createRequestsApi(quotes, { mailer })
  const server = createServer(async (req, res) => { if (await requestsApi(req, res)) return; res.writeHead(404); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form()) })
  assert.equal(response.status, 201)
  const { request } = await response.json()
  await mailer.idle()
  const rows = outbox.forRequest(request.id)
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.status === 'failed' && /provider down/.test(row.error)))
})


/**
 * The voice, pinned (t62). Three of the four customer emails said "we", put
 * Ken in the third person and carried no way to reach him, because
 * `t62-voice.md` part F was written *for* these templates and never applied
 * to them -- an approved document that existed, was correct, and went unused.
 * Nothing caught it until somebody rendered one and read it.
 *
 * So the rule is a test rather than a paragraph. Owner mail is exempt: it
 * speaks to Ken in the second person and needs no signature.
 */
test('every customer email speaks as Ken: no "we", a way to reach him, and his name on it', () => {
  const ctx = {
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', customerNotes: 'c',
      vehicleInfo: '2016 Honda Civic', quantity: 4, locationType: 'Home', serviceZip: '02148', date: SOON },
    quote: { lineItems: [{ description: 'T', quantity: 4, unitPrice: 50 }], total: 250, note: 'a note', reason: null },
    tire: { name: 'T', size: SIZE }, origin: 'https://x', to: 'a@b.c', toName: 'A',
  }
  const customer = MAIL_TYPES.filter(type => TEMPLATES[type].audience === 'customer')
  assert.ok(customer.length >= 4, 'the customer messages are the ones under test')

  for (const type of customer) {
    const { subject, text } = TEMPLATES[type].render(TEMPLATES[type].data(ctx))
    assert.doesNotMatch(text, /\bwe\b/i, `${type}: "we" nowhere -- Ken is one person`)
    assert.doesNotMatch(subject, /\bwe\b/i, `${type}: "we" nowhere in the subject either`)
    assert.doesNotMatch(text, /reaches the shop/i, `${type}: "the shop" is not how Ken refers to himself`)
    assert.match(text, /Text me at \(617\) 410-8319/, `${type}: the text number, in every customer message (t63)`)
    assert.match(text, /— Ken/, `${type}: signed by the person sending it`)
  }
})

/**
 * The links have to be links. `htmlOf` escaped every body into a `<pre>` with
 * no anchors at all, so in the message a customer actually opens -- clients
 * render the HTML part, not the text -- the status URL and the number were
 * bare text: tappable only if the client guessed, and `sms:` never. t63 had
 * already replaced calling with texting, so a person at hour six had no
 * working way to reach Ken from the email. Verified in the delivered form,
 * not the rendered one, which is how it was missed.
 */
test('every email links what it asks the reader to do', () => {
  const ctx = {
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', customerNotes: 'c',
      vehicleInfo: '2016 Honda Civic', quantity: 4, locationType: 'Home', serviceZip: '02148', date: SOON },
    quote: { lineItems: [{ description: 'T', quantity: 4, unitPrice: 50 }], total: 250, note: 'a note', reason: null },
    tire: { name: 'T', size: SIZE }, origin: 'https://x', to: 'a@b.c', toName: 'A',
  }
  for (const type of MAIL_TYPES) {
    const template = TEMPLATES[type]
    const { text, html } = template.render(template.data(ctx))
    for (const url of text.match(/https:\/\/\S+/g) || []) {
      assert.ok(html.includes(`<a href="${url}">`), `${type}: ${url} is a link, not text`)
    }
    if (template.audience === 'customer') {
      assert.match(html, /<a href="sms:/, `${type}: the number is tappable (t63)`)
    }
    assert.doesNotMatch(text, /<a /, `${type}: the plain-text part stays plain`)
  }
})
