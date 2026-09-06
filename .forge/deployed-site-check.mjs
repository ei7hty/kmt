import { chromium } from 'playwright';
import { CATALOG_FIELDS } from './audit-ui.mjs';

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
 * The domain, as configuration rather than a literal (t53).
 *
 * CANONICAL_HOST is the apex the app is meant to live on -- decided, but still
 * read from the environment rather than typed into the script a second time,
 * because the one time this sprint a domain literal got typed into a file it
 * had to be undone an hour later. REDIRECT_HOSTS are the names expected to
 * send a visitor on to it once the flip is live. HEALTH_OTHER_HOST is checked
 * for /api/health alongside AUDIT_BASE (see check 2 above): kmt.fly.dev
 * specifically, never one of the DNS aliases, because an alias tests the
 * resolver and not the app -- it is the one host KMT_ALLOWED_HOSTS could omit
 * by accident while every customer-facing name kept working.
 */
const CANONICAL_HOST = process.env.CANONICAL_HOST || 'kensmobiletire.com';
const REDIRECT_HOSTS = (process.env.REDIRECT_HOSTS || 'www.kensmobiletire.com,order.kensmobiletire.com,kmt.fly.dev')
  .split(',').map(host => host.trim()).filter(Boolean);
const HEALTH_OTHER_HOST = process.env.HEALTH_OTHER_HOST || 'kmt.fly.dev';

/**
 * How many checks a complete run performs.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 25;

let passed = 0;
let failed = 0;
let skipped = 0;

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

/**
 * No DNS record and "resolves but answers wrong" have different fixes -- one
 * at the registrar, one in the app -- and this check is the only thing that
 * will be looking when it happens, so it says which.
 */
function describeFetchError(error) {
  const code = error.cause?.code || error.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `no DNS record for this host (${code})`;
  return `request failed: ${error.message.split('\n')[0]}`;
}

/**
 * A check counted as ran, neither passed nor failed -- because the thing it
 * proves has not happened yet. Never printed as OK: a skip that looks like a
 * pass is exactly how a check quietly stops being able to fail.
 */
function skip(message, reason) {
  skipped += 1;
  console.log(`SKIP: ${message} (${reason})`);
}

/** The count, held against the baseline. Printed last, so it is the line a reader lands on. */
function reportCount() {
  const ran = passed + failed + skipped;
  console.log(`\n${passed} checks passed, ${failed} failed, ${skipped} skipped -- ${ran} of ${EXPECTED_CHECKS} expected checks ran`);
  if (ran < EXPECTED_CHECKS) {
    fail(`only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`);
  } else if (ran > EXPECTED_CHECKS) {
    fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`);
  }
  if (skipped > 0) {
    console.log(`${skipped} of those are SKIP, not OK -- read them, they are not the same as a pass.`);
  }
}

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

  // 9. The domain (t53). Read entirely: no browser, and no literal domain --
  //    the apex-versus-subdomain decision changed once already this sprint,
  //    and reading CANONICAL_HOST from configuration is what kept that a
  //    value change instead of a rewrite.
  try {
    const canonicalResponse = await fetch(`https://${CANONICAL_HOST}/`);
    check(canonicalResponse.status === 200, `the canonical host (${CANONICAL_HOST}) answers 200 over HTTPS`,
      `got ${canonicalResponse.status}`);
  } catch (error) {
    fail(`the canonical host (${CANONICAL_HOST}) answers 200 over HTTPS — ${describeFetchError(error)}`);
  }

  // Bare hostname, no scheme, no trailing slash -- dumb on purpose. A guard
  // that is itself clever is a guard nobody can verify by reading, and the
  // bundle-leak check that once passed 3-of-3 on a leaking build is why that
  // matters here: this one exists to catch a state rare enough that it will
  // be read far more often than it ever fires.
  const bareHost = (value) => value.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  const flipConfigured = Boolean(process.env.KMT_CANONICAL_HOST);
  const auditBaseIsCanonical = bareHost(BASE) === bareHost(CANONICAL_HOST);

  for (const host of REDIRECT_HOSTS) {
    const label = `${host} redirects to the canonical host (${CANONICAL_HOST})`;
    if (!flipConfigured) {
      if (auditBaseIsCanonical) {
        // The workflow's half of the flip (AUDIT_BASE) moved to the canonical
        // host; the backend's half (KMT_CANONICAL_HOST) did not. That is not
        // "not yet" -- it is the two halves of one cutover disagreeing, and
        // it is invisible from outside: the canonical host answers fine
        // throughout, which is exactly what would let this sit unnoticed.
        fail(`${label} — AUDIT_BASE already points at the canonical host but KMT_CANONICAL_HOST is not set on the server`);
      } else {
        skip(label, 'KMT_CANONICAL_HOST not set yet');
      }
      continue;
    }
    try {
      const response = await fetch(`https://${host}/`, { redirect: 'manual' });
      const location = response.headers.get('location') || '';
      const redirectsToCanonical = response.status === 301 && bareHost(location) === bareHost(CANONICAL_HOST);
      check(redirectsToCanonical, label,
        `got status ${response.status}${location ? `, location ${location}` : ', no location header'}`);
    } catch (error) {
      fail(`${label} — ${describeFetchError(error)}`);
    }
  }

  // kmt.fly.dev specifically, not one of the DNS aliases: www and order are
  // names for the same machine AUDIT_BASE already tests (check 2 above), so
  // testing them again would prove the resolver works, not the app. This is
  // the one host KMT_ALLOWED_HOSTS could omit by accident during the flip
  // while every customer-facing name kept answering -- nothing else in this
  // file would notice that.
  try {
    const otherHealthResponse = await fetch(`https://${HEALTH_OTHER_HOST}/api/health`, { headers: { Accept: 'application/json' } });
    const otherHealth = await otherHealthResponse.json().catch(() => null);
    check(otherHealthResponse.status === 200 && otherHealth?.ok === true,
      `GET /api/health on ${HEALTH_OTHER_HOST} answers 200 with ok:true`,
      `status ${otherHealthResponse.status}, body ${JSON.stringify(otherHealth)}`);
  } catch (error) {
    fail(`GET /api/health on ${HEALTH_OTHER_HOST} answers 200 with ok:true — ${describeFetchError(error)}`);
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
