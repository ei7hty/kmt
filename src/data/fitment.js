// Passenger, SUV and light-truck fitment values, matching the range a tire
// supplier's size menu offers for the same vehicles.
//
// These are deliberately NOT derived from the tire catalog. The catalog is a
// hardcoded demo fixture holding a handful of real sizes, and deriving the
// selector from it meant the only sizes a customer could choose were the few
// we happen to stock -- so anyone checking the demo against the tires actually
// on their car would find their size missing and conclude the tool was broken.
//
// The lists are the metric values from giga-tires.com's width / aspect ratio /
// wheel diameter menu that describe a car, SUV, van or pickup tire in the
// `205/65R15` form this app understands everywhere (parsers, audits, the owner
// backend's supported-size list). Left out on purpose, because they are other
// vehicles or another size grammar, not because they are rare:
//
//   - widths under 135 and even-ten widths such as 180, 200, 240 (motorcycle),
//   - widths above 355 and the 9.5L / 11L / 12.4 / 18.4 family (agricultural
//     and off-the-road),
//   - flotation sizes such as 33x12.50R15, which have no aspect ratio,
//   - fractional rim diameters such as 17.5, 19.5 and 22.5 (commercial truck)
//     and the suffixed ones such as 15NHS, 16.1SL and F19 (implement, trailer).
//
// Offering the real range means a customer can land on a size we do not stock.
// That is handled where it surfaces, in the tire step, rather than avoided by
// pretending the other sizes do not exist. Which combinations of these three
// lists are real tires is the plausibility rule in data/catalog.js.

export const FITMENT_WIDTHS = [
  '135', '145', '155', '165', '175', '185', '195', '205', '215', '225', '235',
  '245', '255', '265', '275', '285', '295', '305', '315', '325', '335', '345',
  '355',
]

export const FITMENT_RATIOS = [
  '25', '30', '35', '40', '45', '50', '55', '60', '65', '70', '75', '80', '85',
]

export const FITMENT_DIAMETERS = [
  '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
]
