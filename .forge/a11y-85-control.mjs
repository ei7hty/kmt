/**
 * Positive and negative control for a11y-85-measure.mjs's failure mode.
 *
 * Kept as a file rather than a paragraph in a pull request, the same reason
 * head-check-control.mjs gives: a claim in a PR body is read once, by one
 * person, and stops being rerunnable the moment anything moves.
 *
 *   npm run build && AUDIT_BASE=... KMT_OWNER_PASSWORD=... node .forge/a11y-85-control.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * a11y-85-measure.mjs could not fail. Its only `process.exit` was `exit(2)` on a
 * missing AUDIT_BASE -- nothing for what it measured. It printed contrast and
 * tap-target failures and exited 0, so "trust the exit code", which is right for
 * every other script here, silently gave the wrong answer for this one. Giving
 * it an exit code is worthless unless something proves the exit code moves.
 *
 * The fault injected is the real one: #404 fixed `.owner-request a` painting
 * `--accent-text` onto `.btn-primary`'s red fill -- 1.88:1 where AA needs 4.5:1,
 * on the only tappable way a customer reaches Ken. Reverting `:not(.btn)` in the
 * BUILT css brings it back without touching src/ or needing a rebuild.
 *
 * It also proves the state coverage, which is the other half of the change: the
 * defect was live on /status in draft, rejected and cancelled, and the script
 * used to visit only draft. A run that names all three is the coverage doing
 * something, not just a larger number.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.AUDIT_BASE;
if (!BASE) {
  console.error('Set AUDIT_BASE explicitly. Never let a harness default to a target.');
  process.exit(2);
}

const cssDir = path.join(ROOT, 'dist', 'assets');
const cssFile = readdirSync(cssDir).find(name => name.endsWith('.css'));
if (!cssFile) { console.error('No built css in dist/assets. Run `npm run build` first.'); process.exit(2); }
const cssPath = path.join(cssDir, cssFile);
const GOOD = readFileSync(cssPath, 'utf8');

const FIXED = '.owner-request a:not(.btn){color:var(--accent-text)}';
const BROKEN = '.owner-request a{color:var(--accent-text)}';
if (!GOOD.includes(FIXED)) {
  console.error(`Could not find ${FIXED} in ${cssFile}. #404 may have been reworked; this control needs updating with it.`);
  process.exit(2);
}

let failures = 0;
const check = (ok, message) => { console.log(`${ok ? 'OK  ' : 'FAIL'}: ${message}`); if (!ok) failures += 1; };

const run = () => spawnSync(process.execPath, ['.forge/a11y-85-measure.mjs'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, AUDIT_BASE: BASE },
});

try {
  // ---- negative: the defect #404 fixed, put back ----
  writeFileSync(cssPath, GOOD.replace(FIXED, BROKEN));
  const bad = run();
  check(bad.status === 1, `a contrast failure exits 1 (got ${bad.status})`);
  check(/TEXT CONTRAST FAILURES.*instances\)/.test(bad.stdout), 'and the run reports the failure');
  check(/in 3 state\(s\)/.test(bad.stdout), 'and names all three states it occurs in, not just the one it used to visit');
  check(/7\/7 statuses/.test(bad.stdout), 'while still covering every quote status');

  // ---- positive: as shipped ----
  writeFileSync(cssPath, GOOD);
  const good = run();
  check(good.status === 0, `the shipped css exits 0 (got ${good.status})`);
  check(/PASS: .* 0 finding\(s\)/.test(good.stdout), 'and reports no findings');
} finally {
  writeFileSync(cssPath, GOOD);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} of 6 checks failed`);
process.exitCode = failures === 0 ? 0 : 1;
