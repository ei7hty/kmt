/**
 * A small, hand-picked sample of giga-tires.com's own product sitemap.
 *
 * Not scraped, not fetched by this repository's code -- extracted by hand from
 * one of the two product sitemaps named in their sitemap index, which the
 * owner separately authorised reading (2026-09-10, one live GET, spent the
 * same way the robots.txt read was). That sitemap named 50,000 URLs, every one
 * of exactly this shape: `/{size}/{brand}-tires/{model}/tirecode/{code}`. This
 * file keeps 30 of them -- the first 10, 10 from the middle, 10 from the end --
 * as a permanent, offline regression fixture, so `giga-tires.test.mjs` can
 * assert against a slice of the supplier's OWN declared crawl targets without
 * this repository ever holding (or re-fetching) the full 8.9MB file.
 *
 * These are read-only evidence of what the supplier considers a product page,
 * not addresses this code will ever request: nothing in this repository
 * fetches a URL in this list, and no further live request to giga-tires.com
 * is authorised.
 */
export const GIGA_SITEMAP_SAMPLE = [
  'https://www.giga-tires.com/205-35-18/accelera-tires/alpha/tirecode/1200026936',
  'https://www.giga-tires.com/165-80-13/accelera-tires/eco-plush/tirecode/1200028513',
  'https://www.giga-tires.com/175-70-13/accelera-tires/eco-plush/tirecode/1200026937',
  'https://www.giga-tires.com/185-70-13/accelera-tires/eco-plush/tirecode/1200053848',
  'https://www.giga-tires.com/155-65-14/accelera-tires/eco-plush/tirecode/1200031852',
  'https://www.giga-tires.com/165-60-14/accelera-tires/eco-plush/tirecode/1200053236',
  'https://www.giga-tires.com/165-65-14/accelera-tires/eco-plush/tirecode/1200039509',
  'https://www.giga-tires.com/165-70-14/accelera-tires/eco-plush/tirecode/1200039510',
  'https://www.giga-tires.com/175-65-14/accelera-tires/eco-plush/tirecode/1200040115',
  'https://www.giga-tires.com/175-70-14/accelera-tires/eco-plush/tirecode/1200047426',
  'https://www.giga-tires.com/33-12.50-20/kanati-tires/mud-hog-m-t/tirecode/L2033125E-252',
  'https://www.giga-tires.com/35-12.50-20/kanati-tires/mud-hog-m-t/tirecode/L2035125E-252',
  'https://www.giga-tires.com/37-12.50-20/kanati-tires/mud-hog-m-t/tirecode/L2037125E-252',
  'https://www.giga-tires.com/39-13.50-20/kanati-tires/mud-hog-m-t/tirecode/L2039135E-252',
  'https://www.giga-tires.com/40-13.50-20/kanati-tires/mud-hog-m-t/tirecode/L2040135E-252',
  'https://www.giga-tires.com/33-12.50-22/kanati-tires/mud-hog-m-t/tirecode/L2233125E-252',
  'https://www.giga-tires.com/35-12.50-22/kanati-tires/mud-hog-m-t/tirecode/L2235125E-252',
  'https://www.giga-tires.com/37-13.50-22/kanati-tires/mud-hog-m-t/tirecode/L2237135E-252',
  'https://www.giga-tires.com/39-14.50-22/kanati-tires/mud-hog-m-t/tirecode/L2239145E-252',
  'https://www.giga-tires.com/265-75-16/kanati-tires/trail-hog-a-t-4/tirecode/LTH1626575E',
  'https://www.giga-tires.com/255-70-16/westlake-tires/su318-h-t/tirecode/24270005',
  'https://www.giga-tires.com/265-70-16/westlake-tires/su318-h-t/tirecode/24272007',
  'https://www.giga-tires.com/265-75-16/westlake-tires/su318-h-t/tirecode/24773003',
  'https://www.giga-tires.com/245-65-17/westlake-tires/su318-h-t/tirecode/24552508',
  'https://www.giga-tires.com/245-70-17/westlake-tires/su318-h-t/tirecode/24552603',
  'https://www.giga-tires.com/255-60-17/westlake-tires/su318-h-t/tirecode/24607004',
  'https://www.giga-tires.com/255-65-17/westlake-tires/su318-h-t/tirecode/24626004',
  'https://www.giga-tires.com/255-70-17/westlake-tires/su318-h-t/tirecode/24629001',
  'https://www.giga-tires.com/265-60-17/westlake-tires/su318-h-t/tirecode/24370003',
  'https://www.giga-tires.com/265-65-17/westlake-tires/su318-h-t/tirecode/24689005',
]
