// Hardcoded tire catalog for the prototype.
//
// This structure allows an easy swap to a real pricing source later without
// refactoring consumers: everything downstream reads name, size, price,
// inStock, category and description, none of which assume where a row came from.
//
// The original six entries are kept verbatim, ids included, because the
// verification scripts and the demo walkthrough depend on them: 215/60R16 has a
// clean tire and an out-of-stock one, and 265/70R16 carries the off-road tire
// that triggers owner review. Everything after them is generated coverage, so a
// customer checking the demo against the tires actually on their car usually
// finds their size.

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

function generateTires() {
  const generated = []

  for (const size of COVERED_SIZES) {
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

export const TIRE_CATALOG = [...SEED_TIRES, ...generateTires()]

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
