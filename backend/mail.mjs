// The email seam (t37): one module that turns a request event into a message,
// records it in the outbox, and hands it to whichever provider is configured.
//
// The provider is behind an adapter with one method, `send(message)`, and the
// default adapter sends nothing: with no SMTP configuration in the environment
// every message is recorded `queued` and the flow is verifiable with no
// account and no inbox (R25). The gate therefore never sends. With a host and
// a credential, the SMTP adapter sends through the owner's own Google
// Workspace -- the relay at smtp-relay.gmail.com or a mailbox at
// smtp.gmail.com with an App Password are the same code with different
// values -- and the message id the server assigns is stored on the row as the
// provider id. The user decided this over a third-party sender, and the seam
// was built so that decision is an adapter, not a rewrite.
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
 * code (m10 non-functional). SMTP settings without a sending address or an
 * owner address are a misconfigured deploy and are refused at boot, the same
 * as a missing owner password; no SMTP settings at all is the outbox-only
 * mode and is fine. The credential is `KMT_MAIL_SMTP_PASSWORD`: an App
 * Password or a relay credential, set by the user as a Fly secret, never
 * read by anyone else.
 */
export function readMailConfig(env = process.env) {
  const host = (env.KMT_MAIL_SMTP_HOST || '').trim()
  const user = (env.KMT_MAIL_SMTP_USER || '').trim()
  const password = env.KMT_MAIL_SMTP_PASSWORD || ''
  const port = Number(env.KMT_MAIL_SMTP_PORT || 587)
  const from = (env.KMT_MAIL_FROM || '').trim()
  const ownerEmail = (env.KMT_OWNER_EMAIL || '').trim()
  const ownerName = (env.KMT_OWNER_NAME || 'Ken\'s Mobile Tire').trim()
  const configured = Boolean(host || user || password)
  if (configured) {
    if (!from) throw new Error('SMTP is configured but KMT_MAIL_FROM is not. Set the mailbox on the domain that mail is sent from, e.g. quotes@kensmobiletire.com.')
    if (!ownerEmail) throw new Error('SMTP is configured but KMT_OWNER_EMAIL is not. Set the address the owner reads and customers reply to.')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`KMT_MAIL_SMTP_PORT must be a port number, got ${JSON.stringify(env.KMT_MAIL_SMTP_PORT)}.`)
    if ((user && !password) || (!user && password)) throw new Error('KMT_MAIL_SMTP_USER and KMT_MAIL_SMTP_PASSWORD go together: set both for an authenticated mailbox or relay, or neither for an IP-allowlisted relay.')
  }
  return {
    provider: configured ? 'smtp' : 'none',
    host: host || 'smtp-relay.gmail.com', port, user, password,
    from, ownerEmail, ownerName,
  }
}

/** Sends nothing; the row stays `queued`. The default, and what the gate runs. */
export class NullAdapter {
  name = 'none'
  async send() { return { providerId: null, sent: false } }
}

/**
 * SMTP through nodemailer: STARTTLS on 587 (implicit TLS on 465), AUTH when a
 * user and password are given, one message per send, the server-assigned
 * message id kept. Bounces come back to the reply-to mailbox, which is the
 * owner's; a delivery feed comes later if it is ever wanted.
 *
 * `transporter` is injectable so the tests never open a socket; the real one
 * is created lazily on the first send, so a server that never sends never
 * loads the library.
 */
export class SmtpAdapter {
  name = 'smtp'
  constructor({ host, port = 587, user = '', password = '', transporter = null }) {
    if (!host) throw new Error('The SMTP adapter needs a host.')
    this.options = {
      host, port,
      secure: port === 465,
      ...(user ? { auth: { user, pass: password } } : {}),
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    }
    this.transporter = transporter
  }

  async transport() {
    if (!this.transporter) {
      const { default: nodemailer } = await import('nodemailer')
      this.transporter = nodemailer.createTransport(this.options)
    }
    return this.transporter
  }

  async send({ from, to, toName, replyTo, subject, text, html }) {
    const transporter = await this.transport()
    const info = await transporter.sendMail({
      from,
      to: toName ? { name: toName, address: to } : to,
      ...(replyTo ? { replyTo } : {}),
      subject, text, html,
    })
    return { providerId: info?.messageId ?? null, sent: true }
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
   *
   * The request is re-read here as the owner sees it: what the handlers
   * return is the customer shape, which carries no contact fields (t44).
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
  const adapter = config.provider === 'smtp'
    ? new SmtpAdapter({ host: config.host, port: config.port, user: config.user, password: config.password })
    : new NullAdapter()
  return new Mailer({ outbox, quotes, adapter, config, origin, log })
}

export { MAIL_TYPES }
