import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  cleanSocialProfiles, cleanTestimonials, normalizeSocialProfile, resolveSocialProof,
} from '../src/social-proof.js'
import { SocialProof } from './social-proof.mjs'
import { createApi, isKnownApiPath, isPublicApiCall, readJsonBody } from './api.mjs'
import { createAuth, readAuthConfig } from './auth.mjs'

function fakeInventory(initial = null) {
  let value = initial
  return {
    getMeta() { return value },
    setMeta(key, next) { assert.equal(key, 'socialProof'); value = next },
  }
}

test('social profile URLs normalize to the approved host and trailing slash', () => {
  assert.deepEqual(normalizeSocialProfile({ platform: 'instagram', url: 'https://www.instagram.com/KMTBoston/?hl=en' }), {
    platform: 'instagram', url: 'https://instagram.com/kmtboston/', enabled: true,
  })
  assert.deepEqual(normalizeSocialProfile({ platform: 'youtube', url: 'https://www.youtube.com/@kmt' }).url, 'https://youtube.com/@kmt/')
  assert.deepEqual(normalizeSocialProfile({ platform: 'youtube', url: 'https://youtube.com/channel/abc' }).url, 'https://youtube.com/channel/abc/')
  assert.equal(normalizeSocialProfile({ platform: 'facebook', url: 'https://www.facebook.com/p/Kens-Mobile-Tire-61577670628260/' }).url, 'https://facebook.com/p/kens-mobile-tire-61577670628260/')
  assert.equal(normalizeSocialProfile({ platform: 'tiktok', url: 'https://www.tiktok.com/@ken_thetireguy' }).url, 'https://tiktok.com/@ken_thetireguy/')
})

test('social profile validation rejects invented or unsafe destinations', () => {
  for (const profile of [
    { platform: 'instagram', url: 'http://instagram.com/kmt' },
    { platform: 'instagram', url: 'https://instagram.com/p/abc' },
    { platform: 'instagram', url: 'https://instagram.com.example.test/kmt' },
    { platform: 'facebook', url: 'https://facebook.com/share/foo' },
    { platform: 'tiktok', url: 'https://tiktok.com/@kmt/video/1' },
    { platform: 'youtube', url: 'https://youtube.com/watch?v=abc' },
    { platform: 'linkedin', url: 'https://linkedin.com/posts/kmt' },
    { platform: 'x', url: 'https://x.com/kmt?utm_source=ads' },
    { platform: 'instagram', url: 'https://instagram.com/kmt?utm_source=ads' },
    { platform: 'facebook', url: 'https://facebook.com/p/kmt/abc' },
  ]) assert.throws(() => normalizeSocialProfile(profile))
})

test('profiles reject duplicate platforms and URLs', () => {
  assert.throws(() => cleanSocialProfiles([
    { platform: 'instagram', url: 'https://instagram.com/kmt' },
    { platform: 'instagram', url: 'https://instagram.com/other' },
  ]), /one profile per platform/)
  assert.throws(() => cleanSocialProfiles([
    { platform: 'facebook', url: 'https://facebook.com/kmt' },
    { platform: 'facebook', url: 'https://www.facebook.com/kmt' },
  ]), /one profile per platform/)
})

test('review records distinguish owner testimonials from source-linked reviews', () => {
  const [testimonial, review] = cleanTestimonials([
    { id: 'a', kind: 'testimonial', text: 'Great work', attribution: 'A customer', source: '', order: 2 },
    { id: 'b', kind: 'external-review', text: 'Excellent', attribution: 'B customer', source: 'Google Business Profile', sourceUrl: 'https://example.com/review/1', date: '2026-09-07', order: 1 },
  ])
  assert.equal(testimonial.kind, 'external-review')
  assert.equal(review.kind, 'testimonial')
  assert.throws(() => cleanTestimonials([{ id: 'x', kind: 'external-review', text: 'x', attribution: 'A', source: 'Google' }]), /source URL/)
  assert.throws(() => cleanTestimonials([{ id: 'x', kind: 'testimonial', text: 'x', attribution: 'A', date: '2026-02-31' }]), /YYYY-MM-DD/)
})

test('malformed or absent metadata resolves to no public claims', () => {
  assert.deepEqual(resolveSocialProof(null), { profiles: [], testimonials: [] })
  assert.deepEqual(resolveSocialProof({ profiles: [{ platform: 'instagram', url: 'not-a-url' }], testimonials: [] }), { profiles: [], testimonials: [] })
  assert.deepEqual(resolveSocialProof({ profiles: [], testimonials: [{ id: 'x', kind: 'testimonial', text: '', attribution: 'A' }] }), { profiles: [], testimonials: [] })
  assert.deepEqual(resolveSocialProof({ profiles: [{ platform: 'instagram', url: 'https://instagram.com/kmt', enabled: false }], testimonials: [{ id: 'x', kind: 'testimonial', text: 'x', attribution: 'A', visible: false }] }), { profiles: [], testimonials: [] })
})

test('owner store provides CRUD and one-step undo from the metadata table', () => {
  const inventory = fakeInventory()
  const store = new SocialProof(inventory)
  const created = store.create({ kind: 'testimonial', text: 'Helpful', attribution: 'A customer', order: 0 })
  assert.equal(created.testimonials.length, 1)
  const id = created.testimonials[0].id
  const edited = store.update(id, { kind: 'testimonial', text: 'Very helpful', attribution: 'A customer', visible: false, order: 0 })
  assert.equal(edited.testimonials[0].text, 'Very helpful')
  assert.equal(store.resolved().testimonials.length, 0)
  const removed = store.remove(id)
  assert.equal(removed.testimonials.length, 0)
  assert.equal(store.undo().testimonials.length, 1)
})

test('authenticated testimonial API rejects malformed writes with 400 and preserves metadata', async t => {
  let stored = null
  const inventory = { getMeta: () => stored, setMeta: (key, value) => { assert.equal(key, 'socialProof'); stored = value } }
  const auth = createAuth(readAuthConfig({ KMT_OWNER_PASSWORD: 'a-long-enough-password', KMT_SESSION_SECRET: 'social-proof-test' }))
  const api = createApi(inventory, null)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await auth.handle(request, response, url, readJsonBody)) return
    if (!isKnownApiPath(url.pathname)) { response.writeHead(404); response.end(); return }
    if (!isPublicApiCall(request.method, url.pathname) && !auth.isAuthenticated(request)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Sign in to use the owner workspace.' }))
      return
    }
    if (await api(request, response)) return
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(`${base}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-enough-password' }) })
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const get = () => fetch(`${base}/api/owner/social-proof`, { headers }).then(async response => ({ status: response.status, body: await response.json() }))
  assert.deepEqual((await get()).body.testimonials, [])

  const missingSource = await fetch(`${base}/api/owner/testimonials`, { method: 'POST', headers, body: JSON.stringify({ kind: 'external-review', text: 'External', attribution: 'Customer', source: 'Google' }) })
  assert.equal(missingSource.status, 400)
  assert.match((await missingSource.json()).error, /source URL/)
  assert.deepEqual((await get()).body.testimonials, [], 'rejected POST leaves metadata unchanged')

  const created = await fetch(`${base}/api/owner/testimonials`, { method: 'POST', headers, body: JSON.stringify({ kind: 'testimonial', text: 'Approved', attribution: 'Customer', source: 'Direct' }) })
  assert.equal(created.status, 201)
  const id = (await created.json()).testimonials[0].id
  const badUpdate = await fetch(`${base}/api/owner/testimonials/${id}`, { method: 'PUT', headers, body: JSON.stringify({ kind: 'testimonial', text: 'Changed', attribution: 'Customer', date: '2026-02-31' }) })
  assert.equal(badUpdate.status, 400)
  assert.match((await badUpdate.json()).error, /YYYY-MM-DD/)
  const after = await get()
  assert.equal(after.body.testimonials[0].text, 'Approved', 'rejected PUT leaves the saved review unchanged')
})
