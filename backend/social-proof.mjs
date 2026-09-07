import { randomUUID } from 'node:crypto'
import { InputError } from './inventory.mjs'
import {
  SOCIAL_PROOF_KEY, cleanSocialProfiles, cleanTestimonials, normalizeTestimonial,
  resolveSocialProof,
} from '../src/social-proof.js'

const now = () => new Date().toISOString()

export class SocialProof {
  constructor(inventory) { this.inventory = inventory }

  stored() {
    const row = this.inventory.getMeta(SOCIAL_PROOF_KEY)
    let profiles = []
    let testimonials = []
    try { profiles = cleanSocialProfiles(row?.profiles || []) } catch { /* malformed legacy metadata fails closed */ }
    try { testimonials = cleanTestimonials(row?.testimonials || []) } catch { /* malformed legacy metadata fails closed */ }
    return {
      profiles,
      testimonials,
      previous: row?.previous && typeof row.previous === 'object' ? row.previous : null,
      updatedAt: row?.updatedAt || null,
    }
  }

  resolved() { return resolveSocialProof(this.stored()) }

  save(profiles, testimonials) {
    let cleanedProfiles
    let cleanedTestimonials
    try {
      cleanedProfiles = cleanSocialProfiles(profiles)
      cleanedTestimonials = cleanTestimonials(testimonials)
    } catch (error) { throw new InputError(error.message) }
    const current = this.stored()
    this.inventory.setMeta(SOCIAL_PROOF_KEY, {
      profiles: cleanedProfiles,
      testimonials: cleanedTestimonials,
      previous: { profiles: current.profiles, testimonials: current.testimonials },
      updatedAt: now(),
    })
    return this.stored()
  }

  setProfiles(profiles) { return this.save(profiles, this.stored().testimonials) }

  create(input) {
    const current = this.stored()
    let review
    try { review = normalizeTestimonial({ ...input, id: `review-${randomUUID()}` }) }
    catch (error) { throw new InputError(error.message) }
    return this.save(current.profiles, [...current.testimonials, review])
  }

  update(id, input) {
    const current = this.stored()
    if (!current.testimonials.some(review => review.id === id)) throw new InputError('No such review.', 404)
    let review
    try { review = normalizeTestimonial({ ...input, id }) }
    catch (error) { throw new InputError(error.message) }
    return this.save(current.profiles, current.testimonials.map(item => item.id === id ? review : item))
  }

  remove(id) {
    const current = this.stored()
    if (!current.testimonials.some(review => review.id === id)) throw new InputError('No such review.', 404)
    return this.save(current.profiles, current.testimonials.filter(item => item.id !== id))
  }

  undo() {
    const current = this.stored()
    if (!current.previous) throw new InputError('There is nothing to undo.')
    this.inventory.setMeta(SOCIAL_PROOF_KEY, {
      profiles: current.previous.profiles || [],
      testimonials: current.previous.testimonials || [],
      previous: { profiles: current.profiles, testimonials: current.testimonials },
      updatedAt: now(),
    })
    return this.stored()
  }
}
