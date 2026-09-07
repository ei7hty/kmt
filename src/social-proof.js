/**
 * Verified social profiles and owner-entered social proof.
 *
 * This is deliberately separate from editable site copy. Profiles are
 * structured identity facts and testimonials/reviews are claims that must be
 * supplied by the owner; an empty or malformed value is safe to publish.
 */

export const SOCIAL_PROOF_KEY = 'socialProof'
export const SOCIAL_PROOF_ELEMENT_ID = 'social-proof'

export const SOCIAL_PLATFORMS = {
  facebook: { label: 'Facebook', hosts: ['facebook.com', 'www.facebook.com'] },
  instagram: { label: 'Instagram', hosts: ['instagram.com', 'www.instagram.com'] },
  tiktok: { label: 'TikTok', hosts: ['tiktok.com', 'www.tiktok.com'] },
  youtube: { label: 'YouTube', hosts: ['youtube.com', 'www.youtube.com'] },
  x: { label: 'X', hosts: ['x.com', 'www.x.com'] },
  linkedin: { label: 'LinkedIn', hosts: ['linkedin.com', 'www.linkedin.com'] },
}

const PLATFORM_KEYS = new Set(Object.keys(SOCIAL_PLATFORMS))
function cleanText(value, label, max, required = true) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return ''
    throw new Error(`${label} must be text.`)
  }
  const text = value.trim()
  if (required && !text) throw new Error(`${label} cannot be empty.`)
  if (text.length > max) throw new Error(`${label} is too long.`)
  return text
}

function profilePath(platform, pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (platform === 'facebook') {
    if (parts.length !== 1 || ['share', 'watch', 'groups', 'events', 'marketplace'].includes(parts[0].toLowerCase())) return false
  } else if (platform === 'instagram') {
    if (parts.length !== 1 || ['p', 'reel', 'stories', 'explore'].includes(parts[0].toLowerCase())) return false
  } else if (platform === 'tiktok') {
    if (parts.length !== 1 || !parts[0].startsWith('@') || parts[0].length < 2) return false
  } else if (platform === 'youtube') {
    if ((parts.length === 1 && !parts[0].startsWith('@')) || (parts.length === 2 && !['channel', 'c', 'user'].includes(parts[0])) || ![1, 2].includes(parts.length)) return false
  } else if (platform === 'x') {
    if (parts.length !== 1 || ['i', 'home', 'search', 'hashtag', 'status'].includes(parts[0].toLowerCase())) return false
  } else if (platform === 'linkedin') {
    if (parts.length !== 2 || !['company', 'in'].includes(parts[0])) return false
  }
  return true
}

/** Canonicalize one owner-supplied profile URL, or throw at the trust boundary. */
export function normalizeSocialProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each social profile must be an object.')
  const platform = typeof input.platform === 'string' ? input.platform.trim().toLowerCase() : ''
  if (!PLATFORM_KEYS.has(platform)) throw new Error('Choose a supported social platform.')
  let url
  try { url = new URL(input.url) } catch { throw new Error('Social profile URL must be a complete HTTPS URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !SOCIAL_PLATFORMS[platform].hosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`That is not a valid ${SOCIAL_PLATFORMS[platform].label} profile URL.`)
  }
  if (!profilePath(platform, url.pathname)) throw new Error(`That URL is not a ${SOCIAL_PLATFORMS[platform].label} profile or channel.`)
  const parts = url.pathname.split('/').filter(Boolean)
  url.hostname = SOCIAL_PLATFORMS[platform].hosts[0]
  url.pathname = `/${parts.join('/')}/`
  return { platform, url: url.toString(), enabled: input.enabled !== false }
}

export function cleanSocialProfiles(input) {
  if (!Array.isArray(input)) throw new Error('Social profiles must be an array.')
  const profiles = input.map(normalizeSocialProfile)
  const platforms = new Set()
  const urls = new Set()
  for (const profile of profiles) {
    if (platforms.has(profile.platform)) throw new Error('Only one profile per platform can be saved.')
    if (urls.has(profile.url)) throw new Error('The same social profile cannot be saved twice.')
    platforms.add(profile.platform)
    urls.add(profile.url)
  }
  return profiles
}

export function normalizeTestimonial(input, { id = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Each review must be an object.')
  const kind = input.kind === 'external-review' ? 'external-review' : input.kind === 'testimonial' ? 'testimonial' : ''
  if (!kind) throw new Error('Choose testimonial or external review.')
  const text = cleanText(input.text, 'Review text', 800)
  const attribution = cleanText(input.attribution, 'Attribution', 120)
  const source = cleanText(input.source, 'Source', 100, kind === 'external-review')
  const sourceUrl = cleanSourceUrl(input.sourceUrl)
  if (kind === 'external-review' && !sourceUrl) throw new Error('An external review needs its source URL.')
  let date = input.date || null
  if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) throw new Error('Date must be YYYY-MM-DD.')
  const order = Number.isInteger(input.order) && input.order >= 0 ? input.order : 0
  return { id: id || cleanText(input.id, 'Review id', 80), kind, text, attribution, source, sourceUrl, date, visible: input.visible !== false, order }
}

function cleanSourceUrl(value) {
  if (value === undefined || value === null || value === '') return ''
  let url
  try { url = new URL(value) } catch { throw new Error('Review source URL must be a complete HTTPS URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Review source URL must be a plain HTTPS link.')
  return url.toString()
}

export function cleanTestimonials(input) {
  if (!Array.isArray(input)) throw new Error('Reviews must be an array.')
  const ids = new Set()
  const reviews = input.map(review => normalizeTestimonial(review))
  for (const review of reviews) {
    if (ids.has(review.id)) throw new Error('Review ids must be unique.')
    ids.add(review.id)
  }
  return reviews.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Fail closed for old, partial, or malformed metadata. */
export function resolveSocialProof(stored) {
  try {
    const profiles = cleanSocialProfiles(stored?.profiles || []).filter(profile => profile.enabled)
    const testimonials = cleanTestimonials(stored?.testimonials || []).filter(review => review.visible)
    return { profiles, testimonials }
  } catch {
    return { profiles: [], testimonials: [] }
  }
}

export function platformLabel(platform) {
  return SOCIAL_PLATFORMS[platform]?.label || ''
}

let injected = null

/** Read only the server-resolved, public subset embedded in the marketing shell. */
export function socialProof() {
  if (!injected) {
    try {
      const element = globalThis.document?.getElementById(SOCIAL_PROOF_ELEMENT_ID)
      const value = element?.textContent ? JSON.parse(element.textContent) : null
      injected = resolveSocialProof(value)
    } catch { injected = { profiles: [], testimonials: [] } }
  }
  return injected
}
