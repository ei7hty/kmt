/* global window, document, innerWidth */ // used inside page.evaluate, which runs in the browser
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { signInIfAsked } from './audit-ui.mjs'

// AUDIT_BASE like the other three audits, so one server can serve the whole
// gate. The fallback is the local dev server; a hosted-shape server on any
// port works too, with KMT_OWNER_PASSWORD set to what it was started with.
const base = process.env.AUDIT_BASE || 'http://127.0.0.1:4180'

/**
 * How many of *this script's own* counted checks a complete run performs.
 *
 * Unlike the other four audits, most of this script's assertions are plain
 * `assert.equal` calls that already crash the run on failure -- counting them
 * too would just duplicate that. This constant covers only the size-filter
 * checks below, added because that filter had no coverage at all: change it
 * in the same commit as a check you add or remove there.
 */
const EXPECTED_CHECKS = 6

let checksPassed = 0
let checksFailed = 0

function ok(msg) {
  checksPassed += 1
  console.log('OK: ' + msg)
}

function fail(msg) {
  checksFailed += 1
  console.error('FAIL: ' + msg)
  process.exitCode = 1
}

function reportCounted() {
  const ran = checksPassed + checksFailed
  console.log(`\n${checksPassed} OK, ${checksFailed} FAIL -- ${ran} of ${EXPECTED_CHECKS} expected size-filter checks ran`)
  if (ran < EXPECTED_CHECKS) {
    fail(`only ${ran} of ${EXPECTED_CHECKS} size-filter checks ran. A check that stopped running is not a check that passed.`)
  } else if (ran > EXPECTED_CHECKS) {
    fail(`${ran} size-filter checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`)
  }
}

/**
 * The owner API from outside the browser, signed in when the server asks.
 *
 * backend/server.mjs answers 401 to everything under /api/owner without a
 * session; backend/dev.mjs has no login route at all and answers 404 to the
 * attempt. Either way the calls below have to work, because they read the
 * first tire before the run and put its offer back after.
 */
const session = await (async () => {
  const password = process.env.KMT_OWNER_PASSWORD || ''
  if (!password) return ''
  const response = await fetch(base + '/api/owner/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  })
  if (response.status === 404) return ''
  assert.equal(response.status, 200, 'owner sign-in for the API calls')
  return response.headers.get('set-cookie').split(';')[0]
})()
const ownerFetch = (path, init = {}) => fetch(base + path, {
  ...init, headers: { ...(init.headers || {}), ...(session ? { Cookie: session } : {}) },
})

const browser = await chromium.launch()
const errors = []
const inventory = await ownerFetch('/api/owner/inventory')
assert.equal(inventory.status, 200, 'the owner inventory API answered ' + inventory.status + ' -- is KMT_OWNER_PASSWORD set to what the server was started with?')
const initial = (await inventory.json()).items[0]
mkdirSync('.forge/shots', {recursive:true})
try {
  for (const viewport of [{width:1280,height:900},{width:375,height:812}]) {
    const page = await browser.newPage({viewport})
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base + '/owner')
    await signInIfAsked(page)
    await page.locator('.oi-tire').first().waitFor()
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    const card = page.locator('.oi-tire').first()
    await card.getByLabel('Your price per tire ($)').fill('89.99')
    await card.getByLabel('Offer this tire').check()
    await card.getByLabel('Owner notes').fill('Owner UI verification')
    await card.getByTestId('oi-save-offer').click()
    await page.getByTestId('oi-save-notice').waitFor()
    await page.reload()
    await page.locator('.oi-tire').first().waitFor()
    assert.equal(await card.getByLabel('Your price per tire ($)').inputValue(), '89.99')
    assert.equal(await card.getByLabel('Offer this tire').isChecked(), true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({path:'.forge/shots/owner-inventory-' + viewport.width + '.png'})
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    assert.equal(overflow, false, 'Owner viewport overflow')

    const sizeInput = page.getByLabel('Tire size')
    const refreshButton = page.locator('section[aria-label="Supplier refresh"] .oi-primary')

    // Half-typed: a prefix of 205/65R15's digits that is not itself an exact
    // size, so the filter must stay pending rather than guessing a commit.
    await sizeInput.fill('20565')
    await page.locator('.oi-size-matches').waitFor()
    assert.equal(await refreshButton.isDisabled(), true, 'refresh should be disabled while a size is only half-typed')
    assert.equal((await refreshButton.innerText()).trim(), 'Finish choosing a size to refresh it')
    ok('refresh disables while a size is half-typed, at ' + viewport.width)

    // Committing an exact size: value must reach the inventory query, not just the input.
    const inventoryRequest = page.waitForRequest(req =>
      req.url().includes('/api/owner/inventory') && req.url().includes(encodeURIComponent('205/65R15')))
    await sizeInput.fill('205/65R15')
    await inventoryRequest
    ok('typing an exact size sends it to the inventory query, at ' + viewport.width)

    assert.equal(await sizeInput.inputValue(), '205/65R15')
    assert.equal(await refreshButton.isDisabled(), false, 'refresh should enable once a size is committed')
    assert.equal((await refreshButton.innerText()).trim(), 'Refresh 205/65R15')
    ok('typing an exact size commits it and enables refresh, at ' + viewport.width)

    // Clear the filter so the later search check isn't scoped to one size.
    await sizeInput.fill('')
    await page.waitForTimeout(250)

    await page.getByTestId('nav-quote-requests').click()
    await signInIfAsked(page)
    await page.getByTestId('quote-requests-heading').waitFor()
    await page.getByTestId('nav-inventory').click()
    await page.locator('.oi-tire').first().waitFor()
    await page.getByLabel('Search tires or SKU').fill('NO-SUCH-TIRE-XYZ')
    await page.getByTestId('oi-empty-state').waitFor()
    await page.goto(base + '/')
    await page.getByTestId('hero-heading').waitFor()
    console.log('PASS owner save/reload, navigation, search, customer home, and no overflow at ' + viewport.width)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS no browser runtime errors')
  reportCounted()
} finally {
  const latest = (await (await ownerFetch('/api/owner/inventory?search=' + encodeURIComponent(initial.id))).json()).items.find(t => t.id === initial.id)
  if (latest) await ownerFetch('/api/owner/offers/' + encodeURIComponent(initial.id), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...initial.offer, version:latest.offer.version})})
  await browser.close()
}
