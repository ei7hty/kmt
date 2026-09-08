import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateQueue, parseClaims, checkConsistency, PROHIBITIONS } from './release-check.mjs';
import { candidateConfig, candidateFetch, candidateAsset, transferBudget, MAX_CANDIDATE_BODY, assertCandidateRequest } from './release-candidate.mjs';

const sha = 'a'.repeat(40);
const task = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const at = '2026-09-08T09:00:00Z';
function ready() {
  return { version: 1, entries: [{ pr: 900, branch: 'codex/example', head: sha, authorTask: task(1), coordinatorTask: task(2), executorTask: task(3), state: 'ready', ship: true, updatedAt: at,
    authorization: { source: 'owner message permalink', owner: 'owner', head: sha, action: 'merge', at },
    review: { source: 'review permalink', reviewerTask: task(4), head: sha, verdict: 'clean', at },
    verification: { source: 'gate run permalink', head: sha, base: 'b'.repeat(40), result: 'passed', at },
    boundaries: ['merge-via-existing-ci'], prohibitions: [...PROHIBITIONS], blockers: [], release: null }] };
}

test('empty bootstrap and complete readiness are valid; validator never mutates', () => {
  assert.deepEqual(validateQueue({ version: 1, entries: [] }), []);
  const queue = ready(), before = structuredClone(queue);
  assert.deepEqual(validateQueue(queue), []);
  assert.deepEqual(queue, before);
});

for (const [name, change, expected] of [
  ['same PM routing', e => { e.executorTask = e.coordinatorTask; }, /executor/],
  ['self merge', e => { e.executorTask = e.authorTask; }, /executor/],
  ['self review', e => { e.review.reviewerTask = e.authorTask; }, /independent/],
  ['negative review', e => { e.review.verdict = 'changes-requested'; }, /lacks/],
  ['failed gate', e => { e.verification.result = 'failed'; }, /lacks/],
  ['missing owner authorization', e => { e.authorization = null; }, /lacks/],
  ['stale review', e => { e.review.head = 'c'.repeat(40); }, /different head/],
  ['stale authorization', e => { e.authorization.head = 'c'.repeat(40); }, /different head/],
  ['stale gate', e => { e.verification.head = 'c'.repeat(40); }, /different head/],
  ['broader external scope', e => { e.boundaries.push('provider-contact'); }, /unsupported/],
  ['missing prohibitions', e => { e.prohibitions.pop(); }, /prohibitions/],
  ['unexplained waiting', e => { e.state = 'waiting'; }, /blocker/],
  ['missing release evidence', e => { e.state = 'deployed'; }, /observed/],
  ['unknown field', e => { e.autoMerge = true; }, /unknown/],
  ['prototype-named unknown field', e => { e.constructor = 'unknown'; }, /unknown/],
  ['invalid date', e => { e.updatedAt = '2026-02-31T00:00:00Z'; }, /timestamp/],
]) test(name, () => { const queue = ready(); change(queue.entries[0]); assert.match(validateQueue(queue).join(';'), expected); });

test('only ship merges serialize; duplicate branch or PR is rejected', () => {
  const queue = ready();
  queue.entries[0].state = 'merging';
  const second = structuredClone(queue.entries[0]);
  second.pr++; second.branch += '-second'; queue.entries.push(second);
  assert.match(validateQueue(queue).join(';'), /one ship/);
  second.ship = false;
  assert.deepEqual(validateQueue(queue), []);
  second.branch = queue.entries[0].branch;
  assert.match(validateQueue(queue).join(';'), /duplicate/);
});

const row = branch => `| ${branch} | agent | scoped region | 2026-09-08 |`;
test('claims use branch identity; missing, duplicate and ended rows are errors', () => {
  const claims = parseClaims(['| branch | agent | files / area | started |', '| --- | --- | --- | --- |', row('codex/closed'), row('codex/closed'), row('codex/review')].join('\r\n'));
  const prs = [{ number: 1, branch: 'codex/closed', state: 'closed' }, { number: 2, branch: 'codex/open', state: 'open' }];
  const report = checkConsistency({ entries: [] }, claims, prs);
  assert.equal(claims.length, 3);
  assert.match(report.errors.join(';'), /Duplicate claim/);
  assert.match(report.errors.join(';'), /Ended PR still claimed/);
  assert.match(report.errors.join(';'), /missing claim on main/);
  assert.equal(report.warnings.length, 1); // preparatory/review claim is not a stale lock
});

test('GitHub head drift, premature claim/queue release, and ended queue are detected', () => {
  const queue = ready(), entry = queue.entries[0];
  const pr = { number: entry.pr, branch: entry.branch, head: sha, state: 'open' };
  const claims = parseClaims(row(entry.branch));
  assert.deepEqual(checkConsistency(queue, claims, [pr]).errors, []);
  pr.head = 'c'.repeat(40);
  assert.match(checkConsistency(queue, claims, [pr]).errors.join(';'), /differs/);
  pr.head = sha; pr.state = 'closed';
  assert.match(checkConsistency(queue, claims, [pr]).errors.join(';'), /queued PR has ended/);
  entry.state = 'deployed';
  assert.match(checkConsistency(queue, [], [pr]).errors.join(';'), /without merge/);
  pr.state = 'open';
  assert.match(checkConsistency(queue, [], [pr]).errors.join(';'), /premature/);
  entry.state = 'closed'; pr.state = 'closed'; pr.merged = true;
  assert.match(checkConsistency(queue, [], [pr]).errors.join(';'), /merged shipping PR requires/);
  entry.state = 'merging';
  assert.deepEqual(validateQueue(queue), []);
  assert.deepEqual(checkConsistency(queue, [], [pr]).errors, []); // deploy still in flight
  entry.state = 'closed';
  pr.merged = false;
  assert.deepEqual(checkConsistency(queue, [], [pr]).errors, []); // cancelled before shipping
});

test('candidate configuration rejects remote/ambiguous targets and missing identity', () => {
  for (const base of ['', 'https://kensmobiletire.com', 'http://localhost:4173', 'http://127.0.0.1:4173/path', 'http://user@127.0.0.1:4173']) {
    assert.throws(() => candidateConfig({ AUDIT_MODE: 'candidate', AUDIT_BASE: base, AUDIT_EXPECTED_RELEASE: sha }));
  }
  assert.throws(() => candidateConfig({ AUDIT_MODE: 'oops' }));
  assert.throws(() => candidateConfig({ AUDIT_MODE: 'deployed', AUDIT_BASE: 'http://127.0.0.1:4173', AUDIT_EXPECTED_RELEASE: 'abcdef0' }));
  assert.throws(() => candidateConfig({ AUDIT_BASE: 'http://127.0.0.1:4173' }));
  assert.throws(() => candidateConfig({ AUDIT_BASE: 'http://0x7f000001:4173' }));
  assert.throws(() => candidateConfig({ AUDIT_MODE: 'candidate', AUDIT_BASE: 'http://127.0.0.1:4173' }));
  assert.equal(candidateConfig({}), null);
});

test('candidate request guard refuses writes, other ports, and remote redirects before following', async () => {
  const config = candidateConfig({ AUDIT_MODE: 'candidate', AUDIT_BASE: 'http://127.0.0.1:4173', AUDIT_EXPECTED_RELEASE: sha });
  assert.throws(() => assertCandidateRequest(config, config.origin, 'POST'));
  assert.throws(() => assertCandidateRequest(config, 'http://127.0.0.1:9999'));
  assert.throws(() => assertCandidateRequest(config, 'https://kensmobiletire.com'));
  let calls = 0;
  await assert.rejects(candidateFetch(config, config.origin, {}, async (_url, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://kensmobiletire.com' } });
  }), /refuses redirects/);
  assert.equal(calls, 1);
  assert.equal(candidateAsset(config, 'https://kensmobiletire.com/brand/logo.png', 'kensmobiletire.com'), `${config.origin}/brand/logo.png`);
  assert.throws(() => candidateAsset(config, 'https://example.com/logo.png', 'kensmobiletire.com'));
  assert.equal(config.release, sha.slice(0, 7));
  const cached = await candidateFetch(config, config.origin, {}, async () => new Response(null, { status: 304 }));
  assert.equal(cached.status, 304);
});

test('checked-in schema uses only supported validation keywords', () => {
  const schema = JSON.parse(readFileSync(new URL('./release-schema.json', import.meta.url), 'utf8'));
  const keywords = new Set(['$schema', 'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minLength', 'minimum', 'uniqueItems']);
  function visit(rule) {
    for (const key of Object.keys(rule)) assert.ok(keywords.has(key), `unsupported schema keyword ${key}`);
    Object.values(rule.properties || {}).forEach(visit);
    if (rule.items) visit(rule.items);
  }
  visit(schema);
});

test('candidate compression budget preserves live wire contract and rejects unknown encoding', () => {
  const response = { status: 200, encoding: 'identity', bytes: 10000, body: Buffer.alloc(10000, 'a') };
  assert.equal(transferBudget({ ...response, candidate: true }, 1024).ok, true);
  assert.match(transferBudget({ ...response, candidate: true }, 1024).label, /candidate-computed Brotli/);
  assert.equal(transferBudget(response, 20000).ok, false); // live identity never passes
  assert.equal(transferBudget({ ...response, candidate: true, body: randomBytes(10000) }, 1024).ok, false);
  for (const encoding of ['zstd', 'br, gzip', 'BR', '']) {
    assert.equal(transferBudget({ ...response, candidate: true, encoding }, 20000).ok, false);
  }
  assert.equal(transferBudget({ ...response, candidate: true, encoding: 'br' }, 1024).ok, false); // actual wire size wins
  assert.equal(transferBudget({ ...response, candidate: true, encoding: 'gzip' }, 20000).bytes, 10000);
  assert.throws(() => transferBudget({ ...response, candidate: true, body: Buffer.alloc(MAX_CANDIDATE_BODY + 1) }, 1024), /bound/);
});

test('workflow gates metadata and candidate before mutation; queue updates cannot evict deployment', () => {
  const workflow = readFileSync(new URL('../.github/workflows/fly-deploy.yml', import.meta.url), 'utf8');
  const ignored = workflow.split('paths-ignore:')[1].split('pull_request:')[0];
  assert.ok(ignored.includes("- '.forge/release-queue.json'"));
  assert.ok(!ignored.includes('.forge/*.json'));
  assert.ok(!ignored.includes('release-check.mjs'));
  const checkJob = workflow.split('\n  check:')[1].split('\n  image:')[0];
  assert.ok(checkJob.includes('node .forge/release-check.mjs'));
  assert.ok(checkJob.includes('node --test .forge/release-check.test.mjs'));
  assert.ok(checkJob.includes('node --test .forge/release-browser.test.mjs'));
  assert.ok(checkJob.includes('KMT_RELEASE="${GITHUB_SHA::7}"'));
  const candidate = checkJob.indexOf('AUDIT_MODE=candidate AUDIT_EXPECTED_RELEASE="${GITHUB_SHA::7}"');
  assert.ok(candidate > 0 && candidate < checkJob.indexOf('node .forge/dead-end-audit.mjs'));
  assert.ok(!checkJob.includes('--github'));
});
