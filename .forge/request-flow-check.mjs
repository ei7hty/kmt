import { chromium } from 'playwright'
import { expandTireList, openOwnerQuotes } from './audit-ui.mjs'
import assert from 'node:assert/strict'

const base = process.env.AUDIT_BASE || 'http://localhost:4183'

/**
 * How many checks a complete run performs, across both widths.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 34

const browser = await chromium.launch()
let checks = 0
try {
  for (const width of [375, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
    const overflow = () => page.locator('.order-section').evaluate(el => [...el.querySelectorAll('*')].filter(node => node.getClientRects().length).every(node => node.getBoundingClientRect().right <= innerWidth + 1))
    await page.goto(base)
    // A real supplier row, not a seed: a tire whose id doesn't start with
    // giga- is itself an exception reason, so this has to be a supplier tire
    // to stay a clean, non-exception path through the form.
    for (const value of ['205', '65', '15']) await page.locator('.fitment-option').getByText(value, { exact: true }).click()
    await page.locator('#fitmentZip').fill('02149')
    await page.getByRole('button', { name: 'Continue to tires' }).click()
    await expandTireList(page)
    await page.locator('.tire-option').filter({ hasText: 'Waterfall Quattro' }).click()
    await page.getByLabel('Year', { exact: true }).fill('2020')
    await page.getByLabel('Make', { exact: true }).fill('Honda')
    await page.getByLabel('Model', { exact: true }).fill('Civic')
    check((await page.locator('.vehicle-preview').innerText()).includes('2020 Honda Civic'), 'guided vehicle entry composes the description')
    await page.getByLabel('Make', { exact: true }).fill('Toyota')
    check(await page.getByLabel('Model', { exact: true }).inputValue() === '', 'changing make clears the previous model')
    await page.getByLabel('Model', { exact: true }).fill('Corolla')
    check(await overflow(), 'vehicle controls fit within viewport')
    await page.locator('.step-panel').screenshot({ path: `.forge/shots/request-vehicle-${width}.png` })
    await page.getByRole('button', { name: 'Continue to mobile service' }).click()
    check(await page.locator('#serviceZip').inputValue() === '02149', 'earlier ZIP carries into service details')
    await page.getByRole('button', { name: 'Request my quote' }).click()
    check(await page.locator('#location').getAttribute('aria-invalid') === 'true' && await page.locator('#date').getAttribute('aria-invalid') === 'true', 'empty address and date get inline errors')
    check(await page.locator('#customerName').getAttribute('aria-invalid') === 'true' && await page.locator('#customerEmail').getAttribute('aria-invalid') === 'true', 'empty name and email get inline errors')
    await page.getByRole('button', { name: 'Roadside', exact: false }).click()
    check(await page.getByLabel('Road, exit or nearby address').isVisible(), 'roadside option provides relevant address guidance')
    await page.locator('#location').fill('I-93 North, Exit 20, Boston')
    await page.locator('#locationNotes').fill('Blue sedan near the gas station')
    await page.getByRole('button', { name: 'Tomorrow', exact: true }).click()
    check(!!await page.locator('#date').inputValue(), 'date shortcut fills the date input')
    await page.getByRole('button', { name: 'Back to tire selection' }).click()
    check(await page.getByLabel('Model', { exact: true }).inputValue() === 'Corolla', 'vehicle survives back navigation')
    await page.getByRole('button', { name: 'Continue to mobile service' }).click()
    check(await page.locator('#locationNotes').inputValue() === 'Blue sedan near the gas station', 'service details survive back navigation')
    check(await overflow(), 'service controls fit within viewport')
    await page.locator('#customerName').fill('Jamie Rivera')
    await page.locator('#customerEmail').fill('jamie@example.com')
    await page.locator('#customerPhone').fill('(617) 410-8319')
    await page.locator('.step-panel').screenshot({ path: `.forge/shots/request-service-${width}.png` })
    await page.getByRole('button', { name: 'Request my quote' }).click()
    await page.waitForSelector('.success-message')
    check(await page.locator('.success-message').isVisible(), 'submitting acknowledges the request on screen')

    // What the customer typed is checked where it matters -- on the owner's
    // screen. Reading it back out of the browser's own storage proved that a
    // row existed, not that the request reached the person who has to act on
    // it, and it stopped working the moment requests moved to the server.
    await openOwnerQuotes(page)
    const ownerText = await page.locator('.owner-content').first().innerText()
    check(ownerText.includes('2020 Toyota Corolla'), 'owner sees the vehicle the customer entered')
    check(ownerText.includes('02149'), 'owner sees the ZIP the customer entered')
    check(ownerText.includes('Blue sedan'), 'owner sees the access instructions the customer entered')
    check(ownerText.includes('Jamie Rivera') && ownerText.includes('jamie@example.com') && ownerText.includes('+16174108319'), 'owner sees the contact name, email and normalized phone the customer entered')
    check(errors.length === 0, 'no browser runtime errors')
    await page.close()
  }
  console.log(`${checks}/${EXPECTED_CHECKS} request flow checks passed`)
  if (checks < EXPECTED_CHECKS) {
    console.error(`FAIL: only ${checks} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`)
    process.exitCode = 1
  } else if (checks > EXPECTED_CHECKS) {
    console.error(`FAIL: ${checks} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`)
    process.exitCode = 1
  }
} catch (error) {
  // An assertion stops the run where it failed; say how far it got.
  console.error(`FAIL after ${checks} of ${EXPECTED_CHECKS} checks: ${error.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
