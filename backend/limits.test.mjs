import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIT_BUDGET, LIMITS, LoginThrottle, RateLimiter, clientIp, logLabel } from './limits.mjs'

/** A clock the test moves by hand. */
const clock = (start = 1_000_000) => {
  let now = start
  return { now: () => now, advance: ms => { now += ms } }
}

test('the limits sit above what one gate run does, with room', () => {
  // The audits submit, pay and cancel from one address on every pull request.
  // A limit under their budget turns every PR red in a way that reads as a
  // flaky audit, so the margin is asserted rather than remembered. Twice the
  // budget: a script may gain a scenario before anyone revisits this.
  assert.ok(LIMITS.publicPerIp.max >= 2 * AUDIT_BUDGET.publicPosts,
    `per-address limit ${LIMITS.publicPerIp.max} must be at least twice the gate's ${AUDIT_BUDGET.publicPosts} public POSTs`)
  assert.ok(LIMITS.previewPerIp.max >= 2 * AUDIT_BUDGET.previewPosts,
    `preview address limit ${LIMITS.previewPerIp.max} must be at least twice the gate's ${AUDIT_BUDGET.previewPosts} previews`)
  assert.ok(LIMITS.submitPerEmail.max >= AUDIT_BUDGET.submitsPerEmail + 8,
    `per-email cap ${LIMITS.submitPerEmail.max} must clear the gate's ${AUDIT_BUDGET.submitsPerEmail} submissions with one address`)
  // Every gate run opens a fresh browser context per scenario, so a key never
  // carries more than a few calls; the per-key limit only has to clear one.
  assert.ok(LIMITS.publicPerKey.max >= 4)
  assert.ok(LIMITS.previewPerKey.max >= 4)
  // The gate never guesses wrong, and the free failures cover a person's typos.
  assert.equal(AUDIT_BUDGET.loginFailures, 0)
  assert.ok(LIMITS.loginFailures.free >= 3)
})

test('a window counts hits, refuses past its limit, and opens again when it closes', () => {
  const time = clock()
  const logged = []
  const limiter = new RateLimiter({ rules: { hits: { max: 3, windowMs: 1000 } }, now: time.now, log: line => logged.push(line) })

  assert.deepEqual([1, 2, 3].map(() => limiter.take('hits', 'a').allowed), [true, true, true])
  const fourth = limiter.take('hits', 'a')
  assert.equal(fourth.allowed, false)
  assert.equal(fourth.retryAfterSeconds, 1, 'the wait is until the window closes')
  assert.equal(limiter.take('hits', 'b').allowed, true, 'another id has its own window')

  time.advance(1000)
  assert.equal(limiter.take('hits', 'a').allowed, true, 'the window closed and a fresh one opened')

  assert.ok(logged.some(line => /refused for a/.test(line)), 'a refusal is logged')
  assert.ok(logged.some(line => /at 2\/3 for a/.test(line)), 'the halfway mark is logged once')
  assert.equal(logged.filter(line => /at 2\/3 for a/.test(line)).length, 1)
})

test('a private id is logged as a short hash, never as itself; an address is logged as itself', () => {
  // The email cap's id is the customer's address and the key cap's id is the
  // credential that reads, pays and cancels that browser's requests. Fly's
  // logs persist and are readable by anyone who can pull them.
  assert.equal(LIMITS.publicPerKey.private, true)
  assert.equal(LIMITS.submitPerEmail.private, true)
  assert.notEqual(LIMITS.publicPerIp.private, true, 'addresses stay readable: they are what an operator blocks')

  const logged = []
  const limiter = new RateLimiter({
    rules: { submitPerEmail: { max: 2, windowMs: 1000, private: true }, publicPerIp: { max: 2, windowMs: 1000 } },
    log: line => logged.push(line),
  })
  for (let i = 0; i < 3; i++) limiter.take('submitPerEmail', 'victim@example.com')
  for (let i = 0; i < 3; i++) limiter.take('publicPerIp', '203.0.113.9')

  assert.ok(logged.length >= 4, 'the halfway mark and the refusal were logged for both')
  assert.ok(logged.every(line => !line.includes('victim') && !line.includes('example.com')), `no line carries the address: ${logged.join(' | ')}`)
  const hash = logLabel(LIMITS.submitPerEmail, 'victim@example.com')
  assert.match(hash, /^[0-9a-f]{8}$/)
  assert.ok(logged.some(line => line.includes(`submitPerEmail refused for ${hash}`)), 'the same id is recognisable across lines by its hash')
  assert.ok(logged.some(line => line.includes('publicPerIp refused for 203.0.113.9')))
  assert.equal(logLabel(LIMITS.publicPerIp, '203.0.113.9'), '203.0.113.9')

  // The label is keyed per process, not a bare digest: an address is
  // low-entropy, so anyone holding the log and a guess could otherwise compute
  // the prefix and confirm the guess. 'ffbe8cff' is sha256('victim@example.com').
  assert.notEqual(hash, 'ffbe8cff', 'a bare SHA-256 prefix would confirm a guessed address')
  assert.equal(logLabel(LIMITS.submitPerEmail, 'victim@example.com'), hash, 'stable within one process, which is all correlation needs')
})

test('the login throttle lets a few failures pass, then doubles the wait, and a success clears it', () => {
  const time = clock()
  const throttle = new LoginThrottle({
    rule: { free: 2, windowMs: 60_000, baseDelayMs: 2_000, maxDelayMs: 10_000 },
    now: time.now, log: () => {},
  })

  assert.equal(throttle.check('1.1.1.1').allowed, true)
  throttle.fail('1.1.1.1')
  throttle.fail('1.1.1.1')
  assert.equal(throttle.check('1.1.1.1').allowed, true, 'the free failures cost nothing')

  throttle.fail('1.1.1.1')
  assert.deepEqual(throttle.check('1.1.1.1'), { allowed: false, retryAfterSeconds: 2 }, 'the third failure starts the delay')
  time.advance(2_000)
  assert.equal(throttle.check('1.1.1.1').allowed, true, 'and the delay passes')

  throttle.fail('1.1.1.1')
  assert.equal(throttle.check('1.1.1.1').retryAfterSeconds, 4, 'each failure doubles it')
  time.advance(4_000)
  throttle.fail('1.1.1.1')
  assert.equal(throttle.check('1.1.1.1').retryAfterSeconds, 8)
  time.advance(8_000)
  throttle.fail('1.1.1.1')
  assert.equal(throttle.check('1.1.1.1').retryAfterSeconds, 10, 'up to the ceiling')

  assert.equal(throttle.check('2.2.2.2').allowed, true, 'a stranger elsewhere has a record of their own, and the owner is never locked')

  time.advance(10_000)
  throttle.succeed('1.1.1.1')
  throttle.fail('1.1.1.1')
  assert.equal(throttle.check('1.1.1.1').allowed, true, 'a right password cleared the count')
})

test('the client address is the platform header when present, else the socket', () => {
  assert.equal(clientIp({ headers: { 'fly-client-ip': ' 203.0.113.9 ' }, socket: { remoteAddress: '172.16.0.1' } }), '203.0.113.9')
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1')
  assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown')
})
