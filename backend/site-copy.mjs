import { InputError } from './inventory.mjs'

/**
 * The site copy Ken can edit, and the guards that replace the review he is
 * losing by being able to edit it.
 *
 * Until now every word on the site arrived through a pull request -- an
 * author, a diff, a second reader and a gate -- not because anyone designed a
 * copy-review process but because there was no other way to change a string.
 * This module removes that chain, so it also has to replace it. The design and
 * the rulings behind it are `.forge/site-copy-inventory.md`.
 *
 * Two facts shape everything here.
 *
 * **The literals stay in the JSX and this is only ever an override.** An
 * absent key renders today's site byte for byte. That is forced rather than
 * chosen: R15 and R22 require the customer flow to keep working with the
 * backend unreachable, and copy living only in the database would blank the
 * landing page's hero the moment the server was. It also makes per-field
 * revert free -- delete an override and the shipped default returns -- which
 * is a stronger undo than the whole-object `previous` snapshot beside it.
 *
 * **Copy editing changes words, never structure.** Every field below is
 * required and non-empty, so the strip is always three items and the hero
 * always has a heading. Removing an element is a layout change and belongs to
 * the UI lane, not to a text box. This is also what lets the gate assert
 * "three items, each non-empty" honestly (GATE ENGINEER's question, answered
 * in the inventory document): the audit and this module enforce the same rule
 * from two sides, which is the point -- a guard that has only ever been
 * watched pass is unproven in the direction that matters.
 */

/**
 * Owner-editable strings, by stable key.
 *
 * `key` is stable across a rewording, exactly as `setPricingLines` keeps a
 * line's id stable across a rename: a reference that changes when the words
 * change is not a reference. `default` is the literal currently in the JSX and
 * must stay byte-identical to it -- if these drift, the site silently changes
 * wording on the deploy that wires a component up.
 *
 * `max` is sized to the field's job rather than to a single global number. A
 * 500-character eyebrow is not a long eyebrow, it is a broken layout, and the
 * responsive check is the only instrument that would notice.
 */
export const SITE_COPY_FIELDS = [
  { key: 'hero.eyebrow', max: 40, default: 'I COME TO YOU', label: 'Hero eyebrow' },
  { key: 'hero.headingTop', max: 40, default: 'Mobile Tire', label: 'Hero heading, first line' },
  { key: 'hero.headingAccent', max: 40, default: 'Service', label: 'Hero heading, second line (red)' },
  { key: 'hero.lede1', max: 90, default: 'Tires. Repairs. Roadside assistance.', label: 'Hero lede, first line' },
  { key: 'hero.lede2', max: 90, default: 'You deal with me, start to finish.', label: 'Hero lede, second line' },
  { key: 'hero.visualLabel', max: 48, default: 'REAL MOBILE SERVICE / BOSTON', label: 'Hero logo caption' },

  { key: 'strip.1.title', max: 32, default: 'I COME TO YOU', label: 'Service 1, title' },
  { key: 'strip.1.body', max: 80, default: 'Home, work or roadside', label: 'Service 1, description' },
  { key: 'strip.2.title', max: 32, default: 'PRICE UP FRONT', label: 'Service 2, title' },
  { key: 'strip.2.body', max: 80, default: 'See the whole quote before I turn up', label: 'Service 2, description' },
  { key: 'strip.3.title', max: 32, default: 'QUALITY SERVICE', label: 'Service 3, title' },
  { key: 'strip.3.body', max: 80, default: 'Professional care every time', label: 'Service 3, description' },

  { key: 'order.eyebrow', max: 40, default: 'SHOP KMT', label: 'Order section eyebrow' },
  { key: 'order.heading', max: 60, default: 'Order tires online', label: 'Order section heading' },
  { key: 'order.lede', max: 160, default: "Find the right fit for your vehicle and I'll handle the rest.", label: 'Order section lede' },

  { key: 'footer.brand', max: 60, default: "KMT / KEN'S MOBILE TIRE", label: 'Footer brand line' },

  { key: 'inquiry.eyebrow', max: 40, default: 'MORE THAN TIRES', label: 'Inquiry page eyebrow' },
  { key: 'inquiry.heading', max: 60, default: 'Tell me what you need', label: 'Inquiry page heading' },
  { key: 'inquiry.lede', max: 160, default: 'Flat repairs, roadside help and anything else that keeps you moving.', label: 'Inquiry page lede' },
  { key: 'inquiry.sentHeading', max: 60, default: 'I got your message.', label: 'Inquiry sent, heading' },
  { key: 'inquiry.sentBody', max: 160, default: "I'll read it and text you back using the contact you left.", label: 'Inquiry sent, body' },

  { key: 'notFound.eyebrow', max: 40, default: 'NOT FOUND', label: '404 eyebrow' },
  { key: 'notFound.heading', max: 60, default: "That page isn't here", label: '404 heading' },
  { key: 'notFound.body', max: 200, default: 'If you followed a link, it may be out of date. These are the pages that exist:', label: '404 body' },
]

const FIELD_BY_KEY = new Map(SITE_COPY_FIELDS.map(field => [field.key, field]))

/** The shipped wording, as rendered with nothing saved. */
export function siteCopyDefaults() {
  return Object.fromEntries(SITE_COPY_FIELDS.map(field => [field.key, field.default]))
}

/**
 * What a page should render: the defaults, with the owner's overrides on top.
 *
 * Unknown keys in storage are ignored rather than thrown on. A key removed
 * from the registry in a later release would otherwise make every read of an
 * old row fail -- the customer's landing page is not the place to discover a
 * migration, and the value has nowhere to render anyway.
 */
export function resolveSiteCopy(stored) {
  const values = stored && typeof stored === 'object' ? stored.values : null
  const resolved = siteCopyDefaults()
  if (!values || typeof values !== 'object') return resolved
  for (const field of SITE_COPY_FIELDS) {
    const value = values[field.key]
    if (typeof value === 'string' && value.trim()) resolved[field.key] = value
  }
  return resolved
}

/**
 * Validate what the owner screen sent.
 *
 * Deliberately the same shape as `cleanReason` and `cleanQuoteAdjustment` in
 * `quotes.mjs` rather than a new idiom: those are proven -- required/optional,
 * typed, trimmed, hard length cap, rejected rather than truncated -- and a
 * reviewer who knows one knows this.
 *
 * An unknown key is an error, not something to drop. Silently ignoring one
 * means the owner screen can send a field this module has never heard of and
 * be told it saved.
 */
export function cleanSiteCopy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('Send the copy as an object of key to text.')
  }
  const entries = Object.entries(input)
  if (entries.length > SITE_COPY_FIELDS.length) {
    throw new InputError('That is more copy fields than this site has.')
  }

  const values = {}
  for (const [key, raw] of entries) {
    const field = FIELD_BY_KEY.get(key)
    if (!field) throw new InputError(`There is no copy field called "${key}".`)
    if (typeof raw !== 'string') throw new InputError(`${field.label} must be text.`)
    const trimmed = raw.trim()
    // Non-empty on every field, because copy editing changes words and never
    // structure: an empty strip title is a hole in the layout, not a shorter
    // strip. Clearing a field back to the shipped wording is `reset`, which
    // removes the override instead of storing a blank.
    if (!trimmed) throw new InputError(`${field.label} cannot be empty. Use Reset to restore the original wording.`)
    if (trimmed.length > field.max) {
      throw new InputError(`${field.label} is too long: ${trimmed.length} characters, and the limit is ${field.max}.`)
    }
    values[key] = trimmed
  }
  return values
}

/**
 * Terms the booking form cannot honour, and the constraint that makes each one
 * false rather than merely bold.
 *
 * High precision on purpose. A check that false-alarms does not stay neutral --
 * it teaches the person reading it that the check lies, and the workaround
 * becomes reflex (`NOTES.md`, 2026-09-07). So this list holds only terms that a
 * seven-day booking floor makes untrue however they are phrased, and leaves out
 * every word that is merely energetic. Those are handled below, where they
 * actually cause harm.
 */
const HARD_CLAIMS = [
  { pattern: /\bsame[\s-]?day\b/i, term: 'same day' },
  { pattern: /\b24[\s/-]?7\b/i, term: '24/7' },
  { pattern: /\bemergenc(y|ies)\b/i, term: 'emergency' },
  { pattern: /\bright away\b/i, term: 'right away' },
  { pattern: /\bimmediate(ly)?\b/i, term: 'immediately' },
  { pattern: /\basap\b/i, term: 'ASAP' },
  { pattern: /\bwithin (the |an )?hour\b/i, term: 'within the hour' },
  { pattern: /\bon[\s-]?demand\b/i, term: 'on demand' },
  { pattern: /\bnext[\s-]day\b/i, term: 'next day' },
  { pattern: /\bovernight\b/i, term: 'overnight' },
]

/**
 * Words that are fine alone and are a promise together.
 *
 * This is the one the word list above cannot catch, and it is the failure that
 * actually happened here. No single line was wrong: *roadside assistance*,
 * *always on the move*, *I come to you*, *fast*, *quick response* -- each
 * defensible, stacked above a booking form with a seven-day floor, composing
 * into immediacy for anyone reading at a glance. It took two sessions a full
 * night to see it, and a per-field check could not have seen it at all,
 * because every field passed.
 *
 * So the composite is checked across the whole submission rather than per
 * field, and only fires at two or more. One energetic word is a voice; several
 * agreeing with each other is a claim.
 */
const SOFT_CLAIMS = [
  { pattern: /\bfast(est)?\b/i, term: 'fast' },
  { pattern: /\bquick(ly|est)?\b/i, term: 'quick' },
  { pattern: /\brapid(ly)?\b/i, term: 'rapid' },
  { pattern: /\binstant(ly)?\b/i, term: 'instant' },
  { pattern: /\bspeedy\b/i, term: 'speedy' },
  { pattern: /\bin minutes\b/i, term: 'in minutes' },
  { pattern: /\bany ?time\b/i, term: 'anytime' },
]

const LEAD_TIME_CONSTRAINT =
  'The booking form enforces a seven-day minimum (MIN_LEAD_DAYS in backend/quotes.mjs), so a customer who reads this and decides to buy meets a seven-day wall.'

const COMPOSITE_CONSTRAINT =
  'No single line here promises speed, but several together read as immediacy at a glance -- and the booking form still enforces a seven-day minimum.'

/**
 * What is wrong with this copy, and why -- never a refusal.
 *
 * Ruled by the OWNER AGENT: warn, explain, require an acknowledgement, never
 * silently block. A word list cannot tell "quick quote" (true) from "same-day
 * service" (false), so it must not try. Ken owns the business and may say what
 * he means; what he must not be able to do is promise something without
 * knowing the form will refuse it. A block gets resented and routed around; a
 * reason gets read.
 */
export function siteCopyConflicts(values) {
  const conflicts = []
  for (const [key, text] of Object.entries(values || {})) {
    const field = FIELD_BY_KEY.get(key)
    if (!field || typeof text !== 'string') continue
    for (const claim of HARD_CLAIMS) {
      if (claim.pattern.test(text)) {
        conflicts.push({ key, label: field.label, term: claim.term, constraint: LEAD_TIME_CONSTRAINT })
      }
    }
  }

  const softHits = []
  for (const claim of SOFT_CLAIMS) {
    const keys = Object.entries(values || {})
      .filter(([key, text]) => FIELD_BY_KEY.has(key) && typeof text === 'string' && claim.pattern.test(text))
      .map(([key]) => key)
    if (keys.length) softHits.push({ term: claim.term, keys })
  }
  // Two or more, across the whole submission. One is a voice; several agreeing
  // with each other is the composite that took a night to find.
  const composite = softHits.length >= 2
    ? { terms: softHits.map(hit => hit.term), keys: [...new Set(softHits.flatMap(hit => hit.keys))], constraint: COMPOSITE_CONSTRAINT }
    : null

  return { conflicts, composite }
}

/**
 * The store, over the `metadata` key/JSON table inventory already owns.
 *
 * No schema change, no `migrate()`, no CHECK to widen -- which matters more
 * than it looks: `NOTES.md` records that a schema change is the thing that
 * passes every test and both CI jobs and then fails on production's first
 * write, because `CREATE TABLE IF NOT EXISTS` is a no-op against an existing
 * table. This avoids that class rather than mitigating it.
 */
export const SITE_COPY_KEY = 'siteCopy'

export class SiteCopy {
  constructor(inventory) {
    this.inventory = inventory
  }

  /** Defaults with the owner's overrides on top: what a page renders. */
  resolved() {
    return resolveSiteCopy(this.inventory.getMeta(SITE_COPY_KEY))
  }

  /** The overrides alone, plus the one undo step, for the owner screen. */
  stored() {
    const row = this.inventory.getMeta(SITE_COPY_KEY)
    return {
      values: row?.values && typeof row.values === 'object' ? row.values : {},
      previous: row?.previous && typeof row.previous === 'object' ? row.previous : null,
      updatedAt: row?.updatedAt ?? null,
    }
  }

  /**
   * Save, keeping exactly one undo step.
   *
   * `previous` is the whole prior `values` object rather than a per-field
   * history, because "one-tap revert" means undoing the save that just went
   * wrong. Per-field revert already exists and is stronger: remove the
   * override and the shipped default returns.
   *
   * `acknowledged` carries the terms Ken was shown and accepted. It is checked
   * here rather than only in the owner screen: a warning enforced in the UI is
   * a warning any other client skips, and it could not be tested at the level
   * that matters.
   */
  save(input, { acknowledged = [] } = {}) {
    const values = cleanSiteCopy(input)
    const { conflicts, composite } = siteCopyConflicts(values)
    const accepted = new Set(Array.isArray(acknowledged) ? acknowledged : [])

    const unacknowledged = conflicts.filter(conflict => !accepted.has(conflict.term))
    if (unacknowledged.length || (composite && !accepted.has('composite'))) {
      const error = new InputError('This copy promises something the booking form will refuse. Confirm you mean it, or change the wording.')
      error.conflicts = unacknowledged
      error.composite = composite && !accepted.has('composite') ? composite : null
      throw error
    }

    const current = this.stored()
    this.inventory.setMeta(SITE_COPY_KEY, {
      values,
      previous: current.values,
      updatedAt: new Date().toISOString(),
    })
    return this.stored()
  }

  /** Put back what was there before the last save. One step, not a history. */
  undo() {
    const current = this.stored()
    if (!current.previous) throw new InputError('There is nothing to undo.')
    this.inventory.setMeta(SITE_COPY_KEY, {
      values: current.previous,
      previous: current.values,
      updatedAt: new Date().toISOString(),
    })
    return this.stored()
  }
}
