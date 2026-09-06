import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { QUOTE_STATUSES } from '../backend/quotes.mjs';

const SCRIPT = path.join(import.meta.dirname, 'restore-integrity-check.mjs');

/**
 * Run the script exactly the way the drill will: a real subprocess, a real
 * file path as argv[2], nothing else configured. Never throws on a non-zero
 * exit -- a FAIL run is a normal, expected outcome for several tests here.
 */
function run(dbPath) {
  // FAIL lines go to stderr (console.error), OK lines to stdout: spawnSync
  // (unlike execFileSync) never throws on a non-zero exit, and hands back
  // both streams the same way whether the run passed or failed.
  const result = spawnSync('node', [SCRIPT, dbPath].filter(Boolean), { encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout ?? '') + (result.stderr ?? '') };
}

/**
 * A file with today's full production schema and the minimum valid rows to
 * satisfy every check, built through a genuinely separate write connection
 * that is closed before the script ever opens the file -- the same standard
 * backend/outbox.test.mjs's deployedDatabase() helper uses, so this proves
 * the check against a real, closed, reopenable file rather than a shared
 * in-process handle.
 */
function soundDatabase(dir, mutate = () => {}) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE supplier (id TEXT PRIMARY KEY, size TEXT NOT NULL, payload TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE offers (id TEXT PRIMARY KEY REFERENCES supplier(id), price_cents INTEGER, enabled INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE coverage (size TEXT PRIMARY KEY, last_success TEXT, completeness TEXT NOT NULL, error TEXT, attempted_at TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE quotes (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      version INTEGER NOT NULL DEFAULT 1, reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK(status IN (${QUOTE_STATUSES.map(s => `'${s}'`).join(', ')}))
    );
    CREATE TABLE owner_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
      type TEXT NOT NULL, template_version INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL,
      to_address TEXT NOT NULL, to_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', provider_id TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO supplier VALUES ('giga-1', '215/60R16', '{}', '2026-09-06', 1);
    INSERT INTO offers VALUES ('giga-1', 5000, 1, '', 1, '2026-09-06');
    INSERT INTO coverage VALUES ('215/60R16', '2026-09-06', 'full', NULL, '2026-09-06');
    INSERT INTO metadata VALUES ('seeded', '{"at":"2026-09-06"}');
    INSERT INTO requests VALUES ('req-1', 'customerkey', '{}', '2026-09-06', '2026-09-06');
    INSERT INTO quotes (id, request_id, payload, status, created_at, updated_at) VALUES ('quote-1', 'req-1', '{}', 'draft', '2026-09-06', '2026-09-06');
  `);
  mutate(db);
  db.close();
  return file;
}

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmt-restore-check-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a sound, fully-seeded database passes every check', () => withTmpDir(dir => {
  const file = soundDatabase(dir);
  const { status, stdout } = run(file);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /14 of 14 expected checks ran/);
  assert.match(stdout, /SOUND: this file passed every check/);
  assert.match(stdout, /PRAGMA user_version: 0/);
  assert.doesNotMatch(stdout, /FAIL:/);
  assert.doesNotMatch(stdout, /OLDER SCHEMA:/);
}));

test('a real failure alongside an older-schema table still exits NOT SOUND (1), not OLDER SCHEMA (2) -- a real problem always wins the verdict', () => withTmpDir(dir => {
  const file = soundDatabase(dir, db => {
    // outbox missing entirely (OLDER SCHEMA on its own) plus a genuine FK
    // violation (NOT SOUND on its own): the worse claim must win the exit
    // code and the summary word, in whichever order the checks run.
    db.exec('DROP TABLE outbox');
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec("INSERT INTO offers VALUES ('ghost-id', 4000, 1, '', 1, '2026-09-06')");
  });
  const { status, stdout } = run(file);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /OLDER SCHEMA: table outbox/);
  assert.match(stdout, /FAIL: PRAGMA foreign_key_check/);
  assert.match(stdout, /\nNOT SOUND: see FAIL lines above\./);
}));

test('a missing file fails on the first check and reports the short count honestly', () => withTmpDir(dir => {
  const { status, stdout } = run(path.join(dir, 'does-not-exist.sqlite'));
  assert.equal(status, 1);
  assert.match(stdout, /FAIL:.*does-not-exist\.sqlite exists/);
  assert.match(stdout, /1 of 14 expected checks ran/);
  assert.match(stdout, /NOT SOUND/);
}));

test('a later-added table missing entirely (e.g. a pre-outbox-merge restore) is OLDER SCHEMA, not NOT SOUND', () => withTmpDir(dir => {
  const file = soundDatabase(dir);
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE outbox');
  db.close();
  const { status, stdout } = run(file);
  assert.equal(status, 2, stdout);
  assert.match(stdout, /OLDER SCHEMA: table outbox \(operational\) predates this file/);
  assert.doesNotMatch(stdout, /FAIL:/);
  assert.match(stdout, /OK: table supplier/);
  assert.match(stdout, /\nOLDER SCHEMA: intact, but restore it and let the app's own migration run/);
}));

test('an original-schema table missing entirely (e.g. requests) is NOT SOUND, not OLDER SCHEMA -- it has no later-migration story', () => withTmpDir(dir => {
  const file = soundDatabase(dir);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('DROP TABLE quotes');
  db.exec('DROP TABLE requests');
  db.close();
  const { status, stdout } = run(file);
  assert.equal(status, 1);
  assert.match(stdout, /FAIL: table requests \(irreplaceable\).*missing entirely/);
  assert.doesNotMatch(stdout, /OLDER SCHEMA: table requests/);
}));

test('a table missing an expected column fails with the column named', () => withTmpDir(dir => {
  const file = path.join(dir, 'short-column.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);
  db.close();
  const { stdout } = run(file);
  assert.match(stdout, /FAIL: table requests \(irreplaceable\).*missing: customer_key, created_at, updated_at/);
}));

test('a foreign key violation (an offer for a supplier row that no longer exists) fails PRAGMA foreign_key_check', () => withTmpDir(dir => {
  const file = soundDatabase(dir, db => {
    // Foreign keys are only enforced while the pragma is on for the writing
    // connection; turning it off here is exactly how a real bad row would
    // have gotten in before the constraint existed, or under a connection
    // that never turned enforcement on.
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec("INSERT INTO offers VALUES ('ghost-id', 4000, 1, '', 1, '2026-09-06')");
  });
  const { status, stdout } = run(file);
  assert.equal(status, 1);
  assert.match(stdout, /FAIL: PRAGMA foreign_key_check reports no violations/);
  assert.match(stdout, /violating row/);
}));

test('a quotes table with a pre-widening (pre-t36) CHECK constraint is OLDER SCHEMA, not NOT SOUND -- migrate() fixes it losslessly on next boot', () => withTmpDir(dir => {
  // Otherwise-sound database, just with quotes rebuilt onto the CHECK
  // constraint quotes.mjs used before t36 widened it -- the same rebuild
  // migrate() itself performs, run here by hand so the row survives intact.
  const file = soundDatabase(dir, db => {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`
      CREATE TABLE quotes_old (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK(status IN ('draft', 'sent', 'rejected', 'paid', 'done', 'cancelled'))
      );
      INSERT INTO quotes_old SELECT * FROM quotes;
      DROP TABLE quotes;
      ALTER TABLE quotes_old RENAME TO quotes;
    `);
  });
  const { status, stdout } = run(file);
  assert.equal(status, 2, stdout);
  assert.match(stdout, /OLDER SCHEMA: quotes\.status CHECK constraint predates a status-widening migration -- missing approved; migrate\(\) will widen it losslessly/);
  assert.doesNotMatch(stdout, /FAIL:/);
  assert.match(stdout, /OK: table quotes \(irreplaceable\) is present with its expected columns and readable: 1 row\(s\)/);
}));

test('metadata.seeded set with an empty supplier table fails, naming the silent-no-op risk', () => withTmpDir(dir => {
  const file = soundDatabase(dir, db => {
    db.exec('DELETE FROM offers');
    db.exec('DELETE FROM supplier');
  });
  const { status, stdout } = run(file);
  assert.equal(status, 1);
  assert.match(stdout, /FAIL: if metadata\.seeded is set, the supplier table actually holds rows.*importSnapshot\(\) will treat this file as already seeded/);
}));

test('data sitting only in an uncommitted WAL file is still read and still sound -- the exact state a volume snapshot mid-write leaves behind', () => withTmpDir(dir => {
  const file = path.join(dir, 'wal-only.sqlite');
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  writer.prepare("INSERT INTO metadata VALUES ('seeded', '{}')").run();
  // Deliberately not closed: the WAL file exists on disk with this row in it
  // and nothing checkpointed to the main file yet.
  assert.equal(existsSync(`${file}-wal`), true);
  try {
    const { stdout } = run(file);
    assert.match(stdout, /OK: opens as a SQLite database in read-only mode/);
    assert.match(stdout, /OK: PRAGMA integrity_check reports ok/);
  } finally {
    writer.close();
  }
}));

test('the read-only connection this script opens cannot itself write', () => withTmpDir(dir => {
  const file = soundDatabase(dir);
  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    assert.throws(() => ro.exec("INSERT INTO metadata VALUES ('x', 'y')"), /readonly database/);
  } finally {
    ro.close();
  }
}));
