/**
 * Does a real SIGTERM actually drain in-flight mail? (#285)
 *
 * The one assertion #399 shipped without. Everything inside `shutdown()` is
 * unit-tested; the *sequence* was not, because a POSIX signal cannot be
 * delivered on the Windows machine this project is developed on -- Git Bash's
 * `kill` cannot see the native PID and `taskkill` terminates without running
 * handlers.
 *
 * What was NOT true, and was corrected before #399 merged: that the handler
 * had therefore never run. `fly-deploy.yml` runs on `ubuntu-latest`, its check
 * job starts `node backend/server.mjs &` and tears it down with
 * `trap 'kill $server ...' EXIT` -- `kill` with no signal is SIGTERM, and
 * `server.mjs` carries `process.on('SIGTERM', shutdown)`. So the handler has
 * been invoked on Linux on every run of that job for as long as the file has
 * existed. **What is missing is an instrument, not an execution.**
 *
 * And what that job exercises is the trivial case: it sets no `KMT_MAIL_*`, so
 * the adapter is `NullAdapter`, nothing is ever in flight at teardown, and the
 * drain has nothing to drain. The ordering runs; the drain does not. That is
 * why this script configures a provider of its own rather than reusing the
 * gate's server.
 *
 * ## What it asserts, and why the obvious version is not enough
 *
 * Not "the row left `queued`". Per #285's own finding a `queued` row proves
 * nothing in either direction: a crash between a successful send and
 * `updateStatus` leaves `queued` on a message that was actually delivered, and
 * that row is byte-identical to an ordinary null-adapter row. The evidence that
 * a real send completed *and was recorded* is `status='sent'` carrying a
 * **`provider_id`**, which only a provider can supply.
 *
 * ## The fake SMTP server, and why it has to be slow
 *
 * A send that has already finished proves nothing about draining. So the
 * server below speaks just enough SMTP for nodemailer to get through EHLO,
 * MAIL FROM, RCPT TO and DATA, and then **holds the final 250 back** until this
 * script says otherwise. SIGTERM is sent while it is holding, so the send is
 * genuinely in flight at the moment the process is asked to stop.
 *
 * No AUTH: `readMailConfig` treats host-without-user as an IP-allowlisted
 * relay, which is a real supported mode and the one that needs no credential.
 *
 * ## On the platform gate
 *
 * On a platform that cannot deliver a real SIGTERM this exits **2, UNDETERMINED**
 * -- never 0. A check that cannot run must not look like a check that passed;
 * that is the whole lesson of the address-family check that would have
 * announced a registrar problem it had no way to observe. CI is Linux, so the
 * skip should never fire there, and if it ever does, that is a finding.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const EXPECTED_CHECKS = 7

/**
 * Fly's `kill_timeout` default, and nothing in `fly.toml` overrides it. A
 * drain that needs longer than this does not exist in production, however well
 * it behaves locally.
 */
const GRACE_MS = 5000

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
const ok = (message) => { passed += 1; console.log(`OK: ${message}`) }
const fail = (message) => { failed += 1; console.error(`FAIL: ${message}`) }

if (process.platform === 'win32') {
  console.error('UNDETERMINED: this platform cannot deliver a real SIGTERM to a child process,')
  console.error('so the shutdown sequence cannot be observed here. Not a pass and not a failure.')
  console.error('Run it on Linux; CI does. If CI ever reaches this line, that is the finding.')
  process.exit(2)
}

/* ------------------------------------------------------------- fake SMTP */

/** Held open until `release()`; that hold is what puts a send "in flight". */
function slowSmtpServer() {
  let releaseData
  const dataHeld = new Promise(resolve => { releaseData = resolve })
  let sawData = false
  const server = createServer(socket => {
    let buffer = ''
    let inData = false
    socket.write('220 fake.kmt.test ESMTP\r\n')
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8')
      if (inData) {
        if (!buffer.includes('\r\n.\r\n')) return
        inData = false
        buffer = ''
        sawData = true
        await dataHeld                       // the whole point: hold it open
        socket.write('250 2.0.0 Ok: queued as FAKEID0001\r\n')
        return
      }
      let index
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.kmt.test\r\n250 8BITMIME\r\n')
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 Ok\r\n')
        else if (verb === 'DATA') { socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); inData = true; buffer = '' }
        else if (verb === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end() }
        else socket.write('250 2.0.0 Ok\r\n')
      }
    })
    socket.on('error', () => {})
  })
  return {
    server,
    release: () => releaseData(),
    sawData: () => sawData,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
  }
}

/* ----------------------------------------------------------------- harness */

const dir = mkdtempSync(path.join(tmpdir(), 'kmt-drain-'))
const dbPath = path.join(dir, 'owner.sqlite')
const smtp = slowSmtpServer()
let child = null

const cleanup = () => {
  try { if (child && child.exitCode === null) child.kill('SIGKILL') } catch { /* already gone */ }
  try { smtp.server.close() } catch { /* not listening */ }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* best effort */ }
}

try {
  const smtpPort = await smtp.listen()
  const port = 4247

  child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      KMT_BIND: '127.0.0.1',
      KMT_OWNER_DB: dbPath,
      KMT_OWNER_PASSWORD: 'shutdown-drain-check',
      KMT_SESSION_SECRET: 'shutdown-drain-check-secret',
      // An IP-allowlisted relay: a host with no user is a supported mode and
      // needs no credential. Both addresses are required once SMTP is set.
      KMT_MAIL_SMTP_HOST: '127.0.0.1',
      KMT_MAIL_SMTP_PORT: String(smtpPort),
      KMT_MAIL_FROM: 'quotes@kmt.test',
      KMT_OWNER_EMAIL: 'owner@kmt.test',
      KMT_OWNER_NAME: 'Ken',
    },
  })
  const log = []
  child.stdout.on('data', d => log.push(d.toString()))
  child.stderr.on('data', d => log.push(d.toString()))

  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 60; i++) {
    const answered = await fetch(base + '/api/health').then(r => r.ok).catch(() => false)
    if (answered) { up = true; break }
    if (child.exitCode !== null) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (!up) {
    fail(`the server never answered /api/health on ${port}. Server output:\n${log.join('')}`)
  } else {
    ok('the server booted with a configured SMTP relay')

    // A real customer submission, so the mail is fired the way production
    // fires it -- through mailer.after() from the request handler.
    const catalog = await (await fetch(base + '/api/catalog')).json()
    const tire = (catalog.tires || catalog).find?.(t => t.id?.startsWith('giga-')) ?? (catalog.tires || catalog)[0]
    const soon = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const submit = await fetch(base + '/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerKey: 'd'.repeat(32), tireSize: tire.size, tireSelection: tire.id, quantity: 4,
        vehicleInfo: 'SHUTDOWN DRAIN CHECK', location: '456 Demo Ave, Malden, MA 02148',
        locationType: 'Home', serviceZip: '02148', date: soon,
        customerName: 'Drain Check', customerEmail: 'drain-check@kmt.test',
      }),
    })
    if (!submit.ok) {
      fail(`the submission was refused (${submit.status}): ${(await submit.text()).slice(0, 300)}`)
    } else {
      ok('a request was submitted, which fires the mail the way production does')

      // Wait until the fake provider is actually holding a message open. This
      // is the difference between draining a send and draining nothing.
      let inFlight = false
      for (let i = 0; i < 80; i++) {
        if (smtp.sawData()) { inFlight = true; break }
        await new Promise(r => setTimeout(r, 100))
      }
      if (!inFlight) {
        fail('no message reached the provider, so there was nothing in flight to drain. ' +
             `The rest of this check would have passed vacuously. Server output:\n${log.join('')}`)
      } else {
        ok('a send is genuinely in flight: the provider is holding a message open')

        // The moment of truth. The drain must let this finish.
        const killedAt = Date.now()
        child.kill('SIGTERM')
        // Let the provider answer, as a real one would have.
        setTimeout(() => smtp.release(), 100)

        const exited = await Promise.race([
          new Promise(resolve => child.once('exit', () => resolve(true))),
          new Promise(resolve => setTimeout(() => resolve(false), GRACE_MS + 5000)),
        ])
        const took = Date.now() - killedAt

        if (!exited) {
          fail(`the process had not exited ${took} ms after SIGTERM. Fly SIGKILLs at ${GRACE_MS} ms, ` +
               'so this shutdown would be cut off rather than completed.')
        } else {
          ok(`the process exited ${took} ms after SIGTERM`)
          if (took < GRACE_MS) ok(`and did so inside Fly's ${GRACE_MS} ms kill_timeout`)
          else fail(`but ${took} ms is past Fly's ${GRACE_MS} ms kill_timeout -- in production this would be SIGKILLed mid-drain`)
        }

        // Read the record the shutdown was supposed to leave behind.
        const db = new DatabaseSync(dbPath, { readOnly: true })
        const rows = db.prepare('SELECT type, status, provider_id, attempted_at FROM outbox ORDER BY rowid').all()
        db.close()

        const delivered = rows.filter(r => r.status === 'sent' && r.provider_id)
        if (delivered.length > 0) {
          ok(`the in-flight message was recorded sent with a provider id (${delivered.length} of ${rows.length} row(s))`)
        } else {
          fail('no outbox row reached `sent` with a provider_id. ' +
               `Rows: ${JSON.stringify(rows)}. A row left \`queued\` here is the #285 strand: the ` +
               'provider may well have delivered it and nothing recorded that it did.')
        }

        const stranded = rows.filter(r => r.status === 'queued' && r.attempted_at)
        if (stranded.length === 0) ok('and no row was left attempted-but-unresolved, which is the state a retry cannot safely act on')
        else fail(`${stranded.length} row(s) left \`queued\` with an attempt recorded -- delivered or not, nobody can tell: ${JSON.stringify(stranded)}`)
      }
    }
  }
} finally {
  cleanup()
}

const ran = passed + failed
console.log(`\n${passed} OK, ${failed} FAIL -- ${ran} of ${EXPECTED_CHECKS} expected checks ran`)
if (ran < EXPECTED_CHECKS) {
  console.error(`FAIL: only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`)
  process.exitCode = 1
} else if (ran > EXPECTED_CHECKS) {
  console.error(`FAIL: ${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`)
  process.exitCode = 1
} else if (failed > 0) {
  process.exitCode = 1
}
