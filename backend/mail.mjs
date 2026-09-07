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
 *
 * `KMT_MAIL_FROM` must be a mailbox that actually authenticates on the
 * sending server. A domain address sent through another provider's SMTP
 * before the domain's SPF and DKIM exist fails authentication on the
 * receiving side, silently: the server accepts it, the outbox marks it
 * sent, and it is filed as spam. The message below says so at the moment
 * the value is typed; nothing here can check it.
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
    if (!from) throw new Error('SMTP is configured but KMT_MAIL_FROM is not. Set it to a mailbox that authenticates on the sending server (for Gmail, the KMT_MAIL_SMTP_USER mailbox). Until the domain has SPF and DKIM, a domain address sent through another provider fails authentication silently: filed as spam while the outbox says sent.')
    if (!ownerEmail) throw new Error('SMTP is configured but KMT_OWNER_EMAIL is not. Set the address the owner reads and customers reply to.')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`KMT_MAIL_SMTP_PORT must be a port number, got ${JSON.stringify(env.KMT_MAIL_SMTP_PORT)}.`)
    if ((user && !password) || (!user && password)) throw new Error('KMT_MAIL_SMTP_USER and KMT_MAIL_SMTP_PASSWORD go together: set both for an authenticated mailbox or relay, or neither for an IP-allowlisted relay.')
  }
  // The site's own domain, for two facts the operator confirms at boot. An
  // interim sender is a from-address not on it: the user's stopgap while the
  // domain's mail records are broken, flagged the way isPlaceholder flags the
  // markup rate, so nobody reads it as the end state. And the one trap this
  // file cannot refuse, only name: a from-domain that differs from the
  // authenticating mailbox's needs SPF and DKIM of its own, or the mail is
  // filed as spam while the outbox records it sent. Skipped when there is no
  // user, because an IP-allow-listed relay has no mailbox to compare against.
  const siteDomain = (env.KMT_CANONICAL_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '').toLowerCase()
  const domainOf = address => address.includes('@') ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : ''
  const interim = configured && Boolean(siteDomain) && Boolean(domainOf(from)) && domainOf(from) !== siteDomain
  const warnings = []
  if (configured && user && domainOf(from) && domainOf(user) && domainOf(from) !== domainOf(user)) {
    warnings.push(`KMT_MAIL_FROM is on ${domainOf(from)} but the authenticating mailbox KMT_MAIL_SMTP_USER is on ${domainOf(user)}. ${domainOf(from)}'s SPF and DKIM must authorise this server, or mail is filed as spam while the outbox records it sent.`)
  }
  return {
    provider: configured ? 'smtp' : 'none',
    host: host || 'smtp-relay.gmail.com', port, user, password,
    from, ownerEmail, ownerName,
    interim, warnings,
  }
}

/** The boot lines for mail: what a person confirms before believing a send. */
export function describeMail(config) {
  const lines = []
  if (config.provider === 'none') lines.push('Mail: no SMTP configured; every message is recorded in the outbox as queued and nothing is sent.')
  else lines.push(`Mail: SMTP via ${config.host}:${config.port}${config.user ? ' (authenticated mailbox)' : ' (relay, no auth)'}${config.interim ? ' -- INTERIM sender, not on the site domain; a stopgap, not the end state' : ''}.`)
  for (const warning of config.warnings) lines.push(`WARNING: ${warning}`)
  return lines
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
    // The active probe's last result (#285's sibling): unlike the outbox,
    // this asks whether the seam is alive even when nothing is being sent --
    // the case that hid the 2026-09-06 outage for two hours, because every
    // row that would have surfaced it was queued test traffic and nobody
    // looked. Not persisted: a restart re-probing from scratch is exactly
    // right, since the question is "right now", not "historically".
    this.smtpStatus = { status: 'unknown', checkedAt: null, error: 'Not probed yet.' }
  }

  /**
   * Ask whether the mail seam can actually authenticate, without sending
   * anything: `transporter.verify()` opens the connection, performs AUTH,
   * and disconnects -- no message, no recipient, no quota spent.
   *
   * Three states, not two, because "the probe could not run" and "the
   * probe ran and was refused" are different findings and only one of them
   * is about the credential. `responseCode` is nodemailer's signal that the
   * server actually answered (a real SMTP response came back, even a bad
   * one); its absence means the attempt never got that far -- a timeout, a
   * DNS failure, a connection refused -- which says nothing about whether
   * the credential is good. Regenerating an App Password that was never the
   * problem is exactly the ninety minutes #285's incident report spent.
   *
   * With no SMTP configured (the null adapter), there is no seam to ask
   * about at all -- `unknown`, not `ok`, because "nothing is wrong" and
   * "nothing was checked" are not the same claim.
   */
  async probeSmtp() {
    const checkedAt = new Date().toISOString()
    if (this.adapter.name !== 'smtp') {
      this.smtpStatus = { status: 'unknown', checkedAt, error: 'SMTP is not configured; nothing to probe.' }
      return this.smtpStatus
    }
    try {
      const transporter = await this.adapter.transport()
      await transporter.verify()
      this.smtpStatus = { status: 'ok', checkedAt, error: null }
    } catch (error) {
      const answered = Number.isFinite(error?.responseCode)
      this.smtpStatus = {
        status: answered ? 'failing' : 'unknown',
        checkedAt,
        error: String(error?.message || error).slice(0, 500),
      }
    }
    return this.smtpStatus
  }

  /**
   * Start the periodic probe. Five minutes: a healthy `verify()` finishes in
   * well under a second, so this is not paced by cost -- it is paced to stay
   * well clear of anything Google might read as unusual traffic against one
   * mailbox, while still being frequent enough that a revoked credential is
   * caught within minutes rather than the two hours nobody looked tonight.
   * Runs once immediately rather than waiting for the first interval, so a
   * fresh deploy (which #285 means happens on every merge to main) is not
   * silently `unknown` for five minutes after every restart.
   */
  startSmtpProbe(intervalMs = 5 * 60_000) {
    this.probeSmtp().catch(() => {})
    return setInterval(() => { this.probeSmtp().catch(() => {}) }, intervalMs)
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
