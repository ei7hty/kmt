/**
 * What KMT charges over a supplier's price.
 *
 * This is a seam, not a pricing policy. The real rules are Ken's to decide and
 * do not exist yet; what exists is the one place they will live, with the
 * signature they will need. Today it applies a single flat rate, which is a
 * placeholder standing in for those rules -- not a decision that has been made.
 *
 * Lives in its own module rather than in pricing.js because pricing.js imports
 * the catalog and the catalog needs markup, which would be a cycle.
 *
 * The supplier price is what giga-tires charges a walk-up customer online. It
 * is neither Ken's cost nor what he should quote for a tire fitted at the
 * roadside, so it is never shown to a customer without passing through here.
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
 * When those arrive they belong inside `retailPrice`, applied in a defined
 * order, with this comment replaced by what was actually decided.
 */

/**
 * PLACEHOLDER rate. Not Ken's number, and not the shape the real answer will
 * take -- see the rules above. It is here so the prototype shows a plausible
 * customer-facing price instead of the supplier's own, and so there is exactly
 * one thing to delete when the rules land.
 */
const PLACEHOLDER_RATE = 1.35

const roundCurrency = (amount) => Math.round(amount * 100) / 100

/**
 * The customer-facing price for a tire we source at `supplierPrice`.
 *
 * `tire` is unused today and is here because every rule listed above needs it
 * -- category, size and cost all feed the real logic. Passing it from the start
 * means adding a rule is a change to this function alone.
 *
 * Returns null for a price we cannot work from, rather than inventing one: a
 * tire with no usable cost is not something the quoting flow should price.
 */
// eslint-disable-next-line no-unused-vars
export function retailPrice(supplierPrice, tire = {}) {
  if (typeof supplierPrice !== 'number' || !Number.isFinite(supplierPrice) || supplierPrice <= 0) {
    return null
  }

  return roundCurrency(supplierPrice * PLACEHOLDER_RATE)
}

/**
 * Whether `retailPrice` is still the placeholder.
 *
 * Exported so a screen or a check can say "these prices are provisional"
 * without hardcoding that fact in two places. Flip it when the real rules land.
 */
export const MARKUP_IS_PLACEHOLDER = true
