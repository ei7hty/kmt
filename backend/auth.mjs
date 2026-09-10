/**
 * Authentication gate for the owner workspace.
 *
 * The local server did not need this: it bound to loopback and refused any Host
 * but localhost, so the only person who could reach it was already at the
 * keyboard. A hosted server has no such protection, and behind `/owner` sit
 * supplier costs, KMT's margins and a button that rewrites every price. So the
 * gate is not optional: the hosted server refuses to start unless Google or a
 * valid shared password provides a way in, rather than defaulting to open.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { PUBLIC_BODY_LIMIT, clientIp, refuse } from './limits.mjs'
import { exchangeCodeForIdToken, fetchGoogleClaims, googleAuthUrl, readGoogleConfig, verifyGoogleClaims } from './google-auth.mjs'

const COOKIE = 'kmt_owner'
/** The cookie name a caller needs to mint or recognise a session by hand (scripts/mint-session.mjs). */
export const SESSION_COOKIE_NAME = COOKIE
/**
 * Carries the sign-in `state` nonce between the redirect out and the callback
 * back, so a callback can be tied to the browser that began the sign-in.
 *
 * A cookie rather than a server-side table because it is one short-lived value
 * per attempt and the signing machinery already exists. It is SameSite=Lax for
 * the reason recorded on the shared cookie builder below.
 *
 * **It is a CSRF nonce, not a credential.** It authorises nothing: holding it
 * lets you complete a sign-in you already started, and the account still has
 * to survive every claim check. That distinction is the reason for the name.
 * These constants were `OAUTH_STATE_*`, and CodeQL reads the `auth` inside
 * `OAUTH` as marking a credential -- so it flagged the HMAC that signs this
 * nonce as "password hash with insufficient computational effort" and each
 * `Set-Cookie` as "clear text storage of sensitive information", four high
 * alerts, none of them real: HMAC-SHA256 is the right primitive for a MAC and
 * wrong only for storing passwords, which this is not.
 *
 * Renaming both silences a false positive and describes the value more
 * accurately, which is the only reason it is an acceptable response to a
 * scanner. Recorded rather than done quietly, because "rename until the
 * security tool goes quiet" is a bad habit that looks identical to this from
 * the outside -- the test of the difference is whether the new name would be
 * the better one with no scanner in the room. Here it is.
 */
const SIGNIN_STATE_COOKIE = 'kmt_signin_state'
/** Long enough to choose an account and type a password, short enough not to linger. */
const SIGNIN_STATE_TTL_MS = 10 * 60_000
const DEFAULT_TTL_HOURS = 12

/**
 * The password-login idiom for "no person behind this", in the same shape as
 * `backend/quotes.mjs`'s `SHARED_PASSWORD_ACTOR` -- kept as a separate literal
 * here rather than imported, since that constant's long-term home is this
 * file (auth decides who you are, quotes only records who decided) but
 * moving it now would fight #349 over one export. Whoever wires a real
 * identity into `moveTo`'s `actor` seam should do that move and delete this
 * duplicate.
 */
export const PASSWORD_SESSION_ACTOR = 'owner:shared-password'

/**
 * The minted-session idiom (#354... #362's follow-up): a session `create()`d
 * by `scripts/mint-session.mjs` rather than a sign-in, so that `decided_by`
 * (`backend/quotes.mjs`) can record "authenticated, but not a person" instead
 * of either a false identity or silently falling back to the shared-password
 * marker once Google sign-in starts passing real identities through that seam.
 */
export const MINTED_SESSION_ACTOR = 'owner:minted-session'

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
 *
 * Each row also carries who -- or what -- created it: `actor`, a nullable
 * string in the `owner:*` idiom (`PASSWORD_SESSION_ACTOR`,
 * `MINTED_SESSION_ACTOR`, and eventually a verified email once Google
 * sign-in records one -- naming the work rather than an issue number, since
 * #290 itself is the closed spec, not this implementation).
 * A plain `ALTER TABLE`, not a `migrate()` entry: this table has no CHECK to
 * rebuild around, and unlike `quotes.decided_by` a null here is never
 * permanent -- a row with no actor is one created before this column existed,
 * and it is gone on its own within `KMT_SESSION_HOURS` (12 by default). Read
 * through `actorFor`, not `has`: `has` runs on every authenticated request,
 * `actorFor` only when a decision is being attributed, and the read has no
 * business on the hot path it doesn't need.
 */
export function createSessionStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_sessions (
    id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
  )`)
  const columns = db.prepare("SELECT name FROM pragma_table_info('owner_sessions')").all().map(row => row.name)
  if (!columns.includes('actor')) db.exec('ALTER TABLE owner_sessions ADD COLUMN actor TEXT')

  const insert = db.prepare('INSERT INTO owner_sessions (id, expires_at, actor) VALUES (?, ?, ?)')
  const select = db.prepare('SELECT expires_at FROM owner_sessions WHERE id=?')
  const selectActor = db.prepare('SELECT actor FROM owner_sessions WHERE id=?')
  const remove = db.prepare('DELETE FROM owner_sessions WHERE id=?')
  const sweep = db.prepare('DELETE FROM owner_sessions WHERE expires_at <= ?')
  return {
    create(expiresAt, actor = null) {
      sweep.run(Date.now())
      const id = randomBytes(16).toString('hex')
      insert.run(id, expiresAt, actor)
      return id
    },
    has(id) {
      const row = select.get(id)
      return Boolean(row) && row.expires_at > Date.now()
    },
    /** Who created this session, or null if it predates the column, or the id is unknown. */
    actorFor(id) {
      return selectActor.get(id)?.actor ?? null
    },
    delete(id) { remove.run(id) },
  }
}

/** The same contract in memory, for tests and for a server without a database. */
export function memorySessionStore() {
  const live = new Map()
  return {
    create(expiresAt, actor = null) {
      const id = randomBytes(16).toString('hex')
      live.set(id, { expiresAt, actor })
      return id
    },
    has(id) {
      const entry = live.get(id)
      return entry !== undefined && entry.expiresAt > Date.now()
    },
    actorFor(id) {
      return live.get(id)?.actor ?? null
    },
    delete(id) { live.delete(id) },
  }
}

const b64 = (value) => Buffer.from(value).toString('base64url')

/**
 * Constant-time compare that tolerates different lengths without throwing.
 *
 * Exported for `readMonitorConfig`/`isMonitorAuthorized` below: a monitoring
 * token is a leaked-secret risk of its own (it costs a status read, not the
 * workspace), and the same discipline that protects the owner password
 * costs nothing extra to reuse rather than re-implement.
 */
export function equals(a, b) {
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
 * A valid `KMT_OWNER_PASSWORD` or both Google client variables are required.
 * `KMT_SESSION_SECRET` is not: without one a random secret is generated per
 * boot, which is safe but signs every existing session out on restart. Set it
 * in any deployment you do not want logging people out on every deploy.
 */
export function readAuthConfig(env = process.env) {
  const password = env.KMT_OWNER_PASSWORD || ''
  // The guard moves rather than disappears. It used to be "a password or refuse
  // to boot"; it is now "a way in, or refuse to boot" -- which is the same
  // property once Google is a way in, and is what makes unsetting the password
  // survivable. Read the message on the throw below for why that matters more
  // than it sounds.
  const google = readGoogleConfig(env)
  if (!password && !google) {
    throw new Error(
      'KMT_OWNER_PASSWORD is not set and no Google client is configured, so nobody ' +
      'could sign in to the owner workspace. Set KMT_GOOGLE_CLIENT_ID and ' +
      'KMT_GOOGLE_CLIENT_SECRET, or set KMT_OWNER_PASSWORD, and redeploy.',
    )
  }
  if (password && password.length < 12) {
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
 * readAuthConfig refuses when neither Google nor a valid password provides a
 * way in. Minting a session needs neither, so inheriting that boot guard here
 * would be an incidental dependency -- and would break the recovery tool at
 * the one moment it exists to work: after password sign-in is retired.
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

/**
 * The mail-status route's bearer token, read separately from everything
 * above it.
 *
 * Deliberately not `issue`/`verify` below, and not derived from
 * `KMT_SESSION_SECRET`: those tokens are short-lived and signed, made to
 * expire. A monitoring token has to be long-lived -- nobody is going to
 * re-mint it every two hours the way the import bookmarklet is re-pasted --
 * so it is a standalone shared secret instead, `KMT_MONITOR_TOKEN`, compared
 * literally rather than verified as a signature. The reason this matters:
 * if it derived from `KMT_SESSION_SECRET`, revoking a leaked monitor token
 * would mean rotating that secret and signing Ken out of his own workspace.
 * A standalone secret costs nothing to revoke -- unset it, or set a new one --
 * which is the whole argument for a token over an open endpoint in the
 * first place.
 *
 * Unset by default and that is fine: the route this gates answers 404 until
 * a token exists, the same way the server runs fine before KMT_SESSION_SECRET
 * is set. Setting it is a Fly secret, which restarts the machine -- stage it
 * for a deploy that was going to happen anyway (#285: a restart can strand
 * in-flight mail).
 */
export function readMonitorConfig(env = process.env) {
  const token = (env.KMT_MONITOR_TOKEN || '').trim()
  return { token: token || null }
}

/**
 * Whether a request carries the mail-status token, the same bearer shape
 * `isImportAuthorized` uses (`Authorization: Bearer <token>`) but checked
 * against the standalone secret above rather than a signed, purpose-scoped
 * token -- there is no session for this to be scoped against.
 *
 * No token configured means no caller can ever be authorised, which is what
 * makes the route 404 rather than exist half-protected before the secret is
 * set.
 */
export function isMonitorAuthorized(config, request) {
  if (!config.token) return false
  const header = request.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return false
  return equals(header.slice(7).trim(), config.token)
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
  const id = sessions.create(expiresAt, MINTED_SESSION_ACTOR)
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
export function createAuth(config, {
  sessions = memorySessionStore(),
  throttle = null,
  google = readGoogleConfig(),
  // Injectable so the callback route can be tested end to end without a
  // browser, a consent screen or a real Google account. The claim checks are
  // tested directly against the verifier (google-auth.test.mjs); this seam is
  // what lets the route around them be tested too, rather than assumed.
  googleFetch = fetch,
} = {}) {
  const isSecure = (request) =>
    (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(request.socket.encrypted)

  // One builder, two cookies. The flags are a security decision and were
  // duplicated across two near-identical helpers, which is how the session
  // cookie and the sign-in nonce could quietly drift apart on the one
  // attribute that matters.
  const cookie = (request, name, value, maxAgeSeconds) => [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict (t47, #89): Strict withholds the cookie on every
    // top-level navigation from another site, including the link in a mail
    // client, so the owner tapping a notification landed on the sign-in
    // screen every time while holding a valid session. Lax still withholds it
    // on cross-site POST, which is the attack Strict was chosen against; the
    // import endpoint keeps its bearer token for the same reason.
    //
    // The sign-in nonce needs Lax for a second, independent reason: the OAuth
    // callback is a top-level cross-site GET navigation, which is exactly what
    // Strict withholds on -- so Strict would fail every sign-in while looking
    // like a fault at Google's end.
    'SameSite=Lax',
    isSecure(request) ? 'Secure' : '',
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join('; ')

  const setCookie = (request, value, maxAgeSeconds) => cookie(request, COOKIE, value, maxAgeSeconds)

  const stateCookie = (request, value, maxAgeSeconds) => cookie(request, SIGNIN_STATE_COOKIE, value, maxAgeSeconds)

  const signedIn = (request) => verifySession(config, sessions, readCookie(request.headers.cookie, COOKIE))

  const sessionActor = (request) => {
    const opened = open(config, readCookie(request.headers.cookie, COOKIE))
    if (opened?.purpose !== 'session' || !opened.id || !sessions.has(opened.id)) return null
    return sessions.actorFor(opened.id)
  }

  return {
    isAuthenticated: signedIn,
    actorFor: sessionActor,

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
        // `google` says whether this server has an OAuth client, so the
        // sign-in screen can offer the button only where pressing it would
        // work. Additive: `authenticated` keeps its meaning and its shape.
        return json(200, { authenticated: signedIn(request), google: Boolean(google), password: Boolean(config.password) })
      }

      if (url.pathname === '/api/owner/login' && request.method === 'POST') {
        // Refused before the throttle, before the body, and above all before
        // any comparison: with no password configured, `equals('', '')` is
        // TRUE -- a constant-time compare of two empty buffers succeeds -- so
        // falling through here would sign in anyone who posts an empty
        // password. That is the whole hazard of making the password optional.
        //
        // Derived from `config.password` itself rather than from a separate
        // `passwordEnabled` flag, which is how this was first written. A flag
        // is a parallel contract: every caller that builds a config by hand
        // rather than through `readAuthConfig` -- and this repository has
        // several, including test helpers that mirror the server -- would have
        // silently lost password sign-in by omitting it. The full suite caught
        // exactly that. One source of truth cannot drift from itself.
        //
        // 404 rather than 401, for the same reason the Google routes answer
        // 404 when unconfigured: the way in does not exist on this server,
        // which is a different statement from "those credentials were wrong".
        if (!config.password) {
          return json(404, { error: 'Password sign-in is not available on this server.' })
        }
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
        const id = sessions.create(expiresAt, PASSWORD_SESSION_ACTOR)
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

      // --- Google sign-in ------------------------------------------------
      //
      // These live here, in auth.handle, and not in api.mjs -- and that is a
      // requirement rather than a preference. server.mjs calls auth.handle
      // (:189) BEFORE the /api/ session gate (:191), which answers 401 to
      // anything under /api/owner/ without a session. A callback implemented
      // in api.mjs would be refused before it could create the session it
      // exists to create: a failure at the very last step, after the owner has
      // already been sent to Google and back, looking exactly like Google's
      // fault.
      //
      // Both are GET, because both are browser navigations rather than calls.

      // Start: remember a nonce in a signed short-lived cookie, send the owner
      // to Google carrying the same nonce as `state`, and require the two to
      // match on the way back. That binds the callback to the browser that
      // began the sign-in, which is what makes a replayed or forged callback
      // useless.
      if (url.pathname === '/api/owner/session/google/start' && request.method === 'GET') {
        if (!google) return json(404, { error: 'Google sign-in is not configured on this server.' })
        const nonce = randomBytes(16).toString('hex')
        response.writeHead(302, {
          Location: googleAuthUrl(google, nonce),
          'Cache-Control': 'no-store',
          'Set-Cookie': stateCookie(request, issue(config, 'signin-state', SIGNIN_STATE_TTL_MS, nonce), Math.floor(SIGNIN_STATE_TTL_MS / 1000)),
        })
        response.end()
        return true
      }

      if (url.pathname === '/api/owner/session/google/callback' && request.method === 'GET') {
        if (!google) return json(404, { error: 'Google sign-in is not configured on this server.' })

        // One exit for every refusal. Whoever was turned away is told nothing
        // beyond "that did not work": a wrong domain, an unverified address, a
        // token minted for another application and a replayed callback are the
        // same answer to the person holding them. The reason is logged, so a
        // refusal can still be diagnosed -- the audits and the owner's own
        // support call both need that, and neither needs it in the browser.
        const refuseSignIn = (reason) => {
          console.error(`owner google sign-in refused: ${reason}`)
          response.writeHead(302, {
            Location: '/owner?signin=refused',
            'Cache-Control': 'no-store',
            'Set-Cookie': stateCookie(request, '', 0),
          })
          response.end()
          return true
        }

        const opened = open(config, readCookie(request.headers.cookie, SIGNIN_STATE_COOKIE))
        const state = url.searchParams.get('state')
        // Required equality on present values, the same rule as every claim
        // check: an absent cookie, an absent `state`, or a token of the wrong
        // purpose is a refusal, never a skip.
        if (opened?.purpose !== 'signin-state' || !opened.id || !state || !equals(opened.id, state)) {
          return refuseSignIn('state did not match the cookie issued at the start of the flow')
        }
        // Google reports its own refusals here rather than by failing to
        // arrive -- the user closing the account chooser, most often.
        if (url.searchParams.get('error')) return refuseSignIn(`Google returned error=${url.searchParams.get('error')}`)
        const code = url.searchParams.get('code')
        if (!code) return refuseSignIn('no authorization code in the callback')

        let claims
        try {
          claims = await fetchGoogleClaims(await exchangeCodeForIdToken(google, code, googleFetch), googleFetch)
        } catch (error) {
          // A network failure or a refused exchange. Not the owner's fault and
          // not something they can act on, so it reads the same as any other
          // refusal to them and carries detail only in the log.
          return refuseSignIn(`could not verify the token with Google: ${error.message}`)
        }

        const decision = verifyGoogleClaims(claims, google)
        if (!decision.ok) return refuseSignIn(decision.reason)

        // Verified. From here the session mechanism that already exists takes
        // over unchanged: the same signed cookie, the same expiry, the same
        // row that logout deletes and the sweep collects.
        //
        // The verified address becomes the session's actor -- owner_sessions.actor,
        // landed in #374. This is the one place a real identity enters the system,
        // and the actor argument belongs here and NOWHERE else. The chain it feeds:
        // session.actor -> `actorFor` on the auth layer -> the decide handler
        // threading it into moveTo's `actor` -> quotes.decided_by.
        //
        // That chain is wired and covered end to end. If any link ever yields
        // null, the quote-action handler answers 401 rather than recording a
        // blank attribution -- quotes.test.mjs's "refuses a valid session whose
        // stored actor is null" pins that, asserting the quote never leaves
        // `draft`. An unattributed decision does not happen; it is not merely
        // unlabelled.
        const expiresAt = Date.now() + config.ttlMs
        const id = sessions.create(expiresAt, decision.email)
        response.writeHead(302, {
          Location: '/owner',
          'Cache-Control': 'no-store',
          'Set-Cookie': [
            setCookie(request, issue(config, 'session', config.ttlMs, id), Math.floor(config.ttlMs / 1000)),
            stateCookie(request, '', 0),
          ],
        })
        response.end()
        return true
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
