/* global document */ // used inside page.evaluate, which runs in the browser
import { chromium } from 'playwright';
import https from 'node:https';
import { CATALOG_FIELDS } from './audit-ui.mjs';
import { GA_MEASUREMENT_ID } from '../src/analytics.js';

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
const EXPECTED_CHECKS = 55;

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
 * og:image, absolute and naming the canonical host (the auditor's design).
 * A relative tag is silently useless: no social scraper resolves it, and
 * nothing else in this gate reads a meta tag at all, so a wrong one would
 * ship unnoticed the way #145's tag briefly was on an earlier revision of
 * that branch -- never on main, per the auditor's own check of the merge
 * tree, but real enough during review that it earns a permanent assertion.
 *
 * Missing, relative, and wrong-host are three different mistakes with one
 * fix each, but they get one check: the detail string names which,
 * matching how this file already writes a condition plus a detail rather
 * than three near-duplicate checks for one property.
 */
function checkOgImageTag(html, canonicalHost) {
  const match = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
  if (!match) return { ok: false, url: null, reason: 'no og:image tag found' };
  const content = match[1];
  if (!/^https?:\/\//i.test(content)) {
    return { ok: false, url: content, reason: `relative, not absolute: ${content}` };
  }
  let host;
  try {
    host = new URL(content).hostname.toLowerCase();
  } catch {
    return { ok: false, url: content, reason: `not a valid URL: ${content}` };
  }
  if (host !== canonicalHost.toLowerCase()) {
    return { ok: false, url: content, reason: `host is ${host}, not the canonical host ${canonicalHost}` };
  }
  return { ok: true, url: content, reason: '' };
}

/**
 * The meta description, and the JSON-LD block beside it.
 *
 * Both are invisible on the page and visible only to a search engine, which
 * is the whole reason they need a check: nothing a person clicks through
 * would ever reveal that either had gone missing, and a build that dropped
 * them would look perfect in every other assertion here. Same argument as
 * og:image above, one layer further in -- that tag at least shows itself the
 * moment somebody shares a link.
 *
 * The description is checked for being present and non-empty rather than for
 * its wording, which is copy and changes; an empty content attribute is the
 * failure worth catching, because it reads as "described deliberately as
 * nothing" to a crawler rather than as an omission it would work around.
 */
function checkMetaDescription(html) {
  const tag = html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i)?.[0];
  if (!tag) return { ok: false, reason: 'no meta description tag found' };
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '';
  if (!content.trim()) return { ok: false, reason: 'meta description is present but empty' };
  return { ok: true, reason: `${content.trim().length} characters` };
}

/**
 * The structured data, parsed rather than pattern-matched. A JSON-LD block
 * with a trailing comma is not partially valid: every consumer drops the
 * whole thing silently, so the parse is the check.
 *
 * `AutoRepair` is a LocalBusiness subtype; the assertion is on the family
 * rather than the exact word so that narrowing the type later is not a
 * failure, while replacing it with something that is not a business is.
 */
const LOCAL_BUSINESS_TYPES = new Set(['LocalBusiness', 'AutoRepair', 'AutomotiveBusiness', 'TireShop', 'Store']);

function checkStructuredData(html, canonicalHost) {
  const block = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!block) return { ok: false, data: null, reason: 'no application/ld+json block found' };
  let data;
  try {
    data = JSON.parse(block);
  } catch (error) {
    return { ok: false, data: null, reason: `JSON-LD does not parse: ${error.message.split('\n')[0]}` };
  }
  const types = [data['@type']].flat().filter(Boolean);
  if (!types.some(type => LOCAL_BUSINESS_TYPES.has(type))) {
    return { ok: false, data, reason: `@type is ${types.join(', ') || 'absent'}, not a LocalBusiness type` };
  }
  if (!data.name) return { ok: false, data, reason: 'no name' };
  let host;
  try {
    host = new URL(data.url).hostname.toLowerCase();
  } catch {
    return { ok: false, data, reason: `url is not absolute: ${data.url ?? 'absent'}` };
  }
  if (host !== canonicalHost.toLowerCase()) {
    return { ok: false, data, reason: `url host is ${host}, not the canonical host ${canonicalHost}` };
  }
  if (!data.telephone) return { ok: false, data, reason: 'no telephone' };
  return { ok: true, data, reason: `${types.join(', ')}, ${data.name}` };
}

/**
 * The canonical tag, which src/App.jsx sets by JavaScript because index.html
 * is one static shell for every route and cannot carry two pages' worth of
 * `<link rel="canonical">`. Google documents exactly this as the accepted
 * pattern for a page that cannot set the tag in its own HTML. A page-based
 * check rather than a `fetch()` of raw HTML, because the tag does not exist
 * until the route's effect has run.
 */
async function checkCanonicalTag(page, expectedHref) {
  await page.waitForSelector('link[rel="canonical"]', { timeout: 5000 }).catch(() => {});
  const hrefs = await page.locator('link[rel="canonical"]')
    .evaluateAll(links => links.map(link => link.getAttribute('href')));
  if (hrefs.length === 0) return { ok: false, reason: 'no link rel="canonical" found' };
  if (hrefs.length > 1) {
    return { ok: false, reason: `${hrefs.length} canonical tags found, expected exactly one: ${JSON.stringify(hrefs)}` };
  }
  if (hrefs[0] !== expectedHref) return { ok: false, reason: `href is ${hrefs[0]}, expected ${expectedHref}` };
  return { ok: true, reason: '' };
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

/**
 * A size the supplier snapshot covers, and one only the generator fills.
 *
 * GENERATED_SIZE was 175/70R14 until the September 6 breadth import gave it
 * 10 real supplier rows -- the check still passes (a completed selection
 * still lands on tires, more surely than before), but it stopped exercising
 * the path its own label claims: the pure-generated fallback with no
 * supplier data behind it. 135/80R12 is confirmed absent from that import's
 * walk file, so it still tests what this constant says it tests. Confirm
 * against the current walk file before reusing this size again -- coverage
 * only grows from here.
 */
const SCRAPED_SIZE = '215/60R16';
const GENERATED_SIZE = '135/80R12';

/**
 * The static assets t60 shipped (#141, #147): 14 brand files plus the web
 * manifest, each with its own content-type. #141 landed 15 files under
 * public/brand/ with nothing in the app referencing any of them for a full
 * day -- a fully green pipeline on an asset drop nothing consumed, one
 * letter away from #61. Checked one at a time, the way the redirect hosts
 * are, so a single wrong content-type or a missing file names itself
 * rather than hiding behind a count.
 */
const BRAND_ASSETS = [
  ['/brand/icon-32.png', 'image/png'],
  ['/brand/icon-64.png', 'image/png'],
  ['/brand/icon-180.png', 'image/png'],
  ['/brand/icon-192.png', 'image/png'],
  ['/brand/icon-512.png', 'image/png'],
  ['/brand/kens-badge-dark-800.webp', 'image/webp'],
  ['/brand/kens-badge-light-800.webp', 'image/webp'],
  ['/brand/kens-dark-600.webp', 'image/webp'],
  ['/brand/kens-dark-1200.webp', 'image/webp'],
  ['/brand/kens-light-600.webp', 'image/webp'],
  ['/brand/kens-light-1200.webp', 'image/webp'],
  ['/brand/kmt-dark-800.webp', 'image/webp'],
  ['/brand/kmt-light-800.webp', 'image/webp'],
  ['/brand/og-1200x630.jpg', 'image/jpeg'],
  ['/manifest.webmanifest', 'application/manifest+json'],
];

/**
 * TRACE is a forbidden method in both browser fetch() and Node's --
 * undici answers "'TRACE' HTTP method is unsupported" before a request
 * ever leaves the process, proven directly against this same host before
 * writing the check below. node:https has no such restriction, so it is
 * the only way to ask the deployed server the question at all.
 */
function traceRequest(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'TRACE' }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow || '', location: res.headers.location || '' }));
    });
    req.on('error', reject);
    req.end();
  });
}

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

  // 3b. The release header (t53), shape only. The post-deploy CI step already
  // proves an exact match against the commit that run just built (it has
  // GITHUB_SHA; this script does not) -- what this proves instead is that the
  // header answers at all, in the shape backend/site.mjs's readRelease()
  // actually validates, whenever this script runs: hand-run against
  // production next week, not just in the minute after a deploy.
  const releaseResponse = await fetch(`${BASE}/`);
  const release = releaseResponse.headers.get('x-kmt-release') || '';
  check(/^[0-9a-f]{7,40}$/i.test(release),
    'the deployed site answers X-KMT-Release, shaped like a commit SHA',
    release ? `got ${JSON.stringify(release)}` : 'header absent');

  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

    // 4. The site answers and renders the thing a customer starts with.
    const home = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    check(home?.status() === 200, '/ answers 200', `got ${home?.status()}`);
    check(await page.locator('.fitment-option').first().isVisible().catch(() => false),
      '/ renders the size selector');

    // 4b. The two pages the sitemap lists each carry exactly one canonical
    //     tag naming themselves, not the other, and not whichever host is
    //     answering this request (see checkCanonicalTag above).
    const homeCanonical = await checkCanonicalTag(page, `https://${CANONICAL_HOST}/`);
    check(homeCanonical.ok, '/ carries exactly one canonical tag naming itself', homeCanonical.reason);

    await page.goto(`${BASE}/privacy`, { waitUntil: 'domcontentloaded' });
    const privacyCanonical = await checkCanonicalTag(page, `https://${CANONICAL_HOST}/privacy`);
    check(privacyCanonical.ok, '/privacy carries exactly one canonical tag naming itself, not /',
      privacyCanonical.reason);

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

  // Whether the flip is live is not a question this script can ask its own
  // environment: KMT_CANONICAL_HOST is a Fly secret, set on the server this
  // script audits, never on whatever runs the script -- a CI runner, a
  // laptop, anything. Reading process.env.KMT_CANONICAL_HOST here always
  // reads this process's own environment, which can never be the answer,
  // and it was false in every run this file ever made, including runs
  // against a production that was correctly flipped at the time (found by
  // DEV OPS, 2026-09-06: the redirect checks read SKIP and the closing
  // banner read OPEN two minutes after all three hosts were measured
  // redirecting correctly). Production can answer this about itself: a
  // host that 301s to the canonical is the flip, observed rather than
  // inferred, the same way X-KMT-Release and X-KMT-Service-Area answer
  // questions no environment variable available here ever could.
  const redirectResults = [];
  for (const host of REDIRECT_HOSTS) {
    try {
      const response = await fetch(`https://${host}/`, { redirect: 'manual' });
      const location = response.headers.get('location') || '';
      const redirectsToCanonical = response.status === 301 && bareHost(location) === bareHost(CANONICAL_HOST);
      redirectResults.push({ host, redirectsToCanonical, status: response.status, location, error: null });
    } catch (error) {
      redirectResults.push({ host, redirectsToCanonical: false, status: null, location: '', error });
    }
  }
  // One switch moves every host together (KMT_CANONICAL_HOST is a single
  // server-wide setting), so "some redirect, some don't" is never the flip
  // caught mid-rollout -- it is one host broken while the rest are fine,
  // and that is a real failure, not the pre-flip state this file stays
  // quiet about.
  const flipLive = redirectResults.some(result => result.redirectsToCanonical);

  for (const { host, redirectsToCanonical, status, location, error } of redirectResults) {
    const label = `${host} redirects to the canonical host (${CANONICAL_HOST})`;
    if (error) {
      fail(`${label} — ${describeFetchError(error)}`);
    } else if (redirectsToCanonical) {
      ok(label);
    } else if (!flipLive) {
      // This file gets run by hand against the new domain routinely, ahead
      // of the official cutover, and every one of those runs would
      // otherwise read as a live misconfiguration. The check cannot pass
      // before the flip regardless of which host AUDIT_BASE names, so SKIP
      // is the honest state -- verified against what every other host in
      // this same run actually did, not assumed from an unreachable secret.
      skip(label, 'none of the redirect hosts show the flip live yet');
    } else {
      fail(`${label} — got status ${status}${location ? `, location ${location}` : ', no location header'}, but another redirect host in this same run does show the flip live`);
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

  // 10. The brand assets t60 shipped, one file at a time.
  for (const [path, expectedType] of BRAND_ASSETS) {
    try {
      const response = await fetch(`${BASE}${path}`);
      const type = response.headers.get('content-type') || '';
      check(response.status === 200 && type.startsWith(expectedType),
        `${path} answers 200 as ${expectedType}`,
        `got status ${response.status}, content-type ${type || 'none'}`);
    } catch (error) {
      fail(`${path} answers 200 as ${expectedType} — ${describeFetchError(error)}`);
    }
  }

  // robots.txt and sitemap.xml both name the canonical host explicitly no
  // matter which host answers this request: a crawler reads them to learn
  // the one address worth indexing, not to learn about whichever host it
  // happened to ask.
  try {
    const robotsResponse = await fetch(`${BASE}/robots.txt`);
    const robotsType = robotsResponse.headers.get('content-type') || '';
    const robotsBody = await robotsResponse.text();
    const requiredLines = [
      'Disallow: /owner', 'Disallow: /status', 'Disallow: /confirmation', 'Disallow: /api/',
      `Sitemap: https://${CANONICAL_HOST}/sitemap.xml`,
    ];
    const missingLines = requiredLines.filter(line => !robotsBody.includes(line));
    check(robotsResponse.status === 200 && robotsType.startsWith('text/plain') && missingLines.length === 0,
      "/robots.txt answers 200 as text/plain, disallowing the customer's own pages and naming the sitemap",
      `status ${robotsResponse.status}, content-type ${robotsType || 'none'}${missingLines.length ? `, missing: ${JSON.stringify(missingLines)}` : ''}`);
  } catch (error) {
    fail(`/robots.txt answers 200 as text/plain, disallowing the customer's own pages and naming the sitemap — ${describeFetchError(error)}`);
  }

  try {
    const sitemapResponse = await fetch(`${BASE}/sitemap.xml`);
    const sitemapType = sitemapResponse.headers.get('content-type') || '';
    const sitemapBody = await sitemapResponse.text();
    const locMatches = [...sitemapBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    // The pages meant for an index and nothing else: the customer flow and the
    // privacy notice (t50). A page a customer owns never appears here.
    const expectedLocs = [`https://${CANONICAL_HOST}/`, `https://${CANONICAL_HOST}/privacy`];
    check(sitemapResponse.status === 200 && sitemapType.startsWith('application/xml') &&
      JSON.stringify(locMatches) === JSON.stringify(expectedLocs),
      '/sitemap.xml answers 200 as application/xml listing exactly / and /privacy on the canonical host',
      `status ${sitemapResponse.status}, content-type ${sitemapType || 'none'}, locs ${JSON.stringify(locMatches)}`);
  } catch (error) {
    fail(`/sitemap.xml answers 200 as application/xml listing exactly / and /privacy on the canonical host — ${describeFetchError(error)}`);
  }

  // Three behaviors, not just files: caching that actually works, a method
  // that is actually disabled, and a link that actually reaches the
  // manifest. Each is a way "the file exists" can still not be "the
  // feature works" -- #141's own lesson is that the gap between shipped
  // and consumed is exactly where nothing was watching.
  try {
    const first = await fetch(`${BASE}/brand/icon-192.png`);
    const etag = first.headers.get('etag');
    if (!etag) {
      fail('a conditional GET on /brand/icon-192.png answers 304 with an empty body — no ETag on the first response to condition on');
    } else {
      const conditional = await fetch(`${BASE}/brand/icon-192.png`, { headers: { 'If-None-Match': etag } });
      const body = await conditional.text();
      check(conditional.status === 304 && body === '',
        'a conditional GET on /brand/icon-192.png answers 304 with an empty body',
        `got status ${conditional.status}, body length ${body.length}`);
    }
  } catch (error) {
    fail(`a conditional GET on /brand/icon-192.png answers 304 with an empty body — ${describeFetchError(error)}`);
  }

  try {
    // BASE is not always the canonical host -- the deploy pipeline points it
    // at whichever domain the moment calls for, and one of the redirect
    // hosts a moment ago was BASE's own default. A method restriction
    // answered by a 301 elsewhere is not this check's concern; a redirect
    // to the canonical host is the same "not directly serving TRACE" fact
    // stated the other way, so it passes on the same evidence as the 405.
    const { status, allow, location } = await traceRequest(`${BASE}/`);
    const answersDirectly = status === 405 && allow.includes('GET') && allow.includes('HEAD');
    const redirectsToCanonical = status === 301 && bareHost(location) === bareHost(CANONICAL_HOST);
    check(answersDirectly || redirectsToCanonical,
      'TRACE / answers 405 naming GET and HEAD as the allowed methods, or redirects to the host that does',
      `got status ${status}, allow ${allow || 'none'}${location ? `, location ${location}` : ''}`);
  } catch (error) {
    fail(`TRACE / answers 405 naming GET and HEAD as the allowed methods, or redirects to the host that does — ${describeFetchError(error)}`);
  }

  try {
    const homeResponse = await fetch(`${BASE}/`);
    const homeBody = await homeResponse.text();
    // A tag search, not a literal string: Vite's HTML output is free to
    // reorder attributes or self-close the tag, and a check that cares
    // about that formatting would fail on a harmless build-output change
    // rather than on the thing that actually matters -- whether the
    // manifest is linked at all.
    const manifestLinkTag = homeBody.match(/<link\b[^>]*>/gi)?.find(tag =>
      /rel=["']manifest["']/i.test(tag) && /href=["']\/manifest\.webmanifest["']/i.test(tag));
    check(Boolean(manifestLinkTag),
      'the live index.html links the manifest, not just serves it separately',
      manifestLinkTag ? '' : homeBody.includes('manifest') ? 'a manifest reference exists but not as a <link> tag' : 'no manifest reference found');
  } catch (error) {
    fail(`the live index.html links the manifest, not just serves it separately — ${describeFetchError(error)}`);
  }

  try {
    const homeHtml = await (await fetch(`${BASE}/`)).text();
    const ogImage = checkOgImageTag(homeHtml, CANONICAL_HOST);
    check(ogImage.ok, 'og:image is absolute and names the canonical host', ogImage.reason);

    if (ogImage.url) {
      const resolvedUrl = /^https?:\/\//i.test(ogImage.url) ? ogImage.url : new URL(ogImage.url, BASE).toString();
      try {
        const imgResponse = await fetch(resolvedUrl);
        const imgType = imgResponse.headers.get('content-type') || '';
        check(imgResponse.status === 200 && imgType.startsWith('image/'),
          'the og:image URL resolves with an image content-type',
          `status ${imgResponse.status}, content-type ${imgType || 'none'}`);
      } catch (error) {
        fail(`the og:image URL resolves with an image content-type — ${describeFetchError(error)}`);
      }
    } else {
      fail('the og:image URL resolves with an image content-type — no og:image tag found to resolve');
    }
  } catch (error) {
    fail(`og:image is absolute and names the canonical host — ${describeFetchError(error)}`);
  }

  try {
    const homeHtml = await (await fetch(`${BASE}/`)).text();

    const description = checkMetaDescription(homeHtml);
    check(description.ok, 'the live index.html serves a non-empty meta description', description.reason);

    const structured = checkStructuredData(homeHtml, CANONICAL_HOST);
    check(structured.ok, 'the JSON-LD block parses and describes this business at the canonical host', structured.reason);

    // The two images the structured data points a search engine at. They are
    // separate URLs from og:image above and can rot independently of it --
    // a renamed brand file would leave the share preview working and the
    // search listing without a picture.
    const assets = [['image', structured.data?.image], ['logo', structured.data?.logo]].filter(([, url]) => url);
    if (assets.length === 0) {
      fail('the JSON-LD image and logo resolve with an image content-type — no image or logo in the structured data');
    } else {
      const problems = [];
      for (const [field, url] of assets) {
        try {
          const response = await fetch(/^https?:\/\//i.test(url) ? url : new URL(url, BASE).toString());
          const type = response.headers.get('content-type') || '';
          if (response.status !== 200 || !type.startsWith('image/')) {
            problems.push(`${field}: status ${response.status}, content-type ${type || 'none'}`);
          }
        } catch (error) {
          problems.push(`${field}: ${describeFetchError(error)}`);
        }
      }
      check(problems.length === 0,
        'the JSON-LD image and logo resolve with an image content-type',
        problems.join('; '));
    }
  } catch (error) {
    fail(`the live index.html serves a non-empty meta description — ${describeFetchError(error)}`);
  }

  // The service-area check, on or off, as its own header (t48/#182's config,
  // answered the same minimal way as X-KMT-Release: a boolean, never the
  // radius, base ZIP or review distance readServiceAreaConfig() also
  // produces). This does not assert which value is correct -- on is the
  // default and off is a deliberate, explicit choice, and a generic audit
  // script has no business hardcoding which one production should be in
  // right now. What it proves is that the answer is legible at all, on
  // every deploy, without anyone needing a shell on the machine to find out.
  try {
    const serviceAreaResponse = await fetch(`${BASE}/`);
    const serviceArea = (serviceAreaResponse.headers.get('x-kmt-service-area') || '').toLowerCase();
    check(serviceArea === 'on' || serviceArea === 'off',
      'the deployed site answers X-KMT-Service-Area as on or off',
      serviceArea ? `got ${JSON.stringify(serviceArea)}` : 'header absent');
    if (serviceArea === 'on' || serviceArea === 'off') {
      console.log(`    service-area check is currently ${serviceArea.toUpperCase()} on ${BASE} (this run's own read, not a cached or assumed value)`);
    }
  } catch (error) {
    fail(`the deployed site answers X-KMT-Service-Area as on or off — ${describeFetchError(error)}`);
  }

  // GA4's measurement id, checked against the deployed bundle rather than
  // trusted from source: a wrong id fails completely silently (GA accepts
  // the hits, nothing errors, the audits pass, and the data lands in a
  // property nobody is watching, discovered weeks later). This proves the
  // constant src/analytics.js exports actually reached what was deployed --
  // it cannot prove the value itself is the one Ken's own GA4 account
  // expects, which nothing in this repository can check.
  try {
    const homeHtml = await (await fetch(`${BASE}/`)).text();
    const scriptSrc = homeHtml.match(/<script\b[^>]*type=["']module["'][^>]*\bsrc=["']([^"']+)["']/i)?.[1];
    if (!scriptSrc) {
      fail('the deployed bundle carries the GA4 measurement id src/analytics.js exports — no module script tag found on /');
    } else {
      const bundle = await (await fetch(new URL(scriptSrc, BASE).toString())).text();
      const present = bundle.includes(GA_MEASUREMENT_ID);
      check(present, 'the deployed bundle carries the GA4 measurement id src/analytics.js exports',
        present ? '' : `${GA_MEASUREMENT_ID} not found in ${scriptSrc}`);
    }
  } catch (error) {
    fail(`the deployed bundle carries the GA4 measurement id src/analytics.js exports — ${describeFetchError(error)}`);
  }

  reportCount();

  // A SKIP is honest and easy to scroll past: the three above read this way
  // for a day before anyone acted on them. This is not "not applicable" --
  // it is an unfinished cutover step with a known fix and a known order.
  // Printed after reportCount() on purpose, same reason that function is:
  // last is the line a reader actually lands on. Keyed off flipLive, the
  // observed result above, not a guess at which secret is missing: this
  // script cannot see KMT_CANONICAL_HOST and must not claim to.
  if (!flipLive) {
    console.log(
      `\nOPEN: none of ${REDIRECT_HOSTS.join(', ')} redirect to the canonical host yet. Until one does, ${[CANONICAL_HOST, ...REDIRECT_HOSTS].join(', ')} ` +
      'all serve identical content with no redirect between them -- four crawlable copies of one site, ' +
      'not a missing feature. Fix is docs/operations.md Step 2 (KMT_CANONICAL_HOST) -- but only after Step 1 ' +
      '(KMT_ALLOWED_HOSTS) has shipped, or the flip 403s every visitor.'
    );
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  // A script that cannot run is not a site that passed.
  console.error(`FAIL: the deployed-site check could not complete: ${error.message.split('\n')[0]}`);
  reportCount();
  process.exit(1);
});
