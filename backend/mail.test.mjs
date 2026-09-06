import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Inventory } from './inventory.mjs'
import { Quotes } from './quotes.mjs'
import { Outbox, OUTBOX_PERSONAL_DATA_KEYS } from './outbox.mjs'
import { Mailer, NullAdapter, ResendAdapter, addressLabel, readMailConfig } from './mail.mjs'
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
const CONFIG = { provider: 'resend', apiKey: 'k', from: 'quotes@kensmobiletire.com', ownerEmail: 'owner@example.com', ownerName: 'Ken' }

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

/** A Resend that remembers what it was asked and answers as told. */
function fakeResend(reply = { status: 200, body: { id: 'msg_1' } }) {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } }
  return { calls, adapter: new ResendAdapter({ apiKey: 'k', fetch: fetchImpl }) }
}

test('the configuration is the environment: no key means the outbox-only mode, a key needs its two addresses', () => {
  assert.equal(readMailConfig({}).provider, 'none')
  assert.equal(readMailConfig({ KMT_MAIL_API_KEY: 'k', KMT_MAIL_FROM: 'q@x.com', KMT_OWNER_EMAIL: 'o@x.com' }).provider, 'resend')
  assert.throws(() => readMailConfig({ KMT_MAIL_API_KEY: 'k', KMT_OWNER_EMAIL: 'o@x.com' }), /KMT_MAIL_FROM/)
  assert.throws(() => readMailConfig({ KMT_MAIL_API_KEY: 'k', KMT_MAIL_FROM: 'q@x.com' }), /KMT_OWNER_EMAIL/)
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

test('with Resend the message is one POST, the id comes back onto the row, and the row is sent', async t => {
  const { calls, adapter } = fakeResend()
  const { quotes, mailer } = world(t, { adapter })
  const { request } = quotes.submit(form())
  const row = await mailer.notify('request-received', request.id)
  assert.equal(row.status, 'sent')
  assert.equal(row.providerId, 'msg_1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k')
  assert.equal(calls[0].body.from, 'quotes@kensmobiletire.com')
  assert.deepEqual(calls[0].body.to, ['Jamie Rivera <jamie@example.com>'])
  assert.equal(calls[0].body.reply_to, 'owner@example.com')
  assert.match(calls[0].body.subject, /Jamie/)
  assert.match(calls[0].body.text, /Test Touring/)
})

test('a provider failure is a failed row with the provider\'s words, and nothing else changes', async t => {
  const { adapter } = fakeResend({ status: 422, body: { message: 'domain not verified' } })
  const { quotes, mailer } = world(t, { adapter })
  const { request } = quotes.submit(form())
  const row = await mailer.notify('quote-sent', request.id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /422.*domain not verified/)
  assert.equal(quotes.get(request.id).quote.status, 'draft', 'the request is untouched')
})

test('no log line ever carries an address; correlation is the keyed hash', async t => {
  const { adapter } = fakeResend({ status: 500, body: {} })
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
  const afterSubmit = outbox.forRequest(submitted.request.id).map(row => row.type).sort()
  assert.deepEqual(afterSubmit, ['request-arrived', 'request-received'])

  const { version } = quotes.get(submitted.request.id).quote
  const decided = await (await post(`/api/owner/quotes/${submitted.request.id}/approve`, { version })).json()
  assert.equal(decided.quote.status, 'sent')
  await mailer.idle()
  assert.ok(outbox.forRequest(submitted.request.id).some(row => row.type === 'quote-sent'))

  const paid = await (await post(`/api/requests/${submitted.request.id}/pay`, { customerKey: KEY })).json()
  assert.equal(paid.quote.status, 'paid')
  await mailer.idle()
  const types = outbox.forRequest(submitted.request.id).map(row => row.type).sort()
  assert.deepEqual(types, ['payment-recorded', 'quote-sent', 'request-arrived', 'request-received'])

  const rejected = await (await post(`/api/owner/quotes/${submitted.request.id}/reject`, { version: quotes.get(submitted.request.id).quote.version })).json()
  assert.equal(rejected.error !== undefined || rejected.quote?.status !== 'sent', true, 'a rejection after payment is refused and sends nothing')
  await mailer.idle()
  assert.equal(outbox.forRequest(submitted.request.id).length, 4, 'no message for a refused transition')

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
