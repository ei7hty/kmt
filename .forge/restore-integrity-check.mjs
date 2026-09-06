import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { QUOTE_STATUSES } from '../backend/quotes.mjs';

/**
 * t54: is a restored or suspect database sound? A yes/no plus a reason,
 * against a raw file -- nothing serving it, nothing configured.
 *
 * DEV OPS owns the restore drill: flyctl in the user's hands, a snapshot
 * landed on a throwaway machine, "the file is back." This is the step after
 * that one, the step their procedure was never going to answer for them --
 * whether the file that came back is the right file. Their lane ends at the
 * bytes existing; this lane opens them and asks what they hold.
 *
 * `node .forge/restore-integrity-check.mjs /path/to/restored.sqlite`
 *
 * Opens `DatabaseSync(path, { readOnly: true })` -- confirmed against this
 * Node version to (a) genuinely refuse a write attempt at the engine level,
 * not by convention, and (b) still read rows that exist only in an
 * uncommitted `-wal` file, which is the exact state a volume snapshot taken
 * mid-write leaves behind. That second property is why read-only is not
 * merely a safety habit here: opening a SQLite file read-write is not inert
 * -- it can replay a hot journal or checkpoint a WAL, quietly repairing a
 * file that arrived damaged-but-recoverable. A check that mutates the thing
 * it is judging can pass once, repair the evidence, and pass again forever
 * -- nobody ever learns the restore produced something that needed fixing.
 * Safe to point at a live production file for the same reason: it cannot
 * write to it no matter what it finds.
 *
 * ## What this does NOT check
 *
 * - **Foreign key enforcement.** `PRAGMA foreign_keys=ON` is a per-connection
 *   setting (backend/inventory.mjs's constructor sets it, not the file), so
 *   a restored file carries no memory of whether it was ever on. What this
 *   script asks instead is `PRAGMA foreign_key_check`: do any rows *right
 *   now* violate a declared foreign key, regardless of whether enforcement
 *   was ever active. That is a real question about the data; whether
 *   enforcement itself is wired up is a question about the code that opens
 *   the file next, and belongs in a test against inventory.mjs, not here.
 * - **Application-level correctness.** That `payload`/`data` JSON parses,
 *   that a price is sane, that a session hasn't already expired -- none of
 *   that is asked. Structural soundness is not business-logic soundness.
 * - **Freshness.** Nothing here knows what today's real row counts should
 *   be, or whether this is the *most recent* snapshot rather than an older
 *   one that also happens to be internally consistent. A stale-but-sound
 *   restore passes.
 * - **Redaction correctness.** Whether a removed customer's data was
 *   actually scrubbed from `outbox`/`requests` is docs/data-policy.md's
 *   promise, not a structural property this script can see.
 * - **Anything beyond what SQLite's own `integrity_check` catches.** A
 *   corruption mode below that floor is invisible to a tool built on top of
 *   the engine that missed it.
 *
 * `PRAGMA integrity_check` is the floor everything else stands on: if that
 * is not "ok", nothing below it can be trusted either, so it runs first and
 * everything after it still runs regardless -- a second problem is still
 * worth naming even once the first one has failed the run.
 *
 * ## Three verdicts, not two
 *
 * A schema mismatch and a broken database are not the same claim, and
 * training an operator to read them as the same thing is dangerous in
 * exactly the way a flaky check is dangerous, with higher stakes: the drill
 * exists to be run scared, and the whole value of SOUND/NOT SOUND is that
 * NOT SOUND always means stop. Every Fly snapshot is a file from the past by
 * construction (five-day retention), and this project has added a table or
 * widened a constraint on consecutive days, so "the file predates a
 * migration" is not a today problem, it is the permanent shape of restoring
 * anything. So a table added later than the file (`owner_sessions`,
 * `outbox` -- see `label: 'operational'` below) being entirely absent, or
 * `quotes.status`'s CHECK predating a widening it has a tested, lossless
 * `migrate()` for, is its own verdict: **OLDER SCHEMA**. The file is intact;
 * it needs the app's own migration to run once, the same as any deploy.
 * That is the t36 lesson from the other direction -- a file that fails a
 * schema comparison is not necessarily damaged, the same way a file that
 * passes one is not necessarily current. Everything else that can go wrong
 * here (integrity_check, foreign_key_check, a column actually missing from
 * a table that exists, the seeded-but-empty trap) has no such migration to
 * fall back on and stays **NOT SOUND**.
 */

const EXPECTED_CHECKS = 14;

let passed = 0;
let failed = 0;
let staled = 0;

function ok(message) {
  passed += 1;
  console.log(`OK: ${message}`);
}

function fail(message) {
  failed += 1;
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

/**
 * Intact, but from before a specific migration this codebase already knows
 * how to run losslessly on next boot -- not a claim that the file is
 * damaged. Still a non-zero exit (a drill should not silently pass an old
 * file), but exit code 2 rather than 1, and its own word in the summary, so
 * a person or a script reading the result is not trained to treat this the
 * same as the thing this whole tool exists to catch.
 */
function stale(message) {
  staled += 1;
  console.log(`OLDER SCHEMA: ${message}`);
  if (!process.exitCode) process.exitCode = 2;
}

function check(condition, message, detail = '') {
  if (condition) ok(message);
  else fail(`${message}${detail ? ` — ${detail}` : ''}`);
}

/**
 * The schema every table on `main` declares today. Column names only, in
 * declaration order they do not need to match -- a restored file that has
 * them all, however SQLite chose to store them, has the columns the code
 * reads by name. `outbox` is included because t54 was scoped the same day
 * as PR #157 (`outbox-table`): by the time a restore drill runs this for
 * real, that table is expected to exist. Its columns are read directly off
 * that branch (`backend/outbox.mjs`'s `OUTBOX_COLUMNS`) rather than guessed.
 *
 * `label` marks how a missing or short row *count* below should read to a
 * person at 2am: `irreplaceable` cannot be rebuilt from anything but the
 * customer who made it; `rebuildable` can be re-imported from a snapshot
 * already in the repository; `operational` is neither -- it is working
 * state (sessions, queued mail) that is fine to be empty on a fresh restore.
 */
const EXPECTED_TABLES = {
  supplier: { label: 'rebuildable', columns: ['id', 'size', 'payload', 'last_seen', 'active'] },
  offers: { label: 'rebuildable', columns: ['id', 'price_cents', 'enabled', 'notes', 'version', 'updated_at'] },
  coverage: { label: 'rebuildable', columns: ['size', 'last_success', 'completeness', 'error', 'attempted_at'] },
  metadata: { label: 'rebuildable', columns: ['key', 'value'] },
  requests: { label: 'irreplaceable', columns: ['id', 'customer_key', 'payload', 'created_at', 'updated_at'] },
  quotes: { label: 'irreplaceable', columns: ['id', 'request_id', 'payload', 'status', 'version', 'reason', 'created_at', 'updated_at'] },
  owner_sessions: { label: 'operational', columns: ['id', 'expires_at'] },
  outbox: {
    label: 'operational',
    columns: ['id', 'request_id', 'type', 'template_version', 'data', 'to_address', 'to_name', 'status', 'provider_id', 'error', 'created_at', 'updated_at'],
  },
};

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

function main() {
  const path = process.argv[2];
  if (!path) {
    fail('usage: node .forge/restore-integrity-check.mjs /path/to/database.sqlite');
    process.exitCode = 1;
    return;
  }

  console.log(`Restore-integrity check against ${path}`);

  // 1. The file exists, checked before anything tries to open it, so a typo'd
  //    path (a real risk when an operator is holding two databases at once --
  //    the live one and the restored one) fails with its own name rather than
  //    a generic "unable to open database file".
  const fileExists = existsSync(path);
  check(fileExists, `${path} exists`);
  if (!fileExists) { reportCount(); return; }

  // 2. Opens read-only. If this throws, the file is not a database SQLite
  //    will open at all, which is itself the answer: report it and stop --
  //    every check after this one needs a connection.
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    ok('opens as a SQLite database in read-only mode');
    // Printed, not asserted: this codebase has never set it, so there is
    // nothing to compare it against, but it costs nothing and it is the
    // fastest way for whoever reads this output pasted into a message to
    // tell which migration generation the file belongs to.
    console.log(`PRAGMA user_version: ${db.prepare('PRAGMA user_version').get()?.user_version}`);
  } catch (error) {
    fail(`opens as a SQLite database in read-only mode — ${error.message}`);
    reportCount();
    return;
  }

  try {
    // 3. The floor. Everything below assumes this passed, but still runs if
    //    it did not -- a second problem is still worth naming.
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    check(integrity === 'ok', 'PRAGMA integrity_check reports ok', integrity ? `reported: ${integrity}` : 'no result');

    // 4. Declared foreign keys, checked against the rows that actually exist --
    //    not whether enforcement was ever on for this file (see header: that
    //    is a property of the connection that opens it next, not of the file).
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    check(violations.length === 0, 'PRAGMA foreign_key_check reports no violations',
      violations.length ? `${violations.length} violating row(s), e.g. ${JSON.stringify(violations[0])}` : '');

    // 5-12. Every table present with the columns the code reads by name, and
    //   readable end to end -- a table scan that throws despite integrity_check
    //   passing would itself be news. Row counts are printed labeled by
    //   whether the data is irreplaceable, rebuildable, or merely operational,
    //   because that is the distinction that tells an operator whether a gap
    //   is a problem or an inconvenience.
    for (const [table, { label, columns }] of Object.entries(EXPECTED_TABLES)) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) {
        // A whole table added after this file was written is not the same
        // claim as one that should always have been there: `operational`
        // marks the tables this codebase added on a specific later day, with
        // no prior rows anywhere to have lost -- `CREATE TABLE IF NOT
        // EXISTS` recreates it empty on next boot, which is exactly what
        // "predates this feature" should mean. `supplier`/`offers`/
        // `coverage`/`metadata`/`requests`/`quotes` have existed since this
        // app's first schema; their total absence has no such story.
        if (label === 'operational') {
          stale(`table ${table} (${label}) predates this file -- intact, will be created fresh on next boot`);
        } else {
          fail(`table ${table} (${label}) is present with its expected columns — missing entirely`);
        }
        continue;
      }
      const actualColumns = tableColumns(db, table);
      const missing = columns.filter(c => !actualColumns.includes(c));
      if (missing.length) {
        fail(`table ${table} (${label}) is present with its expected columns — missing: ${missing.join(', ')}`);
        continue;
      }
      try {
        const count = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
        ok(`table ${table} (${label}) is present with its expected columns and readable: ${count} row(s)`);
      } catch (error) {
        fail(`table ${table} (${label}) is present with its expected columns and readable — ${error.message}`);
      }
    }

    // 13. The same question quotes.mjs's own migrate() asks of a live
    //   connection, asked here of the file instead: does the stored CHECK
    //   constraint on quotes.status actually include every current status,
    //   or does this file predate a widening (t36) and carry the old one? A
    //   restore from before that migration looks structurally fine -- the
    //   table exists, every expected column is there -- and only refuses on
    //   the first `sent` write, which is the owner's Approve button. Unlike
    //   a missing table or column, this is not a NOT SOUND finding: it is
    //   exactly what migrate() exists to fix, tested (migration.test.mjs) to
    //   do so losslessly on next boot, so a stale CHECK here is the same
    //   OLDER SCHEMA claim as an absent later table, not evidence of damage.
    const quotesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='quotes'").get()?.sql ?? '';
    const staleStatuses = QUOTE_STATUSES.filter(status => !quotesSql.includes(`'${status}'`));
    if (quotesSql === '') {
      fail('quotes.status CHECK constraint includes every current status — quotes table missing, already reported above');
    } else if (staleStatuses.length) {
      stale(`quotes.status CHECK constraint predates a status-widening migration -- missing ${staleStatuses.join(', ')}; migrate() will widen it losslessly on next boot`);
    } else {
      ok('quotes.status CHECK constraint includes every current status');
    }

    // 14. importSnapshot() no-ops once metadata.seeded is set (backend/
    //   inventory.mjs). A restored file with that flag set and no supplier
    //   rows would look "already seeded" to the running app and stay empty
    //   forever -- silently, because nothing would ever try importing again.
    //   That is exactly the shape of failure that looks like success.
    const metadataExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    const seededRow = metadataExists ? db.prepare("SELECT value FROM metadata WHERE key='seeded'").get() : null;
    const supplierCount = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier'").get()
      ? db.prepare('SELECT count(*) AS n FROM supplier').get().n
      : null;
    const seededCheckMessage = 'if metadata.seeded is set, the supplier table actually holds rows';
    if (!metadataExists) {
      fail(`${seededCheckMessage} — metadata table missing, already reported above`);
    } else if (!seededRow) {
      ok(`${seededCheckMessage} — not set, so no empty-but-seeded risk`);
    } else if (supplierCount === null) {
      fail(`${seededCheckMessage} — supplier table missing, already reported above`);
    } else {
      check(supplierCount > 0, seededCheckMessage,
        'seeded is true but supplier is empty — importSnapshot() will treat this file as already seeded and silently do nothing');
    }
  } finally {
    db.close();
  }

  reportCount();
}

function reportCount() {
  const ran = passed + failed + staled;
  console.log(`\n${passed} OK, ${staled} OLDER SCHEMA, ${failed} FAIL — ${ran} of ${EXPECTED_CHECKS} expected checks ran`);
  if (ran < EXPECTED_CHECKS) {
    fail(`only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`);
  } else if (ran > EXPECTED_CHECKS) {
    fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`);
  }
  if (failed > 0) {
    console.log('\nNOT SOUND: see FAIL lines above.');
  } else if (staled > 0) {
    console.log('\nOLDER SCHEMA: intact, but restore it and let the app\'s own migration run before serving from it -- see OLDER SCHEMA lines above.');
  } else {
    console.log('\nSOUND: this file passed every check this script knows to run.');
  }
}

main();
