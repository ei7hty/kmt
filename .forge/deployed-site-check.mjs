import { chromium } from 'playwright';

/**
 * What a deploy has to prove, without touching anything.
 *
 * The three flow audits perform the journey: they submit a request, approve it
 * and pay for it. Against the temporary database the pre-merge gate builds,
 * that is exactly right and it is where the flow is proved. Against the
 * deployed site it would write real rows into the real database, and every
 * deploy would leave a fabricated request in the owner's list -- paid. The
 * owner's screen is a record of what customers asked for, and a record that
 * fills up with our own test data is not one.
 *
 * So this run proves the deploy rather than the flow: that the site is up, that
 * the catalog it serves is the shape a customer's browser expects, that the
 * routes resolve, that the owner's data is still behind its password, and that
 * nothing overflows on a phone. It reads. It never posts, never signs in, and
 * leaves the database exactly as it found it.
 */

const BASE = process.env.AUDIT_BASE || 'https://kmt.fly.dev';

/**
 * How many checks a complete run performs.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 20;

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
    fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`);
  }
}

/** The seven fields a customer's browser is built around, and nothing else. */
const CATALOG_FIELDS = ['id', 'name', 'size', 'price', 'inStock', 'category', 'description'];

/** A size the supplier snapshot covers, and one only the generator fills. */
const SCRAPED_SIZE = '215/60R16';
const GENERATED_SIZE = '175/70R14';

/** Anything sticking out past the viewport, which is what a phone shows as a sideways scroll. */
async function overflow(page) {
  return page.evaluate(() => ({
    doc: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

/**
 * Walk the size selector the way a customer does, and see where it lands.
 *
 * It counts tire options; it never looks for a tire by name, and it never
 * expands the list. The customer list is capped with a "Show all N" control, so
 * a named tire may sit behind it and its position moves as the owner curates.
 * What a deploy has to prove is that a completed selection leads somewhere --
 * one or more options rather than a dead end -- and that answer is the same
 * before and after any change to how the list is paged. Naming a tire here
 * would make this check fail for reasons that have nothing to do with the
 * deploy.
 */
async function selectSize(page, size) {
  const [width, rest] = size.split('/');
  const [ratio, diameter] = rest.split('R');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  for (const value of [width, ratio, diameter]) {
    await page.click(`.fitment-option:has-text("${value}")`, { timeout: 20000 });
  }
  await page.click('button:has-text("Continue to tires")', { timeout: 20000 });
  await page.waitForSelector('.tire-option, .tire-empty', { timeout: 20000 });
  return {
    tires: await page.locator('.tire-option').count(),
    empty: await page.locator('.tire-empty').isVisible().catch(() => false),
  };
}

async function main() {
  console.log(`Deployed-site check against ${BASE}`);

  // 1. The API, read directly. No browser needed to know whether the catalog is
  //    the shape the customer flow is built on.
  const catalogResponse = await fetch(`${BASE}/api/catalog`, { headers: { Accept: 'application/json' } });
  check(catalogResponse.status === 200, 'GET /api/catalog answers 200', `got ${catalogResponse.status}`);

  const type = catalogResponse.headers.get('content-type') || '';
  check(type.includes('application/json'), 'GET /api/catalog answers JSON', `content-type: ${type || 'none'}`);

  const catalog = await catalogResponse.json().catch(() => null);
  const tires = catalog?.tires;
  check(Array.isArray(tires) && tires.length > 0, 'the catalog is a non-empty list of tires',
    Array.isArray(tires) ? 'it is empty' : 'it is not an array');

  if (Array.isArray(tires) && tires.length > 0) {
    // Every row, not a sample: one leaking row is the whole problem.
    const wrongShape = tires.filter(tire => {
      const keys = Object.keys(tire).sort();
      return keys.length !== CATALOG_FIELDS.length ||
        !CATALOG_FIELDS.every(field => Object.prototype.hasOwnProperty.call(tire, field));
    });
    check(wrongShape.length === 0,
      `every catalog row carries exactly the seven customer fields (${tires.length} rows)`,
      wrongShape.length ? `first offender: ${JSON.stringify(Object.keys(wrongShape[0]))}` : '');
  }

  // 2. The machine says it can reach its own database, and says so to anyone:
  //    the platform check that reads this arrives with no session, so a health
  //    endpoint that needs one is a machine marked unhealthy forever.
  const healthResponse = await fetch(`${BASE}/api/health`, { headers: { Accept: 'application/json' } });
  const health = await healthResponse.json().catch(() => null);
  check(healthResponse.status === 200 && health?.ok === true,
    'GET /api/health answers 200 with ok:true, and needs no session',
    `status ${healthResponse.status}, body ${JSON.stringify(health)}`);

  // 3. The owner's data is still behind the password. Asked without a session,
  //    which is the only way this script ever asks.
  const ownerResponse = await fetch(`${BASE}/api/owner/inventory`, { headers: { Accept: 'application/json' } });
  check(ownerResponse.status === 401, 'GET /api/owner/inventory refuses without a session',
    `got ${ownerResponse.status}`);

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

    // 4. The site answers and renders the thing a customer starts with.
    const home = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    check(home?.status() === 200, '/ answers 200', `got ${home?.status()}`);
    check(await page.locator('.fitment-option').first().isVisible().catch(() => false),
      '/ renders the size selector');

    // 5. Hard navigation to each route returns the app, not a 404. This is the
    //    SPA fallback, it is server configuration rather than app code, and it
    //    has broken production before -- which is why it is checked here and
    //    cannot be checked anywhere else.
    for (const path of ['/status', '/owner', '/owner/quotes']) {
      const response = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      const rendered = await page.locator('#root').count();
      check(response?.status() === 200 && rendered > 0,
        `hard navigation to ${path} returns the app shell, not a 404`,
        `status ${response?.status()}, #root ${rendered}`);
    }

    // 6. The owner screen asks for the password rather than showing anything.
    await page.goto(`${BASE}/owner`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.oi-signin, .oi-results', { timeout: 20000 }).catch(() => {});
    check(await page.locator('.oi-signin').count() > 0,
      '/owner shows the sign-in form to a visitor with no session');

    // 7. A completed selection lands on tires, for a size the supplier covers
    //    and a size only the generator fills. Both, because they come from
    //    different halves of the catalog and only one of them is live data.
    for (const [size, label] of [[SCRAPED_SIZE, 'a scraped size'], [GENERATED_SIZE, 'a generated size']]) {
      const landing = await selectSize(page, size);
      check(landing.tires > 0 && !landing.empty,
        `a completed selection for ${size} (${label}) lands on tires`,
        `${landing.tires} tires, empty state ${landing.empty}`);
    }

    // 8. Nothing scrolls sideways, on a phone or on a desktop.
    for (const viewport of [{ name: 'phone', width: 375, height: 812 }, { name: 'desktop', width: 1280, height: 900 }]) {
      const sized = await (await browser.newContext({ viewport })).newPage();
      for (const path of ['/', '/status', '/owner']) {
        await sized.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
        await sized.waitForTimeout(500);
        const { doc, scroll } = await overflow(sized);
        check(scroll <= doc + 1, `${path} does not scroll sideways at ${viewport.width}px`,
          `document ${doc}, content ${scroll}`);
      }
      await sized.context().close();
    }
  } finally {
    await browser.close();
  }

  reportCount();
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  // A script that cannot run is not a site that passed.
  console.error(`FAIL: the deployed-site check could not complete: ${error.message.split('\n')[0]}`);
  reportCount();
  process.exit(1);
});
