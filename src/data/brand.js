/**
 * A tire's brand, derived from the supplier's own URL rather than guessed
 * from its display name.
 *
 * Every supplier listing URL is
 * `https://www.giga-tires.com/<size>/<brand>-tires/<model>/tirecode/<code>` --
 * a fixed five path segments, confirmed against all 1,083 rows in
 * `src/data/scraped-tires.json` with zero misses, 125 distinct brands.
 * Reading the brand segment out of the supplier's own URL is reading data;
 * splitting the display name on its first space ("Waterfall Quattro" ->
 * "Waterfall") is inference, and it breaks silently on any multi-word
 * brand name.
 */
const BRAND_URL_PATTERN = /\/([a-z0-9-]+)-tires\//i

/**
 * Exceptions to plain title-casing, for the slugs where title case is
 * demonstrably wrong rather than merely plain. Checked against all 125
 * brands: only these two of the 14 hyphenated slugs come out wrong
 * ("Bf Goodrich", "Gt Radial"), plus two single-word acronyms a title-case
 * pass can't fix on its own ("Rbp", "Tbb"). A slug missing from this map
 * degrades to title case rather than breaking, so this stays a short list
 * of corrections, not a hand-maintained brand-identity catalogue.
 */
const BRAND_LABEL_OVERRIDES = {
  'bf-goodrich': 'BFGoodrich',
  'gt-radial': 'GT Radial',
  rbp: 'RBP',
  tbb: 'TBB',
}

const titleCase = slug => slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')

/**
 * `{ slug, label }` for a supplier listing URL, or `null` if the URL does
 * not match the supplier's known shape -- a row without a recognisable
 * brand segment is not something this should guess at.
 */
export function deriveBrand(sourceUrl) {
  const match = typeof sourceUrl === 'string' ? sourceUrl.match(BRAND_URL_PATTERN) : null
  if (!match) return null
  const slug = match[1].toLowerCase()
  return { slug, label: BRAND_LABEL_OVERRIDES[slug] || titleCase(slug) }
}
