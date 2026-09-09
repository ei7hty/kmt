import { isIP } from 'node:net'
import { assertAllowedImageUrl, sha256Bytes } from './image-assets.mjs'

export const IMAGE_EXECUTION_ENABLED = false
// This reviewed source is the trust anchor. No env var, CLI flag, JSON boolean,
// request field or caller-supplied digest can grant PROJECT MANAGER approval.
// PM must supply the exact profile, snapshot digest and five candidate IDs.
// A separate reviewed change must populate this registry AND enable execution.
const PM_APPROVALS = Object.freeze([])
export const IMAGE_PILOT_POLICY = Object.freeze({
  candidateLimit: 5, allowedPorts: Object.freeze([443]), maxBytes: 5 * 1024 * 1024,
  maxWidth: 10000, maxHeight: 10000, maxPixels: 16_000_000, maxFrames: 1,
  maxDecodeMs: 5000, memoryBytes: 256 * 1024 * 1024, maxRedirects: 3,
  timeoutMs: 30000, delayMs: 1500,
})
const reject = () => { throw new Error('Image provider profile or approval refused') }
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject()
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export function compileImageProviderProfile(input) {
  exactKeys(input, ['version', 'providerId', 'allowedHosts', 'policy'])
  if (input.version !== 1 || typeof input.providerId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.providerId) ||
      !Array.isArray(input.allowedHosts) || !input.allowedHosts.length || input.allowedHosts.length > 16) reject()
  if (input.allowedHosts.some(host => typeof host !== 'string')) reject()
  const hosts = [...input.allowedHosts].sort()
  if (new Set(hosts).size !== hosts.length) reject()
  for (const host of hosts) {
    if (isIP(host) || host.length > 253 || host.split('.').some(label => label.length > 63) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) reject()
    assertAllowedImageUrl(`https://${host}/`, hosts)
  }
  exactKeys(input.policy, Object.keys(IMAGE_PILOT_POLICY))
  // Pilot budgets are exact. A profile cannot silently relax them.
  for (const key of Object.keys(IMAGE_PILOT_POLICY)) {
    if (JSON.stringify(input.policy[key]) !== JSON.stringify(IMAGE_PILOT_POLICY[key])) reject()
  }
  const profile = { version: 1, providerId: input.providerId, allowedHosts: hosts, policy: { ...IMAGE_PILOT_POLICY, allowedPorts: [443] } }
  const digest = sha256Bytes(JSON.stringify(profile))
  return freeze({ ...profile, digest })
}

export function assertApprovedImagePlan(profile, snapshotDigest, candidateIds) {
  if (!/^[a-f0-9]{64}$/.test(snapshotDigest) || !Array.isArray(candidateIds) ||
      candidateIds.length !== 5 || new Set(candidateIds).size !== 5) reject()
  const approval = PM_APPROVALS.find(item => item.profileDigest === profile?.digest &&
    item.snapshotDigest === snapshotDigest && JSON.stringify(item.candidateIds) === JSON.stringify(candidateIds))
  if (!approval) throw new Error('Image execution blocked: exact PROJECT MANAGER approval is absent')
  return approval
}
