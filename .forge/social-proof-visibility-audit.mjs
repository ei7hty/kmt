import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { signInIfAsked } from './audit-ui.mjs'

const base = process.env.AUDIT_BASE || 'http://127.0.0.1:4180'
const localBase = ['localhost', '127.0.0.1'].includes(new URL(base).hostname)
const ownerUrls = [
  { platform: 'instagram', url: 'https://www.instagram.com/kens_mobiletire/?hl=en', enabled: true },
  { platform: 'tiktok', url: 'https://www.tiktok.com/@ken_thetireguy', enabled: true },
  { platform: 'youtube', url: 'https://www.youtube.com/@kens_mobiletire', enabled: false },
  { platform: 'facebook', url: 'https://www.facebook.com/p/Kens-Mobile-Tire-61577670628260/', enabled: false },
]
const browser = await chromium.launch()
let checks = 0

function ok(message) {
  checks += 1
  console.log(`OK: ${message}`)
}

async function ownerCookie() {
  const minted = process.env.KMT_OWNER_SESSION_COOKIE || ''
  if (minted) return minted
  const password = process.env.KMT_OWNER_PASSWORD || ''
  if (!password) return ''
  const response = await fetch(`${base}/api/owner/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (response.status === 404) return ''
  assert.equal(response.status, 200, 'owner sign-in for social-proof audit')
  return response.headers.get('set-cookie')?.split(';')[0] || ''
}

const cookie = await ownerCookie()
const ownerFetch = (path, init = {}) => fetch(`${base}${path}`, {
  ...init,
  headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
})

let initial = null
let seeded = false
try {
  const stateResponse = await ownerFetch('/api/owner/social-proof')
  if (stateResponse.status === 200) {
    initial = await stateResponse.json()
  } else if (!localBase) {
    throw new Error(`Owner social-proof state was not readable (${stateResponse.status}); refusing to write against a non-local target.`)
  }

  if (initial && initial.testimonials?.length) {
    throw new Error('This regression requires the release state with zero testimonials; refusing to delete or rewrite owner-entered content.')
  }
  if (initial && !initial.profiles?.some(profile => profile.enabled)) {
    if (!localBase || !cookie) throw new Error('No enabled social profile is configured; refusing to seed a non-local target.')
    const response = await ownerFetch('/api/owner/social-profiles', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles: ownerUrls }),
    })
    assert.equal(response.status, 200, 'temporary local social profiles saved')
    seeded = true
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.getByTestId('hero-heading').waitFor()

  const publicState = await page.locator('#social-proof').textContent().then(text => JSON.parse(text))
  assert.equal(publicState.testimonials.length, 0, 'public state has no testimonials for this release regression')
  assert.ok(publicState.profiles.length > 0, 'public state has at least one enabled profile')
  ok('public HTML exposes enabled profiles without testimonials')

  // This audit intentionally stays on CustomerRequest: the owner-approved
  // marketing surface is the order page and its footer, not PrivacyFooter.
  const compact = page.locator('.customer-shell > .social-proof-compact')
  await compact.waitFor()
  assert.equal(await compact.getByRole('heading', { name: "Follow Ken's Mobile Tire" }).count(), 1)
  assert.equal(await compact.getByText('Real words from real customers').count(), 0)
  const compactLinks = compact.locator('.social-profile-links a')
  assert.equal(await compactLinks.count(), publicState.profiles.length)
  for (let index = 0; index < await compactLinks.count(); index += 1) assert.equal(await compactLinks.nth(index).isVisible(), true)
  ok('profile-only marketing state uses truthful follow copy and visible links')

  const orderTop = await page.locator('#order').boundingBox()
  const compactBottom = await compact.boundingBox()
  assert.ok(orderTop && compactBottom && compactBottom.y + compactBottom.height <= orderTop.y, 'compact links appear before the order form')
  ok('enabled profile links are discoverable before the customer starts the order form')

  const footer = page.locator('.customer-shell > .site-footer .social-proof-footer')
  await footer.waitFor()
  assert.equal(await footer.locator('a').count(), publicState.profiles.length)
  ok('footer repeats the compact profile links for a consistent marketing location')

  assert.deepEqual(errors, [], 'marketing page has no browser runtime errors')
  ok('marketing page has no browser runtime errors')
  await page.close()

  const ownerPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await ownerPage.goto(`${base}/owner/social-proof`, { waitUntil: 'networkidle' })
  await signInIfAsked(ownerPage)
  await ownerPage.locator('.social-proof-list').waitFor()
  for (const profile of (initial?.profiles?.some(item => item.enabled) ? initial.profiles : ownerUrls)) {
    const row = ownerPage.locator('.social-proof-list li').filter({ hasText: profile.platform })
    await row.waitFor()
    const label = profile.enabled ? 'Live on marketing pages' : 'Saved, not live — enable to publish'
    assert.equal(await row.getByText(label, { exact: true }).count(), 1, `owner state is explicit for ${profile.platform}`)
  }
  ok('owner profile rows distinguish live and saved-but-not-live states')
  await ownerPage.close()
} finally {
  if (seeded) {
    const restored = await ownerFetch('/api/owner/social-profiles', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles: initial.profiles || [] }),
    })
    assert.equal(restored.status, 200, 'temporary local social profiles restored')
  }
  await browser.close()
}

console.log(`PASS social-proof visibility audit (${checks} checks)`)
