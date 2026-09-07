/**
 * Owner sign-in with Google, restricted to the Workspace domain.
 *
 * The design is `.forge/owner-google-signin.md`; the sequence and its hazards
 * are `.forge/owner-auth-cutover.md`. What matters here:
 *
 * **The fetch and the judgement are separate functions, deliberately.**
 * `fetchGoogleClaims` talks to Google; `verifyGoogleClaims` decides. They are
 * split because a test that drives a real sign-in cannot tell you whether this
 * code refused someone or whether Google's Internal consent screen refused
 * them first -- two independent controls producing one indistinguishable
 * outcome. Splitting them gives the tests a seam to feed constructed claims
 * into, which is the only way this layer's own behaviour can be observed. If
 * the two are ever inlined together, that coverage disappears silently.
 *
 * **Why no JWT library.** Verifying an ID token properly means fetching
 * Google's JWKS and doing an RS256 verify. Google's token-info endpoint does
 * exactly that and returns the claims, in one HTTPS call at login only -- a
 * handful of times a day, not per request. `AGENTS.md` asks for a
 * justification that beats keeping the surface small, and a JWT library plus
 * JWKS caching does not beat it at this volume. If that trade ever changes,
 * local verification replaces one function and nothing above it moves.
 *
 * **This module decides who you are. It does not decide that you stay signed
 * in.** Everything after a successful verification is the session mechanism
 * that already exists in auth.mjs -- the signed cookie, the expiry,
 * SameSite=Lax, logout invalidating the row.
 */

/**
 * The one domain whose accounts may sign in.
 *
 * Deliberately a constant and not configuration. Under domain-only there is
 * nothing behind this check -- no allow-list, no exact-address match -- so the
 * single comparison against this value IS the entire authorization decision.
 * An environment variable would add a way to get that wrong (unset, typo'd,
 * shadowed in one deploy) in exchange for a flexibility a one-owner business
 * does not need. The allow-list day, when it comes, adds KMT_OWNER_EMAILS
 * behind this line rather than replacing it.
 */
export const OWNER_DOMAIN = 'kensmobiletire.com'

/**
 * Both spellings Google uses for its own issuer, and no others.
 *
 * ID token payloads carry `https://accounts.google.com`; some Google surfaces
 * return the bare host. Listing both is not leniency -- an exact membership
 * test still refuses `https://accounts.google.com.evil.example`, which a
 * `startsWith` or a substring match would accept.
 */
export const GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com'])

/**
 * Where Google sends the owner back, exact and not configurable.
 *
 * Google matches this against the console registration character for
 * character, so drift is not a runtime failure anyone can fix from here -- it
 * is a console edit. Hard-coding it means the value in the code and the value
 * in the console can only disagree by someone editing this line.
 *
 * https, the canonical host, no trailing slash, no `www`: kmt.fly.dev answers
 * 301 to kensmobiletire.com (measured), and a URI registered against any other
 * name puts a redirect inside the callback -- which fails at the last step of
 * the flow, after the owner has already been to Google and back, looking
 * exactly like Google's fault.
 */
export const GOOGLE_REDIRECT_URI = `https://${OWNER_DOMAIN}/api/owner/session/google/callback`

const TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/**
 * Read the OAuth client from the environment, or say it is not configured.
 *
 * Three cases, and the middle one is the point:
 *
 * - **Neither variable set: `null`.** Google sign-in is off and the password
 *   path carries the owner. This is change one's normal state before the
 *   client exists, and the server must boot in it.
 * - **One set, not the other: throw.** That is a misconfiguration, not a
 *   decision. Failing at boot names the missing variable; failing at login
 *   looks like Google is down to the one person who cannot fix it.
 * - **Both set: the config.**
 *
 * This inverts in change two. Once the password is gone, no OAuth config means
 * nobody can sign in at all, which has to become a refuse-to-boot rather than
 * a silent degrade -- and that inversion belongs to change two rather than
 * being something to notice afterwards.
 */
export function readGoogleConfig(env = process.env) {
  const clientId = (env.KMT_GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (env.KMT_GOOGLE_CLIENT_SECRET || '').trim()

  if (!clientId && !clientSecret) return null
  if (!clientId) {
    throw new Error(
      'KMT_GOOGLE_CLIENT_SECRET is set but KMT_GOOGLE_CLIENT_ID is not. Set both to enable ' +
      'Google sign-in, or neither to leave it off; half of an OAuth client cannot sign anyone in.',
    )
  }
  if (!clientSecret) {
    throw new Error(
      'KMT_GOOGLE_CLIENT_ID is set but KMT_GOOGLE_CLIENT_SECRET is not. Set both to enable ' +
      'Google sign-in, or neither to leave it off; half of an OAuth client cannot sign anyone in.',
    )
  }
  return { clientId, clientSecret, redirectUri: GOOGLE_REDIRECT_URI }
}

/**
 * Decide whether a set of claims is the owner. Pure: no network, no clock.
 *
 * **Every check is a required equality on a present value. A missing claim is
 * a rejection, not a skip.** The wrong form is the one a careful person
 * reaches for when being defensive about `undefined`:
 *
 *     if (claims.hd && claims.hd !== OWNER_DOMAIN) reject()   // WRONG
 *
 * A consumer Google account carries no `hd` at all, so that guard never runs
 * and admits every Google account on earth -- while looking more careful than
 * the correct form. `aud` is the one that would hurt most if missed, because a
 * token forged or minted for another application is precisely the token most
 * likely to be missing claims.
 *
 * Returns `{ ok: true, email }` or `{ ok: false, reason }`. The reason names
 * the claim, so a refusal can be diagnosed from a log line rather than
 * guessed at; it is never shown to whoever was refused.
 */
export function verifyGoogleClaims(claims, config) {
  const c = claims ?? {}

  if (!config?.clientId) return { ok: false, reason: 'Google sign-in is not configured on this server.' }

  // Order matters. `hd` is a claim inside a token and means nothing until the
  // token is known to be Google's and to have been minted for us: a token from
  // another application can carry any `hd` it likes.
  if (!GOOGLE_ISSUERS.includes(c.iss)) {
    return { ok: false, reason: `iss ${JSON.stringify(c.iss ?? null)} is not Google.` }
  }
  if (c.aud !== config.clientId) {
    return { ok: false, reason: `aud ${JSON.stringify(c.aud ?? null)} is not this application's client id.` }
  }
  // Listed rather than truthiness-tested. The token-info endpoint is a debug
  // endpoint and returns its values as strings, while an ID token payload
  // carries a real boolean -- both are Google saying the same thing. A
  // truthiness test would also accept the string 'false', which is truthy and
  // means the opposite.
  if (c.email_verified !== true && c.email_verified !== 'true') {
    return { ok: false, reason: `email_verified ${JSON.stringify(c.email_verified ?? null)} is not true.` }
  }
  // Under domain-only this line is the entire authorization decision.
  if (c.hd !== OWNER_DOMAIN) {
    return { ok: false, reason: `hd ${JSON.stringify(c.hd ?? null)} is not ${OWNER_DOMAIN}.` }
  }
  // Checked last and separately: the address is what gets written into the
  // audit trail, so an accepted sign-in with no email would attribute a
  // decision to nobody while looking like a success.
  if (typeof c.email !== 'string' || !c.email.includes('@')) {
    return { ok: false, reason: `email ${JSON.stringify(c.email ?? null)} is missing or not an address.` }
  }

  return { ok: true, email: c.email }
}

/**
 * The string a verified person is recorded as in the audit trail.
 *
 * `owner:` is the reserved namespace for "authenticated, but we cannot say
 * who" -- `owner:shared-password` and `owner:minted-session`. A real identity
 * must never be written into that shape, because `quotes.decided_by` must
 * never claim a person decided something a shared password or a break-glass
 * session did.
 *
 * The two vocabularies cannot collide, and not by luck: a colon is not valid
 * in an unquoted email local-part, and every address reaching this function
 * has already been required to carry an `@` and this domain. The function
 * exists anyway, so the boundary has one name and one place to change if the
 * marker format ever moves.
 */
export function actorFromEmail(email) {
  return email
}

/** Where to send the owner to sign in. `state` is CSRF, and is checked on return. */
export function googleAuthUrl(config, state) {
  const url = new URL(AUTH_URL)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  // A hint that pre-fills the account chooser, and nothing more. The
  // restriction is the `hd` check in verifyGoogleClaims; this parameter is a
  // convenience the client could omit or change at will.
  url.searchParams.set('hd', OWNER_DOMAIN)
  // Ask for a fresh choice rather than silently reusing whichever account the
  // browser last used, so signing in as the wrong person is a visible act.
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

/**
 * Exchange the callback's code for an ID token. Network; no judgement.
 *
 * Throws on anything that is not a token, so the caller has one failure path
 * rather than a shape to inspect.
 */
export async function exchangeCodeForIdToken(config, code, fetchImpl = fetch) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) throw new Error(`Google refused the code exchange (${response.status}).`)
  const body = await response.json()
  if (!body?.id_token) throw new Error('Google returned no id_token.')
  return body.id_token
}

/**
 * Ask Google to verify an ID token and return its claims. Network; no judgement.
 *
 * A 200 from this endpoint means Google checked the signature and the expiry.
 * It does not mean the token is for us or for anyone allowed -- that is
 * verifyGoogleClaims' job, on the claims this returns.
 */
export async function fetchGoogleClaims(idToken, fetchImpl = fetch) {
  const url = new URL(TOKEN_INFO_URL)
  url.searchParams.set('id_token', idToken)
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Google rejected the id_token (${response.status}).`)
  return response.json()
}
