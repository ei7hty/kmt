import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The built bundle is public. Supplier data is not supposed to be in it.
 *
 * `src/data/scraped-tires.json` used to be imported straight into
 * `src/data/catalog.js`'s static fallback, which put every scraped row --
 * `source.sku`, stock counts, `listPrice`, the supplier's product URL, and
 * `DEFAULT_MARKUP_SETTINGS` -- into the deployed JS. The live catalog is
 * supposed to be the only path a customer sees real supplier data, through
 * `GET /api/catalog`, never the static build. This greps `dist/` after
 * `npm run build` for the shapes that import would have left behind.
 *
 * The markers are object-key shape, `key:` with no quotes -- not `sku` or
 * `listPrice` alone, and not the quoted `"sku":` shape either. Measured
 * against this toolchain, not assumed: esbuild minifies a bundled JSON
 * import into an object literal with bare identifier keys --
 * `source:{sku:"WATF...",stock:4,listPrice:38.93,...}` -- never a quoted
 * key. A first version of this check used the quoted form and passed 3 of 3
 * against a build that still had 1083 SKUs in it; this version is proven
 * against that same leaking build below it merged only after failing on.
 * The bare *words* `sku` and `listPrice` are not used either, because both
 * also appear as legitimate property-access identifiers in the owner
 * screen's own code (`tire.source?.listPrice`), which minifies to
 * `.listPrice`/`?.listPrice` -- never `listPrice:` with a colon -- and ships
 * in the same single-bundle app. `src/` and `backend/` were checked: neither
 * writes `sku`, `listPrice` or `stock` as an object key anywhere a browser
 * bundle would see it. Likewise `giga-tires.com` alone matches the owner
 * screen's supplier-link allowlist and bookmarklet, both intentional.
 */
const DIST = process.env.DIST_DIR || path.join(process.cwd(), 'dist')

/**
 * How many checks a complete run performs.
 *
 * One per forbidden string. Change this in the same commit as a term you add
 * or remove below -- the run fails if a different number of checks executed,
 * the same contract every other audit script here carries.
 */
const EXPECTED_CHECKS = 3

/**
 * Shapes that should never appear in a built bundle: the bare-key form a
 * bundled `scraped-tires.json` import would render as after minification.
 * Structural, not a value from today's snapshot, so it still catches the
 * leak after the next scrape changes every SKU and price in the file.
 */
const FORBIDDEN = ['sku:', 'listPrice:', 'scrapedAt:']

let passed = 0
let failed = 0

function ok(msg) {
  passed += 1
  console.log(`OK: ${msg}`)
}

function fail(msg) {
  failed += 1
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

function walk(dir) {
  let files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files = files.concat(walk(full))
    else files.push(full)
  }
  return files
}

if (!statSync(DIST, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`${DIST} does not exist. Run \`npm run build\` first, or set DIST_DIR.`)
  process.exit(1)
}

const files = walk(DIST).filter(f => /\.(js|css|html|map)$/.test(f))
if (files.length === 0) {
  fail(`no built files found under ${DIST}. A check that found nothing did not check anything.`)
  process.exit(1)
}

const bundle = files.map(f => readFileSync(f, 'utf8')).join('\n')

for (const term of FORBIDDEN) {
  if (bundle.includes(term)) fail(`the built bundle contains "${term}" -- supplier data is leaking into the public build`)
  else ok(`the built bundle does not contain "${term}"`)
}

const ran = passed + failed
console.log(`\n${passed} OK, ${failed} FAIL -- ${ran} of ${EXPECTED_CHECKS} expected checks ran`)
if (ran < EXPECTED_CHECKS) {
  fail(`only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`)
} else if (ran > EXPECTED_CHECKS) {
  fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`)
}
