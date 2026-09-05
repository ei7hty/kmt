// Standard passenger-vehicle fitment values, covering the great majority of
// the consumer market.
//
// These are deliberately NOT derived from the tire catalog. The catalog is a
// hardcoded demo fixture holding a handful of sizes, and deriving the selector
// from it meant the only sizes a customer could choose were the five we happen
// to stock -- so anyone checking the demo against the tires actually on their
// car would find their size missing and conclude the tool was broken.
//
// Offering the real range means a customer can land on a size we do not stock.
// That is handled where it surfaces, in the tire step, rather than avoided by
// pretending the other sizes do not exist.

export const FITMENT_WIDTHS = [
  '175', '185', '195', '205', '215', '225', '235', '245', '255', '265', '275',
]

export const FITMENT_RATIOS = ['35', '40', '45', '50', '55', '60', '65', '70', '75']

export const FITMENT_DIAMETERS = ['14', '15', '16', '17', '18', '19', '20', '21', '22']
