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
 * Rules this will plausibly grow:
 *
 *   - A different rate per category. Winter and off-road turn over more slowly
 *     than all-season and tie up more money per tire. Not implemented.
 *   - Tiers by cost. **Measured and rejected -- see "Why not tiers by cost"
 *     below.** The complaint that motivated it is real and is answered by the
 *     margin floor instead.
 *   - A minimum absolute margin, so cheap tires stay worth fitting.
 *     `minMarginPerTire`, below.
 *   - A floor that never quotes below cost, whatever the other rules produce.
 *     Implied: `rate` is guarded at 1 or more where it is saved, and a margin
 *     floor only ever raises a price, so nothing here can quote under cost.
 *   - Price endings, if Ken wants quotes landing on .99 or round dollars.
 *     Not implemented.
 *
 * Each of those becomes another field here and another step in `retailPrice`.
 * Adding one should not require touching a caller.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT TIERS BY COST -- measured, not reasoned about
 *
 * The obvious reading of the complaint above is "give cheap tires a higher
 * multiplier": bands of supplier cost, each with its own rate. **That shape
 * is arithmetically broken and the catalogue proves it.**
 *
 * A band boundary is a step down in rate, so the price function steps down
 * with it. At a boundary of $80 with 1.60 below and 1.42 above, a tire
 * costing $80.00 is quoted $128.00 and a tire costing $80.01 is quoted
 * $113.61: **the tire that costs Ken more is the cheaper one on the shelf.**
 *
 * Measured over the 1,083 real supplier rows in
 * `src/data/scraped-tires.json` with that band set: **3,710 pairs where a
 * tire costing less is quoted higher than one costing more**, and 2 of them
 * sit next to each other in a price-sorted list where a customer would see
 * both. The inversion is not a tuning problem -- it exists for every band
 * set whose whole purpose is a higher rate at the bottom, because that is
 * the definition of a decreasing step.
 *
 * A margin floor and ceiling are the shape that survives. `cost x rate`,
 * `cost + floor` and `cost + ceiling` are all strictly increasing in cost,
 * and the max/min of increasing functions is increasing, **so no floor or
 * ceiling can ever invert two tires.** Verified over the same 1,083 rows at
 * every floor and ceiling measured: 0 inversions. A property test in
 * `markup.test.mjs` pins it.
 *
 * And it is the version Ken can say out loud: *"fitting a tire costs me the
 * same whatever the tire cost."* A band table is not a sentence.
 */
export const DEFAULT_MARKUP_SETTINGS = {
  rate: 1.35,
  // What Ken pays a supplier to get one tire to Malden, per tire, passed
  // through after markup under the owner's current ruling. It remains an
  // internal pricing input: customers see only the resulting tire price.
  // Zero rather than a guessed dollar figure -- unlike the mobile fee,
  // nothing has ever charged a separate shipping amount before this existed,
  // so an invented number would move live prices on a guess; zero preserves
  // today's pricing until Ken supplies a real one, and `isPlaceholder` still
  // marks it as not his.
  shippingPerTire: 0,
  /**
   * The least goods margin, in dollars per tire, that any marked-up price may
   * carry -- "fitting a tire costs me the same whatever the tire cost."
   *
   * `null` is ABSENT, not a placeholder, and the distinction is the same one
   * `.forge/pricing-settings.md` draws for tax: `isPlaceholder` is right for a
   * number we guessed on Ken's behalf, and wrong for one nobody has claimed.
   * No floor has ever been charged, so there is nothing to guess at; absent
   * means `retailPrice` behaves exactly as it did before this field existed,
   * and every price in the catalogue is byte-identical. A floor that exists is
   * Ken's by construction -- he is the only thing that can write one -- so it
   * needs no flag saying whose it is. That is why nothing here gains a
   * `minMarginPerTireIsPlaceholder` beside `rateIsPlaceholder` and
   * `shippingPerTireIsPlaceholder`: those two mark numbers we invented.
   *
   * Measured against the 1,083 supplier rows in `src/data/scraped-tires.json`:
   * supplier cost runs $31.14 to $382.42, so one flat 1.35 earns $10.90 on the
   * cheapest tire and $133.85 on the dearest -- **12.3x the money for the same
   * driveway, the same jack and the same forty-five minutes.** 40.8% of the
   * catalogue costs $80 or less, and at 1.35 a four-tire job on any of those
   * returns Ken at most $112 of goods margin before he has driven anywhere.
   */
  minMarginPerTire: null,
  /**
   * The most goods margin, in dollars per tire, that a marked-up price may
   * carry. `null` is ABSENT, exactly as above -- the other end of the same
   * sentence, and the end that protects the customer rather than Ken.
   *
   * A ceiling only ever lowers a price, so it can only cost Ken money: it is
   * his to turn on and nobody else's, which is why it ships off rather than at
   * some defensible-looking number.
   */
  maxMarginPerTire: null,
  /**
   * False once a human has actually chosen these numbers. It covers `rate` and
   * `shippingPerTire` -- the two this module supplies a value for. The margin
   * bounds are absent rather than guessed, so they have nothing to disclaim.
   */
  isPlaceholder: true,
}

const roundCurrency = (amount) => Math.round(amount * 100) / 100

const isUsableAmount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const isUsableShipping = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * A margin bound is a non-negative dollar amount or nothing at all.
 *
 * `undefined` is resolved to `null` by the caller before this sees it, so
 * "the key is not there" and "Ken turned it off" are the same answer here --
 * unlike `shippingPerTire`, where they had to be told apart because one of
 * them was a guessed number wearing a decided flag. Nothing guesses a margin
 * bound, so there is no such distinction to lose.
 */
const isUsableMargin = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

const marginOrNull = (value) => (value === undefined ? null : value)

/**
 * Fill in anything the caller left out, and refuse a rule that would produce
 * nonsense. A backend returning a malformed rule should not silently reprice
 * the whole catalog to zero -- it falls back to the default instead.
 *
 * The margin bounds are refused as a whole rule, not dropped quietly, and the
 * difference matters. Dropping a malformed floor would put every tire under it
 * back to the bare `rate` -- a real repricing of hundreds of rows, with
 * nothing anywhere saying it happened. Falling back to the default reprices
 * too, but it also sets `isPlaceholder: true`, which the owner screen already
 * renders as "this is not Ken's number". A wrong answer that raises a flag is
 * recoverable; a wrong answer that raises nothing is the failure this file
 * already exists to avoid.
 */
export function normalizeMarkupSettings(settings) {
  const merged = { ...DEFAULT_MARKUP_SETTINGS, ...(settings || {}) }
  merged.minMarginPerTire = marginOrNull(merged.minMarginPerTire)
  merged.maxMarginPerTire = marginOrNull(merged.maxMarginPerTire)
  const contradictory = merged.minMarginPerTire !== null && merged.maxMarginPerTire !== null &&
    merged.minMarginPerTire > merged.maxMarginPerTire
  if (!isUsableAmount(merged.rate) || !isUsableShipping(merged.shippingPerTire) ||
      !isUsableMargin(merged.minMarginPerTire) || !isUsableMargin(merged.maxMarginPerTire) || contradictory) {
    return { ...DEFAULT_MARKUP_SETTINGS, isPlaceholder: true }
  }
  return merged
}

/**
 * Hold a marked-up price inside the margin bounds, if there are any.
 *
 * Margin here is GOODS margin -- what the tire earns over what Ken paid the
 * supplier for it. Freight is not margin (see `retailPrice`), so it is added
 * after this and is never what a floor is reaching for or what a ceiling caps.
 * A $25.75 shipping cost is not $25.75 of anybody's profit.
 *
 * The floor is applied before the ceiling and they cannot disagree:
 * `normalizeMarkupSettings` has already refused a rule whose floor is above
 * its ceiling, so at most one of these two branches can ever fire.
 */
function clampMargin(marked, supplierPrice, { minMarginPerTire, maxMarginPerTire }) {
  if (minMarginPerTire !== null && marked < supplierPrice + minMarginPerTire) {
    return supplierPrice + minMarginPerTire
  }
  if (maxMarginPerTire !== null && marked > supplierPrice + maxMarginPerTire) {
    return supplierPrice + maxMarginPerTire
  }
  return marked
}

/**
 * What markup proposes for a tire we source at `supplierPrice`.
 *
 * `tire` carries per-tire shipping when a scraper has actually confirmed one
 * exists (pricing-settings.md: "the honest answer is a configured average
 * rather than a scraped figure" until that is known) -- `tire.shippingPerTire`
 * falls back to the flat setting so adding a real per-tire number later is a
 * change to this function alone, not to any caller. `tire.category` and
 * `tire.size` remain unread; the per-category rule listed above still needs
 * them. The margin bounds do not -- they key on supplier cost, which is
 * already the first argument.
 *
 * The order is: mark the goods up, hold that inside the margin bounds, then
 * add freight. `clamp(supplierPrice × rate) + shipping`. Shipping stays
 * outside the clamp because it is Ken's internal freight cost, not goods
 * margin; a floor that counted freight toward the margin it is protecting
 * would stop protecting anything the moment Ken set a shipping figure. It
 * never appears as its own customer-facing line or field either way.
 *
 * Returns null for a price it cannot work from, rather than inventing one: a
 * tire with no usable cost is not something the quoting flow should price.
 */
export function retailPrice(supplierPrice, tire = {}, settings = DEFAULT_MARKUP_SETTINGS) {
  if (!isUsableAmount(supplierPrice)) return null
  const normalized = normalizeMarkupSettings(settings)
  const shipping = isUsableShipping(tire?.shippingPerTire) ? tire.shippingPerTire : normalized.shippingPerTire
  const marked = clampMargin(supplierPrice * normalized.rate, supplierPrice, normalized)
  return roundCurrency(marked + shipping)
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
