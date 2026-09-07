#!/usr/bin/env node
/**
 * Sign in as the owner without a password, on purpose, on a database.
 *
 * Google-only owner sign-in cannot be driven by Playwright: it needs a real
 * account, interactive consent, and Google actively refuses automation. Five
 * audit scripts (a11y-85-measure.mjs, dead-end-audit.mjs,
 * owner-inventory-audit.mjs, request-flow-check.mjs, responsive-check.mjs)
 * import signInIfAsked to reach the owner screen, and the pre-merge gate
 * cannot prove "a customer submits, the owner approves, the customer pays"
 * without a way past that screen. This is that way.
 *
 *   node scripts/mint-session.mjs
 *   node scripts/mint-session.mjs --hours 1
 *   KMT_OWNER_SESSION_COOKIE="$(node scripts/mint-session.mjs --quiet)" node .forge/dead-end-audit.mjs
 *
 * ## Three deliberate choices, the same three scripts/redact.mjs makes
 *
 * **It is a command, not an endpoint.** There is no route for this and there
 * must not be: authorisation is a human with machine access, not a request
 * the public internet can send. On production it is reached with
 * `flyctl ssh console -a kmt -C "node /app/scripts/mint-session.mjs"`.
 *
 * **It grants nothing new.** Anyone who can run this can already open the
 * database directly, insert an `owner_sessions` row and sign a matching
 * cookie by hand -- `backend/auth.mjs`'s `mintSession` only does that
 * arithmetic and signing correctly. A mechanism that adds no capability to
 * anyone who does not already have it is not a bypass of the password gate;
 * it is the password gate's own session table, reached from the side the
 * password used to be the only door to.
 *
 * **It needs no `sqlite3`.** Same reason as `redact.mjs`: Node's own
 * `node:sqlite` is what the server runs on, so this works wherever the
 * server's image does, whether or not that image happens to carry the
 * separate binary.
 *
 * ## Recovery path, not just a gate fixture
 *
 * If Google sign-in ever breaks -- an expired OAuth client, a locked-out
 * account, a Saturday -- this is also how the owner gets back into the
 * workspace: someone with `flyctl ssh` mints a session and hands the cookie
 * over. Whether that gets written into the runbook is a product call, not
 * this script's; it functions as the recovery path whether or not anyone
 * documents it, which is why this paragraph says so.
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSessionStore, mintSession, readSessionSigningConfig } from '../backend/auth.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = process.env.KMT_OWNER_DB || path.join(ROOT, 'backend', 'data', 'owner.sqlite')

const HELP = `
Mint an owner session cookie directly, without signing in.

Usage:
  node scripts/mint-session.mjs [--hours N] [--db PATH] [--quiet]

Prints "name=value" for the session cookie on stdout, and its expiry to
stderr. Reads KMT_SESSION_SECRET (required -- it must match the secret the
running server was started with, or the cookie signs with a value nobody
can verify) and KMT_SESSION_HOURS from the environment. Deliberately does
not read KMT_OWNER_PASSWORD: minting never checks a password, and this
needs to keep working once the server no longer has one to check.

Options:
  --hours N   Session lifetime in hours (default: KMT_SESSION_HOURS, or 12).
  --db PATH   Database file (default ${DEFAULT_DB}, or $KMT_OWNER_DB).
  --quiet     Print only the cookie's "name=value" -- nothing else on
              stdout, for capturing directly into an environment variable
              or a Playwright header. The expiry still goes to stderr.
  --help      This message.
`.trimStart()

function parseArgs(argv) {
  const options = { hours: null, db: DEFAULT_DB, quiet: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--quiet' || arg === '-q') options.quiet = true
    else if (arg === '--hours') options.hours = Number(argv[++i])
    else if (arg === '--db') options.db = argv[++i]
    else throw new Error(`Unknown argument ${arg}. Run with --help.`)
  }
  if (options.hours !== null && (!Number.isFinite(options.hours) || options.hours <= 0)) {
    throw new Error('--hours must be a positive number.')
  }
  return options
}

function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  if (options.help) { console.log(HELP); return }

  let config
  try { config = readSessionSigningConfig(process.env) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  const ttlMs = options.hours !== null ? options.hours * 3600_000 : config.ttlMs

  const db = new DatabaseSync(options.db)
  try {
    const sessions = createSessionStore(db)
    const { name, value, expiresAt } = mintSession(config, sessions, ttlMs)
    console.log(`${name}=${value}`)
    if (!options.quiet) {
      console.error(`Database: ${options.db}`)
      console.error(`Expires: ${new Date(expiresAt).toISOString()} (in ${(ttlMs / 3600_000).toFixed(2)}h)`)
      console.error('This is a real, working session -- treat the line above like a password.')
    }
  } finally {
    db.close()
  }
}

main()
