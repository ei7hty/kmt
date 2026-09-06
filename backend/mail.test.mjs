import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS } from './outbox.mjs'
import { Mailer, NullAdapter, SmtpAdapter, addressLabel, readMailConfig } from './mail.mjs'
import { MAIL_TYPES, TEMPLATES } from './mail-templates.mjs'
import { createApi, createRequestsApi } from './api.mjs'

const SIZE = '215/60R16'
const tire = (id = 'giga-a') => ({ id, name: 'Test Touring', size: SIZE, price: 50, inStock: true, category: 'all-season', description: '95H BSW',
  source: { sku: id.slice(5), stock: 12, listPrice: 60, segment: 'Passenger', url: 'https://www.giga-tires.com/tires/test' } })
const snapshot = tires => ({ source: 'giga-tires.com', scrapedAt: '2026-09-05T15:00:00Z', sizes: [SIZE], tires })
const KEY = 'a'.repeat(32)
const form = () => ({ customerKey: KEY, tireSize: SIZE, tireSelection: 'giga-a', quantity: 4, vehicleInfo: '2020 Toyota Corolla',
  location: '456 Demo Ave, Everett, MA 02149', locationType: 'Home', serviceZip: '02149', locationNotes: 'Blue sedan, gate code 1234',
  date: '2026-09-10', customerName: 'Jamie Rivera', customerEmail: 'Jamie@Example.com', customerPhone: '6175550100' })
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
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_OWNER_EMAIL: 'o@x.com' }), /KMT_MAIL_FROM/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_MAIL_FROM: 'q@x.com' }), /KMT_OWNER_EMAIL/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_USER: 'u', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' }), /go together/)
  assert.throws(() => readMailConfig({ KMT_MAIL_SMTP_HOST: 'h', KMT_MAIL_SMTP_PORT: 'lots', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' }), /port number/)
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
    quote: { lines: [{ description: 'T', quantity: 4, unitPrice: 50 }], total: 250 }, tire: { name: 'T', size: SIZE },
    origin: 'https://x', to: 'a@b.c', toName: 'A',
  })
  for (const key of OUTBOX_PERSONAL_DATA_KEYS) assert.ok(key in data, `${key} is a top-level key of the stored data`)
  const rendered = TEMPLATES['quote-sent'].render(data)
  assert.match(rendered.subject, /\$250\.00/)
  assert.match(rendered.text, /T × 4 @ \$50\.00 = \$200\.00/)
  assert.match(rendered.text, /https:\/\/x\/status\?request=r1/)
  assert.doesNotMatch(rendered.html, /<script/)
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
  assert.ok(outbox.forRequest(submitted.request.id).some(row => row.type === 'quote-sent'))

  const paid = await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  assert.equal(paid.quote.status, 'paid')
  await mailer.idle()
  assert.deepEqual(outbox.forRequest(submitted.request.id).map(row => row.type).sort(), ['payment-recorded', 'quote-sent', 'request-arrived', 'request-received'])

  const refused = await post(`/api/owner/quotes/${submitted.request.id}/reject`, { version: quotes.get(submitted.request.id).quote.version })
  assert.equal(refused.status, 409, 'a rejection after payment is refused')
  await mailer.idle()
  assert.equal(outbox.forRequest(submitted.request.id).length, 4, 'and sends nothing')

  const listed = await (await fetch(base + '/api/owner/outbox?limit=10')).json()
  assert.equal(listed.provider, 'none')
  assert.equal(listed.messages.length, 4)
  assert.equal(listed.messages[0].status, 'queued')
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
