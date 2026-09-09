import test from 'node:test'
import assert from 'node:assert/strict'
import { compileImageProviderProfile, assertApprovedImagePlan, IMAGE_EXECUTION_ENABLED, IMAGE_PILOT_POLICY } from './image-provider-profile.mjs'

const profile = () => ({ version: 1, providerId: 'synthetic-fixture', allowedHosts: ['cdn.example.test'], policy: structuredClone(IMAGE_PILOT_POLICY) })
test('profile copies, canonicalizes and deeply freezes exact pilot policy', () => {
  const input = profile(), result = compileImageProviderProfile(input)
  input.allowedHosts[0] = 'changed.example.test'; input.policy.allowedPorts.push(80)
  assert.deepEqual(result.allowedHosts, ['cdn.example.test'])
  assert.throws(() => result.policy.allowedPorts.push(80))
  assert.equal(result.digest, compileImageProviderProfile(profile()).digest)
})
test('profile refuses wildcards, IPs, credentials, localhost, ports and malformed hosts', () => {
  for (const host of ['*.example.test', '127.0.0.1', 'cdn.example.test:443', 'me@cdn.example.test', 'localhost', 'x.local', 'CDN.example.test', 'cdn.example.test.', '-x.example.test']) {
    assert.throws(() => compileImageProviderProfile({ ...profile(), allowedHosts: [host] }), host)
  }
})
test('profile refuses relaxed limits and injected approval fields', () => {
  for (const [key, value] of [['candidateLimit', 6], ['allowedPorts', [443, 8443]], ['maxFrames', 2], ['delayMs', 0], ['memoryBytes', 1024 * 1024 * 1024]]) {
    const raw = profile(); raw.policy[key] = value; assert.throws(() => compileImageProviderProfile(raw))
  }
  assert.throws(() => compileImageProviderProfile({ ...profile(), approved: true }))
})
test('no caller, environment switch or matching digest grants PM approval', () => {
  const compiled = compileImageProviderProfile(profile())
  assert.equal(IMAGE_EXECUTION_ENABLED, false)
  process.env.KMT_IMAGE_EXECUTE = 'true'
  try { assert.throws(() => assertApprovedImagePlan({ ...compiled, approved: true }, 'a'.repeat(64), ['1', '2', '3', '4', '5']), /PROJECT MANAGER/) }
  finally { delete process.env.KMT_IMAGE_EXECUTE }
})
