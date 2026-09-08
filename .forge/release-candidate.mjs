import { brotliCompressSync } from 'node:zlib';

// Candidate mode has no network authority beyond one numeric loopback origin.
export const MAX_CANDIDATE_BODY = 8 * 1024 * 1024;
export function transferBudget({ candidate = false, status, encoding, bytes, body }, budget) {
  const computed = candidate && encoding === 'identity';
  if (computed && (!Buffer.isBuffer(body) || body.length > MAX_CANDIDATE_BODY)) throw new Error('Candidate body exceeds bound or is absent');
  const measured = computed ? brotliCompressSync(body).length : bytes;
  return {
    ok: status === 200 && (computed || ['br', 'gzip'].includes(encoding)) && measured > 0 && measured <= budget,
    bytes: measured,
    label: computed ? 'candidate-computed Brotli payload' : 'compressed transfer',
  };
}
export function candidateConfig(env = process.env) {
  if (env.AUDIT_MODE && !['candidate', 'deployed'].includes(env.AUDIT_MODE)) throw new Error('Unknown AUDIT_MODE');
  if (!env.AUDIT_MODE && (env.AUDIT_EXPECTED_RELEASE || /127\.0\.0\.1|localhost|\[::1\]/.test(env.AUDIT_BASE || ''))) throw new Error('Local audits require explicit AUDIT_MODE=candidate');
  if (env.AUDIT_MODE !== 'candidate') return null;
  const base = new URL(env.AUDIT_BASE || '');
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Candidate AUDIT_BASE must be a numeric HTTP loopback origin');
  }
  if (!/^(?:[a-f0-9]{7}|[a-f0-9]{40})$/.test(env.AUDIT_EXPECTED_RELEASE || '')) throw new Error('Candidate requires AUDIT_EXPECTED_RELEASE (7 or 40 hex characters)');
  return { origin: base.origin, release: env.AUDIT_EXPECTED_RELEASE.slice(0, 7), violations: [] };
}

export function assertCandidateRequest(config, url, method = 'GET') {
  const target = new URL(url);
  if (target.origin !== config.origin || target.username || target.password || !['GET', 'HEAD', 'TRACE'].includes(method)) {
    throw new Error('Candidate blocked a nonlocal or mutating request');
  }
}

export async function candidateFetch(config, url, options = {}, fetcher = globalThis.fetch) {
  assertCandidateRequest(config, url, options.method || 'GET');
  const response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('Candidate refuses redirects');
  return response;
}

export async function guardCandidateContext(context, config) {
  // CSP may block an attempt before Playwright routing sees a request.
  await context.exposeBinding('__kmtCandidateViolation', () => config.violations.push('CSP violation'));
  await context.addInitScript(() => {
    globalThis.addEventListener('securitypolicyviolation', () => globalThis.__kmtCandidateViolation());
  });
  await context.route('**/*', async route => {
    try {
      assertCandidateRequest(config, route.request().url(), route.request().method());
      const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
      if ([301, 302, 303, 307, 308].includes(response.status())) {
        config.violations.push('browser redirect');
        console.log('BLOCK: candidate browser redirect');
        return route.abort('blockedbyclient');
      }
      return route.fulfill({ response });
    } catch {
      config.violations.push('forbidden or failed browser request');
      console.log(`BLOCK: candidate browser ${route.request().method()} outside the read-only local contract`);
      return route.abort('blockedbyclient');
    }
  });
  // Route interception does not cover WebSocket handshakes.
  await context.routeWebSocket('**/*', socket => {
    config.violations.push('WebSocket attempt');
    socket.close();
  });
}

export function assertCandidateClean(config) {
  if (config.violations.length) throw new Error(`Candidate attempted ${config.violations.length} forbidden/failed browser operations; blocked traffic is not a passing contract`);
}

export function candidateAsset(config, url, canonicalHost) {
  const target = new URL(url, config.origin);
  if (target.origin === config.origin) return target.href;
  if (target.origin !== `https://${canonicalHost}` || target.username || target.password) throw new Error('Asset does not name the canonical origin');
  return `${config.origin}${target.pathname}${target.search}`;
}
