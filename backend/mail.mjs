// The email seam (t37): one module that turns a request event into a message,
// records it in the outbox, and hands it to whichever provider is configured.
//
// The provider is behind an adapter with one method, `send(message)`, and the
// default adapter sends nothing: with no `KMT_MAIL_API_KEY` in the environment
// every message is recorded `queued` and the flow is verifiable with no
// account and no inbox (R25). The gate therefore never sends. With a key, the
// Resend adapter makes one POST per message with `fetch` -- no SDK -- and the
// message id it returns is stored on the row as the provider id.
//
// Sending happens after the request's own transaction has committed and is
// never awaited by the handler that triggered it: a provider outage marks the
// row `failed` and changes nothing about the request. Nothing here can make a
// submit, a decision or a payment fail because mail did.
//
// Logging rule, decided before this code existed: no address in any log line.
// A line carries the outbox row id, the type and the provider's message id.
// When an address has to be correlated across lines it is the keyed hash from
// limits.mjs, the same construction the rate limiter uses, because a log that
// once wrote customer emails into Fly's output is why that rule exists.

import { InputError } from './inventory.mjs'
import { logLabel } from './limits.mjs'
import { MAIL_TYPES, TEMPLATES } from './mail-templates.mjs'

const PRIVATE = { private: true }

/** A correlation label for an address that never reveals it. */
export const addressLabel = address => logLabel(PRIVATE, String(address || '').trim().toLowerCase())

/**
 * The mail configuration, read from the environment and nowhere else.
 *
 * Provider, sending address and the owner's address are configuration, never
 * code (m10 non-functional). A key without a sending address or an owner
 * address is a misconfigured deploy and is refused at boot, the same as a
 * missing owner password; no key at all is the outbox-only mode and is fine.
 */
export function readMailConfig(env = process.env) {
  const apiKey = (env.KMT_MAIL_API_KEY || '').trim()
  const from = (env.KMT_MAIL_FROM || '').trim()
  const ownerEmail = (env.KMT_OWNER_EMAIL || '').trim()
  const ownerName = (env.KMT_OWNER_NAME || 'Ken\'s Mobile Tire').trim()
  if (apiKey) {
    if (!from) throw new Error('KMT_MAIL_API_KEY is set but KMT_MAIL_FROM is not. Set the verified sending address, e.g. quotes@kensmobiletire.com.')
    if (!ownerEmail) throw new Error('KMT_MAIL_API_KEY is set but KMT_OWNER_EMAIL is not. Set the address the owner reads and customers reply to.')
  }
  return { provider: apiKey ? 'resend' : 'none', apiKey, from, ownerEmail, ownerName }
}

/** Sends nothing; the row stays `queued`. The default, and what the gate runs. */
export class NullAdapter {
  name = 'none'
  async send() { return { providerId: null, sent: false } }
}

/**
 * Resend's HTTP API: one POST per message, the credential in a header, the
 * returned id kept. Bounces and delivery events come later, by webhook or
 * polling; today a 2xx is `sent` and anything else is `failed` with the
 * provider's own words in the row's error column and nothing in the log.
 */
export class ResendAdapter {
  name = 'resend'
  constructor({ apiKey, fetch: fetchImpl = globalThis.fetch, endpoint = 'https://api.resend.com/emails' }) {
    if (!apiKey) throw new Error('The Resend adapter needs an API key.')
    this.apiKey = apiKey
    this.fetch = fetchImpl
    this.endpoint = endpoint
  }

  async send({ from, to, toName, replyTo, subject, text, html }) {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [toName ? `${toName.replace(/[<>"]/g, '')} <${to}>` : to],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject, text, html,
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(`Resend answered ${response.status}${body?.message ? `: ${body.message}` : ''}`)
    }
    return { providerId: body?.id ?? null, sent: true }
  }
}

/**
 * The seam. `notify(type, requestId)` is the whole surface a transition uses.
 */
export class Mailer {
  constructor({ outbox, quotes, adapter = new NullAdapter(), config, origin, templates = TEMPLATES, log = () => {} }) {
    if (!outbox) throw new Error('The mailer needs the outbox.')
    if (!quotes) throw new Error('The mailer needs the quotes store to read the owner-audience request.')
    this.outbox = outbox
    this.quotes = quotes
    this.adapter = adapter
    this.config = config
    this.origin = (origin || '').replace(/\/+$/, '')
    this.templates = templates
    this.log = log
    this.inFlight = new Set()
  }

  /** Who a message goes to: the customer on the request, or the owner. */
  recipientFor(template, request) {
    if (template.audience === 'owner') {
      return { to: this.config.ownerEmail, toName: this.config.ownerName }
    }
    return { to: request.customerEmail, toName: request.customerName }
  }

  /**
   * Record and send one message about one request. Returns the outbox row,
   * or null when nothing could be recorded (no such request, no address).
   * Never throws past this line: a provider failure is a `failed` row.
   */
  async notify(type, requestId) {
    const template = this.templates[type]
    if (!template) throw new InputError(`No mail template for ${type}.`)
    const found = this.quotes.get(requestId, 'owner')
    if (!found?.request) return null
    const { request, quote } = found
    const tire = this.quotes.catalog().find(item => item.id === request.tireSelection) ?? null
    const { to, toName } = this.recipientFor(template, request)
    if (!to || !toName) {
      this.log(`mail: ${type} for request ${request.id} has no recipient; not recorded`)
      return null
    }
    const data = template.data({ request, quote, tire, origin: this.origin, to, toName })
    const row = this.outbox.record({ requestId: request.id, type, templateVersion: template.version, data, to, toName })
    this.log(`mail: queued ${row.id} ${type} to=${addressLabel(to)}`)

    const rendered = template.render(data)
    try {
      const { providerId, sent } = await this.adapter.send({
        from: this.config.from, to, toName, replyTo: this.config.ownerEmail || undefined, ...rendered,
      })
      if (sent) {
        this.outbox.updateStatus(row.id, { status: 'sent', providerId })
        this.log(`mail: sent ${row.id} ${type} provider=${providerId ?? '-'}`)
      }
    } catch (error) {
      this.outbox.updateStatus(row.id, { status: 'failed', error: String(error?.message || error).slice(0, 500) })
      this.log(`mail: failed ${row.id} ${type}`)
    }
    return this.outbox.get(row.id)
  }

  /**
   * Fire and forget, for the API layer: the handler has already answered,
   * and nothing about mail may reach the customer's response. `idle()` lets
   * a test wait for what was started.
   */
  after(type, requestId) {
    const task = this.notify(type, requestId).catch(error => this.log(`mail: ${type} for ${requestId} threw: ${error.message}`))
    this.inFlight.add(task)
    task.finally(() => this.inFlight.delete(task))
    return task
  }

  async idle() { await Promise.allSettled([...this.inFlight]) }
}

/** The mailer for a server: adapter picked by configuration, nothing else. */
export function createMailer({ outbox, quotes, env = process.env, origin, log = console.log }) {
  const config = readMailConfig(env)
  const adapter = config.provider === 'resend' ? new ResendAdapter({ apiKey: config.apiKey }) : new NullAdapter()
  return new Mailer({ outbox, quotes, adapter, config, origin, log })
}

export { MAIL_TYPES }
