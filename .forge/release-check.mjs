import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const schema = JSON.parse(readFileSync(new URL('./release-schema.json', import.meta.url), 'utf8'));
export const PROHIBITIONS = ['no-direct-deploy', 'no-secrets', 'no-production-data', 'no-provider-contact', 'no-self-merge'];

// Limited to keywords used in release-schema.json; no coercion, defaults,
// reference resolution, dependencies, network access or mutation.
export function validateShape(value, rule, path = '$', errors = []) {
  if ('const' in rule && value !== rule.const) errors.push(`${path}: wrong constant`);
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: unsupported value`);
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual) && !(types.includes('integer') && Number.isInteger(value))) {
      errors.push(`${path}: invalid type`);
      return errors;
    }
  }
  if (value === null) return errors;
  if (typeof value === 'string') {
    if (rule.minLength && value.trim().length < rule.minLength) errors.push(`${path}: empty text`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: invalid format`);
  }
  if (typeof value === 'number' && value < rule.minimum) errors.push(`${path}: below minimum`);
  if (Array.isArray(value)) {
    if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path}: duplicates`);
    value.forEach((item, i) => validateShape(item, rule.items, `${path}[${i}]`, errors));
  } else if (typeof value === 'object') {
    for (const key of rule.required || []) if (!(key in value)) errors.push(`${path}.${key}: missing`);
    for (const key of Object.keys(value)) {
      if (!rule.properties || !Object.hasOwn(rule.properties, key)) {
        if (rule.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
      } else validateShape(value[key], rule.properties[key], `${path}.${key}`, errors);
    }
  }
  return errors;
}

export function validateQueue(queue) {
  const errors = validateShape(queue, schema);
  if (errors.length) return errors;
  const seen = new Set();
  let merging = 0;
  for (const entry of queue.entries) {
    const add = message => errors.push(`#${entry.pr}: ${message}`);
    if (!PROHIBITIONS.every(rule => entry.prohibitions.includes(rule))) add('missing explicit prohibitions');
    if (seen.has(entry.pr) || seen.has(entry.branch)) add('duplicate PR or branch');
    seen.add(entry.pr); seen.add(entry.branch);
    if (entry.executorTask && [entry.authorTask, entry.coordinatorTask].includes(entry.executorTask)) add('executor must differ from author and coordinator');
    for (const key of ['authorization', 'review', 'verification']) {
      if (entry[key] && entry[key].head !== entry.head) add(`${key} is for a different head`);
    }
    if (entry.review?.reviewerTask === entry.authorTask) add('review must be independent');
    const active = ['ready', 'merging', 'deployed'].includes(entry.state);
    if (active && (!entry.authorization || entry.review?.verdict !== 'clean' || entry.verification?.result !== 'passed' || !entry.executorTask ||
        entry.blockers.length || !entry.boundaries.includes('merge-via-existing-ci'))) add('active release lacks authorization, review, verification, executor, scope or has blockers');
    if (entry.state === 'merging' && entry.ship) merging += 1;
    if (entry.state === 'deployed' && (!entry.ship || !entry.release)) add('deployed needs ship scope and observed release evidence');
    if (entry.state !== 'deployed' && entry.release !== null) add('release evidence belongs only to deployed');
    if (entry.state === 'waiting' && !entry.blockers.length) add('waiting needs a concrete blocker');
    for (const date of [entry.updatedAt, entry.authorization?.at, entry.review?.at, entry.verification?.at, entry.release?.at].filter(Boolean)) {
      if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().replace('.000Z', 'Z') !== date) add('invalid timestamp');
    }
  }
  if (merging > 1) errors.push('Only one ship-scoped merge may be in flight');
  return errors;
}

export function parseClaims(markdown) {
  return markdown.split(/\r?\n/).filter(line => /^\|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length === 4 && cells[0] !== 'branch' && !/^[- :]+$/.test(cells[0]))
    .map(([branch, agent, area, started]) => ({ branch: branch.replaceAll('`', ''), agent, area, started }));
}

export function checkConsistency(queue, claims, prs) {
  const errors = validateQueue(queue), warnings = [];
  if (errors.length) return { errors, warnings };
  const branches = new Set();
  for (const claim of claims) {
    if (branches.has(claim.branch)) errors.push(`Duplicate claim: ${claim.branch}`);
    branches.add(claim.branch);
    const matches = prs.filter(pr => pr.branch === claim.branch);
    if (matches.length && !matches.some(pr => pr.state === 'open')) errors.push(`Ended PR still claimed: ${claim.branch}`);
    if (!matches.length) warnings.push(`No PR found for claim (may be preparation or review): ${claim.branch}`);
  }
  for (const pr of prs.filter(pr => pr.state === 'open')) {
    if (!branches.has(pr.branch)) errors.push(`Open PR #${pr.number} missing claim on main: ${pr.branch}`);
  }
  for (const entry of queue.entries) {
    const pr = prs.find(pr => pr.number === entry.pr);
    if (!pr) { errors.push(`#${entry.pr}: PR absent from snapshot`); continue; }
    if (pr.branch !== entry.branch || pr.head !== entry.head) errors.push(`#${entry.pr}: branch/head differs from GitHub`);
    if (['waiting', 'ready', 'merging'].includes(entry.state) && pr.state !== 'open' && !(entry.state === 'merging' && pr.merged)) errors.push(`#${entry.pr}: queued PR has ended; reconcile ledger and release claim`);
    if (['closed', 'deployed'].includes(entry.state) && pr.state === 'open') errors.push(`#${entry.pr}: premature queue completion`);
    if (entry.state === 'deployed' && !pr.merged) errors.push(`#${entry.pr}: closed without merge cannot be deployed`);
    if (entry.ship && pr.merged && entry.state === 'closed') errors.push(`#${entry.pr}: merged shipping PR requires deployed state and release evidence`);
  }
  return { errors, warnings };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

export function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--github')) throw new Error('Usage: node .forge/release-check.mjs [--github]');
  const queue = JSON.parse(readFileSync(new URL('./release-queue.json', import.meta.url), 'utf8'));
  const errors = validateQueue(queue), warnings = [];
  if (args.includes('--github')) {
    // Fixed repository and GET endpoints. Read CURRENT main, never the feature
    // branch's copy of CLAIMS. Paginate all PRs to detect closed stale rows too.
    const content = JSON.parse(gh(['api', 'repos/ei7hty/kmt/contents/.forge/CLAIMS.md?ref=main']));
    const claims = parseClaims(Buffer.from(content.content, 'base64').toString('utf8'));
    const pages = JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/ei7hty/kmt/pulls?state=all&per_page=100']));
    const prs = pages.flat().map(pr => ({ number: pr.number, branch: pr.head.ref, head: pr.head.sha, state: pr.state, merged: Boolean(pr.merged_at) }));
    if (!errors.length) {
      const result = checkConsistency(queue, claims, prs);
      errors.push(...result.errors); warnings.push(...result.warnings);
    }
    console.log(`Observed ${new Date().toISOString()}: main claims blob ${content.sha}, ${claims.length} claims, ${prs.length} PRs. Snapshot is not a lock.`);
  }
  warnings.forEach(message => console.log(`WARN: ${message}`));
  errors.forEach(message => console.error(`FAIL: ${message}`));
  console.log(`${queue.entries?.length ?? 0} queue entries; ${errors.length} errors; ${warnings.length} warnings. Read-only; no action authorized or executed.`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}
