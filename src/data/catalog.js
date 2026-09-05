// The tire catalog, assembled from three sources in order of how real they are.
//
// This structure allows an easy swap to a real pricing source later without
// refactoring consumers: everything downstream reads name, size, price,
// inStock, category and description, none of which assume where a row came from.
//
//   1. SEED_TIRES      -- the original six, kept verbatim.
//   2. scraped-tires   -- real tires from giga-tires.com, for the sizes we have
//                         actually scraped. See scripts/scrape-tires.mjs.
//   3. generated       -- invented coverage for every other plausible size.
//
// Real rows displace generated ones for the sizes they cover, so where we have
// been to the supplier the customer sees tires that exist at prices someone
// charges, and everywhere else they still see something rather than a dead end.
//
// The seeds survive both, ids included, because the verification scripts and
// the demo walkthrough select them by name: 215/60R16 has a clean tire and an
// out-of-stock one, and 265/70R16 carries the off-road tire that triggers owner
// review. Both of those sizes are also scraped, so dropping seeds in favour of
// real rows would quietly break .forge/dead-end-audit.mjs.

import SCRAPED from './scraped-tires.json' with { type: 'json' }
import { FITMENT_DIAMETERS, FITMENT_RATIOS, FITMENT_WIDTHS } from './fitment.js'
import { quotedPrice } from '../markup.js'

/** The seed tires. Do not renumber or rename: scripts select these by name. */
const SEED_TIRES = [
  { id: 'tire-1', name: 'All-Weather Standard', size: '215/60R16', price: 85.99, inStock: true, category: 'all-season', description: 'Reliable year-round performance' },
  { id: 'tire-2', name: 'Performance Plus', size: '225/50R17', price: 125.50, inStock: true, category: 'performance', description: 'Enhanced grip and handling' },
  { id: 'tire-3', name: 'Budget Economy', size: '205/65R15', price: 59.99, inStock: true, category: 'all-season', description: 'Value-focused option' },
  { id: 'tire-4', name: 'Winter Expert', size: '215/60R16', price: 145.00, inStock: false, category: 'winter', description: 'Premium winter traction (out of stock)' },
  { id: 'tire-5', name: 'Off-Road Terrain', size: '265/70R16', price: 175.99, inStock: true, category: 'off-road', description: 'Aggressive tread for off-road' },
  { id: 'tire-6', name: 'Eco Hybrid', size: '185/55R15', price: 95.50, inStock: true, category: 'eco', description: 'Fuel-efficient low rolling resistance' }
]

/**
 * Which of the standard fitment combinations actually exist.
 *
 * The three ranges multiply out to 891 combinations, and most are not real
 * tires: nobody makes a 175/35R22. Real fitments correlate, bigger rims taking
 * wider tires and lower profiles, so the catalog is generated from that rule
 * instead of a hand-listed set. That covers roughly a third of the grid, which
 * is the third a customer can actually be driving on.
 *
 * The selector then offers only onward choices that exist, so a completed
 * selection always lands on tires. The rule is what makes that possible: it
 * decides the shape of the catalog, and the catalog decides the menu.
 */
function isPlausibleFitment(width, ratio, diameter) {
  const w = Number(width)
  const r = Number(ratio)
  const d = Number(diameter)
  if (d <= 15) return w <= 215 && r >= 55
  if (d <= 17) return w >= 185 && w <= 265 && r >= 45 && r <= 70
  if (d <= 19) return w >= 215 && r >= 35 && r <= 60
  return w >= 245 && r >= 35 && r <= 50
}

const COVERED_SIZES = FITMENT_WIDTHS.flatMap(width =>
  FITMENT_RATIOS.flatMap(ratio =>
    FITMENT_DIAMETERS
      .filter(diameter => isPlausibleFitment(width, ratio, diameter))
      .map(diameter => `${width}/${ratio}R${diameter}`)
  )
)

/** Models offered per size. The all-terrain option is truck-only, see below. */
const MODELS = [
  { name: 'Touring Comfort', category: 'all-season', base: 92, description: 'Quiet ride, long tread life' },
  { name: 'Grand Touring AS', category: 'all-season', base: 118, description: 'All-season grip with a comfortable ride' },
  { name: 'Sport Performance', category: 'performance', base: 149, description: 'Responsive steering and dry grip' },
  { name: 'Winter Grip', category: 'winter', base: 134, description: 'Snow and ice traction for New England winters' },
  { name: 'Trail Terrain AT', category: 'off-road', base: 168, description: 'All-terrain tread for trucks and SUVs' }
]

const parseSize = (size) => {
  const match = size.match(/^(\d+)\/(\d+)R(\d+)$/)
  return match ? { width: Number(match[1]), ratio: Number(match[2]), diameter: Number(match[3]) } : null
}

/** Bigger rims cost more. Deterministic, so the demo shows the same price twice. */
const priceFor = (base, size) => {
  const parsed = parseSize(size)
  if (!parsed) return base
  const byRim = (parsed.diameter - 15) * 11
  const byWidth = (parsed.width - 205) * 0.22
  return Math.round((base + byRim + byWidth) * 100) / 100
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Real rows, priced for a given owner configuration and reduced to the same
 * shape as every other row.
 *
 * `offers` is keyed by the snapshot's tire id, which is also the owner
 * backend's `supplier.id` -- it seeds from this same file and validates the
 * `giga-` prefix, so the two agree by construction rather than by convention.
 *
 * With no offers passed, every tire is priced by markup and offered. That is
 * exactly what the catalog did before any of this existed, and it is what the
 * customer flow gets whenever the owner backend is not supplying overrides.
 *
 * The snapshot's `source` block (SKU, stock count, list price, product URL) is
 * deliberately dropped: it is there so a human reviewing the JSON can trace a
 * row back to its page, and nothing in the app should start depending on
 * fields that only some rows have.
 */
function scrapedTiresFor({ settings, offers } = {}) {
  const rows = []

  for (const tire of SCRAPED.tires) {
    // The snapshot holds what the supplier charges. What KMT charges is
    // markup's business, and the customer never sees the former.
    const { price, offered } = quotedPrice({
      supplierPrice: tire.price,
      offer: offers?.[tire.id],
      tire,
      settings,
    })

    // No usable price, or a tire the owner has deselected. Either way it is
    // not something a customer can be offered.
    if (price === null || !offered) continue

    rows.push({
      id: tire.id,
      name: tire.name,
      size: tire.size,
      price,
      inStock: tire.inStock,
      category: tire.category,
      description: tire.description,
    })
  }

  return rows
}

/**
 * `coveredSizes` is the sizes that ended up with real rows, not the sizes the
 * snapshot happens to contain. Those differ once the owner deselects tires: a
 * size he empties gets its generated coverage back rather than becoming a dead
 * end, which is the invariant the fitment selector depends on.
 */
function generateTires(coveredSizes = new Set()) {
  const generated = []

  for (const size of COVERED_SIZES) {
    // Where we have real tires, invented ones would sit alongside them in the
    // same list at prices built from a different rule. The seeds are the
    // deliberate exception, kept above.
    if (coveredSizes.has(size)) continue

    const parsed = parseSize(size)
    if (!parsed) continue

    // All-terrain only where it would plausibly fit: wide, tall-sidewall fitments.
    const truckish = parsed.width >= 245 && parsed.ratio >= 55
    const models = MODELS.filter(model => model.category !== 'off-road' || truckish)

    for (const model of models) {
      // Some winter stock is out, so the out-of-stock path stays reachable
      // across the catalog rather than only on the one seed size.
      const inStock = !(model.category === 'winter' && parsed.diameter % 2 === 1)
      generated.push({
        id: `tire-${slug(size)}-${slug(model.name)}`,
        name: model.name,
        size,
        price: priceFor(model.base, size),
        inStock,
        category: model.category,
        description: inStock ? model.description : `${model.description} (out of stock)`
      })
    }
  }

  return generated
}

/**
 * The catalog, for a given owner configuration.
 *
 *   buildCatalog()                      -- markup prices everything (today)
 *   buildCatalog({ settings, offers })  -- the owner's rule and his overrides
 *
 * `settings` is the markup rule (see DEFAULT_MARKUP_SETTINGS) and `offers` is
 * an object keyed by tire id holding `{ priceCents, enabled }`, which is the
 * shape the owner backend's inventory endpoint already returns.
 *
 * A function rather than a constant because those inputs arrive at runtime,
 * over the network, after this module has loaded. Prices cannot be baked in at
 * import time and still reflect what the owner set thirty seconds ago.
 */
export function buildCatalog(options = {}) {
  const scraped = scrapedTiresFor(options)
  const coveredSizes = new Set(scraped.map(tire => tire.size))
  return [...SEED_TIRES, ...scraped, ...generateTires(coveredSizes)]
}

/**
 * The default catalog: markup prices, no owner overrides.
 *
 * This is what every existing caller reads, and it is unchanged by any of the
 * above until something passes real settings to buildCatalog.
 */
export const TIRE_CATALOG = buildCatalog()

/** When the real rows were pulled, for anything that wants to show staleness. */
export const SCRAPED_AT = SCRAPED.scrapedAt

/**
 * Get all available tires from the catalog
 */
export function getAllTires() {
  return TIRE_CATALOG;
}

/**
 * Get a specific tire by ID
 */
export function getTireById(id) {
  return TIRE_CATALOG.find(tire => tire.id === id);
}

/**
 * Get only tires that are in stock
 */
export function getInStockTires() {
  return TIRE_CATALOG.filter(tire => tire.inStock);
}

/**
 * Get tires by size
 */
export function getTiresBySize(size) {
  return TIRE_CATALOG.filter(tire => tire.size === size);
}
