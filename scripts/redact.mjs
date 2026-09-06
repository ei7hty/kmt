#!/usr/bin/env node
/**
 * Fulfil a customer's removal request against a database, by hand, on purpose.
 *
 * `/privacy` promises in production that a customer can have their name,
 * contact details and address removed. This is how that promise is kept.
 *
 *   node scripts/redact.mjs --request <id>            # show what would change
 *   node scripts/redact.mjs --request <id> --write    # do it
 *   node scripts/redact.mjs --inquiry <id> --write
 *
 * ## Three deliberate choices
 *
 * **It is a command, not an endpoint.** There is no route for this and there
 * must not be: authorisation is a human with machine access, not one shared
 * password on the public internet. On production it is reached with
 * `flyctl ssh console -a kmt -C "node /app/scripts/redact.mjs ..."`.
 *
 * **Nothing is written without `--write`.** The default pass opens the file
 * **read-only** and prints the exact target -- the request id, the fields, the
 * quotes, the outbox rows. A removal has no undo, and the wrong `WHERE` clause
 * is the failure this replaces. Read the printed target before adding the flag.
 *
 * **It needs no `sqlite3`.** The runbook's fallback SQL does, and three
 * procedures once failed at the prompt because the binary was absent from the
 * image (found by the restore drill, fixed in #288). Node 24 and `node:sqlite`
 * are what the server itself runs on, so this works whether or not anyone
 * remembers to keep that package installed.
 *
 * The read-only default is also why inspection cannot damage what it inspects:
 * opening a SQLite file read-write is not inert -- it can checkpoint a WAL,
 * repairing the very evidence an inspection was meant to judge.
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Inventory } from '../backend/inventory.mjs'
import { Quotes } from '../backend/quotes.mjs'
import {
  planInquiryRedaction, planRequestRedaction, redactInquiry, redactRequest, verifyRequestRedaction,
} from '../backend/redaction.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB = process.env.KMT_OWNER_DB || path.join(ROOT, 'backend', 'data', 'owner.sqlite')

const HELP = `
Redact a customer's personal details from a request (and everything attached
to it) or from an inquiry, keeping the business record intact.

Usage:
  node scripts/redact.mjs --request <request-id> [--write]
  node scripts/redact.mjs --inquiry <inquiry-id> [--write]

Without --write nothing is changed: the database is opened read-only and the
exact target is printed. Read it, then run again with --write.

Options:
  --request ID   The request to redact. Its quotes' reasons and every outbox
                 message about it are redacted in the same transaction.
  --inquiry ID   An inquiry to redact. Inquiries are not attached to a
                 request, so they are found by their own id.
  --db PATH      Database file (default ${DEFAULT_DB}, or $KMT_OWNER_DB).
  --write        Actually perform the redaction.
  --help         This message.

What is removed: the customer's name, email, phone, service address, access
notes and special instructions; the recipient columns, provider error text and
personal fields on every outbox message about the request; the reason text on
its quotes. What is kept: the whole quote ledger -- status, version, total,
line items, timestamps -- plus the vehicle, tire, quantity, date and service
ZIP, and the browser key that lets the customer's own device still see their
history. See docs/data-policy.md.
`.trimStart()

function parseArgs(argv) {
  const options = { request: null, inquiry: null, db: DEFAULT_DB, write: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--write') options.write = true
    else if (arg === '--request') options.request = argv[++i]
    else if (arg === '--inquiry') options.inquiry = argv[++i]
    else if (arg === '--db') options.db = argv[++i]
    else throw new Error(`Unknown argument ${arg}. Run with --help.`)
  }
  return options
}

/** What the plan says, in the words an operator needs to check it against the call. */
function describe(plan) {
  const lines = []
  if (plan.kind === 'inquiry') {
    lines.push(`Inquiry ${plan.id}`)
    lines.push(plan.fields.length
      ? `  fields to redact: ${plan.fields.join(', ')}`
      : '  nothing to redact: already redacted, or never carried these fields')
    return lines
  }
  lines.push(`Request ${plan.id}`)
  lines.push(plan.requestFields.length
    ? `  request fields to redact: ${plan.requestFields.join(', ')}`
    : '  request fields: none still hold anything')
  lines.push(plan.quoteReasons.length
    ? `  quote reasons to redact: ${plan.quoteReasons.length} (${plan.quoteReasons.join(', ')})`
    : '  quote reasons: none')
  if (!plan.outboxTable) lines.push('  outbox: table does not exist in this database')
  else if (!plan.outbox.length) lines.push('  outbox: no message about this request still holds anything')
  else {
    lines.push(`  outbox messages to redact: ${plan.outbox.length}`)
    for (const message of plan.outbox) {
      lines.push(`    ${message.id}: columns [${message.columns.join(', ') || '-'}] data [${message.dataKeys.join(', ') || '-'}]`)
    }
  }
  return lines
}

function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1; return }

  if (options.help) { console.log(HELP); return }

  // An unambiguous identifier, and exactly one of them. "Redact everything for
  // this name" is deliberately not offered: matching a person by name is the
  // step where the wrong customer gets redacted, and it is the operator's job
  // to find the id first (docs/operations.md step 1 shows how).
  if (Boolean(options.request) === Boolean(options.inquiry)) {
    console.error('Name exactly one of --request <id> or --inquiry <id>. Run with --help.')
    process.exitCode = 1
    return
  }

  console.log(`Database: ${options.db}`)
  console.log(options.write ? 'Mode: WRITE\n' : 'Mode: dry run, opened read-only, nothing will be written\n')

  // The plan is always computed against a read-only handle, even for --write:
  // what gets printed is what an inspection would have seen, and the write
  // below re-plans inside its own transaction anyway.
  let plan
  const reader = new DatabaseSync(options.db, { readOnly: true })
  try {
    plan = options.request
      ? planRequestRedaction(reader, options.request)
      : planInquiryRedaction(reader, options.inquiry)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  } finally {
    reader.close()
  }

  for (const line of describe(plan)) console.log(line)

  if (plan.empty) {
    console.log('\nNothing to do: this record is already redacted, or never carried these fields.')
    if (!options.write) console.log('(Running with --write would be a no-op. Redaction is idempotent.)')
    return
  }

  if (!options.write) {
    console.log('\nNothing was written. Check the target above, then run again with --write.')
    return
  }

  const inventory = new Inventory(options.db, [])
  try {
    const summary = options.request
      ? redactRequest(inventory, options.request)
      : redactInquiry(inventory, options.inquiry)
    console.log(`\nDone: ${JSON.stringify(summary)}`)

    if (options.request) {
      // Read it back the way the customer's own link does. A row blanked in
      // the table that still answers with the old name over the API has not
      // been removed from the point of view that matters.
      const remaining = verifyRequestRedaction(new Quotes(inventory), options.request)
      if (remaining.length) {
        console.error(`\nVERIFICATION FAILED: still holding ${remaining.join(', ')}`)
        process.exitCode = 1
        return
      }
      console.log('Verified through the owner-audience read: no personal field survives.')
    }
  } catch (error) {
    console.error(`\nFailed, and nothing was written: ${error.message}`)
    process.exitCode = 1
  } finally {
    inventory.close()
  }
}

main()
