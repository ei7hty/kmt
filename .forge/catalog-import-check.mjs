/**
 * Prove a supplier import landed the way the walk file says it did (t43).
 *
 * Read-only, like deployed-site-check.mjs: it never posts, never signs in,
 * and leaves the database exactly as it found it.
 *
 * This does not know what the walk found, and does not try to. DB ADMIN
 * prepares the command and the expected counts against the walk file; this
 * script's job is to prove the number that arrived at the live API matches
 * the number that was supposed to arrive, not to predict what that number
 * should be. Typing an expected count into this file would make the file
 * the thing being checked against itself.
 */

const BASE = process.env.AUDIT_BASE || 'https://kmt.fly.dev';

/**
 * How many checks a complete run performs.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running, more means the baseline was not updated.
 *
 * Fixed at 3 plus one per sample size -- the sample list is supplied per
 * run (see below), so this file cannot know the count until it reads its
 * own input, which is why it is computed once SAMPLE_SIZES is parsed
 * rather than written as a literal.
 */
let EXPECTED_CHECKS;

let passed = 0;
let failed = 0;

function ok(message) {
  passed += 1;
  console.log(`OK: ${message}`);
}

function fail(message) {
  failed += 1;
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function check(condition, message, detail = '') {
  if (condition) ok(message);
  else fail(`${message}${detail ? ` — ${detail}` : ''}`);
}

/** The count, held against the baseline. Printed last, so it is the line a reader lands on. */
function reportCount() {
  const ran = passed + failed;
  console.log(`\n${passed} checks passed, ${failed} failed -- ${ran} of ${EXPECTED_CHECKS} expected checks ran`);
  if (ran < EXPECTED_CHECKS) {
    fail(`only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`);
  } else if (ran > EXPECTED_CHECKS) {
    fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update the sample list or this file in the same commit.`);
  }
}

/** The seven fields a customer's browser is built around, and nothing else. */
const CATALOG_FIELDS = ['id', 'name', 'size', 'price', 'inStock', 'category', 'description'];

async function main() {
  const expectedCountRaw = process.env.EXPECTED_CATALOG_COUNT;
  const sampleSizes = (process.env.SAMPLE_SIZES || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!expectedCountRaw) {
    throw new Error(
      'Set EXPECTED_CATALOG_COUNT to the row count DB ADMIN prepared from the walk file. ' +
      'This script proves the live number matches that one; it does not know it on its own.',
    );
  }
  if (sampleSizes.length === 0) {
    throw new Error(
      'Set SAMPLE_SIZES to a comma-separated list spanning multiple rim-diameter bands ' +
      '(e.g. one each from 12-14", 15-18", 19-24"), so a partial import in one band is ' +
      'not hidden by a row count that happens to land right. Each entry may be ' +
      '"size" (checks at least one supplier row) or "size:count" (checks exactly that ' +
      'many) -- a size expecting exactly one row is the sharpest sample there is: a ' +
      'truncated batch shows up there before it shows up in a size expecting hundreds.',
    );
  }
  const samples = sampleSizes.map(entry => {
    const [size, countRaw] = entry.split(':').map(part => part.trim());
    return { size, expected: countRaw === undefined ? null : Number(countRaw) };
  });
  const expectedCount = Number(expectedCountRaw);

  // 2 fixed checks (row count, no supplier fields) + 1 per sample size.
  EXPECTED_CHECKS = 2 + sampleSizes.length;

  console.log(`Catalog import check against ${BASE}, expecting ${expectedCount} rows across ${sampleSizes.length} sampled sizes`);

  const response = await fetch(`${BASE}/api/catalog`, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  const tires = body?.tires;

  if (!Array.isArray(tires)) {
    // Nothing below this can mean anything against a shape that is not a
    // catalog at all -- say so once, loudly, rather than let every
    // subsequent check fail for the same unexplained reason.
    throw new Error(`/api/catalog did not answer a tires array (status ${response.status}, body ${JSON.stringify(body).slice(0, 200)})`);
  }

  // 1. The number that arrived matches the number the walk file claims.
  check(tires.length === expectedCount,
    `catalog row count matches the walk file (${expectedCount})`,
    `got ${tires.length}`);

  // 2. A partial import can still land the right total if the count happens
  //    to work out, the way a wrong number of tires in one band can be
  //    offset by an extra few in another. Each sampled size is checked on
  //    its own so that a missing band is the line that says which one, not
  //    a single "counts don't match" with no further information.
  //
  //    Where an exact count is given, it is asserted exactly rather than
  //    "at least one": a size expecting exactly one row is the sharpest
  //    sample in the set precisely because "at least one" would let a
  //    duplicate write past unnoticed, and a size the walk covered heavily
  //    would let a truncated batch hide inside a total that still looks
  //    non-empty.
  for (const { size, expected } of samples) {
    const rowsForSize = tires.filter(tire => tire.size === size);
    const supplierRows = rowsForSize.filter(tire => tire.id.startsWith('giga-'));
    if (expected === null) {
      check(supplierRows.length > 0,
        `${size} shows a real supplier tire, not only generated coverage`,
        `${rowsForSize.length} row(s) for this size, ${supplierRows.length} from the supplier`);
    } else {
      check(supplierRows.length === expected,
        `${size} shows exactly ${expected} supplier tire(s)`,
        `got ${supplierRows.length} (${rowsForSize.length} row(s) for this size total)`);
    }
  }

  // 3. No supplier field leaked into the public response -- the same shape
  //    of check deployed-site-check.mjs already carries, repeated here
  //    because t43's own gate names it as its own line and a second reader
  //    should not have to open a different file to confirm it. This is
  //    exactly the regression #61 shipped: sku, stock, listPrice and the
  //    supplier's product URL were reaching every customer's browser.
  const wrongShape = tires.filter(tire => {
    const keys = Object.keys(tire).sort();
    return keys.length !== CATALOG_FIELDS.length ||
      !CATALOG_FIELDS.every(field => Object.prototype.hasOwnProperty.call(tire, field));
  });
  check(wrongShape.length === 0,
    `every catalog row carries exactly the seven customer fields, no supplier fields (${tires.length} rows)`,
    wrongShape.length ? `first offender: ${JSON.stringify(Object.keys(wrongShape[0]))}` : '');

  reportCount();
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(`FAIL: the catalog import check could not complete: ${error.message.split('\n')[0]}`);
  if (typeof EXPECTED_CHECKS === 'number') reportCount();
  process.exit(1);
});
