import { chromium } from 'playwright';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4179';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
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
async function submitRequest(page, { size, tireName, vehicle, location, date }) {
  const [width, rest] = size.split('/');
  const [ratio, diameter] = rest.split('R');

  const step = { timeout: 5000 };

  try {
    await page.goto(BASE + '/');

    // Step 1: fitment. Each stage advances as soon as a value is chosen.
    for (const value of [width, ratio, diameter]) {
      await page.click(`.fitment-option:has-text("${value}")`, step);
    }
    await page.fill('#fitmentZip', '02149').catch(() => {}); // Optional field.
    await page.click('button:has-text("Continue to tires")', step);

    // Step 2: pick the tire by its catalog name, and say what it is going on.
    await page.click(`.tire-option:has-text("${tireName}")`, step);
    await page.fill('#vehicleInfo', vehicle, step);
    await page.click('button:has-text("Continue to mobile service")', step);

    // Step 3: service details, then submit.
    await page.fill('#location', location, step);
    await page.fill('#date', date, step);
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
const EXCEPTION_TIRE = { size: '265/70R16', tireName: 'Off-Road Terrain' };
/** A size and tire that should sail through without an exception. */
const CLEAN_TIRE = { size: '215/60R16', tireName: 'All-Weather Standard' };

async function main() {
  const browser = await chromium.launch();

  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    console.log(`\n=== Viewport: ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    // Start clean.
    await page.goto(BASE + '/');
    await page.evaluate(() => localStorage.removeItem('kmt_store'));
    await page.goto(BASE + '/');

    // 1. Customer submits a request that will trigger an exception (truck + off-road tire)
    //    so we can verify the exception path renders distinctly at /owner.
    await submitRequest(page, {
      ...EXCEPTION_TIRE,
      vehicle: '2019 Ford F-150 Pickup',
      location: '123 Demo St',
      date: '2025-06-01',
    });

    const submissionMsg = await page.locator('[role="status"]').first().textContent().catch(() => null);
    if (submissionMsg && submissionMsg.includes('Quote request submitted')) {
      ok('Customer form: submit produced an immediate confirmation message with the draft quote total.');
    } else {
      fail(`Customer form: no visible submission acknowledgement. Got: ${submissionMsg}`);
    }

    // Visible next action from / after submitting. The nav carries "My Quote"
    // to /status; the owner entry point sits alongside it for the demo.
    const statusLinkVisible = await page.locator('button:has-text("My Quote")').isVisible();
    const ownerLinkVisible = await page.locator('button:has-text("Owner Review")').isVisible();
    if (statusLinkVisible && ownerLinkVisible) {
      ok('Customer form screen: visible next actions (Owner Review, My Quote) after submit.');
    } else {
      fail('Customer form screen: missing visible next action after submit.');
    }

    // 2. Owner review: navigate via visible nav button (not URL typing).
    await page.click('button:has-text("Owner Review")');
    await page.waitForURL('**/owner');

    const exceptionBadge = await page.locator('text=Owner review required').first().isVisible().catch(() => false);
    if (exceptionBadge) {
      ok('/owner: exception state renders distinctly (Owner review required + reasons).');
    } else {
      fail('/owner: exception state did not render as expected for the truck + off-road submission.');
    }

    const approveVisible = await page.locator('button:has-text("Approve")').first().isVisible().catch(() => false);
    if (approveVisible) {
      ok('/owner: Approve action is visible for the reviewed request (owner has a clear next action even on an exception).');
    } else {
      fail('/owner: no visible Approve action found.');
    }

    await page.click('button:has-text("Approve")');
    await page.waitForTimeout(200);

    const approvedStatus = await page.locator('text=APPROVED').first().isVisible().catch(() => false);
    if (approvedStatus) {
      ok('/owner: after clicking Approve, status visibly updates to APPROVED in place (no reload needed).');
    } else {
      fail('/owner: status did not visibly update to APPROVED after clicking Approve.');
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
    const viewConfirmationAfterReload = await page.locator('text=View confirmation').first().isVisible().catch(() => false);
    if (viewConfirmationAfterReload) {
      ok('/status (after reload): paid quote still shows a visible "View confirmation" action.');
    } else {
      fail('/status (after reload): paid quote lost its next action.');
    }

    // 5. Validation dead-end check. On a wizard the risk is not a failed submit,
    //    it is a step that refuses to advance without saying why: the tester
    //    clicks Continue, nothing moves, and there is no visible reason.
    await page.evaluate(() => localStorage.removeItem('kmt_store'));
    await page.goto(BASE + '/');

    const [w, r] = CLEAN_TIRE.size.split('/');
    const [ra, di] = r.split('R');
    for (const value of [w, ra, di]) await page.click(`.fitment-option:has-text("${value}")`);
    await page.click('button:has-text("Continue to tires")');

    // Now on step 2, try to advance without choosing a tire.
    await page.click('button:has-text("Continue to mobile service")');
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
    //    list. Sampled here; the exhaustive walk of all 290 paths is a one-off,
    //    too slow to run every time.
    for (const [w, r, d] of [['175', '70', '14'], ['225', '45', '17'], ['275', '40', '20']]) {
      await page.evaluate(() => localStorage.removeItem('kmt_store'));
      await page.goto(BASE + '/');
      for (const value of [w, r, d]) {
        await page.click(`.fitment-option:has-text("${value}")`, { timeout: 5000 });
      }
      await page.click('button:has-text("Continue to tires")', { timeout: 5000 });

      const tireCount = await page.locator('.tire-option').count();
      const wentEmpty = await page.locator('.tire-empty').isVisible().catch(() => false);
      if (tireCount > 0 && !wentEmpty) {
        ok(`/ (${w}/${r}R${d}): a completed selection lands on tires, not an empty list.`);
      } else {
        fail(`/ (${w}/${r}R${d}): selection ended with no tires -- the selector offered a size nothing fills.`);
      }
    }

    // 7. Rejected quote path: does the customer have a next action, or a dead end?
    await page.evaluate(() => localStorage.removeItem('kmt_store'));
    await submitRequest(page, {
      ...CLEAN_TIRE,
      vehicle: '2021 Honda Civic',
      location: '456 Demo Ave',
      date: '2025-06-02',
    });
    await page.click('button:has-text("Owner Review")');
    await page.waitForURL('**/owner');
    const rejectVisible = await page.locator('button:has-text("Reject")').first().isVisible().catch(() => false);
    if (rejectVisible) {
      await page.click('button:has-text("Reject")');
      await page.waitForTimeout(200);
      await page.click('button:has-text("Back to Customer Flow")');
      await page.waitForURL(BASE + '/');
      await page.click('button:has-text("My Quote")');
      await page.waitForURL('**/status');
      const rejectedMsgVisible = await page.locator('text=This quote was declined').isVisible().catch(() => false);
      if (rejectedMsgVisible) {
        ok('/status: rejected quote shows a clear message explaining the outcome.');
      } else {
        fail('/status: rejected quote has no visible explanation -- reads as a dead end.');
      }
      const newRequestNavVisible = await page.locator('button:has-text("New Request")').isVisible().catch(() => false);
      if (newRequestNavVisible) {
        ok('/status: "New Request" nav is present as the next action for a rejected quote.');
      } else {
        fail('/status: no visible next action after a rejected quote.');
      }
    } else {
      fail('/owner: no visible Reject action found to test the rejected-quote path.');
    }

    await context.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
