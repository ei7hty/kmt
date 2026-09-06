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
    // R4 retired the customer-facing "Owner Review" link: a live site
    // collecting a name, email and phone should not advertise its admin
    // door on the same page. Direct navigation replaces the click, the way
    // owner-inventory-audit.mjs already reaches /owner.
    const origin = new URL(page.url()).origin
    await page.goto(`${origin}/owner`)
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
 * Open the whole tire list when the step is showing only its first page.
 *
 * The seed tires the audits pick by name are priced above every supplier
 * tire in their size, so on a real size they sit behind the paged
 * "Show N more" control and may need more than one click to reach. Loop on
 * the control's class rather than its text -- the count in "Show 24 more"
 * changes on every click, and the button disappears once nothing is left
 * to page in, which is the actual thing this waits for.
 */
export async function expandTireList(page) {
  const showMore = page.locator('button.tire-show-more')
  while (await showMore.count()) {
    await showMore.first().click()
  }
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
/** The size every gate database has real supplier rows in, via the local scraped-tires.json snapshot. */
export const CLEAN_SIZE = '205/65R15'

/**
 * The seven fields a customer's browser is built around, and nothing else.
 *
 * One list, imported by every script that checks it (deployed-site-check.mjs,
 * catalog-import-check.mjs), rather than a hand-synced copy in each. This
 * repository has already lost a copy to drift once -- a duplicated CLEAN_TIRE
 * fixture whose own comment flagged the risk before it happened -- and the
 * failure shape for this particular list is quieter than a leak: someone adds
 * a legitimate eighth field, updates one file, and now one check passes while
 * the other fails on a diff nobody made.
 */
export const CATALOG_FIELDS = ['id', 'name', 'size', 'price', 'inStock', 'category', 'description']

/**
 * A size and a tire in it that sail through without an exception, resolved
 * against whatever the server is actually offering right now rather than a
 * name typed into this file.
 *
 * Has to be a real supplier row, not one of the six seeds: since a tire whose
 * id doesn't start with `giga-` is itself an exception reason, a seed here
 * would no longer be a clean path at all. It used to be hardcoded as
 * Waterfall Quattro -- one specific SKU out of 177 in this size, in a
 * snapshot that gets re-scraped -- so a routine delisting at the supplier
 * would have failed three audits on a Playwright timeout that reads like a
 * UI regression, not "this fixture tire is gone." Asking the server which
 * supplier tire it is currently offering removes that dependency instead of
 * just diagnosing it faster: any tire the database actually carries makes as
 * good a clean-path fixture as any other, so there is nothing to pin here.
 */
export async function cleanTireFor(base) {
  const response = await fetch(`${base}/api/catalog`)
  const { tires } = await response.json()
  const supplierTire = tires.find(tire => tire.size === CLEAN_SIZE && tire.id.startsWith('giga-'))
  if (!supplierTire) {
    throw new Error(
      `No giga- supplier tire is listed in ${CLEAN_SIZE} right now, so there is no clean-path fixture to submit. ` +
      'This is a gap in the gate database or the live catalog, not a UI regression.',
    )
  }
  return { size: CLEAN_SIZE, tireName: supplierTire.name, price: supplierTire.price }
}
