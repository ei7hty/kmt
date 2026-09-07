/**
 * Password gate for the owner workspace.
 *
 * The local server did not need this: it bound to loopback and refused any Host
 * but localhost, so the only person who could reach it was already at the
 * keyboard. A hosted server has no such protection, and behind `/owner` sit
 * supplier costs, KMT's margins and a button that rewrites every price. So the
 * gate is not optional, and `requireOwnerPassword` refuses to start without one
 * rather than defaulting to open.
 *
 * One shared password, because there is one owner. It is deliberately not an
 * account system: no users table, no registration, no reset flow. If more than
 * one person ever needs their own login, replace this rather than growing it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { PUBLIC_BODY_LIMIT, clientIp, refuse } from './limits.mjs'

const COOKIE = 'kmt_owner'
/** The cookie name a caller needs to mint or recognise a session by hand (scripts/mint-session.mjs). */
export const SESSION_COOKIE_NAME = COOKIE
const DEFAULT_TTL_HOURS = 12

/**
 * Where live sessions are kept, so that logging out means something.
 *
 * A session cookie used to be a signed timestamp and nothing else: logging out
 * cleared the browser's copy, and a copied cookie stayed good for its whole
 * twelve hours (#66). Each session now has an id the server remembers, and a
 * cookie whose id the server has forgotten is refused whatever its signature
 * says. The store is a table in the same database as everything else rather
 * than process memory, because a deploy restarts the process and the owner
 * should not be signed out by every merge. Import tokens stay stateless: two
 * hours, one purpose, and nothing to log out of.
 */
export function createSessionStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  )`)
  const insert = db.prepare('INSERT INTO owner_sessions (id, expires_at) VALUES (?, ?)')
  const select = db.prepare('SELECT expires_at FROM owner_sessions WHERE id=?')
  const remove = db.prepare('DELETE FROM owner_sessions WHERE id=?')
  const sweep = db.prepare('DELETE FROM owner_sessions WHERE expires_at <= ?')
  return {
    create(expiresAt) {
      sweep.run(Date.now())
      const id = randomBytes(16).toString('hex')
      insert.run(id, expiresAt)
      return id
    },
    has(id) {
      const row = select.get(id)
      return Boolean(row) && row.expires_at > Date.now()
    },
    delete(id) { remove.run(id) },
  }
}

/** The same contract in memory, for tests and for a server without a database. */
export function memorySessionStore() {
  const live = new Map()
  return {
    create(expiresAt) {
      const id = randomBytes(16).toString('hex')
      live.set(id, expiresAt)
      return id
    },
    has(id) {
      const expiresAt = live.get(id)
      return expiresAt !== undefined && expiresAt > Date.now()
    },
    delete(id) { live.delete(id) },
  }
}

const b64 = (value) => Buffer.from(value).toString('base64url')

/** Constant-time compare that tolerates different lengths without throwing. */
function equals(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) {
    // Still compare something, so a wrong length is not faster than a wrong byte.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Read the configuration, and fail loudly if it would leave the workspace open.
 *
 * `KMT_OWNER_PASSWORD` is required. `KMT_SESSION_SECRET` is not: without one a
 * random secret is generated per boot, which is safe but signs every existing
 * session out on restart. Set it in any deployment you do not want logging
 * people out on every deploy.
 */
export function readAuthConfig(env = process.env) {
  const password = env.KMT_OWNER_PASSWORD || ''
  if (!password) {
    throw new Error(
      'KMT_OWNER_PASSWORD is not set. The owner workspace exposes supplier costs ' +
      'and lets anyone change prices, so this server refuses to start without a ' +
      'password. Set one in the environment and redeploy.',
    )
  }
  if (password.length < 12) {
    throw new Error('KMT_OWNER_PASSWORD must be at least 12 characters.')
  }

  // Unset means the default. Anything set has to be a positive number of
  // hours: `KMT_SESSION_HOURS=abc` used to become NaN, so login answered 200
  // with `Max-Age=NaN`, the browser dropped the cookie, and the owner was
  // locked out with nothing in the log saying why. Refusing to boot names
  // the variable instead, the way a missing password does (#86).
  const hours = env.KMT_SESSION_HOURS === undefined || env.KMT_SESSION_HOURS === ''
    ? DEFAULT_TTL_HOURS
    : Number(env.KMT_SESSION_HOURS)
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `KMT_SESSION_HOURS must be a positive number of hours; got ${JSON.stringify(env.KMT_SESSION_HOURS)}. ` +
      `Unset it for the default of ${DEFAULT_TTL_HOURS}.`,
    )
  }

  return {
    password,
    secret: env.KMT_SESSION_SECRET || randomBytes(32).toString('hex'),
    ttlMs: hours * 3600_000,
    generatedSecret: !env.KMT_SESSION_SECRET,
  }
}

/**
 * The minimal config mintSession needs: a secret and a ttl, not a password.
 *
 * readAuthConfig refuses without KMT_OWNER_PASSWORD because it is the login
 * config -- a server that will check a password must have one to check.
 * Minting a session never checks a password, so requiring one here would be
 * an incidental dependency inherited from that guard, not a real one -- and
 * it is exactly the dependency that broke scripts/mint-session.mjs at the
 * one moment it exists to work: after the password is retired for
 * Google-only owner sign-in.
 *
 * KMT_SESSION_SECRET is required here, unlike in readAuthConfig, for the
 * opposite reason readAuthConfig lets it default: a server signs and later
 * verifies its own tokens in the same process, so a per-boot random secret
 * is internally consistent even though it forgets sessions on restart.
 * Minting runs in a separate process from the one that will verify the
 * cookie. A generated secret here would sign with a value the running
 * server never sees, producing a token that looks real and authenticates
 * nothing -- the worst failure shape a recovery tool can have, because it
 * looks like it worked. Refusing means whoever runs this without
 * KMT_SESSION_SECRET set finds out immediately, not after handing Ken a
 * dead cookie.
 */
export function readSessionSigningConfig(env = process.env) {
  const secret = env.KMT_SESSION_SECRET || ''
  if (!secret) {
    throw new Error(
      'KMT_SESSION_SECRET is not set. Minting happens in a different process from the ' +
      'one that will verify the cookie, so both must sign with the same secret -- set ' +
      'KMT_SESSION_SECRET to whatever the running server was started with.',
    )
  }

  const hours = env.KMT_SESSION_HOURS === undefined || env.KMT_SESSION_HOURS === ''
    ? DEFAULT_TTL_HOURS
    : Number(env.KMT_SESSION_HOURS)
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `KMT_SESSION_HOURS must be a positive number of hours; got ${JSON.stringify(env.KMT_SESSION_HOURS)}. ` +
      `Unset it for the default of ${DEFAULT_TTL_HOURS}.`,
    )
  }

  return { secret, ttlMs: hours * 3600_000 }
}

const sign = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url')

/**
 * Tokens carry what they are for, so one kind cannot be used as another.
 *
 * The import token travels in a URL inside a bookmarklet and is handed to a
 * page on giga-tires.com; the session cookie unlocks the whole workspace. If
 * both were just "a signed timestamp", the first would be the second.
 */
function issue(config, purpose = 'session', ttlMs = config.ttlMs, id = '') {
  const payload = b64(`${purpose}:${Date.now() + ttlMs}:${id}`)
  return `${payload}.${sign(config.secret, payload)}`
}

/**
 * What a token says, if its signature is good and it has not expired: its
 * purpose and the session id it names, or null. The signature is checked
 * first so nothing after it is reading attacker-chosen bytes.
 */
function open(config, token) {
  if (typeof token !== 'string') return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  if (!equals(signature, sign(config.secret, payload))) return null

  const [purpose, expires, id = ''] = Buffer.from(payload, 'base64url').toString().split(':')
  if (!Number.isFinite(Number(expires)) || Number(expires) <= Date.now()) return null
  return { purpose, id }
}

function verify(config, token, purpose = 'session') {
  const opened = open(config, token)
  return opened !== null && opened.purpose === purpose
}

/** A session cookie is good only while the server still remembers its id. */
function verifySession(config, sessions, token) {
  const opened = open(config, token)
  return opened !== null && opened.purpose === 'session' && Boolean(opened.id) && sessions.has(opened.id)
}

/**
 * Short-lived credential for posting supplier pages back from a giga-tires tab.
 *
 * Two hours, because it is pasted into a bookmark and then sits in the browser's
 * bookmark bar where the owner may forget it. It authorises exactly one thing --
 * importing pages for a supported size -- and cannot read or change anything.
 */
export const IMPORT_TTL_MS = 2 * 3600_000
export const createImportToken = (config) => issue(config, 'import', IMPORT_TTL_MS)
export const verifyImportToken = (config, token) => verify(config, token, 'import')

/**
 * A session an operator creates directly, without a password check.
 *
 * The one deliberate way in that stays open once the login form is retired
 * for Google-only owner sign-in: a human with database access -- `flyctl ssh`
 * in production, a local file otherwise -- runs `scripts/mint-session.mjs`,
 * which calls this and nothing else. It reaches no route and grants no
 * capability that access does not already carry: anyone who can run this can
 * already insert an `owner_sessions` row and sign a matching cookie by hand.
 * This only does the arithmetic and the signing correctly, and records the
 * row through the same `sessions.create` every login does, so a minted
 * session logs out, expires and gets swept exactly like one issued by a
 * password.
 */
export function mintSession(config, sessions, ttlMs = config.ttlMs) {
  const expiresAt = Date.now() + ttlMs
  const id = sessions.create(expiresAt)
  return { name: COOKIE, value: issue(config, 'session', ttlMs, id), expiresAt }
}

const readCookie = (header, name) =>
  (header || '').split(';')
    .map(part => part.trim().split('='))
    .find(([key]) => key === name)?.[1]

/**
 * The auth layer, as a handler that returns true when it has answered.
 *
 * `secure` follows the request rather than being hardcoded, so the cookie gets
 * the Secure flag behind TLS and still works over plain http on a local run.
 *
 * `sessions` is where live session ids are kept (a database table on the
 * server, memory by default). `throttle` slows wrong passwords per address
 * (#66); without one, as in most tests, guesses are not counted.
 */
export function createAuth(config, { sessions = memorySessionStore(), throttle = null } = {}) {
  const isSecure = (request) =>
    (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(request.socket.encrypted)

  const setCookie = (request, value, maxAgeSeconds) => [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict (t47, #89): Strict withholds the cookie on every
    // top-level navigation from another site, including the link in a mail
    // client, so the owner tapping a notification landed on the sign-in
    // screen every time while holding a valid session. Lax still withholds it
    // on cross-site POST, which is the attack Strict was chosen against; the
    // import endpoint keeps its bearer token for the same reason.
    'SameSite=Lax',
    isSecure(request) ? 'Secure' : '',
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join('; ')

  const signedIn = (request) => verifySession(config, sessions, readCookie(request.headers.cookie, COOKIE))

  return {
    isAuthenticated: signedIn,

    /**
     * Bearer authorisation for posting supplier pages back.
     *
     * A cookie cannot do this job: the session cookie is SameSite=Lax, which
     * is sent on a top-level navigation from another site but never on a
     * cross-site POST, so a request from a giga-tires page never carries it --
     * which is the point and worth keeping. A scoped bearer token travels
     * instead, and can do nothing but import.
     */
    isImportAuthorized: (request) => {
      const header = request.headers.authorization || ''
      return header.startsWith('Bearer ') && verifyImportToken(config, header.slice(7).trim())
    },

    /** A fresh import token for the signed-in owner to put in a bookmarklet. */
    newImportToken: () => createImportToken(config),

    /** Handles /api/owner/login and /logout. Returns true if it responded. */
    async handle(request, response, url, body) {
      const json = (status, value, headers = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
        response.end(JSON.stringify(value))
        return true
      }

      if (url.pathname === '/api/owner/session' && request.method === 'GET') {
        return json(200, { authenticated: signedIn(request) })
      }

      if (url.pathname === '/api/owner/login' && request.method === 'POST') {
        // A slowed address is answered before its body is read: the guess is
        // not even looked at until the wait has passed.
        const ip = clientIp(request)
        const wait = throttle ? throttle.check(ip) : { allowed: true }
        if (!wait.allowed) {
          refuse(response, wait.retryAfterSeconds, `Too many attempts. Try again in ${wait.retryAfterSeconds} seconds.`)
          return true
        }

        // The body reader refuses a wrong content type, an oversized body and
        // malformed JSON with a status of its own. Uncaught, each of those was
        // a 500 with a stack trace in the response (#69). Input errors carry a
        // status and are answered as written; anything without one is a real
        // fault, logged here and answered without detail.
        let input
        try {
          input = await body(request, PUBLIC_BODY_LIMIT)
        } catch (error) {
          if (!error.status) console.error(error)
          return json(error.status || 500, {
            error: error.status ? error.message : 'Could not complete the request. Nothing was changed.',
          })
        }
        if (!equals(input?.password ?? '', config.password)) {
          // No detail about why. A wrong password and an absent one are the
          // same answer to whoever is guessing.
          throttle?.fail(ip)
          return json(401, { error: 'Incorrect password.' })
        }
        throttle?.succeed(ip)
        const expiresAt = Date.now() + config.ttlMs
        const id = sessions.create(expiresAt)
        return json(200, { authenticated: true }, {
          'Set-Cookie': setCookie(request, issue(config, 'session', config.ttlMs, id), Math.floor(config.ttlMs / 1000)),
        })
      }

      // Issued to a signed-in owner only. Everything the bookmarklet needs to
      // authenticate is in here, so this route is behind the session like any
      // other read of workspace state.
      if (url.pathname === '/api/owner/import-token' && request.method === 'POST') {
        if (!signedIn(request)) {
          return json(401, { error: 'Sign in to use the owner workspace.' })
        }
        return json(200, { token: createImportToken(config), expiresInMs: IMPORT_TTL_MS })
      }

      // Logging out forgets the session on the server, so the cookie is dead
      // wherever a copy of it went, and then clears the browser's copy.
      if (url.pathname === '/api/owner/logout' && request.method === 'POST') {
        const opened = open(config, readCookie(request.headers.cookie, COOKIE))
        if (opened?.purpose === 'session' && opened.id) sessions.delete(opened.id)
        return json(200, { authenticated: false }, { 'Set-Cookie': setCookie(request, '', 0) })
      }

      return false
    },
  }
}
