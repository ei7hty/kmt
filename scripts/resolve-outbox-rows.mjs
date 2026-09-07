#!/usr/bin/env node
/**
 * Settle the eight specific outbox rows stranded by the 2026-09-06
 * 15:41-19:30 SMTP outage -- a one-time historical correction, not the
 * ongoing mechanism.
 *
 * The ongoing mechanism is `POST /api/owner/outbox/:id/resolve`: Ken sees a
 * failure or an abandoned row on the owner screen, judges it accounted for,
 * types why. This script exists only for the eight rows that predate that
 * route and that route's audience -- nobody was looking at an owner screen
 * for a row that was never a live problem on it. It is not a general
 * "resolve everything old" tool, and it does not take ids as arguments.
 *
 * ## Why the ids are frozen in the file, not passed on the command line
 *
 * The first draft of this correction identified its target with a SQL
 * `BETWEEN` bound built from the outage's rounded, human-stated window
 * ("15:41-19:30"). That bound was wrong -- inconsistent across two
 * requests for the same data, and the tighter of the two silently excluded
 * a real row that landed 46 seconds past it. The failure was not the
 * arithmetic; it was treating a précised sentence from an incident report
 * as if it were a measurement, in a place (a query bound) whose syntax
 * looks exactly as precise whether or not the number behind it is. A time
 * window is a proxy for "one of the eight rows this investigation actually
 * closed on," and a proxy that already drifted once has no business being
 * the mechanism -- especially since a query re-run at execution time
 * selects whatever is `queued` *then*, which could include a row that
 * arrived after the investigation closed and was never covered by it.
 *
 * So: eight ids, named once, verified against a live read before every
 * write, never re-derived from a range at run time.
 *
 *   node scripts/resolve-outbox-rows.mjs --note "..."          # dry run
 *   node scripts/resolve-outbox-rows.mjs --note "..." --write  # do it
 *
 * ## The cross-check
 *
 * A frozen list still goes stale in one way a bare id can't protect
 * against: something about one of the eight rows changing between when
 * the list was gathered and when this actually runs (resent, redacted,
 * anything). So every row is re-read and compared against what was true
 * when the id was gathered -- `request_id` and `status` -- before any
 * write happens, for any row. A mismatch on any single row aborts the
 * whole run rather than resolving the seven that still check out: this is
 * a one-time correction for a specific, understood incident, not a queue
 * to clear partially. The mismatch is reported by name -- which row,
 * which field, what was expected, what was actually found -- because
 * whoever runs this may be doing so weeks from now with no memory of why,
 * and a bare "mismatch, aborting" sends them to read the database before
 * they know what they're looking for.
 *
 * Same three choices as scripts/redact.mjs, for the same reasons:
 *
 * **It is a command, not an endpoint.** The write route exists for Ken's
 * ongoing judgment calls on live failures; a one-time correction of rows
 * nobody was ever looking at on the owner screen is a human with machine
 * access, not a request the public route needs to serve. On production it
 * is reached with `flyctl ssh console -a kmt -C "node /app/scripts/resolve-outbox-rows.mjs ..."`.
 *
 * **Nothing is written without `--write`.** The default pass opens the
 * database read-only and prints exactly what each row currently holds,
 * whether it's already resolved, and whether it still matches what was
 * recorded when the id was gathered. `resolve()` is idempotent, so a dry
 * run against an already-resolved row shows that plainly rather than
 * silently.
 *
 * **It needs no `sqlite3`.** Same `node:sqlite` the server runs on.
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Inventory } from '../backend/inventory.mjs'
import { Outbox } from '../backend/outbox.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = process.env.KMT_OWNER_DB || path.join(ROOT, 'backend', 'data', 'owner.sqlite')

/**
 * The eight rows, named once, from the read-only queries behind this
 * correction (see .forge/NOTES.md's "outbox-stranded-rows" entries for the
 * full history). `expectedRequestId` and `expectedStatus` are what was true
 * when each id was gathered -- not assumptions, the actual read values --
 * so a live mismatch means something about the row changed since, not that
 * the read itself was ever in question.
 *
 * All eight gathered and cross-checked: read twice, by two different
 * queries (a `BETWEEN` bound the first time, the earliest-ten-by-
 * `created_at` the second, after the first proved unreliable -- see
 * .forge/NOTES.md's "outbox-stranded-rows" entries for the full history),
 * with the three rows common to both reads matching id-for-id. The set is
 * provably complete, not just filtered: the ninth-and-tenth-earliest rows
 * by `created_at` are already `status='sent'`, so the run of `queued` rows
 * this outage produced terminates at exactly these eight -- this is "the
 * ninth row is not queued," not "eight rows matched a filter." Six
 * distinct `request_id`s behind the eight rows, matching the "eight rows,
 * six requests" figure the original customer-impact read found.
 *
 * `TODO_PENDING` stays defined and unused on purpose: FROZEN_ROWS.length
 * must be 8 AND every entry must be a real value, not a placeholder that
 * merely looks real, or this script refuses to do anything at all, dry run
 * included -- so a future edit that drops or blanks a row fails loudly
 * instead of quietly running an incomplete correction that looks right.
 */
const TODO_PENDING = Symbol('id not yet gathered -- see NOTES.md')

const FROZEN_ROWS = [
  { id: '1142892df7cf5c98eef6f6dab4cf0442', expectedRequestId: '2ac26ac0630c9d1f2aacff8525cbe9f0', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T15:41:54.947Z' },
  { id: '9554c63058cd5c992877f17add3cf6e0', expectedRequestId: '4a2be8cb3feb5f0e3b722c0c6822fdd3', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T15:47:24.721Z' },
  { id: '181fc37825eac34c6d2144210b931bd7', expectedRequestId: 'fb0da6739162bd7046ba2444604a84da', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T16:32:05.992Z' },
  { id: '87e9d5fdc2a163b7355f00ea70a2a67f', expectedRequestId: 'c585239b1615a951ceaf18bfc665786d', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T16:33:50.876Z' },
  { id: '6a73687b7c83d1aed88eb23fde26c723', expectedRequestId: 'fb0da6739162bd7046ba2444604a84da', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T16:34:16.493Z' },
  { id: '18b78ee1201a43254ca2775267d4da38', expectedRequestId: 'fb0da6739162bd7046ba2444604a84da', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T18:21:41.739Z' },
  { id: 'f334e41a88bc55aadb122c31e72a4d42', expectedRequestId: 'c8f59dccd1383e5caab89bfc2e0f5f25', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T19:13:21.678Z' },
  { id: '705bb87aa419a88a969ba2d731b8f5b3', expectedRequestId: '0c5a55b8003c31d5800d446372cdf78a', expectedStatus: 'queued', gatheredCreatedAt: '2026-09-06T19:30:46.096Z' },
]

const HELP = `
Resolve the eight outbox rows stranded by the 2026-09-06 15:41-19:30 SMTP
outage -- a one-time historical correction, not the ongoing mechanism (that
is the owner screen's Resolve action, POST /api/owner/outbox/:id/resolve).

Usage:
  node scripts/resolve-outbox-rows.mjs --note "text" [--write]

The eight ids are frozen inside this file, not passed as arguments -- see
the file's own header comment for why. Every row is re-read and checked
against what was true when its id was gathered before anything is written;
a mismatch on any row aborts the whole run.

Without --write nothing is changed: the database is opened read-only and the
exact target rows are printed. Read it, then run again with --write.

Options:
  --note TEXT   The resolution note, applied to every one of the eight rows.
  --db PATH     Database file (default ${DEFAULT_DB}, or $KMT_OWNER_DB).
  --write       Actually call resolve() on each row.
  --help        This message.

resolve() never touches error: the note goes to its own resolution_note
column, and error is left exactly as it was (null on every one of these
eight -- none was ever attempted). Idempotent -- running this twice is
safe; already-resolved rows are reported unchanged, not re-written.
`.trimStart()

function parseArgs(argv) {
  const options = { note: null, db: DEFAULT_DB, write: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--write') options.write = true
    else if (arg === '--note') options.note = argv[++i]
    else if (arg === '--db') options.db = argv[++i]
    else throw new Error(`Unknown argument ${arg}. Run with --help. (Ids are not an argument -- they're frozen in this file.)`)
  }
  return options
}

/**
 * Every entry must be a real, gathered value before this script will touch
 * the database at all -- dry run included. Returns a list of problems
 * (empty if the frozen list is complete and correctly shaped), never
 * throws, so the caller can print all of them at once rather than one
 * failure at a time.
 */
function checkFrozenListShape() {
  const problems = []
  if (FROZEN_ROWS.length !== 8) {
    problems.push(`FROZEN_ROWS has ${FROZEN_ROWS.length} entries, not 8. This script must name exactly the eight rows the investigation closed on -- not fewer, not more.`)
  }
  const seen = new Set()
  for (const [index, row] of FROZEN_ROWS.entries()) {
    if (row.id === TODO_PENDING || row.expectedRequestId === TODO_PENDING || row.gatheredCreatedAt === TODO_PENDING) {
      problems.push(`Row ${index + 1} is still a TODO_PENDING placeholder -- its id has not actually been gathered yet.`)
      continue
    }
    if (seen.has(row.id)) problems.push(`Row ${index + 1}'s id (${row.id}) is a duplicate of an earlier row -- the eight must be distinct.`)
    seen.add(row.id)
  }
  return problems
}

/**
 * Re-reads one frozen row and compares it against what was true when its
 * id was gathered. Returns null if it still matches; otherwise a specific,
 * printable description of what differed -- never a bare "mismatch."
 */
function checkRowAgainstLive(outbox, frozen) {
  const live = outbox.get(frozen.id)
  if (!live) return `id ${frozen.id}: no such outbox row exists anymore (expected request ${frozen.expectedRequestId}, gathered ${frozen.gatheredCreatedAt})`
  if (live.requestId !== frozen.expectedRequestId) {
    return `id ${frozen.id}: request_id is now "${live.requestId}", expected "${frozen.expectedRequestId}" from when this id was gathered`
  }
  if (live.status !== frozen.expectedStatus && !live.resolvedAt) {
    // Already-resolved rows are checked separately (idempotent, not a mismatch) --
    // this only fires for a status change on a row nobody has resolved yet.
    return `id ${frozen.id}: status is now "${live.status}", expected "${frozen.expectedStatus}" from when this id was gathered`
  }
  return null
}

function describe(row) {
  const lines = [`${row.id}  (request ${row.requestId}, ${row.status}, created ${row.createdAt})`]
  if (row.resolvedAt) {
    lines.push(`  already resolved at ${row.resolvedAt}: "${row.resolutionNote}" -- --write would leave this unchanged (idempotent)`)
  } else {
    lines.push('  not yet resolved -- --write would set resolved_at to now and resolution_note to the text below')
  }
  lines.push(`  error column: ${row.error ? JSON.stringify(row.error) : '(empty, untouched either way)'}`)
  return lines
}

function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  if (options.help) { console.log(HELP); return }

  const shapeProblems = checkFrozenListShape()
  if (shapeProblems.length) {
    console.error('The frozen row list is not ready to run:')
    for (const problem of shapeProblems) console.error(`  - ${problem}`)
    console.error('\nNothing was read or written.')
    process.exitCode = 1
    return
  }

  if (typeof options.note !== 'string' || !options.note.trim()) {
    console.error('A --note is required -- resolve() records why, not just that.')
    process.exitCode = 1
    return
  }

  console.log(`Database: ${options.db}`)
  console.log(options.write ? 'Mode: WRITE\n' : 'Mode: dry run, opened read-only, nothing will be written\n')

  // Same discipline as redact.mjs: the plan always reads through a
  // read-only handle first, even on a --write pass, so what gets printed
  // is what an inspection would have seen, and the write below re-reads
  // inside its own handle anyway (the cross-check calls Outbox.get()
  // before Outbox.resolve() ever runs).
  const reader = new DatabaseSync(options.db, { readOnly: true })
  const mismatches = []
  try {
    const outbox = new Outbox(reader)
    for (const frozen of FROZEN_ROWS) {
      const mismatch = checkRowAgainstLive(outbox, frozen)
      if (mismatch) { mismatches.push(mismatch); continue }
      for (const line of describe(outbox.get(frozen.id))) console.log(line)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  } finally {
    reader.close()
  }

  if (mismatches.length) {
    console.error('\nOne or more rows no longer match what was recorded when their id was gathered -- refusing to touch any of the eight:')
    for (const mismatch of mismatches) console.error(`  - ${mismatch}`)
    console.error('\nNothing was written. A live change to one of these rows needs a person to look before this runs again.')
    process.exitCode = 1
    return
  }

  console.log(`\nNote to record on all eight: ${JSON.stringify(options.note)}`)

  if (!options.write) {
    console.log('\nNothing was written. Check the target above, then run again with --write.')
    return
  }

  const inventory = new Inventory(options.db, [])
  try {
    const outbox = new Outbox(inventory.db)
    const results = FROZEN_ROWS.map(frozen => outbox.resolve(frozen.id, options.note))
    console.log('\nDone:')
    for (const row of results) {
      console.log(`  ${row.id}  resolved_at=${row.resolvedAt}  resolution_note=${JSON.stringify(row.resolutionNote)}  error=${row.error ? JSON.stringify(row.error) : 'null'}`)
    }
  } catch (error) {
    console.error(`\nFailed partway through: ${error.message}`)
    console.error('resolve() is idempotent per row -- re-running is safe; already-settled rows come back unchanged.')
    process.exitCode = 1
  } finally {
    inventory.close()
  }
}

main()
