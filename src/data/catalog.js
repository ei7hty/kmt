// Hardcoded tire catalog for the prototype
// This structure allows easy swap to a real pricing source later without refactoring consumers

export const TIRE_CATALOG = [
  {
    id: 'tire-1',
    name: 'All-Weather Standard',
    size: '215/60R16',
    price: 85.99,
    inStock: true,
    description: 'Reliable year-round performance'
  },
  {
    id: 'tire-2',
    name: 'Performance Plus',
    size: '225/50R17',
    price: 125.50,
    inStock: true,
    description: 'Enhanced grip and handling'
  },
  {
    id: 'tire-3',
    name: 'Budget Economy',
    size: '205/65R15',
    price: 59.99,
    inStock: true,
    description: 'Value-focused option'
  },
  {
    id: 'tire-4',
    name: 'Winter Expert',
    size: '215/60R16',
    price: 145.00,
    inStock: false,
    description: 'Premium winter traction (out of stock)'
  },
  {
    id: 'tire-5',
    name: 'Off-Road Terrain',
    size: '265/70R16',
    price: 175.99,
    inStock: true,
    description: 'Aggressive tread for off-road'
  },
  {
    id: 'tire-6',
    name: 'Eco Hybrid',
    size: '185/55R15',
    price: 95.50,
    inStock: true,
    description: 'Fuel-efficient low rolling resistance'
  }
];

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
