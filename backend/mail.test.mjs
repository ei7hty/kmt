import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS } from './outbox.mjs'
import { AUTO_RETRY_TYPES, Mailer, drainMail, NullAdapter, SmtpAdapter, addressLabel, describeMail, readMailConfig } from './mail.mjs'
import { MAIL_TYPES, TEMPLATES } from './mail-templates.mjs'
import { createApi, createMailStatusApi, createRequestsApi } from './api.mjs'
import { isMonitorAuthorized, readMonitorConfig } from './auth.mjs'

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

/* -------------------------------------------------------------- SMTP probe */

/** A transporter whose verify() answers as told; no socket is ever opened. */
function fakeVerify(outcome) {
  const transporter = { async verify() { if (outcome instanceof Error) throw outcome; return true } }
  return new SmtpAdapter({ host: 'smtp-relay.gmail.com', port: 587, user: 'u', password: 'p', transporter })
}

test('probeSmtp reports ok when verify() succeeds', async t => {
  const { mailer } = world(t, { adapter: fakeVerify('ok') })
  const result = await mailer.probeSmtp()
  assert.equal(result.status, 'ok')
  assert.equal(result.error, null)
  assert.ok(result.checkedAt)
  assert.equal(mailer.smtpStatus, result, 'the mailer keeps the latest result, not a copy')
})

test('probeSmtp reports failing when the server answers with a real SMTP response code', async t => {
  // 535 5.7.8, the exact failure from the 2026-09-06 outage this whole
  // feature exists to catch: the credential was rejected, and nodemailer's
  // error carries the code the server actually sent.
  const error = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { responseCode: 535 })
  const { mailer } = world(t, { adapter: fakeVerify(error) })
  const result = await mailer.probeSmtp()
  assert.equal(result.status, 'failing')
  assert.match(result.error, /535/)
})

test('probeSmtp reports unknown, not failing, when the probe never got an answer', async t => {
  // A timeout or DNS failure carries no responseCode -- nothing was asked
  // and answered "no", the probe simply could not complete. Reporting this
  // as "failing" would tell a monitor the credential is bad when the real
  // problem might be the network between here and the mail server.
  const error = new Error('connect ETIMEDOUT')
  const { mailer } = world(t, { adapter: fakeVerify(error) })
  const result = await mailer.probeSmtp()
  assert.equal(result.status, 'unknown')
  assert.match(result.error, /ETIMEDOUT/)
})

test('probeSmtp reports unknown without probing when mail is not configured for SMTP', async t => {
  const { mailer } = world(t, { adapter: new NullAdapter() })
  const result = await mailer.probeSmtp()
  assert.equal(result.status, 'unknown')
  assert.match(result.error, /not configured/)
})

test('before the first probe, smtpStatus is unknown with no checkedAt', async t => {
  const { mailer } = world(t, { adapter: fakeVerify('ok') })
  assert.equal(mailer.smtpStatus.status, 'unknown')
  assert.equal(mailer.smtpStatus.checkedAt, null)
})

/* --------------------------------------------------------- mail-status API */

function mailStatusServer(t, { mailer, token = 'a-real-monitor-token' }) {
  const monitorConfig = readMonitorConfig({ KMT_MONITOR_TOKEN: token })
  const mailStatusApi = createMailStatusApi(mailer, monitorConfig, {
    isAuthorized: request => isMonitorAuthorized(monitorConfig, request),
  })
  const server = createServer(async (req, res) => { if (await mailStatusApi(req, res)) return; res.writeHead(404); res.end() })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  })))
}

test('the mail-status route answers the probed status only with the right bearer token', async t => {
  const { mailer } = world(t, { adapter: fakeVerify('ok') })
  await mailer.probeSmtp()
  const { base, close } = await mailStatusServer(t, { mailer })
  t.after(close)

  const unauthorized = await fetch(base + '/api/mail-status')
  assert.equal(unauthorized.status, 401)

  const wrong = await fetch(base + '/api/mail-status', { headers: { Authorization: 'Bearer nope' } })
  assert.equal(wrong.status, 401)

  const ok = await fetch(base + '/api/mail-status', { headers: { Authorization: 'Bearer a-real-monitor-token' } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  // DEV OPS's contract: { smtp, checkedAt, error }, smtp not status.
  assert.deepEqual(Object.keys(body).sort(), ['checkedAt', 'error', 'smtp'])
  assert.equal(body.smtp, 'ok')
  assert.equal(body.error, null)
  assert.ok(body.checkedAt)
})

test('the mail-status route is a GET only', async t => {
  const { mailer } = world(t, { adapter: fakeVerify('ok') })
  const { base, close } = await mailStatusServer(t, { mailer })
  t.after(close)
  const posted = await fetch(base + '/api/mail-status', { method: 'POST', headers: { Authorization: 'Bearer a-real-monitor-token' } })
  assert.equal(posted.status, 405)
})

test('the mail-status route does not exist at all when no token is configured', async t => {
  const { mailer } = world(t, { adapter: fakeVerify('ok') })
  const { base, close } = await mailStatusServer(t, { mailer, token: '' })
  t.after(close)
  const response = await fetch(base + '/api/mail-status', { headers: { Authorization: 'Bearer anything' } })
  assert.equal(response.status, 404, 'unconfigured means the route does not exist, not that it exists half-protected')
})

/* ------------------------------------------------ unresolved-failures route */

function ownerApiServer(t, { quotes, mailer }) {
  const ownerApi = createApi(quotes.inventory, null, null, quotes, { mailer })
  const server = createServer(async (req, res) => { if (await ownerApi(req, res)) return; res.writeHead(404); res.end() })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  })))
}

test('GET /api/owner/outbox/unresolved-failures answers only unresolved failed rows, not the general recent-messages window', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const { request } = quotes.submit(form())
  outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'queued' }, to: 'a@b.c', toName: 'A' })
  const failed = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'will fail' }, to: 'a@b.c', toName: 'A' })
  outbox.updateStatus(failed.id, { status: 'failed', error: '535 5.7.8 credential dead' })
  const settled = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'already handled' }, to: 'a@b.c', toName: 'A' })
  outbox.updateStatus(settled.id, { status: 'failed', error: 'old incident' })
  outbox.resolve(settled.id, 'handled earlier tonight')

  const response = await fetch(base + '/api/owner/outbox/unresolved-failures?limit=200')
  assert.equal(response.status, 200)
  const { messages } = await response.json()
  assert.equal(messages.length, 1, 'the queued row and the resolved failure are both excluded')
  assert.equal(messages[0].id, failed.id)
  assert.equal(messages[0].error, '535 5.7.8 credential dead')
})

test('GET /api/owner/outbox/unresolved-failures is a real query, not the general list scrolled past', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)
  const { request } = quotes.submit(form())

  const failure = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'x' }, to: 'a@b.c', toName: 'A' })
  outbox.updateStatus(failure.id, { status: 'failed', error: 'still unresolved' })
  for (let i = 0; i < 210; i++) {
    outbox.record({ requestId: request.id, type: 'request-received', data: { note: `q${i}` }, to: 'a@b.c', toName: 'A' })
  }

  const generalList = await (await fetch(base + '/api/owner/outbox?limit=200')).json()
  assert.equal(generalList.messages.some(m => m.id === failure.id), false,
    'sanity check: the general recency-windowed route really has scrolled past the failure by now')

  const unresolved = await (await fetch(base + '/api/owner/outbox/unresolved-failures?limit=200')).json()
  assert.equal(unresolved.messages.length, 1)
  assert.equal(unresolved.messages[0].id, failure.id, 'the failure-filtered route still sees it')
})

/* -------------------------------------------------------------- resolve route */

test('POST /api/owner/outbox/:id/resolve settles a row and takes it out of unresolved-failures', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)
  const { request } = quotes.submit(form())
  const failure = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'x' }, to: 'a@b.c', toName: 'A' })
  outbox.updateStatus(failure.id, { status: 'failed', error: '535 5.7.8 credential dead' })

  const resolved = await (await fetch(`${base}/api/owner/outbox/${failure.id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'credential rotated' }),
  })).json()
  assert.equal(resolved.status, 'failed', 'status is untouched -- the attempt really was rejected')
  assert.ok(resolved.resolvedAt)
  assert.equal(resolved.resolutionNote, 'credential rotated')
  assert.equal(resolved.error, '535 5.7.8 credential dead', 'the diagnostic survives, in its own column')

  const unresolved = await (await fetch(base + '/api/owner/outbox/unresolved-failures?limit=200')).json()
  assert.equal(unresolved.messages.length, 0, 'the resolved row no longer appears')
})

test('POST /api/owner/outbox/:id/resolve on a message that does not exist answers 404', async t => {
  const { quotes, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const response = await fetch(`${base}/api/owner/outbox/${'0'.repeat(32)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(response.status, 404)
})

test('POST /api/owner/outbox/:id/resolve works on a queued row too, and never fills error', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)
  const { request } = quotes.submit(form())
  const stranded = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'x' }, to: 'a@b.c', toName: 'A' })

  const resolved = await (await fetch(`${base}/api/owner/outbox/${stranded.id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'never attempted; no adapter was configured when this was recorded' }),
  })).json()
  assert.equal(resolved.status, 'queued', 'still queued -- it was never attempted, resolving does not invent an attempt')
  assert.ok(resolved.resolvedAt)
  assert.equal(resolved.resolutionNote, 'never attempted; no adapter was configured when this was recorded')
  assert.equal(resolved.error, null, 'error stays null, not the resolution note')
})

test('POST /api/owner/outbox/:id/resolve answers 400, not 500, on a note that is not text', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: new NullAdapter() })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)
  const { request } = quotes.submit(form())
  const message = outbox.record({ requestId: request.id, type: 'request-received', data: { note: 'x' }, to: 'a@b.c', toName: 'A' })

  // { note: 12345 } would otherwise land a number in a TEXT column; { note:
  // {...} } would otherwise throw inside node:sqlite as an unhandled 500 --
  // exactly the worst moment for one, since this is the route Ken reaches
  // for after something has already gone wrong.
  const number = await fetch(`${base}/api/owner/outbox/${message.id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 12345 }),
  })
  assert.equal(number.status, 400)

  const object = await fetch(`${base}/api/owner/outbox/${message.id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: { nested: true } }),
  })
  assert.equal(object.status, 400)

  assert.equal(outbox.get(message.id).resolvedAt, null, 'neither refused call left the row half-resolved')
})

// ---------------------------------------------------------------------------
// #285: an interrupted send used to be indistinguishable from one that never
// happened. These are the measurements that justified the column, written as
// tests so they keep being true.

/** A world on disk rather than in memory, so it can be reopened after a close. */
function durableWorld(t, adapter) {
  const dir = mkdtempSync(join(tmpdir(), 'kmt-mail-285-'))
  const dbPath = join(dir, 'owner.sqlite')
  const opened = []
  const open = () => {
    const inventory = new Inventory(dbPath, [SIZE])
    opened.push(inventory)
    return { inventory, quotes: new Quotes(inventory), outbox: new Outbox(inventory.db) }
  }
  // Close every handle before removing the directory. On Windows an open
  // SQLite file makes rmSync fail EPERM, and t.after hooks run in
  // registration order -- so this hook does both rather than trusting a
  // per-test close registered later to have already run.
  t.after(() => {
    for (const inventory of opened) { try { inventory.close() } catch { /* already closed */ } }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const first = open()
  first.inventory.importSnapshot(snapshot([tire()]))
  const mailer = new Mailer({
    outbox: first.outbox, quotes: first.quotes, adapter, config: CONFIG,
    origin: 'https://kensmobiletire.com', log: () => {},
  })
  return { ...first, mailer, open }
}

/** An adapter that blocks mid-send until released -- SIGTERM during SMTP. */
function blockingAdapter() {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  return { release: () => release(), adapter: { name: 'smtp', async send() { await blocked; return { providerId: '<delivered@x>', sent: true } } } }
}

/** The rendering context a template stores, built the way notify() builds it. */
function dataFor(world, requestId, type, to, toName) {
  const found = world.quotes.get(requestId, 'owner')
  return TEMPLATES[type].data({ request: found.request, quote: found.quote, tire: null, origin: 'https://x', to, toName })
}

test('#285: a send interrupted by shutdown leaves queued -- but now says an attempt was made', async t => {
  const { release, adapter } = blockingAdapter()
  const world = durableWorld(t, adapter)
  const submitted = world.quotes.submit(form())
  const task = world.mailer.after('request-arrived', submitted.request.id)
  await new Promise(resolve => setImmediate(resolve))

  // Shutdown without draining: the database closes under the in-flight send.
  world.inventory.close()
  release()
  await task

  const reopened = world.open()
  const row = reopened.outbox.forRequest(submitted.request.id)[0]

  assert.equal(row.status, 'queued', 'the status update never landed -- that is the bug, and it is unchanged')
  assert.equal(row.providerId, null)
  assert.notEqual(row.attemptedAt, null,
    'but the row now records that an attempt began, which is the point: the message may have been delivered')
  assert.deepEqual(reopened.outbox.retryable({ type: 'request-arrived' }), [],
    'so it is not eligible for an automatic resend -- no duplicate to anyone')
})

test('#285: the same message is NOT stranded when shutdown drains first', async t => {
  const { release, adapter } = blockingAdapter()
  const world = durableWorld(t, adapter)
  const submitted = world.quotes.submit(form())
  world.mailer.after('request-arrived', submitted.request.id)
  await new Promise(resolve => setImmediate(resolve))

  setTimeout(release, 5)
  await world.mailer.idle()          // what shutdown() now awaits, bounded
  world.inventory.close()

  const reopened = world.open()
  const row = reopened.outbox.forRequest(submitted.request.id)[0]
  assert.equal(row.status, 'sent', 'drained before the close, the outcome is recorded')
  assert.equal(row.providerId, '<delivered@x>')
})

test('#285: idle() waits for mail enqueued after the drain started, not just a snapshot', async t => {
  // server.close() lets in-flight requests finish, and those call after().
  // A single Promise.allSettled snapshot misses whatever they enqueue next.
  const delivered = []
  const adapter = {
    name: 'smtp',
    async send(message) { await new Promise(r => setTimeout(r, 5)); delivered.push(message.to); return { providerId: 'x', sent: true } },
  }
  const world = durableWorld(t, adapter)
  const a = world.quotes.submit(form())
  const b = world.quotes.submit(form())

  world.mailer.after('request-arrived', a.request.id)
  const draining = world.mailer.idle()
  setTimeout(() => world.mailer.after('request-arrived', b.request.id), 1)
  await draining

  assert.equal(delivered.length, 2, 'both messages were delivered before idle() resolved')
  assert.equal(world.mailer.inFlight.size, 0, 'and the loop terminated rather than spinning')
})

test('#285: a stranded owner alert is recovered at boot, and only ever an owner alert', async t => {
  const sent = []
  const adapter = { name: 'smtp', async send(message) { sent.push(message.to); return { providerId: '<r@x>', sent: true } } }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request

  // Two rows a crash could have left behind: the owner's alert and the
  // customer's acknowledgement, both queued, neither attempted.
  const owner = world.outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 1,
    data: dataFor(world, request.id, 'request-arrived', CONFIG.ownerEmail, CONFIG.ownerName),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })
  const customer = world.outbox.record({
    requestId: request.id, type: 'request-received', templateVersion: 1,
    data: dataFor(world, request.id, 'request-received', 'jamie@example.com', 'Jamie Rivera'),
    to: 'jamie@example.com', toName: 'Jamie Rivera',
  })

  world.mailer.smtpStatus = { status: 'ok', checkedAt: new Date().toISOString(), error: null }
  const result = await world.mailer.recoverStrandedOwnerAlerts()

  assert.deepEqual(result, { found: 1, sent: 1, failed: 0, skipped: null })
  assert.deepEqual(sent, [CONFIG.ownerEmail], 'the owner alert went again; the customer acknowledgement did not')
  assert.equal(world.outbox.get(owner.id).status, 'sent')
  assert.equal(world.outbox.get(customer.id).status, 'queued',
    'a customer message is Ken to resend by hand, never this pass')

  const second = await world.mailer.recoverStrandedOwnerAlerts()
  assert.equal(second.found, 0, 'and a recovered row is not recovered twice -- attempted_at took it out of the set')
})

test('#285: recovery refuses to send unless the probe says the seam is good', async t => {
  const sent = []
  const adapter = { name: 'smtp', async send(message) { sent.push(message.to); return { providerId: 'x', sent: true } } }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  world.outbox.record({
    requestId: request.id, type: 'request-arrived',
    data: dataFor(world, request.id, 'request-arrived', CONFIG.ownerEmail, CONFIG.ownerName),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })

  // The absent case, not a wrong one: at boot the probe has not answered yet.
  assert.equal(world.mailer.smtpStatus.status, 'unknown')
  assert.deepEqual(await world.mailer.recoverStrandedOwnerAlerts(),
    { found: 0, sent: 0, failed: 0, skipped: 'smtp status is unknown' })

  world.mailer.smtpStatus = { status: 'failing', checkedAt: 'now', error: '535 5.7.8 BadCredentials' }
  assert.equal((await world.mailer.recoverStrandedOwnerAlerts()).skipped, 'smtp status is failing',
    'a known-dead credential is not worth a retry storm across dozens of deploys a day')
  assert.deepEqual(sent, [], 'nothing was sent in either case')

  const nullWorld = durableWorld(t, new NullAdapter())
  assert.equal((await nullWorld.mailer.recoverStrandedOwnerAlerts()).skipped, 'no provider configured')
})

test('#285: the null adapter never stamps an attempt -- outbox-only rows did not "maybe arrive"', async t => {
  const world = durableWorld(t, new NullAdapter())
  const submitted = world.quotes.submit(form())
  await world.mailer.after('request-received', submitted.request.id)

  const row = world.outbox.forRequest(submitted.request.id)[0]
  assert.equal(row.status, 'queued')
  assert.equal(row.attemptedAt, null,
    'NullAdapter sends nothing, so stamping here would mark every gate and pre-SMTP row as possibly-delivered -- backwards')
})

test('#285: a resend replays the stored row and never re-derives the message', async t => {
  const sent = []
  const adapter = { name: 'smtp', async send(message) { sent.push(message); return { providerId: '<again@x>', sent: true } } }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  const row = world.outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 1,
    data: dataFor(world, request.id, 'request-arrived', CONFIG.ownerEmail, CONFIG.ownerName),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })

  const before = world.outbox.list({ limit: 50 }).length
  await world.mailer.resend(row.id)
  assert.equal(world.outbox.list({ limit: 50 }).length, before, 'the same row is updated; no second record for one message')
  assert.equal(world.outbox.get(row.id).status, 'sent')
  assert.equal(sent.length, 1)

  // The guard for the day a template gains a version 2: the stored data was
  // composed for v1 and must not be poured through a different template.
  const stale = world.outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 2,
    data: { any: 'thing' }, to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })
  await assert.rejects(() => world.mailer.resend(stale.id), /composed for request-arrived v2/)
  await assert.rejects(() => world.mailer.resend('nope'), /No outbox message/)
})

test('#285: AUTO_RETRY_TYPES cannot drift into a customer-facing message', () => {
  assert.deepEqual(AUTO_RETRY_TYPES, ['request-arrived'])
  for (const type of AUTO_RETRY_TYPES) {
    assert.ok(TEMPLATES[type], type + ' is a real template')
    assert.equal(TEMPLATES[type].audience, 'owner',
      type + ' must be owner-audience: a duplicate costs Ken an inbox line, a duplicate quote costs a dispute')
  }
})

test('#285: drainMail returns as soon as the mail is done, and does not hold the process open', async () => {
  // Two claims, and only the second one needed a subprocess to see.
  const idle = { inFlight: new Set(), async idle() {} }
  const started = Date.now()
  await drainMail(idle, 5000)
  assert.ok(Date.now() - started < 250, 'it returns on the mail, not on the bound')

  // The bound still applies when the mail never finishes.
  const stuck = { inFlight: new Set(), idle: () => new Promise(() => {}) }
  const t0 = Date.now()
  await drainMail(stuck, 120)
  const waited = Date.now() - t0
  assert.ok(waited >= 100 && waited < 2000, `gave up at the bound, waited ${waited}ms`)

  // And the part no in-process assertion can see: a plain
  // Promise.race([idle(), delay(ms)]) resolves immediately and STILL keeps a
  // ref'd timer alive, so the process lingers for the whole bound. Measured at
  // 2002 ms before drainMail aborted the loser. Only a real exit shows it.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { drainMail } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'mail.mjs')).href)}
    const t0 = Date.now()
    await drainMail({ inFlight: new Set(), async idle() {} }, 4000)
    process.on('exit', () => process.stdout.write(String(Date.now() - t0)))
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const exitedAfter = Number(child.stdout)
  assert.ok(exitedAfter < 1000,
    `the process exited ${exitedAfter}ms after draining -- a ref'd loser would hold it for the full 4000ms bound`)
})

test('#285: a failed resend stays honestly failed and carries the NEW reason', async t => {
  // Ken is looking at this row precisely because the first attempt did not
  // work, so "failed again, same 535" and "failed again, different error"
  // have to lead him somewhere different. A resend that silently re-queued,
  // or that left the first attempt's error in place, would collapse them.
  let failWith = new Error('535 5.7.8 BadCredentials')
  const adapter = { name: 'smtp', async send() { throw failWith } }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  const row = world.outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 1,
    data: dataFor(world, request.id, 'request-arrived', CONFIG.ownerEmail, CONFIG.ownerName),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })

  await world.mailer.resend(row.id)
  const first = world.outbox.get(row.id)
  assert.equal(first.status, 'failed')
  assert.match(first.error, /535 5\.7\.8/)

  failWith = new Error('421 4.7.0 Try again later')
  await world.mailer.resend(row.id)
  const second = world.outbox.get(row.id)

  assert.equal(second.status, 'failed', 'still failed -- never silently back to queued, which would read as "owed and untried"')
  assert.match(second.error, /421 4\.7\.0/, 'and carries the second attempt\'s reason')
  assert.doesNotMatch(second.error, /535/, 'not the first attempt\'s, which is no longer what is wrong')
  assert.ok(second.attemptedAt >= first.attemptedAt,
    'and the attempt stamp moves to the resend: after Ken retries, "may this have arrived" is about the retry')
})

/* ------------------------------------------------------------ resend route */

/** A recorded owner alert, composed the way notify() composes one. */
function recordedAlert(quotes, outbox, requestId) {
  const found = quotes.get(requestId, 'owner')
  return outbox.record({
    requestId, type: 'request-arrived', templateVersion: 1,
    data: TEMPLATES['request-arrived'].data({ request: found.request, quote: found.quote, tire: null, origin: 'https://x', to: CONFIG.ownerEmail, toName: CONFIG.ownerName }),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })
}

test('POST /api/owner/outbox/:id/resend sends the stored row again and answers the updated row', async t => {
  const { calls, adapter } = fakeSmtp({ messageId: '<resent@kensmobiletire.com>' })
  const { quotes, outbox, mailer } = world(t, { adapter })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const { request } = quotes.submit(form())
  const row = recordedAlert(quotes, outbox, request.id)
  const before = outbox.list({ limit: 50 }).length

  const response = await fetch(`${base}/api/owner/outbox/${row.id}/resend`, { method: 'POST' })
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.id, row.id, 'the same row, not a new one')
  assert.equal(body.status, 'sent')
  assert.equal(body.providerId, '<resent@kensmobiletire.com>')
  assert.equal(body.deliveryRisk, 'possible-duplicate', 'it has now reached a provider')
  assert.equal(calls.length, 1, 'exactly one message left the building')
  assert.equal(outbox.list({ limit: 50 }).length, before, 'and no second outbox row for one message')
  assert.equal(outbox.unresolvedFailures().length, 0,
    'a successful resend leaves the failure list on its own -- no separate resolve step')
})

test('a resend that fails answers 200 with the row honestly failed and the NEW reason', async t => {
  const { quotes, outbox, mailer } = world(t, { adapter: fakeSmtp(new Error('421 4.7.0 Try again later')).adapter })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const { request } = quotes.submit(form())
  const row = recordedAlert(quotes, outbox, request.id)
  outbox.updateStatus(row.id, { status: 'failed', error: '535 5.7.8 BadCredentials' })

  const body = await (await fetch(`${base}/api/owner/outbox/${row.id}/resend`, { method: 'POST' })).json()

  assert.equal(body.status, 'failed', 'not silently back to queued, which would read as owed-and-never-tried')
  assert.match(body.error, /421 4\.7\.0/, 'the second attempt\'s reason')
  assert.doesNotMatch(body.error, /535/, 'not the first attempt\'s, which is no longer what is wrong')
  assert.equal(outbox.unresolvedFailures().length, 1, 'and it is still in front of whoever is watching failures')
})

test('the resend route answers the row a customer-facing message needs Ken to decide about', async t => {
  // The route is the ONLY way a customer message reaches a provider twice --
  // AUTO_RETRY_TYPES never includes one. This is the path his judgement takes.
  const { calls, adapter } = fakeSmtp({ messageId: '<second-copy@x>' })
  const { quotes, outbox, mailer } = world(t, { adapter })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const { request } = quotes.submit(form())
  const found = quotes.get(request.id, 'owner')
  const row = outbox.record({
    requestId: request.id, type: 'quote-sent', templateVersion: 1,
    data: TEMPLATES['quote-sent'].data({ request: found.request, quote: found.quote, tire: null, origin: 'https://x', to: 'jamie@example.com', toName: 'Jamie Rivera' }),
    to: 'jamie@example.com', toName: 'Jamie Rivera',
  })
  assert.deepEqual(outbox.retryable({ type: 'quote-sent' }).map(r => r.id), [row.id],
    'the row is retryable in principle; nothing automatic ever asks for this type')

  const body = await (await fetch(`${base}/api/owner/outbox/${row.id}/resend`, { method: 'POST' })).json()
  assert.equal(body.status, 'sent')
  assert.equal(calls[0].to.address, 'jamie@example.com', 'and it went to the customer on the stored row')
})

test('the resend route refuses what it should: unknown id, wrong method, no trailing segment', async t => {
  const { calls, adapter } = fakeSmtp()
  const { quotes, outbox, mailer } = world(t, { adapter })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const missing = await fetch(`${base}/api/owner/outbox/deadbeef/resend`, { method: 'POST' })
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /No outbox message/)

  // A GET must not match the route. Checked against a REAL id, on purpose: an
  // earlier version of this used `deadbeef`, so a route that accepted every
  // method still answered 404 -- from the missing row, not from the guard --
  // and the assertion passed while the guard was gone. A test whose expected
  // result has two possible causes is not testing the one it names.
  const { request } = quotes.submit(form())
  const real = recordedAlert(quotes, outbox, request.id)
  const wrongMethod = await fetch(`${base}/api/owner/outbox/${real.id}/resend`)
  assert.equal(wrongMethod.status, 404)
  assert.equal(calls.length, 0, 'and nothing was sent by a GET')
  assert.equal(outbox.get(real.id).status, 'queued', 'the row is untouched')

  // `resend` as an id rather than an action must not match either.
  const bare = await fetch(`${base}/api/owner/outbox/resend`, { method: 'POST' })
  assert.equal(bare.status, 404)
})

/* --------------------------------------- the resend guard (#407 review) */

test('#407: two concurrent resends of one row send exactly once', async t => {
  // Found by OWNER OPERATIONS ENGINEER reviewing the route, reproduced here
  // before it was fixed: a double-click sent two copies of one quote to one
  // customer. The exact harm the whole of #285 exists to prevent, arriving
  // through the manual door after being shut on the automatic one.
  const sent = []
  const adapter = {
    name: 'smtp',
    async send(message) { sent.push(message.to); await new Promise(r => setTimeout(r, 40)); return { providerId: '<p@x>', sent: true } },
  }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  const row = world.outbox.record({
    requestId: request.id, type: 'quote-sent', templateVersion: 1,
    data: dataFor(world, request.id, 'quote-sent', 'jamie@example.com', 'Jamie Rivera'),
    to: 'jamie@example.com', toName: 'Jamie Rivera',
  })
  world.outbox.updateStatus(row.id, { status: 'failed', error: '535 5.7.8' })

  const results = await Promise.allSettled([world.mailer.resend(row.id), world.mailer.resend(row.id)])
  const rejected = results.filter(r => r.status === 'rejected')

  assert.equal(sent.length, 1, 'exactly one message reached the provider')
  assert.equal(rejected.length, 1, 'and the second call was refused rather than quietly sending')
  assert.equal(rejected[0].reason.status, 409)
  assert.match(rejected[0].reason.message, /already being sent/)
  assert.equal(world.outbox.get(row.id).status, 'sent')
})

test('#407: a row that already went CAN be sent again, and the outbox records that it was', async t => {
  const sent = []
  const adapter = { name: 'smtp', async send(message) { sent.push(message.to); return { providerId: '<p@x>', sent: true } } }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  const row = world.outbox.record({
    requestId: request.id, type: 'quote-sent', templateVersion: 1,
    data: dataFor(world, request.id, 'quote-sent', 'jamie@example.com', 'Jamie Rivera'),
    to: 'jamie@example.com', toName: 'Jamie Rivera',
  })
  await world.mailer.resend(row.id)
  assert.equal(sent.length, 1)
  assert.equal(world.outbox.get(row.id).status, 'sent')
  assert.equal(world.outbox.get(row.id).resentAt, null, 'a first send is not a resend')

  // Ruled by the OWNER AGENT: `sent` means the provider accepted it, not that
  // the customer read it. Spam filtering and silent drops leave a row `sent`
  // and nothing in the inbox -- which is exactly when Ken reaches for this.
  await world.mailer.resend(row.id)
  assert.equal(sent.length, 2, 'the second copy went, because only Ken knows the first never arrived')

  const after = world.outbox.get(row.id)
  assert.notEqual(after.resentAt, null,
    'and the row records that a knowing second copy was sent -- the story six months later')
  assert.equal(after.status, 'sent')

  const third = await world.mailer.resend(row.id)
  assert.equal(third.resentAt, after.resentAt, 'the first such stamp is kept: it does not become more true')
})

test('#407: the guard is released when a send fails, or one failure would freeze the row forever', async t => {
  // The failure mode a `finally` exists to stop: a row that threw once could
  // never be resent again, which is precisely the row Ken most needs to retry.
  let fail = true
  const sent = []
  const adapter = {
    name: 'smtp',
    async send(message) {
      if (fail) throw new Error('421 4.7.0 Try again later')
      sent.push(message.to)
      return { providerId: '<ok@x>', sent: true }
    },
  }
  const world = durableWorld(t, adapter)
  const request = world.quotes.submit(form()).request
  const row = world.outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 1,
    data: dataFor(world, request.id, 'request-arrived', CONFIG.ownerEmail, CONFIG.ownerName),
    to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })

  await world.mailer.resend(row.id)
  assert.equal(world.outbox.get(row.id).status, 'failed')

  fail = false
  await world.mailer.resend(row.id)
  assert.equal(sent.length, 1, 'the second attempt was allowed through')
  assert.equal(world.outbox.get(row.id).status, 'sent')
})

test('#407: the route answers 409 rather than 500 when a resend is refused', async t => {
  const { adapter } = fakeSmtp({ messageId: '<x@x>' })
  const { quotes, outbox, mailer } = world(t, { adapter })
  const { base, close } = await ownerApiServer(t, { quotes, mailer })
  t.after(close)

  const { request } = quotes.submit(form())
  const row = outbox.record({
    requestId: request.id, type: 'request-arrived', templateVersion: 1,
    data: { any: 'thing' }, to: CONFIG.ownerEmail, toName: CONFIG.ownerName,
  })
  // `bounced` is the one status not on RESENDABLE_STATUSES: it is the only
  // case where the receiving server actually said no, so the same message to
  // the same address has a known answer.
  outbox.updateStatus(row.id, { status: 'bounced', error: '550 5.1.1 no such user' })

  const response = await fetch(`${base}/api/owner/outbox/${row.id}/resend`, { method: 'POST' })
  assert.equal(response.status, 409, 'a refused resend is a conflict the owner screen can render, not a server error')
  assert.match((await response.json()).error, /bounced/)
})

test('every HTML alternative uses the email-safe KMT frame, while stored data and plain text stay presentation-free', () => {
  const ctx = {
    request: { id: 'r1', customerPhone: '1', location: 'l', locationNotes: 'n', customerNotes: 'c',
      vehicleInfo: '2016 Honda Civic', quantity: 4, locationType: 'Home', serviceZip: '02148', date: SOON },
    // lineItems, not lines: baseData reads quote.lineItems (the field's real
    // name everywhere else in the codebase, per the fix above this test's own
    // merge point) -- this fixture originally said `lines`, which baseData
    // never reads, so it silently exercised an empty invoice on every run
    // without a single assertion here noticing.
    quote: { lineItems: [{ description: 'Test Touring', quantity: 4, unitPrice: 50 }], total: 250, note: 'a note', reason: null },
    tire: { name: 'Test Touring', size: SIZE }, origin: 'https://x', to: 'a@b.c', toName: 'A',
  }
  for (const type of MAIL_TYPES) {
    const template = TEMPLATES[type]
    const data = template.data(ctx)
    const { text, html } = template.render(data)
    assert.match(html, /<table role="presentation"/, `${type}: table layout survives conservative mail clients`)
    assert.match(html, /border-top:6px solid #d9121a/, `${type}: the settled red is the accent`)
    assert.match(html, /background:#080808/, `${type}: the settled black frames the message`)
    assert.match(html, /Ken's Mobile Tire/, `${type}: the business name is in the HTML footer`)
    assert.doesNotMatch(html, /<pre\b|<style\b|<script\b|<img\b/i, `${type}: inline, asset-free and not a plain-text wrapper`)
    assert.doesNotMatch(text, /role="presentation"|#d9121a|<table/i, `${type}: the text alternative stays plain`)
    assert.equal(template.version, 1, `${type}: a render-only change does not claim a new stored-data shape`)
    assert.equal(data.requestId, 'r1')
    if (type === 'quote-sent' || type === 'payment-recorded') {
      assert.match(text, /Test Touring/, `${type}: the actual line item reaches the message, not an empty invoice (#320)`)
    }
  }
})
