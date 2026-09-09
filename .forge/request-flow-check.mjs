/* global document, getComputedStyle, innerWidth, location */ // used inside locator evaluates, which run in the browser
import { chromium } from 'playwright'
import { cleanTireFor, expandTireList, openOwnerQuotes } from './audit-ui.mjs'
import assert from 'node:assert/strict'

const base = process.env.AUDIT_BASE || 'http://localhost:4183'

/**
 * One address per script, not one shared across the gate (LEAD BACKEND DEV,
 * .forge/NOTES.md 2026-09-06; the drift QA ENGINEER measured into
 * AUDIT_BUDGET, and the false read it produced during #361): a run of this
 * script alone still accumulates toward submitPerEmail the way AUDIT_BUDGET
 * expects, but a manual rerun of one script no longer eats into the budget
 * request-flow-check.mjs, responsive-check.mjs and a11y-85-measure.mjs each
 * need against the same address. Nothing here asserts on the limit itself
 * (that is backend/limits.test.mjs's job), so there is no coverage to lose
 * by giving each script its own identity.
 */
const AUDIT_EMAIL = 'jamie+request-flow-check@example.com'

/**
 * How many checks a complete run performs, across both widths.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 96

const imageHash = 'a'.repeat(64)
const brokenImageHash = 'b'.repeat(64)
const imagePath = `/api/images/${imageHash}.png`
const brokenImagePath = `/api/images/${brokenImageHash}.png`
const remoteImageUrl = 'https://supplier.invalid/private-tire.png'
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const socialProfiles = [
  { platform: 'instagram', url: 'https://instagram.com/kens_mobiletire/', enabled: true },
  { platform: 'tiktok', url: 'https://tiktok.com/@ken_thetireguy/', enabled: true },
  { platform: 'youtube', url: 'https://youtube.com/@kens_mobiletire/', enabled: true },
  { platform: 'facebook', url: 'https://facebook.com/p/kens-mobile-tire-61577670628260/', enabled: true },
]
const socialTestimonials = [
  { id: 'customer-1', text: 'Ken made the whole tire replacement easy.', attribution: 'Local customer', kind: 'testimonial' },
]

async function openTireStep(page, size) {
  const [width, rest] = size.split('/')
  const [ratio, diameter] = rest.split('R')
  await page.goto(base)
  for (const value of [width, ratio, diameter]) await page.getByTestId(`fitment-option-${value}`).click()
  await page.locator('#fitmentZip').fill('02149')
  await page.getByTestId('continue-to-tires').click()
}

async function injectSocialState(page, state) {
  await page.route(`${base}/`, async route => {
    const response = await route.fetch()
    const body = (await response.text()).replace(
      /(<script type="application\/json" id="social-proof">)[\s\S]*?(<\/script>)/,
      `$1${JSON.stringify(state)}$2`,
    )
    await route.fulfill({ response, body })
  })
}

const browser = await chromium.launch()
let checks = 0
try {
  // A real supplier row, not a seed: a tire whose id doesn't start with
  // giga- is itself an exception reason, so this has to be a supplier tire
  // to stay a clean, non-exception path through the form. Resolved against
  // whatever the server is actually offering right now, not a name typed
  // into this file -- see cleanTireFor.
  const cleanTire = await cleanTireFor(base)
  const [cleanWidth, cleanRest] = cleanTire.size.split('/')
  const [cleanRatio, cleanDiameter] = cleanRest.split('R')
  const imageCatalog = await (await fetch(`${base}/api/catalog?size=${encodeURIComponent(cleanTire.size)}`)).json()
  assert.ok(imageCatalog.tires.length >= 4, 'image audit needs four catalog rows')

  for (const { width, count } of [{ width: 768, count: 3 }, { width: 1024, count: 4 }]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await injectSocialState(page, { profiles: socialProfiles.slice(0, count), testimonials: [] })
    await page.goto(base)
    const centered = await page.getByTestId('social-proof-section').evaluate(el => {
      const cards = [...el.querySelectorAll('.social-profile-link')]
      const lowestTop = Math.max(...cards.map(card => card.getBoundingClientRect().top))
      const finalRow = cards.filter(card => Math.abs(card.getBoundingClientRect().top - lowestTop) < 2)
      const left = Math.min(...finalRow.map(card => card.getBoundingClientRect().left))
      const right = Math.max(...finalRow.map(card => card.getBoundingClientRect().right))
      const section = el.getBoundingClientRect()
      return Math.abs((left + right) / 2 - (section.left + section.right) / 2) < 2
    })
    assert.ok(centered, `${count} profiles at ${width}px center their incomplete final row`)
    checks++
    console.log(`OK ${width}px: ${count} profiles center their incomplete final row`)
    await page.close()
  }

  for (const width of [375, 1280]) {
    {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
      const rows = imageCatalog.tires.slice(0, 4).map(tire => ({ ...tire }))
      rows[0].imageUrl = imagePath
      delete rows[1].imageUrl
      rows[2].imageUrl = brokenImagePath
      rows[3].imageUrl = remoteImageUrl
      let remoteRequests = 0
      page.on('request', request => { if (request.url().startsWith('https://supplier.invalid/')) remoteRequests++ })
      await page.route('**/api/catalog?size=*', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...imageCatalog, tires: rows }),
      }))
      await page.route(`**${imagePath}`, route => route.fulfill({ status: 200, contentType: 'image/png', body: onePixelPng }))
      await page.route(`**${brokenImagePath}`, route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' }))
      await openTireStep(page, cleanTire.size)
      const imageCard = page.getByTestId(`tire-option-${rows[0].id}`)
      const absentCard = page.getByTestId(`tire-option-${rows[1].id}`)
      const brokenCard = page.getByTestId(`tire-option-${rows[2].id}`)
      const remoteCard = page.getByTestId(`tire-option-${rows[3].id}`)
      await imageCard.locator('img').waitFor()
      await brokenCard.locator('[data-image-state="fallback"]').waitFor()
      check(await imageCard.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), 'an approved catalog image renders successfully')
      check(await imageCard.locator('img').getAttribute('loading') === 'lazy' && await imageCard.locator('img').getAttribute('decoding') === 'async', 'catalog images lazy-load and decode asynchronously')
      check(await imageCard.locator('img').getAttribute('alt') === `${rows[0].name} tire`, 'the product image has a useful tire-specific alternative')
      check(await absentCard.locator('img').count() === 0 && await absentCard.locator('[data-image-state="fallback"]').count() === 1, 'an absent image uses generic tire art')
      check(await brokenCard.locator('img').count() === 0, 'a failed approved image returns to generic tire art')
      check(await remoteCard.locator('img').count() === 0 && remoteRequests === 0 && !(await page.content()).includes(remoteImageUrl), 'a supplier URL never reaches markup or the network')
      check(await imageCard.locator('.tire-media').evaluate(el => { const box = el.getBoundingClientRect(); return box.width > 0 && Math.abs(box.width - box.height) < 1 }), 'the image slot reserves a fixed square aspect ratio')
      check(await page.locator('.tire-options').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'product-image cards do not overflow the tire list')
      await page.close()
    }

    {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
      await injectSocialState(page, { profiles: socialProfiles, testimonials: [] })
      await page.goto(base)
      const section = page.getByTestId('social-proof-section')
      await section.waitFor()
      const links = section.locator('.social-profile-link')
      check(await page.getByTestId('social-proof-section').count() === 1, 'enabled profiles render in exactly one social section')
      check(await section.evaluate(el => el.previousElementSibling?.id === 'order' && el.nextElementSibling?.classList.contains('site-footer')), 'the social section sits after the order form and before the normal footer')
      check(await links.count() === socialProfiles.length, 'every enabled owner profile renders once')
      check(await links.locator('.social-profile-badge img').evaluateAll(items => items.length === 4 && items.every(item => item.complete && item.naturalWidth > 0 && new URL(item.src).origin === location.origin && item.src.includes('/brand/social/'))), 'social cards use loaded same-origin local icon assets')
      check(await section.evaluate(el => {
        const heading = el.querySelector('.social-proof-heading')
        const container = el.querySelector('.social-profile-links')
        const cards = [...el.querySelectorAll('.social-profile-link')]
        const sectionBox = el.getBoundingClientRect()
        const containerBox = container.getBoundingClientRect()
        const centered = node => getComputedStyle(node).textAlign === 'center' && getComputedStyle(node).alignItems === 'center'
        return getComputedStyle(heading).textAlign === 'center'
          && Math.abs((containerBox.left + containerBox.right) / 2 - (sectionBox.left + sectionBox.right) / 2) < 2
          && cards.every(card => centered(card) && card.getBoundingClientRect().right <= innerWidth + 1)
      }), 'heading, profile row and each card are centered without viewport overflow')
      check(await links.evaluateAll((items, expected) => items.every((item, index) => item.href === expected[index].url && item.target === '_blank' && item.rel.includes('noopener') && item.rel.includes('noreferrer')), socialProfiles), 'profile cards retain their approved destinations and safe external-link behavior')
      check(await links.evaluateAll((items, expected) => items.every((item, index) => item.innerText.includes('↗') && item.textContent.includes(expected[index]) && /opens in a new tab/i.test(item.textContent)), ['Instagram', 'TikTok', 'YouTube', 'Facebook']), 'profile cards expose platform names and an external-link cue')
      await links.first().focus()
      await page.keyboard.press('Tab')
      check(await links.nth(1).evaluate(el => document.activeElement === el && getComputedStyle(el).outlineStyle !== 'none'), 'profile cards have visible keyboard focus in owner-selected order')
      check(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth + 1), 'the social cards do not overflow the viewport')
      await page.close()
    }

    {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
      await injectSocialState(page, { profiles: [], testimonials: [] })
      await page.goto(base)
      check(await page.getByTestId('social-proof-section').count() === 0, 'empty social metadata reserves no customer-page shell')
      await page.close()
    }

    {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
      await injectSocialState(page, { profiles: [], testimonials: socialTestimonials })
      await page.goto(base)
      const section = page.getByTestId('social-proof-section')
      check(await section.locator('.social-proof-card').count() === 1 && await section.locator('.social-profile-link').count() === 0, 'testimonial-only metadata renders customer proof without profile cards')
      check(!(await section.locator('.social-proof-note').innerText()).includes('verified social profiles'), 'testimonial-only copy does not claim social profiles are present')
      await page.close()
    }

    {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
      await injectSocialState(page, { profiles: socialProfiles, testimonials: socialTestimonials })
      await page.goto(base)
      const section = page.getByTestId('social-proof-section')
      check(await section.locator('.social-proof-card').count() === 1 && await section.locator('.social-profile-link').count() === socialProfiles.length, 'combined metadata renders testimonials and every enabled profile')
      check((await section.locator('.social-proof-note').innerText()).includes('Customer experiences') && (await section.locator('.social-proof-note').innerText()).includes('verified social profiles'), 'combined copy truthfully names customer experiences and profiles')
      await page.close()
    }

    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const check = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK ${width}px: ${message}`) }
    const overflow = () => page.locator('.order-section').evaluate(el => [...el.querySelectorAll('*')].filter(node => node.getClientRects().length).every(node => node.getBoundingClientRect().right <= innerWidth + 1))
    await page.goto(base)
    for (const value of [cleanWidth, cleanRatio, cleanDiameter]) await page.getByTestId(`fitment-option-${value}`).click()
    await page.locator('#fitmentZip').fill('02149')
    await page.getByTestId('continue-to-tires').click()
    await expandTireList(page)
    await page.getByTestId(`tire-option-${cleanTire.tireId}`).click()
    await page.getByLabel('Year', { exact: true }).fill('2020')
    await page.getByLabel('Make', { exact: true }).fill('Honda')
    await page.getByLabel('Model', { exact: true }).fill('Civic')
    check((await page.locator('.vehicle-preview').innerText()).includes('2020 Honda Civic'), 'guided vehicle entry composes the description')
    await page.getByLabel('Make', { exact: true }).fill('Toyota')
    check(await page.getByLabel('Model', { exact: true }).inputValue() === '', 'changing make clears the previous model')
    await page.getByLabel('Model', { exact: true }).fill('Corolla')
    check(await overflow(), 'vehicle controls fit within viewport')
    await page.locator('.step-panel').screenshot({ path: `.forge/shots/request-vehicle-${width}.png` })
    await page.getByTestId('continue-to-mobile-service').click()
    check(await page.locator('#serviceZip').inputValue() === '02149', 'earlier ZIP carries into service details')
    await page.getByTestId('pricing-preview-total').waitFor()
    check((await page.getByTestId('pricing-preview').innerText()).includes('ZIP 02149'), 'server-priced mobile service names the active ZIP')
    await page.getByTestId('change-pricing-zip').click()
    check(await page.locator('#fitmentZip').inputValue() === '02149', 'Change ZIP returns to the existing ZIP step with its active value')
    await page.locator('#fitmentZip').fill('02148')
    await page.getByTestId('continue-to-tires').click()
    check(await page.getByTestId(`tire-option-${cleanTire.tireId}`).getAttribute('aria-pressed') === 'true' && (await page.locator('.vehicle-preview').innerText()).includes('2020 Toyota Corolla'), 'changing ZIP preserves the tire and vehicle selections')
    let submittedWhileUnpriced = 0
    page.on('request', request => {
      if (request.method() === 'POST' && request.url() === `${base}/api/requests`) submittedWhileUnpriced++
    })
    await page.route('**/api/requests/preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Preview temporarily unavailable.' }) }), { times: 1 })
    await page.getByTestId('continue-to-mobile-service').click()
    await page.getByText('Something went wrong at the shop. Please try again in a moment.').waitFor()
    check(await page.getByTestId('request-my-quote').isDisabled(), 'a server preview failure disables submission before charges are shown')
    await page.getByTestId('request-my-quote').evaluate(button => button.click())
    await page.waitForTimeout(100)
    check(submittedWhileUnpriced === 0, 'a disabled unpriced form sends no request even when clicked programmatically')
    await page.getByTestId('retry-pricing-preview').click()
    await page.getByTestId('pricing-preview-total').waitFor()
    check(await page.locator('#serviceZip').inputValue() === '02148' && (await page.getByTestId('pricing-preview').innerText()).includes('ZIP 02148'), 'the changed ZIP reaches the service form and refreshed server preview')
    await page.getByTestId('request-my-quote').click()
    check(await page.locator('#location').getAttribute('aria-invalid') === 'true' && await page.locator('#date').getAttribute('aria-invalid') === 'true', 'empty address and date get inline errors')
    check(await page.locator('#customerName').getAttribute('aria-invalid') === 'true' && await page.locator('#customerEmail').getAttribute('aria-invalid') === 'true', 'empty name and email get inline errors')
    await page.getByTestId('location-type-Roadside').click()
    check(await page.getByLabel('Road, exit or nearby address').isVisible(), 'roadside option provides relevant address guidance')
    await page.locator('#location').fill('I-93 North, Exit 20, Boston')
    await page.locator('#locationNotes').fill('Blue sedan near the gas station')
    // t48's date floor retired Today/Tomorrow (both landed inside it,
    // guaranteed rejections); the shortcuts are now a week/two weeks out.
    await page.getByTestId('date-shortcut-in-a-week').click()
    check(!!await page.locator('#date').inputValue(), 'date shortcut fills the date input')
    await page.getByTestId('back-to-tire-selection').click()
    check(await page.getByLabel('Model', { exact: true }).inputValue() === 'Corolla', 'vehicle survives back navigation')
    await page.getByTestId('continue-to-mobile-service').click()
    check(await page.locator('#locationNotes').inputValue() === 'Blue sedan near the gas station', 'service details survive back navigation')
    check(await overflow(), 'service controls fit within viewport')
    await page.locator('#customerName').fill('Jamie Rivera')
    await page.locator('#customerEmail').fill(AUDIT_EMAIL)
    await page.locator('#customerPhone').fill('(617) 410-8319')
    await page.locator('.step-panel').screenshot({ path: `.forge/shots/request-service-${width}.png` })
    const previewTotal = (await page.getByTestId('pricing-preview-total').textContent()).trim()
    await page.getByTestId('request-my-quote').click()
    await page.waitForSelector('.success-message')
    check(await page.locator('.success-message').isVisible(), 'submitting acknowledges the request on screen')
    check((await page.locator('.success-message').innerText()).includes(`Draft quote total: ${previewTotal}`), 'submitted draft total agrees with the server preview shown before submit')

    // What the customer typed is checked where it matters -- on the owner's
    // screen. Reading it back out of the browser's own storage proved that a
    // row existed, not that the request reached the person who has to act on
    // it, and it stopped working the moment requests moved to the server.
    await openOwnerQuotes(page)
    const ownerText = await page.locator('.owner-content').first().innerText()
    check(ownerText.includes('2020 Toyota Corolla'), 'owner sees the vehicle the customer entered')
    check(ownerText.includes('02148'), 'owner sees the changed ZIP the customer entered')
    check(ownerText.includes('Blue sedan'), 'owner sees the access instructions the customer entered')
    const phoneLinkVisible = await page.locator('.owner-content a[href="tel:+16174108319"]').first().isVisible().catch(() => false)
    check(ownerText.includes('Jamie Rivera') && ownerText.includes(AUDIT_EMAIL) && phoneLinkVisible, 'owner sees the contact name, email and normalized phone the customer entered')
    check(errors.length === 0, 'no browser runtime errors')
    await page.close()
  }
  // The owner's door, asserted BEFORE the merge instead of only after it.
  //
  // Until now the only end-to-end evidence that /api/owner/* refuses without a
  // session was deployed-site-check.mjs, which runs AFTER the deploy. So a
  // change that opened that door merged green and shipped, and the first thing
  // that noticed was a check running against production. That ordering is
  // wrong for any control and it is worst for this one.
  //
  // The backend suite is not already covering this, which is the part worth
  // knowing. quotes.test.mjs asserts the same 401s, but against its own serve()
  // -- whose comment says "A server shaped like server.mjs: the same gate, the
  // same handlers". It is a reconstruction, mounted by hand in the same order,
  // and .forge/NOTES.md already records what that costs: it can pass while the
  // real server.mjs is wrong, because nothing makes the two agree. The gate's
  // audit step boots the real server.mjs. This asks THAT one.
  //
  // Cheap on purpose -- three fetches, no browser -- and outside the viewport
  // loop because a 401 is not a property of a screen width.
  {
    const gate = (condition, message) => { assert.ok(condition, message); checks++; console.log(`OK: ${message}`) }

    // Which shape is answering? backend/server.mjs mounts owner auth; 
    // backend/dev.mjs does not import createAuth at all, so it has no session
    // route and its owner API is open by design on loopback. Both are legitimate
    // targets for this script, so each assertion below is written to be true of
    // whichever one is running -- and the count stays the same either way, which
    // is what keeps EXPECTED_CHECKS meaningful across both.
    const session = await fetch(`${base}/api/owner/session`)
    const hostedShape = session.status !== 404

    const inventory = await fetch(`${base}/api/owner/inventory`)
    const requests = await fetch(`${base}/api/owner/requests`)

    gate(
      hostedShape ? inventory.status === 401 : inventory.status === 200,
      hostedShape
        ? `GET /api/owner/inventory refuses without a session (401, got ${inventory.status})`
        : `local passwordless server: /api/owner/inventory is open by design (200, got ${inventory.status})`,
    )

    // The customer-data route, named separately from the inventory one. They are
    // gated by the same allow-list today, so this looks redundant -- and it is
    // the one whose failure would matter most, because what leaks is every
    // customer's name, email, phone and address rather than a tire list.
    gate(
      hostedShape ? requests.status === 401 : requests.status === 200,
      hostedShape
        ? `GET /api/owner/requests refuses without a session (401, got ${requests.status})`
        : `local passwordless server: /api/owner/requests is open by design (200, got ${requests.status})`,
    )

    // No positive control here, deliberately, and this is the note explaining why
    // rather than an omission. A negative result only means something when the
    // same instrument can still produce a positive one -- so I wrote one
    // (`/api/catalog` still answers 200) and then tested it by making the server
    // refuse every route. It never ran: cleanTireFor(base) fetches the catalog
    // before the first check in this file, so the run died at setup with
    // `Cannot read properties of undefined (reading 'find')`, 0 of 37.
    //
    // Which means the control could not fail, because reaching it already proves
    // what it asserted. This script cannot get here on a server that refuses
    // everything. A check that cannot go red is the defect this seat was created
    // to find, so it is a comment instead of an assertion.
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
