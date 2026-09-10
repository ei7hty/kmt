import test from 'node:test'
import assert from 'node:assert/strict'
import * as profileModule from './image-provider-profile.mjs'
import { compileImageProviderProfile, IMAGE_PILOT_POLICY } from './image-provider-profile.mjs'

const profile = () => ({ version: 1, providerId: 'synthetic-fixture', allowedHosts: ['cdn.example.test'], policy: structuredClone(IMAGE_PILOT_POLICY) })
test('profile copies, canonicalizes and deeply freezes exact pilot policy', () => {
  const input = profile(), result = compileImageProviderProfile(input)
  input.allowedHosts[0] = 'changed.example.test'; input.policy.allowedPorts.push(80)
  assert.deepEqual(result.allowedHosts, ['cdn.example.test'])
  assert.deepEqual(result.policy.allowedFormats, ['jpeg', 'png'])
  assert.throws(() => result.policy.allowedFormats.push('gif'))
  assert.throws(() => result.policy.allowedPorts.push(80))
  assert.equal(result.digest, compileImageProviderProfile(profile()).digest)
})
test('profile refuses wildcards, IPs, credentials, localhost, ports and malformed hosts', () => {
  for (const host of ['*.example.test', '127.0.0.1', 'cdn.example.test:443', 'me@cdn.example.test', 'localhost', 'x.local', 'CDN.example.test', 'cdn.example.test.', '-x.example.test']) {
    assert.throws(() => compileImageProviderProfile({ ...profile(), allowedHosts: [host] }), host)
  }
})
test('profile refuses relaxed limits and injected approval fields', () => {
  for (const [key, value] of [['candidateLimit', 6], ['allowedFormats', ['gif', 'jpeg', 'png', 'webp']], ['allowedPorts', [443, 8443]], ['maxFrames', 2], ['delayMs', 0], ['memoryBytes', 1024 * 1024 * 1024]]) {
    const raw = profile(); raw.policy[key] = value; assert.throws(() => compileImageProviderProfile(raw))
  }
  assert.throws(() => compileImageProviderProfile({ ...profile(), approved: true }))
})
// This test used to assert `IMAGE_EXECUTION_ENABLED === false` and that no
// caller could satisfy the PROJECT MANAGER approval registry. Both are gone on
// the owner's ruling that approval lives in the owner screen, so what is left to
// hold is the part that was never about approval: this module compiles a policy
// and nothing in the environment can widen it. The approve/revoke gate that a
// customer actually depends on is `image-publication.mjs`, tested there.
test('the profile module carries no execution switch, and no environment relaxes the politeness budget', () => {
  assert.deepEqual(Object.keys(profileModule).sort(), ['IMAGE_PILOT_POLICY', 'compileImageProviderProfile'])
  process.env.KMT_IMAGE_EXECUTE = 'true'
  process.env.KMT_IMAGE_DELAY_MS = '0'
  process.env.KMT_IMAGE_CANDIDATE_LIMIT = '5000'
  try {
    const compiled = compileImageProviderProfile(profile())
    assert.equal(compiled.policy.delayMs, 1500)
    assert.equal(compiled.policy.candidateLimit, 250)
    assert.equal(compiled.digest, compileImageProviderProfile(profile()).digest)
  } finally {
    delete process.env.KMT_IMAGE_EXECUTE; delete process.env.KMT_IMAGE_DELAY_MS; delete process.env.KMT_IMAGE_CANDIDATE_LIMIT
  }
})
