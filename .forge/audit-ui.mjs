/**
 * Driving the app the way a person does.
 *
 * The audits used to seed state by writing localStorage and read it back the
 * same way. That worked while the whole flow lived in the browser, and it was
 * always a shortcut: it asserted that the store held a row, not that a customer
 * could get a quote or that an owner could see it. Once requests moved to the
 * backend the shortcut stopped working entirely -- which is the useful kind of
 * failure, because it says the audit was testing the wrong thing.
 *
 * Everything here goes through the interface. Seeding a state means performing
 * it: submit through the form, approve on the owner screen, pay on the status
 * page. Checking that data reached the owner means reading the owner's screen.
 * The audit then holds whether or not the data lives in this browser, which is
 * how it can gate a change that moves it.
 */

/** Where the owner password comes from, when the server is a hosted one. */
const OWNER_PASSWORD = process.env.KMT_OWNER_PASSWORD || ''

/**
 * Sign in if the server asks, and say nothing if it does not.
 *
 * A local server binds loopback and has no password, so no form appears. A
 * hosted one does. The audit has to work against both, because the gate runs
 * the hosted shape and a developer runs the local one.
 */
export async function signInIfAsked(page) {
  const form = page.locator('.oi-signin')
  if (!(await form.count())) return false
  if (!OWNER_PASSWORD) {
    throw new Error(
      'The owner screen asked for a password and KMT_OWNER_PASSWORD is not set. ' +
      'Start the server with one and pass it to the audit.',
    )
  }
  await page.fill('#owner-password', OWNER_PASSWORD)
  await page.click('button:has-text("Sign in")')
  await page.waitForSelector('.oi-signin', { state: 'detached', timeout: 15000 })
  return true
}

/** Follow the visible links to the owner's quote list, signing in if asked. */
export async function openOwnerQuotes(page, { from = 'customer' } = {}) {
  if (from === 'customer') {
    await page.click('button:has-text("Owner Review")')
    await page.waitForURL('**/owner')
  }
  await signInIfAsked(page)
  await page.getByRole('button', { name: 'Quote requests' }).click()
  await page.waitForURL('**/owner/quotes')
  await signInIfAsked(page)
  // The list arrives from the server on a backend build and from this browser
  // on a store build; either way it is on screen before anything is asserted.
  await page.waitForSelector('.owner-request, .panel', { timeout: 15000 })
}

/**
 * Submit a request through the wizard.
 *
 * Step 1 is the fitment selector, step 2 picks a tire and takes the vehicle,
 * step 3 takes the service details and submits. Driving it is the point: when
 * the wizard replaced the old single-page form, an audit that filled four
 * fields on load stopped running its checks and nobody noticed.
 */
export async function submitRequest(page, { base, size, tireName, vehicle, location, date, notes }) {
  const [width, rest] = size.split('/')
  const [ratio, diameter] = rest.split('R')
  const step = { timeout: 15000 }

  await page.goto(base + '/')
  for (const value of [width, ratio, diameter]) {
    await page.click(`.fitment-option:has-text("${value}")`, step)
  }
  await page.fill('#fitmentZip', '02149').catch(() => {})
  await page.click('button:has-text("Continue to tires")', step)

  await page.click(`.tire-option:has-text("${tireName}")`, step)
  await page.locator('.manual-vehicle summary').click()
  await page.fill('#vehicleInfo', vehicle, step)
  await page.click('button:has-text("Continue to mobile service")', step)

  await page.fill('#location', location, step)
  if (notes) await page.fill('#locationNotes', notes, step)
  await page.fill('#date', date, step)
  await page.click('button[type="submit"]', step)

  // The acknowledgement is the flow's own signal that the request landed.
  await page.waitForSelector('.success-message', step)
}

/** A viewport-sized context with nothing carried over from the last scenario. */
export async function freshPage(browser, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  return { context, page }
}

/** A size whose tires include the off-road option, which forces owner review. */
export const EXCEPTION_TIRE = { size: '265/70R16', tireName: 'Off-Road Terrain' }
/** A size and tire that sail through without an exception. */
export const CLEAN_TIRE = { size: '215/60R16', tireName: 'All-Weather Standard' }
