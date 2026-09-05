#!/usr/bin/env node
/**
 * Push a scraped snapshot into a running owner server.
 *
 * scripts/scrape-tires.mjs runs on whatever machine has a screen and a home
 * connection, and writes a JSON snapshot. That file seeds a brand-new database
 * once and is otherwise never read again -- so a scrape run locally had no way
 * to reach the server that is actually up, local or hosted. This is that way:
 * read the snapshot, sign in if the server wants a password, and post it to
 * `POST /api/owner/import-snapshot`, which writes it through the same door a
 * refresh uses. Owner prices and choices are never touched.
 *
 *   node scripts/import-tires.mjs                              # local server
 *   node scripts/import-tires.mjs --to https://kmt.fly.dev     # needs KMT_OWNER_PASSWORD
 *   node scripts/import-tires.mjs out.json --sizes 215/60R16 --dry-run
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalSize, parseSize } from './giga-tires.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SNAPSHOT = path.join(ROOT, 'src', 'data', 'scraped-tires.json')
const DEFAULT_SERVER = 'http://127.0.0.1:4180'

const HELP = `
Push a scraped snapshot into a running owner server.

Usage:
  node scripts/import-tires.mjs [snapshot.json] [options]

The snapshot defaults to src/data/scraped-tires.json, the file the scraper
writes. Pass another path to import a scrape you kept elsewhere.

Options:
  --to URL         Server to import into (default ${DEFAULT_SERVER}, which is
                   \`node backend/dev.mjs\`). Use https://kmt.fly.dev for the
                   hosted one.
  --sizes A,B,...  Import only these sizes from the snapshot. Written
                   215/60R16 or 215-60-16.
  --complete       Treat each size as the supplier's whole listing: tires the
                   snapshot does not mention are marked no longer listed (they
                   are kept, with the owner's offer). Only for scrapes run with
                   --limit 0 and enough --pages to read every page. Without it
                   a size is treated as a partial view and nothing is retired.
  --dry-run        Ask the server what would change, write nothing.
  --help           This message.

Environment:
  KMT_OWNER_PASSWORD   The hosted server's owner password. The local server
                       has no sign-in and does not need it.
`.trimStart()

function parseArgs(argv) {
  const options = { snapshot: DEFAULT_SNAPSHOT, to: DEFAULT_SERVER, sizes: [], complete: false, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      return argv[++i]
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--complete') options.complete = true
    else if (arg === '--to') options.to = value()
    else if (arg === '--sizes') options.sizes.push(...value().split(',').map(s => s.trim()).filter(Boolean))
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else options.snapshot = path.resolve(process.cwd(), arg)
  }
  return options
}

/** fetch's own "fetch failed" says nothing about where or why; the cause does. */
async function post(base, route, body, headers = {}) {
  try {
    return await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
  } catch (error) {
    const why = error.cause?.code || error.cause?.message || error.message
    throw new Error(`Could not reach ${base} (${why}). Is the server running? \`node backend/dev.mjs\` starts the local one.`)
  }
}

/**
 * Sign in the way the owner screen does and keep the session cookie.
 *
 * The local server has no login route at all -- it answers 404 -- and that is
 * not an error here: it means there is nothing to sign in to.
 */
async function signIn(base, password) {
  const response = await post(base, '/api/owner/login', { password })
  if (response.status === 404) return null
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(`Sign-in refused by ${base}: ${data.error || response.status}`)
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const session = cookies.map(cookie => cookie.split(';')[0]).find(pair => pair.startsWith('kmt_owner='))
  if (!session) throw new Error(`${base} accepted the password but set no session cookie`)
  return session
}

async function postSnapshot(base, snapshot, { complete, dryRun, cookie }) {
  const response = await post(base, '/api/owner/import-snapshot', { snapshot, complete, dryRun }, cookie ? { Cookie: cookie } : {})
  const data = await response.json().catch(() => ({}))
  if (response.status === 401) {
    throw new Error(`${base} wants the owner password. Set KMT_OWNER_PASSWORD and run again.`)
  }
  if (!response.ok) throw new Error(`${base} refused the snapshot: ${data.error || response.status}`)
  return data
}

function printReport(result, base) {
  console.log(`${result.dryRun ? 'Would import' : 'Imported'} ${result.tires} tire${result.tires === 1 ? '' : 's'}` +
    ` across ${result.sizes.length} size${result.sizes.length === 1 ? '' : 's'} into ${base}` +
    ` (scraped ${result.scrapedAt}${result.complete ? ', as complete listings' : ''})`)
  for (const size of result.sizes) {
    const parts = [`${size.added} new`, `${size.changed} changed`, `${size.unchanged} unchanged`]
    if (result.complete) parts.push(`${size.retired} no longer listed`)
    console.log(`  ${size.size.padEnd(12)} ${String(size.tires).padStart(3)} tires: ${parts.join(', ')}`)
  }
  if (result.dryRun) console.log('\n--dry-run: nothing written.')
  else console.log('\nOwner prices and choices are unchanged. /owner shows the result.')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  const invalid = options.sizes.filter(size => !parseSize(size))
  if (invalid.length) throw new Error(`Not tire sizes: ${invalid.join(', ')}`)
  const only = new Set(options.sizes.map(canonicalSize))

  let file
  try {
    file = JSON.parse(await readFile(options.snapshot, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${path.relative(process.cwd(), options.snapshot)}: ${error.message}`)
  }
  const tires = only.size ? (file.tires || []).filter(tire => only.has(tire.size)) : file.tires
  if (!Array.isArray(tires) || !tires.length) {
    throw new Error(only.size
      ? `${path.relative(process.cwd(), options.snapshot)} has no tires in ${[...only].join(', ')}`
      : `${path.relative(process.cwd(), options.snapshot)} holds no tires`)
  }
  const snapshot = { ...file, sizes: [...new Set(tires.map(tire => tire.size))].sort(), tires }
  const base = options.to.replace(/\/+$/, '')

  const password = process.env.KMT_OWNER_PASSWORD || ''
  const cookie = password ? await signIn(base, password) : null

  const result = await postSnapshot(base, snapshot, { complete: options.complete, dryRun: options.dryRun, cookie })
  printReport(result, base)
}

main().catch(error => {
  console.error(error.message || error)
  process.exitCode = 1
})
