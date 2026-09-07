/**
 * The words on the site that Ken can change, and the wording that ships.
 *
 * This module is the single definition, and it lives in `src/` for the same
 * reason `src/markup.js` does: the backend imports it rather than restating
 * it, so the server's idea of the default wording and the page's idea of it
 * cannot drift. A copy of these strings in the JSX and another in the backend
 * would agree on the day they were written and nowhere after that.
 *
 * **The stored value is only ever an override.** With nothing saved -- a fresh
 * database, a static build, the backend unreachable -- every field falls back
 * to the `default` below, which is the wording that shipped. That is forced
 * rather than chosen: R15 and R22 require the customer flow to keep working
 * with the backend down, and copy living only in the database would blank the
 * landing page's hero the moment the server was.
 *
 * It also gives per-field revert for free: remove an override and the shipped
 * wording returns, which is a better undo than any snapshot.
 *
 * **Copy editing changes words, never structure.** Every field is required and
 * non-empty. The service strip is always three items -- it is
 * `grid-template-columns: repeat(3, 1fr)`, so a fourth wraps to a second row
 * and a missing one leaves a hole. Adding or removing an element is a layout
 * change and belongs to the UI lane, not to a text box.
 *
 * The guards that enforce all of that, and the store behind them, are
 * `backend/site-copy.mjs`; this file holds only what both sides need.
 */

/**
 * Owner-editable strings, by stable key.
 *
 * `key` survives a rewording, exactly as `setPricingLines` keeps a line's id
 * stable across a rename: a reference that changes when the words change is
 * not a reference.
 *
 * `max` is sized to the field's job rather than to one global number. A
 * 500-character eyebrow is not a long eyebrow, it is a broken layout, and the
 * responsive check is the only instrument that would notice.
 *
 * `testId` is what the rendered element carries, so a check can assert the
 * element is present and non-empty without asserting Ken's words. It extends
 * the kebab-case vocabulary #375 established rather than minting a second one.
 */
export const SITE_COPY_FIELDS = [
  { key: 'hero.eyebrow', testId: 'copy-hero-eyebrow', max: 40, default: 'I COME TO YOU', label: 'Hero eyebrow' },
  { key: 'hero.headingTop', testId: 'copy-hero-heading-top', max: 40, default: 'Mobile Tire', label: 'Hero heading, first line' },
  { key: 'hero.headingAccent', testId: 'copy-hero-heading-accent', max: 40, default: 'Service', label: 'Hero heading, second line (red)' },
  { key: 'hero.lede1', testId: 'copy-hero-lede1', max: 90, default: 'Tires. Repairs. Roadside assistance.', label: 'Hero lede, first line' },
  { key: 'hero.lede2', testId: 'copy-hero-lede2', max: 90, default: 'You deal with me, start to finish.', label: 'Hero lede, second line' },
  { key: 'hero.visualLabel', testId: 'copy-hero-visual-label', max: 48, default: 'REAL MOBILE SERVICE / BOSTON', label: 'Hero logo caption' },

  { key: 'strip.1.title', testId: 'copy-strip-1-title', max: 32, default: 'I COME TO YOU', label: 'Service 1, title' },
  { key: 'strip.1.body', testId: 'copy-strip-1-body', max: 80, default: 'Home, work or roadside', label: 'Service 1, description' },
  { key: 'strip.2.title', testId: 'copy-strip-2-title', max: 32, default: 'PRICE UP FRONT', label: 'Service 2, title' },
  { key: 'strip.2.body', testId: 'copy-strip-2-body', max: 80, default: 'See the whole quote before I turn up', label: 'Service 2, description' },
  { key: 'strip.3.title', testId: 'copy-strip-3-title', max: 32, default: 'QUALITY SERVICE', label: 'Service 3, title' },
  { key: 'strip.3.body', testId: 'copy-strip-3-body', max: 80, default: 'Professional care every time', label: 'Service 3, description' },

  { key: 'order.eyebrow', testId: 'copy-order-eyebrow', max: 40, default: 'SHOP KMT', label: 'Order section eyebrow' },
  { key: 'order.heading', testId: 'copy-order-heading', max: 60, default: 'Order tires online', label: 'Order section heading' },
  { key: 'order.lede', testId: 'copy-order-lede', max: 160, default: "Find the right fit for your vehicle and I'll handle the rest.", label: 'Order section lede' },

  { key: 'footer.brand', testId: 'copy-footer-brand', max: 60, default: "KMT / KEN'S MOBILE TIRE", label: 'Footer brand line' },

  { key: 'inquiry.eyebrow', testId: 'copy-inquiry-eyebrow', max: 40, default: 'MORE THAN TIRES', label: 'Inquiry page eyebrow' },
  { key: 'inquiry.heading', testId: 'copy-inquiry-heading', max: 60, default: 'Tell me what you need', label: 'Inquiry page heading' },
  { key: 'inquiry.lede', testId: 'copy-inquiry-lede', max: 160, default: 'Flat repairs, roadside help and anything else that keeps you moving.', label: 'Inquiry page lede' },
  { key: 'inquiry.sentHeading', testId: 'copy-inquiry-sent-heading', max: 60, default: 'I got your message.', label: 'Inquiry sent, heading' },
  { key: 'inquiry.sentBody', testId: 'copy-inquiry-sent-body', max: 160, default: "I'll read it and text you back using the contact you left.", label: 'Inquiry sent, body' },

  { key: 'notFound.eyebrow', testId: 'copy-not-found-eyebrow', max: 40, default: 'NOT FOUND', label: '404 eyebrow' },
  { key: 'notFound.heading', testId: 'copy-not-found-heading', max: 60, default: "That page isn't here", label: '404 heading' },
  { key: 'notFound.body', testId: 'copy-not-found-body', max: 200, default: 'If you followed a link, it may be out of date. These are the pages that exist:', label: '404 body' },
]

/**
 * Where the server puts the resolved copy in the served HTML.
 *
 * A `type="application/json"` block, never an executable inline script: the
 * policy in `backend/site.mjs` is `script-src 'self'` with no
 * `'unsafe-inline'`, and `backend/site.test.mjs` asserts that it stays that
 * way. A JSON data block is not executed, so `script-src` does not apply to
 * it -- the same reason `index.html`'s existing `application/ld+json` block
 * has always coexisted with this policy.
 */
export const SITE_COPY_ELEMENT_ID = 'site-copy'

const FIELD_BY_KEY = new Map(SITE_COPY_FIELDS.map(field => [field.key, field]))

/** The wording that ships, as rendered with nothing saved. */
export function siteCopyDefaults() {
  return Object.fromEntries(SITE_COPY_FIELDS.map(field => [field.key, field.default]))
}

/**
 * The defaults with the owner's overrides on top: what a page renders.
 *
 * An unknown key in storage is ignored rather than thrown on. A key dropped
 * from the registry in a later release would otherwise make every read of an
 * old row fail, and a customer's landing page is not the place to discover a
 * migration -- the value has nowhere to render anyway.
 *
 * A blank or non-string override falls back to the default rather than
 * rendering nothing. The write guard refuses blanks, so this should be
 * unreachable; it is here because "should be unreachable" is not a rendering
 * strategy, and the failure it prevents is an empty hero.
 */
export function resolveSiteCopy(stored) {
  const values = stored && typeof stored === 'object'
    ? (stored.values && typeof stored.values === 'object' ? stored.values : stored)
    : null
  const resolved = siteCopyDefaults()
  if (!values) return resolved
  for (const field of SITE_COPY_FIELDS) {
    const value = values[field.key]
    if (typeof value === 'string' && value.trim()) resolved[field.key] = value
  }
  return resolved
}

/** Look one field up by key, defaulting to the shipped wording. */
export function copyField(copy, key) {
  const value = copy?.[key]
  if (typeof value === 'string' && value.trim()) return value
  return FIELD_BY_KEY.get(key)?.default ?? ''
}

/**
 * Read the copy the server injected, or fall back to the shipped wording.
 *
 * Never throws. Every failure here -- no element, malformed JSON, a document
 * that does not exist because this ran outside a browser -- resolves to the
 * defaults, because the alternative is a blank page on the one screen that
 * matters most. That is the same standing decision as the catalog fallback:
 * the backend improves the page, it is never a hard dependency of it.
 */
export function readInjectedCopy() {
  try {
    const element = globalThis.document?.getElementById(SITE_COPY_ELEMENT_ID)
    if (!element?.textContent) return siteCopyDefaults()
    return resolveSiteCopy(JSON.parse(element.textContent))
  } catch {
    return siteCopyDefaults()
  }
}
