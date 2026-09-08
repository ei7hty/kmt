import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { candidateConfig, candidateFetch, guardCandidateContext, assertCandidateClean } from './release-candidate.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('real browser and Node refuse external origin, writes and redirect egress', async () => {
  let externalHits = 0, writes = 0;
  const trap = http.createServer((_req, res) => { externalHits++; res.end('escaped'); });
  const external = await listen(trap);
  const local = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) writes++;
    if (req.url === '/redirect') { res.writeHead(302, { location: external }); res.end(); return; }
    if (req.url === '/csp') res.setHeader('Content-Security-Policy', "connect-src 'self'");
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Local guard fixture</title><main>Local contract</main>');
  });
  const origin = await listen(local);
  let browser;
  try {
    const config = candidateConfig({ AUDIT_MODE: 'candidate', AUDIT_BASE: origin, AUDIT_EXPECTED_RELEASE: 'abcdef0' });
    await assert.rejects(candidateFetch(config, `${origin}/redirect`), /redirect/);
    await assert.rejects(candidateFetch(config, external), /blocked/);
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await guardCandidateContext(context, config);
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(await page.locator('main').innerText(), 'Local contract');
    assert.doesNotThrow(() => assertCandidateClean(config));
    const outcomes = await page.evaluate(async externalOrigin => {
      return Promise.all([
        fetch(externalOrigin).then(() => 'escaped', () => 'blocked'),
        fetch('/redirect').then(() => 'escaped', () => 'blocked'),
        fetch('/write', { method: 'POST', body: 'forbidden' }).then(() => 'escaped', () => 'blocked'),
      ]);
    }, external);
    assert.deepEqual(outcomes, ['blocked', 'blocked', 'blocked']);
    await assert.rejects(page.goto(`${origin}/redirect`));
    const cspPage = await context.newPage();
    await cspPage.goto(`${origin}/csp`);
    await cspPage.evaluate(target => new Promise(resolve => {
      globalThis.addEventListener('securitypolicyviolation', () => resolve(true), { once: true });
      fetch(target).catch(() => {});
    }), external);
    assert.ok(config.violations.includes('CSP violation'));
    assert.equal(externalHits, 0);
    assert.equal(writes, 0);
    assert.throws(() => assertCandidateClean(config), /blocked traffic is not a passing contract/);
  } finally {
    if (browser) await browser.close();
    await close(local); await close(trap);
  }
});
