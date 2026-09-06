/**
 * Positive and negative control for the two head checks added to
 * deployed-site-check.mjs.
 *
 * Not part of the gate and counted in no baseline: this is the "prove a check
 * can fail before trusting that it can pass" step from NOTES.md, kept as a
 * file so the next person can rerun it rather than take the claim on trust.
 * It boots the real backend/server.mjs over a built dist/ the way the CI gate
 * does, swaps dist/index.html for a deliberately broken copy, and reads back
 * the lines the real script prints -- so the code under test is the code that
 * ships, not a paraphrase of it.
 *
 *   npm run build && node .forge/head-check-control.mjs
 *
 * It rewrites dist/index.html as it goes and restores it at the end, including
 * on a crash. dist/ is git-ignored and rebuilt by every run, so the blast
 * radius is a rebuild.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');
const GOOD = readFileSync(DIST_INDEX, 'utf8');

/** A port the OS says is free. Every fixed audit port here is occupied often enough that picking one is a coin toss. */
function freePort() {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const cases = [
  ['as built', GOOD, { description: true, jsonld: true }],
  ['description emptied', GOOD.replace(/(<meta name="description" content=")[^"]*/, '$1'), { description: false, jsonld: true }],
  ['description tag removed', GOOD.replace(/<meta name="description"[^>]*>/, ''), { description: false, jsonld: true }],
  ['JSON-LD given a trailing comma', GOOD.replace('"telephone"', '"x": 1,,"telephone"'), { description: true, jsonld: false }],
  // Keyed on "url": deliberately. The bare URL string appears six times in the
  // built file and a plain replace rewrote og:url instead, so this case passed
  // while proving nothing -- a control that was itself broken, which is the
  // failure this whole file exists to catch one level down.
  ['JSON-LD url pointed at another host', GOOD.replace('"url": "https://kensmobiletire.com/"', '"url": "https://example.com/"'), { description: true, jsonld: false }],
  ['JSON-LD @type changed to Person', GOOD.replace('"@type":"AutoRepair"', '"@type":"Person"').replace('"@type": "AutoRepair"', '"@type": "Person"'), { description: true, jsonld: false }],
];

function startServer(port, dbdir) {
  const child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      KMT_BIND: '127.0.0.1',
      KMT_OWNER_DB: path.join(dbdir, 'control.sqlite'),
      KMT_OWNER_PASSWORD: 'control-only-password-not-a-secret',
      KMT_SESSION_SECRET: 'control-only-session-secret',
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitUntilUp(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function runCheck(port) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['.forge/deployed-site-check.mjs'], {
      cwd: ROOT,
      // The real canonical host, not the loopback one this is served from: the
      // JSON-LD's url is absolute and names kensmobiletire.com wherever the
      // page is being served, which is the point of asserting on it. Setting
      // this to 127.0.0.1 to make the redirect checks happy would make the
      // check under test fail on a correct page -- which it did, on the first
      // run of this control.
      env: { ...process.env, AUDIT_BASE: `http://127.0.0.1:${port}`, CANONICAL_HOST: 'kensmobiletire.com' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', () => resolve(out));
  });
}

const verdict = (out, needle) => {
  const line = out.split('\n').find(l => l.includes(needle));
  if (!line) return 'NOT RUN';
  return line.trim().startsWith('OK') ? 'pass' : 'fail';
};

const dbdir = mkdtempSync(path.join(tmpdir(), 'kmt-head-control-'));
let wrong = 0;

try {
  console.log('case                                      description   JSON-LD');
  for (const [name, html, expect] of cases) {
    writeFileSync(DIST_INDEX, html);
    const port = await freePort();
    const server = startServer(port, dbdir);
    try {
      if (!await waitUntilUp(port)) {
        console.log(`${name.padEnd(41)} server did not start`);
        wrong += 1;
        continue;
      }
      const out = await runCheck(port);
      const d = verdict(out, 'serves a non-empty meta description');
      const j = verdict(out, 'JSON-LD block parses and describes');
      const dOk = d === (expect.description ? 'pass' : 'fail');
      const jOk = j === (expect.jsonld ? 'pass' : 'fail');
      if (!dOk || !jOk) wrong += 1;
      console.log(`${name.padEnd(41)} ${d.padEnd(13)} ${j}${dOk && jOk ? '' : '   <-- UNEXPECTED'}`);
    } finally {
      server.kill();
    }
  }
} finally {
  writeFileSync(DIST_INDEX, GOOD);
  // Windows holds the SQLite file open a moment after the child dies, so a
  // failed cleanup of a temp directory must not lose the results above it.
  try {
    rmSync(dbdir, { recursive: true, force: true });
  } catch {
    console.log(`(left ${dbdir} behind: still locked)`);
  }
}

console.log(wrong === 0
  ? '\nBoth checks pass on a correct page and fail on every break above. dist/index.html restored.'
  : `\n${wrong} case(s) did not behave as expected. dist/index.html restored.`);
process.exitCode = wrong === 0 ? 0 : 1;
