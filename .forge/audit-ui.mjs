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

/**
 * The owner password, read when it is needed rather than when this module
 * loads: a caller that sets the variable after importing would otherwise get
 * an empty string and a confusing failure about a password it did set.
 */
const ownerPassword = () => process.env.KMT_OWNER_PASSWORD || ''

/**
 * Sign in if the server asks, and say nothing if it does not.
 *
 * A local server binds loopback and has no password, so no form appears. A
 * hosted one does. The audit has to work against both, because the gate runs
 * the hosted shape and a developer runs the local one.
 */
export async function signInIfAsked(page) {
  // Wait for the screen to decide what it is before asking whether it wants a
  // password. The gate appears only after the screen's first call comes back
  // 401, so checking immediately reads "no form" on a screen that is about to
  // show one -- and the audit then waits for content that will never arrive.
  await page
    .waitForSelector('.oi-signin, .owner-content, .oi-results, .oi-error', { timeout: 15000 })
    .catch(() => {})

  const form = page.locator('.oi-signin')
  if (!(await form.count())) return false
  const password = ownerPassword()
  if (!password) {
    throw new Error(
      'The owner screen asked for a password and KMT_OWNER_PASSWORD is not set. ' +
      'Start the server with one and pass it to the audit.',
    )
  }
  await page.fill('#owner-password', password)
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
 * Land on /status and wait for it to have said something.
 *
 * The screen used to render straight from the browser's own storage, so
 * whatever it was going to show was there the moment the URL changed. It asks a
 * server now. Asserting before the answer arrives reads as "no Pay action" on a
 * quote that has one -- a false red that says nothing about the app.
 */
export async function waitForStatus(page) {
  await page.waitForSelector('.owner-request, .panel, .status-note', { timeout: 15000 })
}

/**
 * Submit a request through the wizard.
 *
 * Step 1 is the fitment selector, step 2 picks a tire and takes the vehicle,
 * step 3 takes the service details and submits. Driving it is the point: when
 * the wizard replaced the old single-page form, an audit that filled four
 * fields on load stopped running its checks and nobody noticed.
 */
/**
 * Open the whole tire list when the step is showing only its cheapest dozen.
 *
 * The seed tires the audits pick by name are priced above every supplier tire
 * in their size, so on a real size they sit behind the "Show all" control.
 * Clicking it is what a customer looking for that tire would do; when the
 * list is short enough to have no control, there is nothing to click.
 */
export async function expandTireList(page) {
  const showAll = page.locator('button:has-text("Show all")')
  if (await showAll.count()) await showAll.first().click()
}

export async function submitRequest(page, { base, size, tireName, vehicle, location, date, notes, customerName = 'Jamie Rivera', customerEmail = 'jamie@example.com' }) {
  const [width, rest] = size.split('/')
  const [ratio, diameter] = rest.split('R')
  const step = { timeout: 15000 }

  await page.goto(base + '/')
  for (const value of [width, ratio, diameter]) {
    await page.click(`.fitment-option:has-text("${value}")`, step)
  }
  await page.fill('#fitmentZip', '02149').catch(() => {})
  await page.click('button:has-text("Continue to tires")', step)

  await expandTireList(page)
  await page.click(`.tire-option:has-text("${tireName}")`, step)
  await page.locator('.manual-vehicle summary').click()
  await page.fill('#vehicleInfo', vehicle, step)
  await page.click('button:has-text("Continue to mobile service")', step)

  await page.fill('#location', location, step)
  if (notes) await page.fill('#locationNotes', notes, step)
  await page.fill('#date', date, step)
  await page.fill('#customerName', customerName, step)
  await page.fill('#customerEmail', customerEmail, step)
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
