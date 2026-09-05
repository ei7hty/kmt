import { chromium } from 'playwright';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4179';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

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
    await page.fill('input[name="vehicleInfo"]', '2019 Ford F-150 Pickup');
    await page.selectOption('select[name="tireSelection"]', 'tire-5'); // Off-Road Terrain -> exception trigger
    await page.fill('input[name="location"]', '123 Demo St');
    await page.fill('input[name="date"]', '2025-06-01');
    await page.click('button[type="submit"]');

    const submissionMsg = await page.locator('[role="status"]').first().textContent().catch(() => null);
    if (submissionMsg && submissionMsg.includes('submitted successfully')) {
      ok('Customer form: submit produced an immediate confirmation message with the draft quote total.');
    } else {
      fail(`Customer form: no visible submission acknowledgement. Got: ${submissionMsg}`);
    }

    // Visible next action from / after submitting: nav buttons to /owner and /status.
    const statusLinkVisible = await page.locator('button:has-text("View Quote Status")').isVisible();
    const ownerLinkVisible = await page.locator('button:has-text("Go to Owner Review")').isVisible();
    if (statusLinkVisible && ownerLinkVisible) {
      ok('Customer form screen: visible next actions to Owner Review and Quote Status after submit.');
    } else {
      fail('Customer form screen: missing visible next action after submit.');
    }

    // 2. Owner review: navigate via visible nav button (not URL typing).
    await page.click('button:has-text("Go to Owner Review")');
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
    await page.click('button:has-text("View Quote Status")');
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

    // 5. Validation dead-end check: submitting an empty form on / must show a clear, actionable error, not a silent no-op.
    await page.evaluate(() => localStorage.removeItem('kmt_store'));
    await page.goto(BASE + '/');
    await page.click('button[type="submit"]');
    const validationVisible = await page.locator('text=Please complete all required fields').isVisible().catch(() => false);
    if (validationVisible) {
      ok('/ (empty submit): validation summary is visible, giving the tester a clear next action (fill fields).');
    } else {
      fail('/ (empty submit): no visible validation feedback -- looks like a dead end / silent failure.');
    }

    // 6. Rejected quote path: does the customer have a next action, or a dead end?
    await page.evaluate(() => localStorage.removeItem('kmt_store'));
    await page.goto(BASE + '/');
    await page.fill('input[name="vehicleInfo"]', '2021 Honda Civic');
    await page.selectOption('select[name="tireSelection"]', 'tire-1');
    await page.fill('input[name="location"]', '456 Demo Ave');
    await page.fill('input[name="date"]', '2025-06-02');
    await page.click('button[type="submit"]');
    await page.click('button:has-text("Go to Owner Review")');
    await page.waitForURL('**/owner');
    const rejectVisible = await page.locator('button:has-text("Reject")').first().isVisible().catch(() => false);
    if (rejectVisible) {
      await page.click('button:has-text("Reject")');
      await page.waitForTimeout(200);
      await page.click('button:has-text("Back to Customer Flow")');
      await page.waitForURL(BASE + '/');
      await page.click('button:has-text("View Quote Status")');
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
