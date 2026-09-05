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
 * Common real-world fitments, so most sizes a customer picks return something.
 * Deliberately not exhaustive: "we do not stock that size" is a real outcome
 * for a shop that sources tires, and that path still needs to be reachable.
 */
const COVERED_SIZES = [
  '175/65R14', '185/65R15', '195/60R15', '195/65R15', '205/55R16', '205/60R16',
  '215/55R17', '215/65R16', '225/45R17', '225/60R17', '225/65R17', '235/45R18',
  '235/55R18', '235/60R18', '245/40R18', '245/45R19', '245/60R18', '245/70R17',
  '255/35R19', '255/45R20', '255/55R20', '265/60R18', '265/65R17', '275/40R20',
  '275/55R20'
]

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
