import { isIP } from 'node:net'
import { assertAllowedImageUrl, sha256Bytes } from './image-assets.mjs'

// This module compiles and pins an image provider profile. It no longer decides
// whether a run may happen: the compiled-in execution switch and the PROJECT
// MANAGER approval registry that used to sit here are gone, on the owner's
// ruling that approval lives in the owner screen. The gate that remains is the
// one that matters to a customer -- the owner's approve/revoke decision on
// *publication*, in `image-publication.mjs`, with a staging trigger that makes
// staging structurally unable to approve anything it stores.
//
// What this module still refuses is a relaxed policy. The budgets below are
// exact and compiled in: no environment variable, CLI flag or profile field can
// widen them, and changing one changes the digest a run is recorded under.
// `candidateLimit` is the operational batch ceiling, and it is load on somebody
// else's server: at `delayMs` 1500 a run of 250 is about six minutes of
// one-at-a-time traffic against the supplier. It was 5 for the pilot batch.
// Raising it changes the profile digest, which is correct rather than awkward --
// the digest pins the policy a run was approved under, so a wider batch is a
// different policy and has to be approved as one.
export const IMAGE_PILOT_POLICY = Object.freeze({
  candidateLimit: 250, allowedPorts: Object.freeze([443]), allowedFormats: Object.freeze(['jpeg', 'png']), maxBytes: 5 * 1024 * 1024,
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
  const profile = { version: 1, providerId: input.providerId, allowedHosts: hosts, policy: { ...IMAGE_PILOT_POLICY, allowedPorts: [443], allowedFormats: ['jpeg', 'png'] } }
  const digest = sha256Bytes(JSON.stringify(profile))
  return freeze({ ...profile, digest })
}

// `assertApprovedImagePlan` lived here and is gone with the registry it read.
// Its one invariant that was never about approval -- a snapshot may not ask for
// more candidates than `candidateLimit` -- moved into the coordinator's
// `planFrom`, which is the only place a snapshot is parsed.
