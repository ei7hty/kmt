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

const COOKIE = 'kmt_owner'
const DEFAULT_TTL_HOURS = 12

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

const sign = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url')

/**
 * Tokens carry what they are for, so one kind cannot be used as another.
 *
 * The import token travels in a URL inside a bookmarklet and is handed to a
 * page on giga-tires.com; the session cookie unlocks the whole workspace. If
 * both were just "a signed timestamp", the first would be the second.
 */
function issue(config, purpose = 'session', ttlMs = config.ttlMs) {
  const payload = b64(`${purpose}:${Date.now() + ttlMs}`)
  return `${payload}.${sign(config.secret, payload)}`
}

function verify(config, token, purpose = 'session') {
  if (typeof token !== 'string') return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false
  if (!equals(signature, sign(config.secret, payload))) return false

  const [tokenPurpose, expires] = Buffer.from(payload, 'base64url').toString().split(':')
  if (tokenPurpose !== purpose) return false
  return Number.isFinite(Number(expires)) && Number(expires) > Date.now()
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

const readCookie = (header, name) =>
  (header || '').split(';')
    .map(part => part.trim().split('='))
    .find(([key]) => key === name)?.[1]

/**
 * The auth layer, as a handler that returns true when it has answered.
 *
 * `secure` follows the request rather than being hardcoded, so the cookie gets
 * the Secure flag behind TLS and still works over plain http on a local run.
 */
export function createAuth(config) {
  const isSecure = (request) =>
    (request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(request.socket.encrypted)

  const setCookie = (request, value, maxAgeSeconds) => [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    isSecure(request) ? 'Secure' : '',
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join('; ')

  return {
    isAuthenticated: (request) => verify(config, readCookie(request.headers.cookie, COOKIE)),

    /**
     * Bearer authorisation for posting supplier pages back.
     *
     * A cookie cannot do this job: the session cookie is SameSite=Strict, so a
     * request from a giga-tires page never carries it -- which is the point of
     * Strict and worth keeping. A scoped bearer token travels instead, and can
     * do nothing but import.
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
        return json(200, { authenticated: verify(config, readCookie(request.headers.cookie, COOKIE)) })
      }

      if (url.pathname === '/api/owner/login' && request.method === 'POST') {
        // The body reader refuses a wrong content type, an oversized body and
        // malformed JSON with a status of its own. Uncaught, each of those was
        // a 500 with a stack trace in the response (#69). Input errors carry a
        // status and are answered as written; anything without one is a real
        // fault, logged here and answered without detail.
        let input
        try {
          input = await body(request)
        } catch (error) {
          if (!error.status) console.error(error)
          return json(error.status || 500, {
            error: error.status ? error.message : 'Could not complete the request. Nothing was changed.',
          })
        }
        if (!equals(input?.password ?? '', config.password)) {
          // No detail about why. A wrong password and an absent one are the
          // same answer to whoever is guessing.
          return json(401, { error: 'Incorrect password.' })
        }
        return json(200, { authenticated: true }, {
          'Set-Cookie': setCookie(request, issue(config), Math.floor(config.ttlMs / 1000)),
        })
      }

      // Issued to a signed-in owner only. Everything the bookmarklet needs to
      // authenticate is in here, so this route is behind the session like any
      // other read of workspace state.
      if (url.pathname === '/api/owner/import-token' && request.method === 'POST') {
        if (!verify(config, readCookie(request.headers.cookie, COOKIE))) {
          return json(401, { error: 'Sign in to use the owner workspace.' })
        }
        return json(200, { token: createImportToken(config), expiresInMs: IMPORT_TTL_MS })
      }

      if (url.pathname === '/api/owner/logout' && request.method === 'POST') {
        return json(200, { authenticated: false }, { 'Set-Cookie': setCookie(request, '', 0) })
      }

      return false
    },
  }
}
