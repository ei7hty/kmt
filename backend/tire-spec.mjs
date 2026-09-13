/**
 * Turn a supplier spec string into plain English.
 *
 * What a customer standing next to a flat tyre reads today, verbatim, because
 * it is the only description the shop shows:
 *
 *     Ultra High Performance All Season · 94V BSW
 *     High Performance All Season · XL 98W BSW
 *     Racing · XL 98W BSW
 *
 * `94V` is a load index and a speed symbol. `BSW` is a black sidewall. `XL` is
 * extra load. None of that means anything to the person buying, and none of it
 * is explained anywhere on the screen.
 *
 * This module translates the codes and NOTHING ELSE. It does not write
 * marketing copy, does not rank, does not recommend, and where the string says
 * nothing it says nothing. A code it cannot resolve honestly is reported in
 * `unresolved` rather than guessed at, because a confident wrong expansion of
 * a sidewall code is worse than an absent one: the customer cannot tell the
 * difference and neither can the owner.
 *
 * STANDALONE ON PURPOSE. Nothing imports this yet. It is not wired into
 * `cleanCatalogDescription` or `catalog()` -- those are other lanes' regions
 * of `backend/inventory.mjs` -- and shipping the module before either consumer
 * is the same shape as `scripts/lib/git.mjs`, which merged alone and was
 * adopted afterwards.
 *
 * ---------------------------------------------------------------------------
 * MEASURED BEFORE DESIGNED, over all 1,083 rows of src/data/scraped-tires.json
 *
 *   255 distinct descriptions
 *    35 distinct category labels, longest 33 characters
 *    55 distinct spec tokens, 84 distinct spec strings
 *    28 rows with NO category at all -- the string is a bare spec ("94H BSW")
 *     7 rows whose "category" is supplier marketing boilerplate, 200+
 *       characters with an HTML <sup> tag in it
 *
 * Those last two are why the parser cannot simply split on the separator and
 * trust each half.
 */

/**
 * Load index -> kilograms per tire.
 *
 * The standard table, identical in ETRTO and the Tire and Rim Association's
 * yearbook and reprinted in every tire retailer's glossary. It is NOT a
 * formula and NOT linear -- the steps are 20 kg at index 94 and 35 kg at index
 * 115 -- so an index outside this table is reported unresolved rather than
 * interpolated. A plausible interpolated weight is exactly the kind of
 * confident wrong answer this file exists to avoid.
 *
 * Kilograms only. Pounds are COMPUTED from these by `poundsFromKilograms()`
 * below, and are never a second literal: two numbers encoding one fact agree
 * on the day they are typed and drift silently afterwards, which this
 * repository has already paid for three times in one night.
 */
export const LOAD_INDEX_KG = Object.freeze({
  70: 335, 71: 345, 72: 355, 73: 365, 74: 375, 75: 387, 76: 400, 77: 412, 78: 425, 79: 437,
  80: 450, 81: 462, 82: 475, 83: 487, 84: 500, 85: 515, 86: 530, 87: 545, 88: 560, 89: 580,
  90: 600, 91: 615, 92: 630, 93: 650, 94: 670, 95: 690, 96: 710, 97: 730, 98: 750, 99: 775,
  100: 800, 101: 825, 102: 850, 103: 875, 104: 900, 105: 925, 106: 950, 107: 975, 108: 1000, 109: 1030,
  110: 1060, 111: 1090, 112: 1120, 113: 1150, 114: 1180, 115: 1215, 116: 1250, 117: 1285, 118: 1320, 119: 1360,
  120: 1400, 121: 1450, 122: 1500, 123: 1550, 124: 1600, 125: 1650, 126: 1700, 127: 1750, 128: 1800, 129: 1850,
  130: 1900,
})

/**
 * Speed symbol -> the maximum sustained speed it certifies, in km/h.
 *
 * The same standard table. Note that the sequence is NOT alphabetical: it runs
 * ... S, T, U, H, V, W, Y, with H sitting between U and V. That is correct and
 * is the usual reason someone "fixes" one of these tables into a wrong order,
 * so it is written down here rather than left to be rediscovered.
 *
 * Symbols outside this set -- including the ZR and (Y) constructions -- are
 * reported unresolved. km/h only; mph is computed.
 */
export const SPEED_SYMBOL_KMH = Object.freeze({
  L: 120, M: 130, N: 140, P: 150, Q: 160, R: 170, S: 180, T: 190, U: 200, H: 210, V: 240, W: 270, Y: 300,
})

/**
 * Sidewall markings, expanded only where the expansion is unambiguous and
 * appears in the standard published vocabulary.
 *
 * `W/G` is deliberately absent. It occurs twice in the snapshot and has no
 * entry in any standard sidewall glossary; guessing at it would put an
 * invented fact on a customer's screen. It comes back in `unresolved`.
 */
export const SIDEWALL_CODES = Object.freeze({
  BSW: 'Black sidewall',
  WSW: 'White sidewall',
  WL: 'White lettering on the sidewall',
  OWL: 'Outlined white lettering on the sidewall',
  RWL: 'Raised white lettering on the sidewall',
  ORWL: 'Outlined raised white lettering on the sidewall',
  RBL: 'Raised black lettering on the sidewall',
  BSL: 'Black serrated lettering on the sidewall',
  VSB: 'Vertical serrated band on the sidewall',
})

/**
 * Codes seen in the data that this module refuses to expand, and why.
 *
 * Exported so the decision is inspectable and so the test can assert on the
 * REASON rather than only on the silence. An unresolved code is a finding for
 * whoever next reads a supplier page, not a defect in the parser.
 */
export const KNOWN_UNRESOLVED = Object.freeze({
  'W/G': 'No entry in any standard sidewall glossary. 2 rows.',
  C: 'Appears only immediately before a load range ("C C/6PLY BSW"). Probably the European commercial marking, but "probably" is not good enough to print. 8 rows.',
  RF: 'Run-flat markings are manufacturer-specific (RFT, ZP, SSR, EMT, ROF); "RF" alone certifies nothing industry-wide. 1 row.',
})

/**
 * The longest legitimate category in the snapshot is 33 characters ("Ultra
 * High Performance All Season"). The seven marketing-boilerplate rows are
 * 200+. A category is a LABEL; anything this long is a sentence that leaked
 * into the field, and printing it as a category is how a customer ends up
 * reading the supplier's own comparison-tool advertisement.
 *
 * 60 leaves nearly double the headroom over the longest real one, which is
 * the point of stating the measurement next to the constant rather than
 * only in a commit message.
 */
export const MAX_CATEGORY_CHARS = 60

const KG_TO_LB = 2.20462262185
const KMH_TO_MPH = 0.621371192

export const poundsFromKilograms = kg => Math.round(kg * KG_TO_LB)
export const milesPerHourFromKph = kmh => Math.round(kmh * KMH_TO_MPH)

const LOAD_AND_SPEED = /^(\d{2,3})([A-Z])$/
const LOAD_RANGE = /^([A-Z])\/(\d{1,2})PLY$/

/**
 * Is this token part of a spec, rather than a word in a category?
 *
 * Used to tell a description with no category ("94H BSW", 28 rows) from one
 * with no spec ("Sport truck"). A token counts as spec vocabulary even when
 * this module will not expand it -- `W/G` is a spec token that lands in
 * `unresolved`, not a category word.
 */
function isSpecToken(token) {
  return token === 'XL' || token in KNOWN_UNRESOLVED || token in SIDEWALL_CODES ||
    LOAD_AND_SPEED.test(token) || LOAD_RANGE.test(token)
}

function splitDescription(raw) {
  const parts = raw.split('·').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return { category: null, spec: '' }
  if (parts.length === 1) {
    const tokens = parts[0].split(/\s+/).filter(Boolean)
    // Every token is spec vocabulary, so this is a spec with no category --
    // not a category that happens to look odd.
    return tokens.every(isSpecToken) ? { category: null, spec: parts[0] } : { category: parts[0], spec: '' }
  }
  return { category: parts[0], spec: parts.slice(1).join(' ') }
}

export function parseTireSpec(description) {
  const raw = typeof description === 'string' ? description : ''
  const { category: rawCategory, spec } = splitDescription(raw)

  let category = null, categoryRejected = null
  if (rawCategory !== null) {
    if (rawCategory.includes('<') || rawCategory.includes('>') || rawCategory.length > MAX_CATEGORY_CHARS) {
      categoryRejected = rawCategory.slice(0, 40)
    } else {
      category = rawCategory
    }
  }

  const result = {
    category,
    categoryRejected,
    loadIndex: null, loadKg: null, loadLb: null,
    speedSymbol: null, speedKmh: null, speedMph: null,
    extraLoad: false,
    sidewall: null,
    loadRange: null,
    unresolved: [],
  }

  for (const token of spec.split(/\s+/).filter(Boolean)) {
    if (token === 'XL') { result.extraLoad = true; continue }
    if (token in SIDEWALL_CODES) { result.sidewall = { code: token, text: SIDEWALL_CODES[token] }; continue }

    const loadAndSpeed = LOAD_AND_SPEED.exec(token)
    if (loadAndSpeed) {
      const index = Number(loadAndSpeed[1]), symbol = loadAndSpeed[2]
      // A token can be half-resolvable: a known index with an unknown symbol,
      // or the reverse. Each half is judged on its own so one unknown does not
      // discard a fact the string genuinely carries.
      if (index in LOAD_INDEX_KG) {
        result.loadIndex = index
        result.loadKg = LOAD_INDEX_KG[index]
        result.loadLb = poundsFromKilograms(result.loadKg)
      } else {
        result.unresolved.push(String(index))
      }
      if (symbol in SPEED_SYMBOL_KMH) {
        result.speedSymbol = symbol
        result.speedKmh = SPEED_SYMBOL_KMH[symbol]
        result.speedMph = milesPerHourFromKph(result.speedKmh)
      } else {
        result.unresolved.push(symbol)
      }
      continue
    }

    const loadRange = LOAD_RANGE.exec(token)
    if (loadRange) {
      // Both halves come from the token itself, so the letter and the ply
      // count cannot disagree with each other the way two tables would.
      result.loadRange = { code: loadRange[1], ply: Number(loadRange[2]), text: `Load range ${loadRange[1]} — a ${loadRange[2]}-ply rating` }
      continue
    }

    result.unresolved.push(token)
  }

  return result
}

/**
 * The same facts as sentences, for a screen.
 *
 * Returns `points` in the order a buyer cares about them: what it carries,
 * how fast it is rated for, then the markings. An empty `points` is the
 * correct answer for a description that carried no codes -- where the string
 * says nothing, this says nothing rather than filling the space.
 */
export function describeTireSpec(description) {
  const spec = parseTireSpec(description)
  const points = []

  if (spec.loadLb !== null) {
    points.push(`Carries up to ${spec.loadLb.toLocaleString('en-US')} lb per tire (load index ${spec.loadIndex}).`)
  }
  if (spec.speedMph !== null) {
    points.push(`Rated to ${spec.speedMph} mph (speed rating ${spec.speedSymbol}).`)
  }
  if (spec.extraLoad) {
    points.push('Extra load (XL) — rated to carry more than a standard tire of the same size.')
  }
  if (spec.loadRange) points.push(`${spec.loadRange.text}.`)
  if (spec.sidewall) points.push(`${spec.sidewall.text}.`)

  return { category: spec.category, points, unresolved: spec.unresolved }
}
