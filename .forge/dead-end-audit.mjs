import { chromium } from 'playwright';
import { cleanTireFor, expandTireList, freshPage, openOwnerQuotes, waitForStatus } from './audit-ui.mjs';
import { MOBILE_SERVICE_FEE } from '../src/pricing.js';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4179';

/**
 * How many checks a complete run performs, across both viewports.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means checks stopped running -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 83;

/**
 * Preferred dates, always ahead of today. The server refuses anything inside
 * a week of today (t48's date floor), and a fixed date in a script is a gate
 * that goes red on a morning nobody changed anything. These sit well clear
 * of the 7-day floor rather than right on it: `daysAhead` computes a UTC
 * calendar day from the machine's clock, and the server's floor is computed
 * on the Massachusetts calendar, so a date exactly at day 7 can land on
 * either side of the boundary depending on the time of day this runs.
 */
const daysAhead = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const SOON = daysAhead(14);
const LATER = daysAhead(15);
const LATEST = daysAhead(16);

/**
 * ZIPs the service-area check answers differently (t48). The base is Malden
 * 02148 with a 100-mile radius and a 25-mile review band by default; Everett
 * is next door, Worcester is about 40 miles, Bangor about 200.
 */
const ZIP_IN_AREA = '02149';
const ZIP_REVIEW = '01608';
const ZIP_OUT_OF_AREA = '04401';

/** One address per script, not shared across the gate -- see audit-ui.mjs's submitRequest. */
const AUDIT_EMAIL = 'jamie+dead-end-audit@example.com';

let passed = 0;
let failed = 0;

function fail(msg) {
  failed += 1;
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  passed += 1;
  console.log(`OK: ${msg}`);
}

/** The count, held against the baseline. Printed last, so it is the line a reader lands on. */
function reportCount() {
  const ran = passed + failed;
  console.log(`\n${passed} OK, ${failed} FAIL -- ${ran} of ${EXPECTED_CHECKS} expected checks ran`);
  if (ran < EXPECTED_CHECKS) {
    fail(`only ${ran} of ${EXPECTED_CHECKS} checks ran. A check that stopped running is not a check that passed.`);
  } else if (ran > EXPECTED_CHECKS) {
    fail(`${ran} checks ran but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new check.`);
  }
}

/**
 * Drive the customer flow from a clean start through to a submitted request.
 *
 * The customer flow is a three-step wizard, not a single form: step 1 is the
 * fitment selector (width, then ratio, then diameter, then an optional ZIP),
 * step 2 picks a tire and asks what vehicle it is for, step 3 takes the service
 * details and submits.
 *
 * This helper exists because the audit previously filled four fields on page
 * load, which is how the old single-page form worked. When the wizard replaced
 * it, every check in this file stopped running -- the script failed on its first
 * action and nobody noticed, so a green audit had been asserting nothing. Drive
 * the UI the way a person does, or the audit only tests the audit.
 *
 * @param size  Tire size as it appears in the catalog, e.g. '265/70R16'.
 */
async function submitRequest(page, { size, tireId, vehicle, location, date, zip = ZIP_IN_AREA, customerName = 'Jamie Rivera', customerEmail = AUDIT_EMAIL }) {
  const [width, rest] = size.split('/');
  const [ratio, diameter] = rest.split('R');

  const step = { timeout: 5000 };

  try {
    await page.goto(BASE + '/');

    // Step 1: fitment. Each stage advances as soon as a value is chosen. The
    // ZIP typed here carries into the service details, and the server needs
    // it: it is where the van goes.
    for (const value of [width, ratio, diameter]) {
      await page.getByTestId(`fitment-option-${value}`).click(step);
    }
    await page.fill('#fitmentZip', zip, step);
    await page.getByTestId('continue-to-tires').click(step);

    // Step 2: pick the tire by its stable catalog id, and say what it is going on.
    await expandTireList(page);
    await page.getByTestId(`tire-option-${tireId}`).click(step);
    await page.locator('.manual-vehicle summary').click();
    await page.fill('#vehicleInfo', vehicle, step);
    await page.getByTestId('continue-to-mobile-service').click(step);

    // Step 3: service details, then submit.
    await page.fill('#location', location, step);
    await page.fill('#date', date, step);
    await page.fill('#customerName', customerName, step);
    await page.fill('#customerEmail', customerEmail, step);
    await page.click('button[type="submit"]', step);
  } catch (error) {
    // This is exactly how the audit rotted the first time: the customer flow was
    // rewritten, the script could no longer drive it, and the failure read like
    // an infrastructure problem rather than "every check below stopped running."
    // Say that plainly, so nobody reads a broken audit as a passing one.
    fail(
      'Could not drive the customer flow to a submitted request. The UI shape has ' +
        'changed and this script no longer matches it, so NONE of the checks below ' +
        'ran -- this is not a passing audit. Update submitRequest() to match the ' +
        `current flow. Underlying error: ${error.message.split('\n')[0]}`,
    );
    throw error;
  }
}

/** A size whose matching tires include the off-road option, which forces owner review. */
const EXCEPTION_TIRE = { size: '265/70R16', tireName: 'Off-Road Terrain', tireId: 'tire-5' };

/**
 * A size with no seed tire, so its standard (generated-only) list has
 * nothing that would also survive into a mocked live answer by construction
 * -- unlike a seeded size, where catalogFromLiveRows always prepends every
 * seed regardless of what the live rows say. Confirm against
 * src/data/catalog.js's SEED_TIRES before reusing this size elsewhere.
 */
const NO_SEED_SIZE = '135/80R12';

async function main() {
  const browser = await chromium.launch();
  // Resolved once, against whatever the server is actually offering right
  // now, rather than a name typed into this file -- see cleanTireFor.
  const CLEAN_TIRE = await cleanTireFor(BASE);

  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    console.log(`\n=== Viewport: ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
    let { context, page } = await freshPage(browser, viewport);

    // Start clean. A fresh context is the reset: nothing is cleared by hand,
    // because the state this audit cares about may not live in this browser.
    await page.goto(BASE + '/');

    // 1. Customer submits a request that will trigger an exception (truck + off-road tire)
    //    so we can verify the exception path renders distinctly at /owner.
    await submitRequest(page, {
      ...EXCEPTION_TIRE,
      vehicle: '2019 Ford F-150 Pickup',
      location: '123 Demo St',
      date: SOON,
    });

    const submissionMsg = await page.locator('[role="status"]').first().textContent().catch(() => null);
    if (submissionMsg && submissionMsg.includes('Quote request submitted')) {
      ok('Customer form: submit produced an immediate confirmation message with the draft quote total.');
    } else {
      fail(`Customer form: no visible submission acknowledgement. Got: ${submissionMsg}`);
    }

    // Visible next action from / after submitting. R4 retired the
    // customer-facing "Owner Review" link (a live site collecting a name,
    // email and phone should not advertise its admin door on the same
    // page), so "My Quote" -- the customer's own route back to what they
    // just submitted -- is the one that must not silently vanish.
    const statusLinkVisible = await page.locator('button:has-text("My Quote")').isVisible();
    if (statusLinkVisible) {
      ok('Customer form screen: visible next action (My Quote) after submit.');
    } else {
      fail('Customer form screen: missing visible next action after submit.');
    }

    // 2. Owner review: reached directly, since R4 removed the customer-facing
    //    link -- see openOwnerQuotes() in audit-ui.mjs.
    await openOwnerQuotes(page);

    const exceptionBadge = await page.locator('text=Owner review required').first().isVisible().catch(() => false);
    if (exceptionBadge) {
      ok('/owner: exception state renders distinctly (Owner review required + reasons).');
    } else {
      fail('/owner: exception state did not render as expected for the truck + off-road submission.');
    }

    const contactVisible = await page.locator(`a[href="mailto:${AUDIT_EMAIL}"]`).first().isVisible().catch(() => false);
    if (contactVisible) {
      ok('/owner: the request card shows the customer\'s contact email as a mailto link.');
    } else {
      fail('/owner: no visible contact email for the submitted request.');
    }

    const approveVisible = await page.locator('button:has-text("Approve")').first().isVisible().catch(() => false);
    if (approveVisible) {
      ok('/owner: Approve action is visible for the reviewed request (owner has a clear next action even on an exception).');
    } else {
      fail('/owner: no visible Approve action found.');
    }

    // The editor is collapsed by default (sprint item 4): most quotes need
    // no adjustment, so "Adjust quote" is a deliberate second step before
    // the price fields exist on the page at all.
    await page.click('button:has-text("Adjust quote")');
    const firstPrice = page.locator('input[aria-label="Line 1 unit price"]').first();
    await firstPrice.fill('60.00');
    await page.locator('label.quote-note textarea').first().fill('Audit adjustment included.');
    const adjustedTotal = await page.locator('.quote-editor-total .owner-quote-total').first().textContent();
    if (adjustedTotal === '$289.99') {
      ok('/owner: editing a unit price updates the quote total live before send.');
    } else {
      fail(`/owner: edited total should be $289.99, got ${adjustedTotal}.`);
    }

    await page.click('button:has-text("Approve")');

    // Approve is a network round trip. Wait for the status to appear rather than
    // sleeping 200 ms and sampling once: that form turned the identical commit
    // 598d4e2 red and then green in the gate at the phone viewport (#79). Same
    // assertion, same count; only the observation waits now.
    try {
      await page.locator('text=SENT').first().waitFor({ state: 'visible', timeout: 5000 });
      ok('/owner: after clicking Approve, status visibly updates to SENT in place (no reload needed).');
    } catch {
      fail('/owner: status did not visibly update to SENT after clicking Approve.');
    }

    const backButtonVisible = await page.locator('button:has-text("Back to Customer Flow")').isVisible();
    if (backButtonVisible) {
      ok('/owner: visible way back to the customer flow.');
    } else {
      fail('/owner: no visible way back to the customer flow.');
    }

    // 3. Follow the visible nav back to /, then to /status, to see the approved quote and pay.
    await page.click('button:has-text("Back to Customer Flow")');
    await page.waitForURL(BASE + '/');
    await page.click('button:has-text("My Quote")');
    await page.waitForURL('**/status');
    await waitForStatus(page);

    const sentNote = await page.locator('text=Note from Ken: Audit adjustment included.').first().isVisible().catch(() => false);
    if (sentNote) {
      ok('/status: the sent quote carries the owner adjustment and customer note.');
    } else {
      fail('/status: the sent quote did not show the owner adjustment note.');
    }

    const payButtonVisible = await page.locator('button:has-text("Pay $")').first().isVisible().catch(() => false);
    if (payButtonVisible) {
      ok('/status: approved quote shows a visible Pay action.');
    } else {
      fail('/status: no visible Pay action for the approved quote.');
    }

    await page.click('button:has-text("Pay $")');
    // Paying navigates straight to /confirmation (handlePayment calls navigate() itself) --
    // that IS the visible next action; no intermediate click is required.
    await page.waitForURL('**/confirmation**', { timeout: 3000 }).catch(() => {});

    const onConfirmation = page.url().includes('/confirmation');
    if (onConfirmation) {
      ok('/status: clicking Pay immediately advances to /confirmation with no extra step required.');
    } else {
      fail(`/status: clicking Pay did not advance to /confirmation. Landed on: ${page.url()}`);
    }

    const confirmedHeading = await page.locator('h1:has-text("You\'re all set!")').isVisible().catch(() => false);
    if (confirmedHeading) {
      ok('/confirmation: clear end-state heading is visible.');
    } else {
      fail('/confirmation: end-state heading missing.');
    }

    const startNewVisible = await page.locator('a:has-text("Start a New Request")').isVisible().catch(() => false);
    if (startNewVisible) {
      ok('/confirmation: visible "Start a New Request" action closes the loop back to /.');
    } else {
      fail('/confirmation: no visible next action -- dead end.');
    }

    if (startNewVisible) {
      await page.click('a:has-text("Start a New Request")');
      await page.waitForURL(BASE + '/');
      ok('/confirmation -> /: loop back to start confirmed via click (no URL typed, no back button used).');
    }

    // 4. Reload /status directly (simulating a tester returning to a bookmarked/previous tab) to
    // confirm a *paid* quote still offers a visible way to reach the confirmation screen, rather
    // than stranding the tester with only a status label.
    await page.goto(BASE + '/status');
    await waitForStatus(page);
    const viewConfirmationAfterReload = await page.locator('text=View confirmation').first().isVisible().catch(() => false);
    if (viewConfirmationAfterReload) {
      ok('/status (after reload): paid quote still shows a visible "View confirmation" action.');
    } else {
      fail('/status (after reload): paid quote lost its next action.');
    }

    // 5. Validation dead-end check. On a wizard the risk is not a failed submit,
    //    it is a step that refuses to advance without saying why: the tester
    //    clicks Continue, nothing moves, and there is no visible reason.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await page.goto(BASE + '/');

    const [w, r] = CLEAN_TIRE.size.split('/');
    const [ra, di] = r.split('R');
    for (const value of [w, ra, di]) await page.getByTestId(`fitment-option-${value}`).click();
    await page.getByTestId('continue-to-tires').click();

    // Now on step 2, try to advance without choosing a tire.
    await page.getByTestId('continue-to-mobile-service').click();
    const stepErrorVisible = await page
      .locator('text=Choose a tire for your vehicle')
      .isVisible()
      .catch(() => false);
    if (stepErrorVisible) {
      ok('/ (step 2, nothing chosen): a visible reason is given instead of a button that silently does nothing.');
    } else {
      fail('/ (step 2, nothing chosen): Continue did nothing and said nothing -- a silent dead end.');
    }

    // 6. The selector narrows each stage to choices that lead somewhere, so a
    //    completed selection should always land on tires rather than an empty
    //    list. Sampled here; the exhaustive walk of all 910 paths is a one-off,
    //    too slow to run every time. The first three sit in the middle of the
    //    range; the last two are its edges -- the smallest and the largest
    //    size the selector can build -- so a change to the fitment lists or
    //    the plausibility rule that strands either end fails here.
    for (const [w, r, d] of [['175', '70', '14'], ['225', '45', '17'], ['275', '40', '20'], ['135', '80', '12'], ['325', '35', '24']]) {
      await page.goto(BASE + '/');
      for (const value of [w, r, d]) {
        await page.getByTestId(`fitment-option-${value}`).click({ timeout: 5000 });
      }
      await page.getByTestId('continue-to-tires').click({ timeout: 5000 });

      const tireCount = await page.locator('.tire-option').count();
      const wentEmpty = await page.locator('.tire-empty').isVisible().catch(() => false);
      if (tireCount > 0 && !wentEmpty) {
        ok(`/ (${w}/${r}R${d}): a completed selection lands on tires, not an empty list.`);
      } else {
        fail(`/ (${w}/${r}R${d}): selection ended with no tires -- the selector offered a size nothing fills.`);
      }
    }

    // 6b. The service area (t48). Beyond the radius, the customer is refused
    //     with the distance and a way to call, not a quote for a job nobody
    //     will do. Past the review distance but inside the radius, the
    //     request goes through and the owner's card says how far.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2021 Honda Civic',
      location: '1 Far Away Rd, Bangor, ME',
      date: SOON,
      zip: ZIP_OUT_OF_AREA,
    });
    const refusal = await page.locator('.submit-failure').first();
    const refusalText = (await refusal.textContent().catch(() => '')) || '';
    // t63 replaced every call control with a text one (src/contact.js):
    // the way out of a refusal is now an sms: link, not a tel: one. #228
    // put the refusal message in Ken's voice ("miles I cover", not "mile
    // area"); both land here independently and this check needs both.
    const refusalLink = await refusal.locator('a[href^="sms:"]').first().isVisible().catch(() => false);
    if (/about \d+ miles/.test(refusalText) && /outside the \d+ miles I cover/.test(refusalText) && refusalLink) {
      ok(`Customer form: a ZIP beyond the service area (${ZIP_OUT_OF_AREA}) is refused with the distance and a visible text link.`);
    } else {
      fail(`Customer form: out-of-area ZIP ${ZIP_OUT_OF_AREA} was not refused with the distance and a text link. Got: ${refusalText.slice(0, 200)}`);
    }

    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2021 Honda Civic',
      location: '100 Front St, Worcester, MA',
      date: SOON,
      zip: ZIP_REVIEW,
    });
    await openOwnerQuotes(page);
    const reviewCard = await page.locator('.owner-request', { hasText: 'Worcester' }).first();
    const reviewText = (await reviewCard.textContent().catch(() => '')) || '';
    if (/Owner review required/.test(reviewText) && /about \d+ miles from Malden/.test(reviewText)) {
      ok(`/owner: a request from the review band (${ZIP_REVIEW}) shows "Owner review required" with the distance in miles.`);
    } else {
      fail(`/owner: the review-band request (${ZIP_REVIEW}) did not show the review reason with the miles. Got: ${reviewText.slice(0, 200)}`);
    }

    // 7. Declined quote path (R28's sibling, #78's second half): does the
    //    customer have a next action, or a dead end -- and now that Decline
    //    asks in-page (reusing #264's reason-box component), does the reason
    //    Ken types actually reach the customer, with a way to reply?
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2021 Honda Civic',
      location: '456 Demo Ave',
      date: LATER,
    });
    await openOwnerQuotes(page);
    const declineCard = page.locator('.owner-request', { hasText: 'Honda Civic' }).first();
    const declineVisible = await declineCard.locator('button:has-text("Decline")').first().isVisible().catch(() => false);
    if (declineVisible) {
      await declineCard.locator('button:has-text("Decline")').click();
      const declineReasonPromiseVisible = await declineCard.locator('text=The customer will see this').isVisible().catch(() => false);
      if (declineReasonPromiseVisible) {
        ok('/owner: declining asks for a reason in-page, with "the customer will see this" visible at the point of typing, not window.prompt.');
      } else {
        fail('/owner: declining did not show an in-page reason box with the promise text visible.');
      }
      await declineCard.locator('textarea').fill('That size is back-ordered until next month.');
      await declineCard.locator('button:has-text("Decline request")').click();
      await page.waitForTimeout(200);
      await page.click('button:has-text("Back to Customer Flow")');
      await page.waitForURL(BASE + '/');
      await page.click('button:has-text("My Quote")');
      await page.waitForURL('**/status');
    await waitForStatus(page);
      const rejectedMsgVisible = await page.locator("text=I can't take this one on").isVisible().catch(() => false);
      const reasonReachedCustomer = await page.locator('text=That size is back-ordered until next month').isVisible().catch(() => false);
      if (rejectedMsgVisible && reasonReachedCustomer) {
        ok('/status: declined quote shows a clear message explaining the outcome, including the reason Ken typed.');
      } else {
        fail(`/status: declined quote's explanation or reason was not visible (message: ${rejectedMsgVisible}, reason: ${reasonReachedCustomer}).`);
      }
      const textLinkVisible = await page.locator('.status-outcome a[href^="sms:"]').isVisible().catch(() => false);
      if (textLinkVisible) {
        ok('/status: a declined quote offers a way to reach Ken, matching what the decline email itself says.');
      } else {
        fail('/status: a declined quote has no way to reach Ken, though the email that led here offers one.');
      }
      const newRequestNavVisible = await page.locator('button:has-text("New Request")').isVisible().catch(() => false);
      if (newRequestNavVisible) {
        ok('/status: "New Request" nav is present as the next action for a declined quote.');
      } else {
        fail('/status: no visible next action after a declined quote.');
      }
    } else {
      fail('/owner: no visible Decline action found to test the declined-quote path.');
    }

    // 7b. The customer cancels their own draft (R27, #78). This used to live
    //     behind window.confirm, which Playwright cannot drive at all -- the
    //     control was untestable, and untestable is why nobody had ever
    //     watched it work. Confirming in-page, not a native dialog.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2017 Mazda3',
      location: '111 Demo Way',
      date: LATEST,
    });
    await page.click('button:has-text("My Quote")');
    await page.waitForURL('**/status');
    await waitForStatus(page);
    await page.click('button:has-text("Cancel this request")');
    const selfCancelPromptVisible = await page.locator('text=Cancel this request? You would have to start a new one.').isVisible().catch(() => false);
    if (selfCancelPromptVisible) {
      ok('/status: cancelling asks in-page ("Cancel this request?"), not through window.confirm.');
    } else {
      fail('/status: clicking Cancel did not show the in-page confirmation step.');
    }
    await page.click('button:has-text("Yes, cancel")');
    await page.waitForTimeout(300);
    const selfCancelledVisible = await page.locator('text=This request was cancelled.').isVisible().catch(() => false);
    if (selfCancelledVisible) {
      ok('/status: confirming the in-page cancel step actually cancels the request.');
    } else {
      fail('/status: confirming cancel did not leave the request in a visibly cancelled state.');
    }

    // 7c. The owner cancels with a reason the customer will see (R28, #78).
    //     window.prompt made this equally untestable; the prompt's own text
    //     is a promise ("the customer will see it"), so the in-page
    //     replacement has to keep that promise visible while typing, not
    //     bury it in a placeholder that disappears on the first keystroke --
    //     and the reason actually has to reach the customer's screen.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2018 Subaru Outback',
      location: '222 Demo Ct',
      date: LATEST,
    });
    await openOwnerQuotes(page);
    const ownerCancelCard = page.locator('.owner-request', { hasText: 'Subaru Outback' }).first();
    await ownerCancelCard.locator('button:has-text("Cancel")').click();
    const reasonPromiseVisible = await ownerCancelCard.locator('text=The customer will see this').isVisible().catch(() => false);
    if (reasonPromiseVisible) {
      ok('/owner: cancelling asks for a reason in-page, with "the customer will see this" visible at the point of typing, not window.prompt.');
    } else {
      fail('/owner: cancelling did not show an in-page reason box with the promise text visible.');
    }
    await ownerCancelCard.locator('textarea').fill('Out of stock by the time I checked -- sorry!');
    await ownerCancelCard.locator('button:has-text("Cancel request")').click();
    await page.waitForTimeout(300);
    await page.click('button:has-text("Back to Customer Flow")');
    await page.waitForURL(BASE + '/');
    await page.click('button:has-text("My Quote")');
    await page.waitForURL('**/status');
    await waitForStatus(page);
    const reasonReachedCustomer = await page.locator('text=Out of stock by the time I checked').isVisible().catch(() => false);
    if (reasonReachedCustomer) {
      ok('/status: the owner\'s cancellation reason, typed in-page, actually reaches the customer\'s screen.');
    } else {
      fail('/status: the customer does not see the reason the owner typed when cancelling.');
    }

    // 7d. The link a customer actually gets is id-alone (#78, closed on the
    //     premise that the in-page confirmation made cancel testable at
    //     all -- this is the part that premise did not yet cover). 7b above
    //     reaches /status through "My Quote", which only works because that
    //     same browser context just submitted and so already holds a
    //     customerKey; it has never proven the path a texted or emailed
    //     link actually depends on -- a second device, with nothing in its
    //     localStorage, opening /status?request=<id> directly.
    //
    //     Two more things the page's own text cannot prove, per the OWNER
    //     AGENT's brief: that "Keep it" genuinely refuses (a cancelled
    //     request looks the same on screen whether the confirmation gated
    //     it or the button quietly cancelled on the first click -- the
    //     same control-A-satisfied-by-control-B shape the GA route-gate
    //     check found), and that "Yes, cancel" reached the server rather
    //     than only this page's own state. Both are checked against a
    //     direct GET of /api/requests/:id -- the same server truth the
    //     owner's screen reads -- not the page's narration of itself.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2016 Nissan Altima',
      location: '555 Demo Path',
      date: LATEST,
    });
    await page.click('button:has-text("Track this quote")');
    await page.waitForURL('**/status?request=*');
    const sharedLinkId = new URL(page.url()).searchParams.get('request');
    const baselineQuote = (await fetch(`${BASE}/api/requests/${encodeURIComponent(sharedLinkId)}`).then(res => res.json()))?.quote;
    await context.close();

    // A second, unrelated context: it never visited '/', so nothing was
    // ever written to its localStorage. The id in the URL is the only
    // thing this "device" is handed -- exactly what a shared link gives it.
    ({ context, page } = await freshPage(browser, viewport));
    await page.goto(`${BASE}/status?request=${encodeURIComponent(sharedLinkId)}`);
    await waitForStatus(page);
    const sharedLinkLoaded = await page.locator('.owner-request-vehicle:has-text("Nissan Altima")').isVisible().catch(() => false);
    if (sharedLinkLoaded) {
      ok('/status?request=<id>: a browser with no prior visit and no localStorage key loads the request from the id alone -- the actual shape of a shared link, not the "My Quote" nav path.');
    } else {
      fail(`/status?request=<id>: a key-less browser did not load the request. Server baseline read as ${JSON.stringify(baselineQuote)}.`);
    }

    await page.click('button:has-text("Cancel this request")');
    await page.click('button:has-text("Keep it")');
    await page.waitForTimeout(200);
    const keptCancelButtonBack = await page.locator('button:has-text("Cancel this request")').isVisible().catch(() => false);
    const afterKeepIt = (await fetch(`${BASE}/api/requests/${encodeURIComponent(sharedLinkId)}`).then(res => res.json()))?.quote;
    const keepItLeftServerUnchanged = afterKeepIt?.status === baselineQuote?.status && afterKeepIt?.version === baselineQuote?.version;
    if (keptCancelButtonBack && keepItLeftServerUnchanged) {
      ok('/status: declining the in-page confirmation ("Keep it") leaves the request exactly as it was on the server -- status and version both unchanged, not merely as the now-dismissed page happens to report it.');
    } else {
      fail(
        `/status: "Keep it" should be a real refusal, not a decoration. Cancel button visible again: ${keptCancelButtonBack}. ` +
          `Server before: ${JSON.stringify(baselineQuote)}, after: ${JSON.stringify(afterKeepIt)} -- these must match.`,
      );
    }

    await page.click('button:has-text("Cancel this request")');
    await page.click('button:has-text("Yes, cancel")');
    await page.waitForTimeout(300);
    const cancelledMsgVisible = await page.locator('text=This request was cancelled.').isVisible().catch(() => false);
    const afterConfirm = (await fetch(`${BASE}/api/requests/${encodeURIComponent(sharedLinkId)}`).then(res => res.json()))?.quote;
    const serverConfirmsCancelled = afterConfirm?.status === 'cancelled' && afterConfirm?.version === (baselineQuote?.version ?? 0) + 1;
    if (cancelledMsgVisible && serverConfirmsCancelled) {
      ok(`/status: confirming cancel is real, not just the page's own claim -- a direct GET independently shows status "cancelled" at version ${afterConfirm?.version}, exactly one past the baseline.`);
    } else {
      fail(
        `/status: the page said cancelled (${cancelledMsgVisible}) but a direct GET disagreed or did not move as expected -- ` +
          `baseline: ${JSON.stringify(baselineQuote)}, after confirm: ${JSON.stringify(afterConfirm)}.`,
      );
    }

    // 8. Quantity control (#113): the tire line multiplies by quantity, the
    //    mobile-service fee does not -- "the visit costs the same whether it
    //    fits one tire or four" (.forge/decisions.md). Nothing else in this
    //    gate touches the quantity picker, so a regression here does not
    //    throw or render oddly; it silently shows a customer a total they
    //    read as a price they are agreeing to.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await page.goto(BASE + '/');

    const [qWidth, qRest] = CLEAN_TIRE.size.split('/');
    const [qRatio, qDiameter] = qRest.split('R');
    for (const value of [qWidth, qRatio, qDiameter]) {
      await page.getByTestId(`fitment-option-${value}`).click({ timeout: 5000 });
    }
    // The ZIP is required at submit now (t48); this scenario drives the
    // fitment step itself rather than through submitRequest(), so it types it.
    await page.fill('#fitmentZip', ZIP_IN_AREA, { timeout: 5000 });
    await page.getByTestId('continue-to-tires').click({ timeout: 5000 });
    await expandTireList(page);
    await page.getByTestId(`tire-option-${CLEAN_TIRE.tireId}`).click({ timeout: 5000 });
    await page.getByTestId('quantity-option-2').click({ timeout: 5000 });

    const setPriceText = (await page.locator('.tire-quantity-total b').first().textContent().catch(() => ''))?.trim();
    const expectedSetPrice = `$${(CLEAN_TIRE.price * 2).toFixed(2)}`;
    const setPriceDoubled = setPriceText === expectedSetPrice;

    await page.locator('.manual-vehicle summary').click();
    await page.fill('#vehicleInfo', '2020 Toyota Camry', { timeout: 5000 });
    await page.getByTestId('continue-to-mobile-service').click({ timeout: 5000 });
    await page.fill('#location', '789 Demo Blvd', { timeout: 5000 });
    await page.fill('#date', LATEST, { timeout: 5000 });
    await page.fill('#customerName', 'Jamie Rivera', { timeout: 5000 });
    await page.fill('#customerEmail', AUDIT_EMAIL, { timeout: 5000 });
    await page.click('button[type="submit"]', { timeout: 5000 });

    const draftMsg = await page.locator('[role="status"]').first().textContent().catch(() => null);
    const expectedDraftTotal = (CLEAN_TIRE.price * 2 + MOBILE_SERVICE_FEE).toFixed(2);
    const draftMatches = draftMsg?.includes(`Draft quote total: $${expectedDraftTotal}`);

    if (setPriceDoubled && draftMatches) {
      ok(
        `Quantity 2 on ${CLEAN_TIRE.tireName}: displayed set price doubles to ${expectedSetPrice}, and the ` +
          `drafted total ($${expectedDraftTotal}) is 2x the tire plus one un-multiplied service fee.`,
      );
    } else {
      fail(
        `Quantity 2 on ${CLEAN_TIRE.tireName}: expected set price ${expectedSetPrice} (got "${setPriceText}") and ` +
          `drafted total including $${expectedDraftTotal} (got message: "${draftMsg}"). A service fee that ` +
          'multiplies with quantity, or a tire line that does not, would both surface here.',
      );
    }

    // 9. The tire step under a slow or stalled connection (t62, the lead's
    //    ruling): full-speed checks cannot see this class of defect, since
    //    the swap completes before a human -- or a normal audit -- could
    //    interact. Routing the catalog-for-size request rather than
    //    emulating a slow connection: LEAD FULL STACK measured the live
    //    build on real Slow 3G, Edge and Drip profiles and none of them
    //    ever missed the 8s window (4.5s worst case), so throttling cannot
    //    reach the branches this exists to prove. Delaying or failing the
    //    actual response the component reacts to tests the property
    //    directly, the way LEAD UI ENGINEER proved the feature correct
    //    while building it; approximating a network condition and hoping
    //    the timing lands would test it through a weaker instrument.

    // 9a. No selectable tire renders before the live answer, and Continue
    //     says so rather than silently doing nothing.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    await page.route('**/api/catalog?size=*', async route => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tires: [] }) });
    });
    await page.goto(BASE + '/');
    for (const value of ['215', '60', '16']) {
      await page.getByTestId(`fitment-option-${value}`).click({ timeout: 5000 });
    }
    await page.getByTestId('continue-to-tires').click({ timeout: 5000 });

    const loadingVisible = await page.locator('.tire-loading').first().isVisible().catch(() => false);
    const tireOptionCount = await page.locator('.tire-option').count();
    await page.getByTestId('continue-to-mobile-service').click({ timeout: 5000 });
    const stillCheckingVisible = await page.locator('.step-error:has-text("still checking")').isVisible().catch(() => false);
    const stillOnTireStep = await page.locator('h3:has-text("Your tires. Your vehicle.")').isVisible().catch(() => false);

    if (loadingVisible && tireOptionCount === 0 && stillCheckingVisible && stillOnTireStep) {
      ok('Tire step under a slow connection: no selectable tire renders before the live answer, and Continue is refused with a visible reason.');
    } else {
      fail(
        `Tire step under a slow connection: expected .tire-loading visible (${loadingVisible}), zero .tire-option ` +
          `(${tireOptionCount}), a "still checking" error on Continue (${stillCheckingVisible}), and no advance past ` +
          `the tire step (${stillOnTireStep}).`,
      );
    }
    await page.unroute('**/api/catalog?size=*');

    // 9b. A live answer arriving after the standard list is offered as a
    //     refresh, not swapped in silently, and the customer's own choice
    //     survives the refresh when it is still in the live list. 215/60R16
    //     carries a seed tire ("All-Weather Standard"), and catalogFromLiveRows
    //     always prepends every seed regardless of what a live answer
    //     carries -- so this is not a special case, it is what a real
    //     supplier answer does for any size that also has a seed.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    let releaseLiveAnswerB;
    const liveAnswerHeldB = new Promise(resolve => { releaseLiveAnswerB = resolve; });
    await page.route('**/api/catalog?size=*', async route => {
      await liveAnswerHeldB;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tires: [] }) });
    });
    await page.goto(BASE + '/');
    for (const value of ['215', '60', '16']) {
      await page.getByTestId(`fitment-option-${value}`).click({ timeout: 5000 });
    }
    await page.getByTestId('continue-to-tires').click({ timeout: 5000 });
    // The request stays held; the app's own 8s wait fires first.
    await page.waitForSelector('.tire-options[data-source="standard"]', { timeout: 12000 });
    await page.getByTestId('tire-option-tire-1').click({ timeout: 5000 });

    releaseLiveAnswerB();
    await page.waitForSelector('button.tire-refresh', { timeout: 5000 });
    await page.click('button.tire-refresh', { timeout: 5000 });

    const movedNote = await page.locator('.tire-reselect-note[data-outcome="moved"]').first().isVisible().catch(() => false);
    const stillSelectedB = await page.locator('.tire-option.selected[data-testid="tire-option-tire-1"]').isVisible().catch(() => false);
    const sourceIsLiveB = (await page.locator('.tire-options').getAttribute('data-source').catch(() => '')) === 'live';

    if (movedNote && stillSelectedB && sourceIsLiveB) {
      ok('Tire step refresh: a chosen tire that survives into the live list keeps its selection and reports "moved".');
    } else {
      fail(
        `Tire step refresh: expected the moved note (${movedNote}), the same tire still selected (${stillSelectedB}), ` +
          `and data-source="live" (${sourceIsLiveB}) after refreshing.`,
      );
    }
    await page.unroute('**/api/catalog?size=*');

    // 9c. A live answer that does not carry the customer's choice clears the
    //     selection, says so, and holds Continue until a new choice is made
    //     -- the recovery path, and the part a customer actually needs to
    //     work. NO_SEED_SIZE carries no seed, so the standard list for it
    //     is entirely generated coverage; the mocked live answer names that
    //     size covered with one different tire, so generateTires() skips
    //     placeholder coverage for it and the originally chosen tire is
    //     genuinely absent from the live-composed list, not just reordered.
    await context.close();
    ({ context, page } = await freshPage(browser, viewport));
    let releaseLiveAnswerC;
    const liveAnswerHeldC = new Promise(resolve => { releaseLiveAnswerC = resolve; });
    const [cWidth, cRest] = NO_SEED_SIZE.split('/');
    const [cRatio, cDiameter] = cRest.split('R');
    await page.route('**/api/catalog?size=*', async route => {
      await liveAnswerHeldC;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          tires: [{
            id: 'audit-live-replacement', name: 'Audit Live Replacement', size: NO_SEED_SIZE,
            price: 99.99, inStock: true, category: 'all-season', description: 'Injected for the refresh-clears check',
          }],
        }),
      });
    });
    await page.goto(BASE + '/');
    for (const value of [cWidth, cRatio, cDiameter]) {
      await page.getByTestId(`fitment-option-${value}`).click({ timeout: 5000 });
    }
    await page.getByTestId('continue-to-tires').click({ timeout: 5000 });
    await page.waitForSelector('.tire-options[data-source="standard"]', { timeout: 12000 });
    await page.locator('.tire-option').first().click({ timeout: 5000 });

    releaseLiveAnswerC();
    await page.waitForSelector('button.tire-refresh', { timeout: 5000 });
    await page.click('button.tire-refresh', { timeout: 5000 });

    const clearedNote = await page.locator('.tire-reselect-note[data-outcome="cleared"]').first().isVisible().catch(() => false);
    const continueButton = page.getByTestId('continue-to-mobile-service');
    const continueDisabledAfterClear = await continueButton.isDisabled().catch(() => false);

    await page.locator('.tire-option').first().click({ timeout: 5000 });
    const noteGoneAfterChoice = !(await page.locator('.tire-reselect-note').first().isVisible().catch(() => true));
    const continueEnabledAfterChoice = !(await continueButton.isDisabled().catch(() => true));

    if (clearedNote && continueDisabledAfterClear && noteGoneAfterChoice && continueEnabledAfterChoice) {
      ok(
        'Tire step refresh: a chosen tire that does not survive into the live list clears the selection, reports ' +
          '"cleared", disables Continue, and a new choice clears the note and re-enables it.',
      );
    } else {
      fail(
        `Tire step refresh: expected the cleared note (${clearedNote}), Continue disabled right after (${continueDisabledAfterClear}), ` +
          `the note gone after a new choice (${noteGoneAfterChoice}), and Continue enabled again (${continueEnabledAfterChoice}).`,
      );
    }
    await page.unroute('**/api/catalog?size=*');

    await context.close();
  }

  // The marketing surface: present and non-empty, never a particular sentence.
  //
  // Why this exists. Every other check in this file drives the wizard, the
  // owner screen, /status or /confirmation. Not one of them reads the landing
  // page's content, and neither does request-flow-check or responsive-check --
  // responsive-check visits `/` but measures overflow, contrast and tap
  // targets, which are structure. Measured rather than assumed: with the hero
  // heading, the hero lede and all three service-strip items blanked in the
  // source and rebuilt, this audit reported 78 of 78, responsive-check 10 of
  // 10 screens and 5 of 5 a11y checks, and request-flow-check 34 of 34. The
  // whole pre-merge gate passed on a site with no marketing copy on it.
  //
  // Why it is presence and not wording. Site copy is becoming owner-editable
  // (.forge/site-copy-inventory.md). An assertion pinning Ken's headline would
  // go red the first time he edits his own words, and an audit that fails when
  // the product works as designed gets deleted or routed around within a week.
  // So these assert the shape of the page and stay silent on what it says.
  // The inventory's own guard rules the same boundary from the other side: a
  // heading, a lede and the strip titles cannot be blank. That guard refuses a
  // bad write; this catches a bad render. Two layers, on purpose -- per-layer
  // checks say WHICH control failed, which one combined check cannot.
  //
  // Why the two entrances are in here. The hero CTA and the /inquiry button
  // are not copy, they are the only in-app routes into the wizard and into
  // /inquiry. They used to be covered by accident, because the audits located
  // them by their visible text; #375 replaced those with data-testid, which is
  // the right change and removed the accident with it. A CTA whose label is
  // blank is an invisible button, and one whose scroll target has gone is a
  // dead end -- which is this file's actual charter, not a content check
  // smuggled in beside it.
  //
  // Folded in here rather than given its own script so it inherits
  // EXPECTED_CHECKS, which fails on a mismatch in either direction. The same
  // reasoning as the GA4 gate below: a standalone control only runs when
  // somebody remembers to run it.
  //
  // Run once, at the phone viewport, because this is one page's content and
  // not a per-viewport behaviour; responsive-check already measures `/` at
  // both widths. Asserted on text content rather than visibility, so these
  // stay true regardless of what CSS chooses to show at a given width, and
  // regardless of whether the copy came from the bundle or from a store.
  {
    const { context, page } = await freshPage(browser, { name: 'phone', width: 375, height: 812 });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

    const text = async (selector) => (await page.locator(selector).first().textContent().catch(() => null))?.trim() ?? '';

    const heroHeading = await text('.hero-section h1');
    if (heroHeading.length > 0) {
      ok('/: the hero heading renders with text in it (not asserting which text -- it is owner-editable).');
    } else {
      fail('/: the hero heading is missing or empty. A visitor lands on a page with no headline.');
    }

    const heroLede = await text('.hero-section .hero-lede');
    if (heroLede.length > 0) {
      ok('/: the hero lede renders with text in it.');
    } else {
      fail('/: the hero lede is missing or empty.');
    }

    const stripItems = await page.locator('.service-strip > div').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: (node.querySelector('b')?.textContent ?? '').trim(),
        body: (node.textContent ?? '').replace((node.querySelector('b')?.textContent ?? ''), '').trim(),
      })),
    );
    const stripFilled = stripItems.length === 3 && stripItems.every((item) => item.label.length > 0 && item.body.length > 0);
    if (stripFilled) {
      ok('/: the service strip renders three items, each with a label and a description.');
    } else {
      fail(`/: the service strip is not three filled items. Got ${JSON.stringify(stripItems)}`);
    }

    const ctaLabel = await text('.hero-section .hero-cta');
    const orderAnchor = await page.locator('#order').count();
    if (ctaLabel.length > 0 && orderAnchor > 0) {
      ok('/: the hero CTA has a label and its scroll target #order exists (the only in-app route into the wizard).');
    } else {
      fail(`/: the hero CTA is a dead end. Label: ${JSON.stringify(ctaLabel)}, #order elements found: ${orderAnchor}.`);
    }

    const inquiryButton = page.locator('.service-strip button');
    const inquiryLabel = (await inquiryButton.first().textContent().catch(() => null))?.trim() ?? '';
    let inquiryHeading = '';
    if (inquiryLabel.length > 0) {
      await inquiryButton.first().click();
      await page.waitForURL('**/inquiry', { timeout: 5000 }).catch(() => {});
      inquiryHeading = (await page.locator('h1').first().textContent().catch(() => null))?.trim() ?? '';
    }
    if (inquiryLabel.length > 0 && new URL(page.url()).pathname === '/inquiry' && inquiryHeading.length > 0) {
      ok('/: the service strip\'s inquiry button has a label and actually reaches /inquiry, which renders a heading.');
    } else {
      fail(`/: the inquiry entrance is broken. Label: ${JSON.stringify(inquiryLabel)}, landed on ${page.url()}, heading: ${JSON.stringify(inquiryHeading)}.`);
    }

    await context.close();
  }
  // The route gate that keeps a customer's own request id out of Google
  // (src/analytics.js, .forge/analytics.md): GA4 must fire on the marketing
  // surface and never on a page whose URL carries a request id, which is
  // the credential for that record -- GA sends the full URL, query string
  // included, with every page view. A gate check, not a rerunnable control
  // script (the OWNER AGENT's ruling, 2026-09-07): a control only runs when
  // someone remembers to, and this project has already found three things
  // tonight that a control script would have caught only by accident.
  // Folded in here rather than given its own run, so it inherits
  // EXPECTED_CHECKS, which fails on a mismatch in either direction -- the
  // one thing that notices a check silently no longer running.
  //
  // AUDIT_BASE is never the canonical host, so the hostname gate alone
  // cannot be exercised by a plain page.goto(BASE + ...) the way the rest
  // of this file navigates. This instead routes a fake
  // https://kensmobiletire.com/* origin to the real server under test, the
  // same technique proved by hand before this check existed -- so
  // window.location is genuinely the canonical host, no property-spoofing
  // of `location` needed. GA's own two domains are intercepted
  // unconditionally, in a context of their own, and never allowed to leave
  // the browser: nothing here can reach Google for real even if the gate
  // under test is wrong.
  //
  // The /status assertion below also watches for a CSP violation, not only
  // a GA network attempt, and treats either as a failure -- found by
  // actually breaking the frontend gate before trusting this check to catch
  // it (the standard this file's own reportCount() comment sets). With
  // ANALYTICS_PATHS in src/analytics.js widened to include /status, the
  // frontend genuinely tried to inject GA's script -- but backend/site.mjs
  // carries its own separate, unmodified ANALYTICS_PATHS gating the CSP, so
  // the browser's own CSP enforcement blocked the request before it ever
  // reached this test's route interception, and a check that only watched
  // network traffic would have reported that break as a pass. The two
  // controls are independent on purpose (the repo agent traced this on
  // #314); a check meant to catch one of them failing must not let the
  // other one quietly cover for it.
  {
    const FAKE_ORIGIN = 'https://kensmobiletire.com';
    const context = await browser.newContext();
    const gaAttempts = [];
    const cspViolations = [];
    await context.route('**://www.googletagmanager.com/**', route => {
      gaAttempts.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '// stubbed for the gate -- never reaches Google' });
    });
    await context.route('**://*.google-analytics.com/**', route => {
      gaAttempts.push(route.request().url());
      route.abort();
    });
    await context.route(`${FAKE_ORIGIN}/**`, async route => {
      const url = new URL(route.request().url());
      const local = await fetch(BASE + url.pathname + url.search);
      const headers = {};
      for (const [key, value] of local.headers.entries()) headers[key] = value;
      delete headers['content-encoding'];
      delete headers['content-length'];
      await route.fulfill({ status: local.status, headers, body: Buffer.from(await local.arrayBuffer()) });
    });

    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error' && /content security policy/i.test(msg.text())) cspViolations.push(msg.text());
    });

    await page.goto(`${FAKE_ORIGIN}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    if (gaAttempts.length > 0) {
      ok('GA4 is attempted on / when this is genuinely the canonical host (intercepted, never reached Google)');
    } else {
      fail('GA4 is attempted on / when this is genuinely the canonical host -- expected a request to googletagmanager.com, got none');
    }

    gaAttempts.length = 0;
    cspViolations.length = 0;
    await page.goto(`${FAKE_ORIGIN}/status?request=audit-fake-request-id`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    if (gaAttempts.length === 0 && cspViolations.length === 0) {
      ok('GA4 never even attempts to load on /status, even with the hostname spoofed to canonical and a request id in the URL -- not blocked by CSP, never tried');
    } else {
      fail(
        `GA4's frontend gate tried to run on /status -- attempts: ${JSON.stringify(gaAttempts)}, ` +
          `CSP violations: ${JSON.stringify(cspViolations)}. Blocked by CSP is not the same as never having tried.`,
      );
    }

    await context.close();
  }

  await browser.close();
  reportCount();
}

main().catch((err) => {
  console.error(err);
  // Say how far it got: a crash after 5 checks and a crash after 39 are
  // different failures, and the count is what tells them apart.
  reportCount();
  process.exit(1);
});
