/* global window, document, innerWidth */ // used inside page.evaluate, which runs in the browser
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { signInIfAsked } from './audit-ui.mjs'

// AUDIT_BASE like the other three audits, so one server can serve the whole
// gate. The fallback is the local dev server; a hosted-shape server on any
// port works too, signed in the way the `session` block below describes.
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
 *
 * This is a second, independent authentication from signInIfAsked's -- a
 * plain fetch, not a browser session -- so it needs its own minted-session
 * fallback rather than inheriting the one in audit-ui.mjs. Checked first:
 * once Google-only sign-in is live there is no password to send here at all.
 */
const session = await (async () => {
  const minted = process.env.KMT_OWNER_SESSION_COOKIE || ''
  if (minted) return minted
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
assert.equal(inventory.status, 200, 'the owner inventory API answered ' + inventory.status +
  ' -- is KMT_OWNER_PASSWORD set to what the server was started with, or KMT_OWNER_SESSION_COOKIE to a session minted with scripts/mint-session.mjs?')
const initial = (await inventory.json()).items[0]
mkdirSync('.forge/shots', {recursive:true})
try {
  for (const viewport of [{width:1280,height:900},{width:375,height:812}]) {
    const page = await browser.newPage({viewport})
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base + '/owner')
    await signInIfAsked(page)
    await page.locator('.oi-g-row').first().waitFor()
    assert.equal(await page.locator('vite-error-overlay').count(), 0)

    // The matrix, not the card list it replaced: a real table, sortable
    // headers, a page-size control, and cells that commit on their own.
    // Everything below is a plain assert, which crashes the run on failure --
    // EXPECTED_CHECKS above counts only the size-filter `ok()` calls, and
    // this change adds and removes none of those, so it stays at 6.
    assert.equal(await page.locator('table.oi-g-table thead').count(), 1, 'the grid renders a real table head')
    for (const key of ['size', 'name', 'supplierPrice', 'price', 'margin', 'enabled', 'updated']) {
      assert.equal(await page.getByTestId('oi-sort-' + key).count(), 1, 'sortable header missing: ' + key)
    }
    assert.equal(await page.getByLabel('Rows per page').count(), 1)

    const row = page.locator('.oi-g-row').first()
    const price = row.getByLabel(/^Your price for /)
    // A different value per viewport, deliberately. Filling a cell with the
    // value it already holds fires no change event, so the grid records no
    // edit and never saves -- and the run would then be asserting that a
    // value the PREVIOUS viewport wrote is still there. That is a test that
    // passes for the wrong reason, and it is what the first run of this
    // block actually did.
    const testPrice = viewport.width === 375 ? '79.99' : '89.99'
    await price.fill(testPrice)
    await price.press('Enter')
    await page.getByTestId('oi-row-saved').first().waitFor()
    await row.getByLabel(/^Offer /).check()
    await page.getByTestId('oi-row-saved').first().waitFor()
    // Notes live behind the row's expander, so the grid stays dense.
    await row.locator('.oi-g-notes-toggle').click()
    await page.getByLabel('Owner notes').fill('Owner UI verification at ' + viewport.width)
    await page.getByLabel('Owner notes').blur()
    await page.getByTestId('oi-row-saved').first().waitFor()

    await page.reload()
    await page.locator('.oi-g-row').first().waitFor()
    assert.equal(await row.getByLabel(/^Your price for /).inputValue(), testPrice,
      'an inline price edit survives a reload with no per-row Save button anywhere')
    assert.equal(await row.getByLabel(/^Offer /).isChecked(), true)

    // Selecting rows brings up the bulk bar, and a price change over them
    // states its count and shows before/after BEFORE anything is sent.
    await row.getByLabel(/^Select /).check()
    await page.getByTestId('oi-bulk-bar').waitFor()
    await page.getByTestId('oi-bulk-price').click()
    await page.getByTestId('oi-bulk-confirm').waitFor()
    assert.match(await page.getByTestId('oi-bulk-confirm').innerText(), /\$/,
      'the price confirmation shows real money, not just a row count')
    await page.getByRole('button', { name: 'Cancel' }).click()
    assert.equal(await page.getByTestId('oi-bulk-confirm').count(), 0)
    assert.equal(await row.getByLabel(/^Your price for /).inputValue(), testPrice,
      'cancelling a bulk price change leaves every price where it was')

    // Selection must not survive a page change: an invisible selection on
    // page 7 is how rows nobody looked at get mass-edited.
    if (await page.locator('.oi-pagination').count()) {
      await page.getByRole('button', { name: 'Next →' }).click()
      await page.waitForTimeout(400)
      assert.equal(await page.getByTestId('oi-bulk-bar').count(), 0, 'selection must be dropped on a page change')
      await page.getByRole('button', { name: '← Previous' }).click()
      await page.locator('.oi-g-row').first().waitFor()
    }
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
    await page.locator('.oi-g-row').first().waitFor()
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
