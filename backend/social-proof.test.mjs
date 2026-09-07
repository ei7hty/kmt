import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanSocialProfiles, cleanTestimonials, normalizeSocialProfile, resolveSocialProof,
} from '../src/social-proof.js'
import { SocialProof } from './social-proof.mjs'

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
