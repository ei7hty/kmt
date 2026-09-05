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

  return {
    password,
    secret: env.KMT_SESSION_SECRET || randomBytes(32).toString('hex'),
    ttlMs: Number(env.KMT_SESSION_HOURS || DEFAULT_TTL_HOURS) * 3600_000,
    generatedSecret: !env.KMT_SESSION_SECRET,
  }
}

const sign = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url')

function issue(config) {
  const expires = Date.now() + config.ttlMs
  const payload = b64(String(expires))
  return `${payload}.${sign(config.secret, payload)}`
}

function verify(config, token) {
  if (typeof token !== 'string') return false
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false
  if (!equals(signature, sign(config.secret, payload))) return false

  const expires = Number(Buffer.from(payload, 'base64url').toString())
  return Number.isFinite(expires) && expires > Date.now()
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
        const input = await body(request)
        if (!equals(input?.password ?? '', config.password)) {
          // No detail about why. A wrong password and an absent one are the
          // same answer to whoever is guessing.
          return json(401, { error: 'Incorrect password.' })
        }
        return json(200, { authenticated: true }, {
          'Set-Cookie': setCookie(request, issue(config), Math.floor(config.ttlMs / 1000)),
        })
      }

      if (url.pathname === '/api/owner/logout' && request.method === 'POST') {
        return json(200, { authenticated: false }, { 'Set-Cookie': setCookie(request, '', 0) })
      }

      return false
    },
  }
}
