/**
 * Rate limits for the public endpoints and the owner's login.
 *
 * Three public POSTs -- submit, pay, cancel -- take anyone's request with no
 * session, and submit takes any email address. Today that is spam; the day
 * the email seam sends, each submission mails an attacker-chosen address from
 * the client's own domain, and a burned sending reputation is not fixed in an
 * afternoon (#63, #98). The owner's login takes unlimited guesses (#66).
 *
 * Everything here is in-process and in memory: one machine, one owner, and a
 * limit that resets on restart is still a limit. No dependency, because a
 * token bucket is thirty lines and a package is a supply chain.
 *
 * The gate audits are the hardest constraint. They submit, sign in, pay and
 * cancel repeatedly from one address on every pull request, and a limit that
 * is right for a stranger and wrong for the gate turns every PR red in a way
 * that reads as a flaky audit. AUDIT_BUDGET below is what one gate run does;
 * limits.test.mjs holds the real limits above it, so the *limits* are
 * checked against the budget mechanically. The budget itself is not checked
 * against what the gate actually does -- nothing here can run the three
 * gate scripts and re-measure -- so it is remembered, not verified, and it
 * has already sat wrong for a day once (see the comment on AUDIT_BUDGET).
 * Every process boot starts every counter at zero (the in-memory note
 * above): a gate run's own repeated CI jobs never share state with each
 * other, only a long-lived local server across several manual runs does.
 */

import { createHmac, randomBytes } from 'node:crypto'

/** A request body on a public endpoint: a form is under 3KB, so this is room. */
export const PUBLIC_BODY_LIMIT = 8 * 1024

/**
 * How an id appears in the log: as itself for an address, as eight hex
 * characters of a keyed hash for anything private. Enough to see that the
 * same id is being refused again, and nothing to read a person's address
 * back from. The rule and the count are what an operator acts on, not the
 * value.
 *
 * Keyed, not a bare digest, because an email address is low-entropy: a plain
 * SHA-256 of it is the same eight characters every boot, so anyone holding
 * the log and a guess at an address could compute the prefix and confirm the
 * guess. The key is random per process and configured nowhere. Correlation
 * within one process lifetime is all the log is for: no window outlasts a
 * day and the process restarts on every deploy. (The customer key was never
 * at risk, being 128 random bits; the address was.)
 */
const LABEL_KEY = randomBytes(32)
export const logLabel = (rule, id) =>
  rule.private ? createHmac('sha256', LABEL_KEY).update(String(id)).digest('hex').slice(0, 8) : String(id)

/**
 * What one gate run asks of the server, measured rather than estimated. On
 * 2026-09-06 the three audits run in sequence against one fresh server left
 * 14 requests in its database, every one from the same address with the
 * same email, 4 of them paid, and 12 owner sign-ins, none wrong.
 *
 * Re-measured 2026-09-06 (later the same night, after #264's cancel
 * scenarios and t35's quote editor landed): one full run of the same three
 * scripts against one fresh server left 22 requests, still every one from
 * the same email -- read directly off the database afterward, not counted
 * from a log. submitsPerEmail below moves from 20 to 22 for that reason.
 * At 22, LIMITS.submitPerEmail.max (30) clears the +8 margin
 * limits.test.mjs asserts with exactly zero left over: 30 >= 22 + 8 is
 * true with nothing to spare. The margin the design reserved for a script
 * gaining a scenario is now fully spent by the scenarios that already
 * exist; the next one added to the gate needs this number raised again,
 * or the real limit raised, or it silently fails the assertion below
 * rather than merely tightening it.
 *
 * What limits.test.mjs actually checks is LIMITS against AUDIT_BUDGET --
 * that the recorded limits still clear the recorded cost. It cannot check,
 * and does not check, AUDIT_BUDGET against what a real gate run actually
 * does today; that comparison has no mechanical form here; it is a person
 * running the three scripts and reading the database, the way both
 * measurements above were made. This constant sat at 20 for a day after
 * it should have been 22, and the test suite was green the entire time --
 * it was verifying a true fact about a false number. Recount by hand
 * whenever a scenario is added to any of the three gate scripts, the same
 * way the comment above once said to and nothing enforced.
 */
export const AUDIT_BUDGET = { publicPosts: 24, submitsPerEmail: 22, loginFailures: 0 }

export const LIMITS = {
  /** Public POSTs (submit, pay, cancel) from one address. */
  publicPerIp: { max: 60, windowMs: 15 * 60_000 },
  /**
   * The same, from one browser key: a stranger with many addresses still has
   * one key per browser. `private`: the key is the credential that reads, pays
   * and cancels that browser's requests, so the log carries a hash of it, not it.
   */
  publicPerKey: { max: 20, windowMs: 15 * 60_000, private: true },
  /**
   * Submissions naming one email address in a day: the cap that keeps the
   * mail seam from relaying. `private`: a customer's address is not ours to
   * write into a third-party log because they submitted twice too often.
   */
  submitPerEmail: { max: 30, windowMs: 24 * 3600_000, private: true },
  inquiriesPerContact: { max: 10, windowMs: 24 * 3600_000, private: true },
  /**
   * Wrong passwords from one address before the delay starts, and how it grows.
   * Per address, never per account: a lock on the account would let anyone
   * lock the owner out of his own business by guessing wrong a few times.
   */
  loginFailures: { free: 5, windowMs: 15 * 60_000, baseDelayMs: 2_000, maxDelayMs: 5 * 60_000 },
}

/**
 * The address a request came from.
 *
 * Behind Fly the socket peer is the proxy, and the client is named in
 * `Fly-Client-IP`; locally and in the gate the socket is the client. The
 * header is trusted only because nothing but the proxy can reach the process
 * on the platform; a deployment that exposes the port directly would have to
 * stop reading it.
 */
export function clientIp(request) {
  const header = request.headers['fly-client-ip']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return request.socket?.remoteAddress || 'unknown'
}

/** Drop entries whose window has passed, so an idle process does not keep every address it ever saw. */
function prune(map, now) {
  if (map.size < 1000) return
  for (const [key, entry] of map) if (entry.resetAt <= now) map.delete(key)
}

/**
 * Fixed windows per scope and id: the first hit opens a window, hits inside it
 * count, and the window closes on its own. Simpler than a leaking bucket and
 * enough here: the aim is a ceiling a person never meets, not smooth pacing.
 */
export class RateLimiter {
  constructor({ rules = LIMITS, now = Date.now, log = console.warn } = {}) {
    this.rules = rules
    this.now = now
    this.log = log
    this.windows = new Map()
  }

  /**
   * Count one hit against `rule` for `id`, and say whether it is over.
   *
   * Refusals are logged, because a limit nobody sees firing is one nobody
   * tunes; and the halfway mark is logged once per window, so an address
   * approaching the ceiling in normal use is visible before it is refused.
   */
  take(rule, id) {
    const spec = this.rules[rule]
    const { max, windowMs } = spec
    const now = this.now()
    prune(this.windows, now)
    const key = `${rule}:${id}`
    let entry = this.windows.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs, warned: false }
      this.windows.set(key, entry)
    }
    entry.count += 1
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    const label = logLabel(spec, id)
    if (entry.count > max) {
      this.log(`rate limit: ${rule} refused for ${label} (${entry.count} in window, limit ${max}, retry in ${retryAfterSeconds}s)`)
      return { allowed: false, retryAfterSeconds, count: entry.count }
    }
    if (!entry.warned && entry.count * 2 >= max) {
      entry.warned = true
      this.log(`rate limit: ${rule} at ${entry.count}/${max} for ${label}`)
    }
    return { allowed: true, retryAfterSeconds: 0, count: entry.count }
  }
}

/**
 * A growing delay on wrong passwords, per address.
 *
 * The first few failures cost nothing: a mistyped password is not an attack.
 * After that each failure doubles the wait before the next attempt is even
 * read, up to a ceiling, and a correct password clears the record. There is
 * no lock: the owner is never kept out, only slowed down along with everyone
 * else at his address, and a stranger elsewhere gets a record of their own.
 */
export class LoginThrottle {
  constructor({ rule = LIMITS.loginFailures, now = Date.now, log = console.warn } = {}) {
    this.rule = rule
    this.now = now
    this.log = log
    this.records = new Map()
  }

  /** May this address try now? If not, how long until it may. */
  check(ip) {
    const now = this.now()
    prune(this.records, now)
    const record = this.records.get(ip)
    if (!record || record.resetAt <= now) return { allowed: true, retryAfterSeconds: 0 }
    if (record.until > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((record.until - now) / 1000)) }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** A wrong password: count it, and set the wait before the next try. */
  fail(ip) {
    const now = this.now()
    const { free, windowMs, baseDelayMs, maxDelayMs } = this.rule
    let record = this.records.get(ip)
    if (!record || record.resetAt <= now) {
      record = { failures: 0, until: 0, resetAt: now + windowMs }
      this.records.set(ip, record)
    }
    record.failures += 1
    const over = record.failures - free
    if (over > 0) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (over - 1))
      record.until = now + delay
      record.resetAt = Math.max(record.resetAt, record.until + windowMs)
      this.log(`login: ${record.failures} failures from ${ip}; next attempt in ${Math.ceil(delay / 1000)}s`)
    } else {
      this.log(`login: wrong password from ${ip} (${record.failures} of ${free} before the delay starts)`)
    }
  }

  /** A right password: the record is cleared, so the owner is never slowed by his own earlier typo. */
  succeed(ip) {
    this.records.delete(ip)
  }
}

/** Answer a refusal the way every other JSON error here is answered, with the wait named. */
export function refuse(response, retryAfterSeconds, message) {
  response.writeHead(429, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Retry-After': String(retryAfterSeconds),
  })
  response.end(JSON.stringify({ error: message }))
}
