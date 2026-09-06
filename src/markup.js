/**
 * How a supplier's price becomes the price a customer is quoted.
 *
 * Two things decide that, in order:
 *
 *   1. The owner's price for that specific tire, if he has set one. It wins
 *      outright. This is what the owner backend stores in `offers.price_cents`.
 *   2. Otherwise a markup rule applied to the supplier's price, which proposes
 *      a number so a tire nobody has touched still has a price.
 *
 * Markup proposes, the owner disposes. The rule exists because there are 910
 * sizes -- src/data/catalog.js's own count, measured by counting
 * TIRE_CATALOG, not restated by hand here -- and pricing each tire
 * individually is not a thing anyone will finish; the override exists
 * because a rule will always be wrong about some tire. This number moves
 * every time the fitment bands change; re-measure rather than copy the last
 * one written down (#72 -- this sentence read 290 for a catalogue that had
 * already grown past 900).
 *
 * Nothing here reaches out for its own settings. Callers pass them in, so the
 * catalog can be rebuilt for whatever the owner has configured without this
 * module knowing whether that came from an API, a database or a default.
 *
 * Lives in its own module rather than in pricing.js because pricing.js imports
 * the catalog and the catalog needs markup, which would be a cycle.
 */

/**
 * The markup rule, and the shape the owner backend has to hand back.
 *
 * `rate` is a PLACEHOLDER and not Ken's number. A flat multiplier is probably
 * not the shape of the real answer either -- see the rules below -- so treat
 * this as "no rule has been set yet" rather than as a decision.
 *
 * Rules this will plausibly grow, none of them implemented:
 *
 *   - A different rate per category. Winter and off-road turn over more slowly
 *     than all-season and tie up more money per tire.
 *   - Tiers by cost. A flat multiplier adds $12 to a $34 tire and $60 to a $170
 *     one, which is backwards: the labour is identical and the cheap tire is
 *     the one being quoted against a competitor.
 *   - A minimum absolute margin, so cheap tires stay worth fitting.
 *   - A floor that never quotes below cost, whatever the other rules produce.
 *   - Price endings, if Ken wants quotes landing on .99 or round dollars.
 *
 * Each of those becomes another field here and another step in `retailPrice`.
 * Adding one should not require touching a caller.
 */
export const DEFAULT_MARKUP_SETTINGS = {
  rate: 1.35,
  // What Ken pays a supplier to get one tire to Malden, per tire, folded into
  // the landed cost before the rate multiplies it (pricing-settings.md,
  // "Shipping"): markup applies to what the tire actually cost him to have in
  // hand, not to the supplier's sticker price with freight passed through at
  // cost. Zero rather than a guessed dollar figure -- unlike the mobile fee,
  // nothing has ever charged a separate shipping amount before this existed,
  // so an invented number would move live prices on a guess; zero preserves
  // today's pricing until Ken supplies a real one, and `isPlaceholder` still
  // marks it as not his.
  shippingPerTire: 0,
  /** False once a human has actually chosen these numbers. */
  isPlaceholder: true,
}

const roundCurrency = (amount) => Math.round(amount * 100) / 100

const isUsableAmount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const isUsableShipping = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Fill in anything the caller left out, and refuse a rate that would produce
 * nonsense. A backend returning a malformed rule should not silently reprice
 * the whole catalog to zero -- it falls back to the default instead.
 */
export function normalizeMarkupSettings(settings) {
  const merged = { ...DEFAULT_MARKUP_SETTINGS, ...(settings || {}) }
  if (!isUsableAmount(merged.rate) || !isUsableShipping(merged.shippingPerTire)) {
    return { ...DEFAULT_MARKUP_SETTINGS, isPlaceholder: true }
  }
  return merged
}

/**
 * What markup proposes for a tire we source at `supplierPrice`.
 *
 * `tire` carries per-tire shipping when a scraper has actually confirmed one
 * exists (pricing-settings.md: "the honest answer is a configured average
 * rather than a scraped figure" until that is known) -- `tire.shippingPerTire`
 * falls back to the flat setting so adding a real per-tire number later is a
 * change to this function alone, not to any caller. `tire.category` and
 * `tire.size` remain unread; every other rule listed above still needs them.
 *
 * Shipping lands inside the multiplier, not outside it: `(supplierPrice +
 * shipping) × rate`, because markup is on landed cost, not on the supplier's
 * price with freight passed through separately (pricing-settings.md,
 * "The formula, and the one decision inside it").
 *
 * Returns null for a price it cannot work from, rather than inventing one: a
 * tire with no usable cost is not something the quoting flow should price.
 */
export function retailPrice(supplierPrice, tire = {}, settings = DEFAULT_MARKUP_SETTINGS) {
  if (!isUsableAmount(supplierPrice)) return null
  const normalized = normalizeMarkupSettings(settings)
  const shipping = isUsableShipping(tire?.shippingPerTire) ? tire.shippingPerTire : normalized.shippingPerTire
  return roundCurrency((supplierPrice + shipping) * normalized.rate)
}

/**
 * An owner offer, as the owner backend returns it.
 *
 *   { priceCents: number|null, enabled: boolean }
 *
 * Integer cents, because that is how the backend stores it and converting once
 * here is better than rounding drift at every call site.
 */
const ownerPriceFrom = (offer) => {
  if (!offer || !Number.isInteger(offer.priceCents) || offer.priceCents <= 0) return null
  return roundCurrency(offer.priceCents / 100)
}

/**
 * The price a customer sees, and where it came from.
 *
 * `source` is 'owner' or 'markup' so a screen can show the difference -- an
 * owner-priced tire is a decision, a marked-up one is a suggestion nobody has
 * looked at yet.
 *
 * `offered` is false when the owner has explicitly deselected the tire. The
 * backend's `enabled` flag is his curation of what customers may buy, so a
 * disabled offer means "not for sale", not "price it some other way". A tire
 * with no offer at all is not deselected -- nobody has been asked yet -- so it
 * stays offered at the proposed price.
 */
export function quotedPrice({ supplierPrice, offer, tire = {}, settings } = {}) {
  const owner = ownerPriceFrom(offer)

  if (owner !== null) {
    return { price: owner, source: 'owner', offered: offer.enabled !== false }
  }

  // An offer that exists, is disabled and carries no price is a deliberate
  // "no". Without a price there is nothing to honour, so markup still proposes
  // one, but the tire is not for sale.
  const proposed = retailPrice(supplierPrice, tire, settings)
  const deselected = !!offer && offer.enabled === false

  return {
    price: proposed,
    source: proposed === null ? null : 'markup',
    offered: !deselected,
  }
}

/** Whether these settings are still the placeholder rule rather than a decision. */
export const isPlaceholderMarkup = (settings) =>
  normalizeMarkupSettings(settings).isPlaceholder === true
