// The tire catalog, assembled from two sources in order of how real they are.
//
// This structure allows an easy swap to a real pricing source later without
// refactoring consumers: everything downstream reads name, size, price,
// inStock, category and description, none of which assume where a row came from.
//
//   1. SEED_TIRES      -- the original six, kept verbatim.
//   2. generated       -- invented coverage for every plausible size.
//
// Real scraped tires from giga-tires.com are a third source, but they never
// enter this module: they live in src/data/scraped-tires.json, read from disk
// by the backend alone (backend/dev.mjs, backend/server.mjs) to seed the
// owner's database, and reach a customer only through GET /api/catalog and
// catalogFromLiveRows below. This module builds the static fallback used
// when there is no backend to ask (the static build, or the backend down),
// and a static bundle is public: every byte here ships in the deployed JS.
// A snapshot import here once put every scraped row -- including source.sku,
// stock counts, list price and the supplier's product URL -- into that bundle.
//
// The seeds survive here and in the live composition, ids included, because
// the verification scripts and the demo walkthrough select them by name:
// 215/60R16 has a clean tire and an out-of-stock one, and 265/70R16 carries
// the off-road tire that triggers owner review.

import { FITMENT_DIAMETERS, FITMENT_RATIOS, FITMENT_WIDTHS } from './fitment.js'

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
 * The three ranges multiply out to 3,887 combinations, and most are not real
 * tires: nobody makes a 135/25R24. Real fitments correlate, bigger rims taking
 * wider tires and lower profiles, so the catalog is generated from that rule
 * instead of a hand-listed set. The rule has two parts:
 *
 *   1. Per rim diameter, the band of widths and aspect ratios that are made
 *      for it. A 13-inch rim carries narrow, tall tires; a 22-inch rim carries
 *      wide, low ones. The table is read off what the market sells, from the
 *      145/80R13 on a small hatchback to the 305/30R22 on a large SUV.
 *   2. An overall-diameter check across the band's corners: the tire has to
 *      stand between roughly 20 and 35 inches tall, which is the span from
 *      the smallest car tire to the largest light-truck one. This is what
 *      removes the 345/75R18 and the 135/60R13 that the bands alone allow.
 *
 * Together they keep about a quarter of the grid (910 of 3,887 sizes, measured
 * by counting TIRE_CATALOG), which is the quarter a customer can actually be
 * driving on. The selector then offers only onward choices
 * that exist, so a completed selection always lands on tires. The rule is
 * what makes that possible: it decides the shape of the catalog, and the
 * catalog decides the menu.
 */
const FITMENT_BANDS = {
  12: { width: [135, 165], ratio: [70, 85] },
  13: { width: [135, 185], ratio: [60, 85] },
  14: { width: [155, 215], ratio: [55, 80] },
  15: { width: [165, 265], ratio: [50, 80] },
  16: { width: [175, 285], ratio: [45, 85] },
  17: { width: [195, 315], ratio: [40, 80] },
  18: { width: [205, 345], ratio: [30, 75] },
  19: { width: [225, 355], ratio: [25, 60] },
  20: { width: [235, 355], ratio: [25, 65] },
  21: { width: [245, 325], ratio: [25, 50] },
  22: { width: [255, 355], ratio: [25, 50] },
  23: { width: [275, 325], ratio: [25, 40] },
  24: { width: [275, 325], ratio: [25, 35] },
}

const MIN_OVERALL_MM = 500
const MAX_OVERALL_MM = 900

function isPlausibleFitment(width, ratio, diameter) {
  const w = Number(width)
  const r = Number(ratio)
  const d = Number(diameter)
  const band = FITMENT_BANDS[d]
  if (!band) return false
  if (w < band.width[0] || w > band.width[1]) return false
  if (r < band.ratio[0] || r > band.ratio[1]) return false
  // Rim plus two sidewalls, in millimetres.
  const overall = d * 25.4 + 2 * (w * r / 100)
  return overall >= MIN_OVERALL_MM && overall <= MAX_OVERALL_MM
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
 * The catalog a customer sees when the owner's backend answered.
 *
 * Composition, not replacement, and that distinction is the whole function.
 * The endpoint returns only what the owner has curated -- today two dozen rows
 * across four sizes. Handing that to the customer flow as the entire catalog
 * would leave the fitment selector offering four sizes, turn every other size
 * into a dead end, and remove the seed tires both audits select by name. None
 * of that would be caught before it shipped, because the audit gate runs
 * against a build with no backend and therefore only ever sees the fallback.
 *
 * So live rows take the place of generated ones and nothing else: the seeds
 * stay, the live rows follow, and generated coverage fills every size the live
 * rows do not reach -- the same shape buildCatalog builds with no live rows at
 * all. An empty answer composes to a catalog that still covers every size,
 * which is what makes an empty one safe to accept as an answer rather than
 * treat as a failure.
 */
export function catalogFromLiveRows(rows = []) {
  const live = Array.isArray(rows) ? rows : []
  const coveredSizes = new Set(live.map(tire => tire.size))
  return [...SEED_TIRES, ...live, ...generateTires(coveredSizes)]
}

/**
 * The static fallback catalog: seeds plus generated coverage, no scraped
 * rows. Used when there is no backend to ask (a static build, or the backend
 * down); the live catalog composes through catalogFromLiveRows instead.
 */
export function buildCatalog() {
  return [...SEED_TIRES, ...generateTires()]
}

export const TIRE_CATALOG = buildCatalog()

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
