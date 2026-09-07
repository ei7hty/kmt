/* global document */ // used inside page.evaluate, which runs in the browser
import { chromium } from 'playwright';
import { EXCEPTION_TIRE, cleanTireFor, freshPage, openOwnerQuotes, signInIfAsked, submitRequest } from './audit-ui.mjs';
import { dedupe, measure } from './contrast-measure.mjs';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4173';
/** One address per script, not shared across the gate -- see audit-ui.mjs's submitRequest. */
const AUDIT_EMAIL = 'jamie+responsive-check@example.com';
/**
 * A preferred date well clear of today: the server now refuses anything
 * inside a week of today (t48's date floor), and a value right at day 7 can
 * land on either side of that boundary depending on the time of day this
 * runs and the machine's clock vs. the Massachusetts calendar the server
 * judges it on.
 */
const SOON = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * How many screens a complete run measures: every screen at every viewport.
 *
 * The baseline lives here, in the thing that produces it, and nowhere in
 * prose. When you add or remove a check, change this number in the same
 * commit. The run fails if a different number of checks executed: fewer
 * means screens stopped being measured -- the way an audit here once passed while
 * asserting nothing -- and more means the baseline was not updated.
 */
const EXPECTED_CHECKS = 12;

/**
 * #107: the same baseline, but for the AA-contrast and 44px-tap-target gate.
 * One per screen, at the phone viewport only -- that pairing (contrast and
 * tap targets, at 375px) is the scope #85 measured and #107 gates, and
 * running it a second time at desktop would mean asserting a touch-target
 * rule against a pointer that isn't a finger.
 *
 * No element is exempted by position or purpose: not an inline contact
 * link, not a link to another site, not a checkbox. A rule with a carve-out
 * for "this kind of element doesn't really count" needs a classifier to
 * decide what counts, and the classifier is where a real failure goes to
 * hide. If a specific element can't reasonably be fixed, that is a decision
 * for whoever owns that screen to make and record -- not a filter in here.
 */
const EXPECTED_A11Y_CHECKS = 6;
function usesA11y(v) { return v.name === 'phone'; }

async function checkOverflow(page) {
  return page.evaluate(() => {
    const docWidth = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const overflowing = [];
    if (scrollWidth > docWidth + 1) {
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > docWidth + 1) {
          overflowing.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().split(' ').filter(Boolean).slice(0, 3).join('.'),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
        }
      }
    }
    return { docWidth, scrollWidth, overflowing: overflowing.slice(0, 10) };
  });
}

/**
 * Each screen, reached the way a customer or an owner reaches it.
 *
 * These states used to be written straight into localStorage -- a fabricated
 * request and quote, then a navigation to the screen that rendered them. It was
 * quick, and it measured screens nobody could have arrived at: an owner list
 * holding a quote for a tire that is not in the catalog, a confirmation marked
 * paid without anything being paid. Performing the state means the screen being
 * measured is a screen that exists.
 */
const screens = [
  {
    label: 'home/request-form',
    path: '/',
    async reach(page) { await page.goto(BASE + '/', { waitUntil: 'networkidle' }); },
  },
  {
    label: 'status (no device history)',
    path: '/status',
    async reach(page) {
      await page.goto(BASE + '/status', { waitUntil: 'networkidle' });
      await page.getByText('No request history was found on this device.', { exact: true }).waitFor();
      await page.getByText("Reopen the quote status link from Ken's email to view a previous request.", { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Text (617) 410-8319' }).waitFor();
      await page.getByRole('button', { name: 'New Request' }).waitFor();
    },
  },
  {
    label: 'owner inventory',
    path: '/owner',
    async reach(page) {
      await submitRequest(page, {
        base: BASE, customerEmail: AUDIT_EMAIL, ...EXCEPTION_TIRE,
        vehicle: '2020 Ford F-150 Pickup Truck Long Bed XLT',
        location: '123 Very Long Street Address Name, Springfield, ST 00000',
        date: SOON,
        notes: 'Behind the building, blue truck by the loading bay',
      });
      // Stop at the inventory table itself, one step short of the quotes
      // list openOwnerQuotes() lands on -- the two are different screens
      // with different elements, and the inventory table is where #85 found
      // its tap-target failures.
      const origin = new URL(page.url()).origin;
      await page.goto(`${origin}/owner`);
      await signInIfAsked(page);
      await page.waitForSelector('.owner-content, .oi-results, .oi-error, [role="tablist"]', { timeout: 15000 }).catch(() => {});
    },
  },
  {
    label: 'owner quote list (draft, exception)',
    path: '/owner/quotes',
    async reach(page) {
      await submitRequest(page, {
        base: BASE, customerEmail: AUDIT_EMAIL, ...EXCEPTION_TIRE,
        vehicle: '2020 Ford F-150 Pickup Truck Long Bed XLT',
        location: '123 Very Long Street Address Name, Springfield, ST 00000',
        date: SOON,
        notes: 'Behind the building, blue truck by the loading bay',
      });
      await openOwnerQuotes(page);
    },
  },
  {
    label: 'status (sent, payable)',
    path: '/status',
    async reach(page) {
      await submitRequest(page, {
        base: BASE, customerEmail: AUDIT_EMAIL, ...(await cleanTireFor(BASE)),
        vehicle: '2020 Toyota Corolla',
        location: '456 Demo Ave, Everett, MA 02149',
        date: SOON,
      });
      await openOwnerQuotes(page);
      await page.click('button:has-text("Approve")');
      await page.waitForSelector('text=SENT', { timeout: 15000 });
      await page.click('button:has-text("Back to Customer Flow")');
      await page.waitForURL(BASE + '/');
      await page.click('button:has-text("My Quote")');
      await page.waitForURL('**/status');
      await page.waitForSelector('button:has-text("Pay $")', { timeout: 15000 });
    },
  },
  {
    label: 'confirmation (paid)',
    path: '/confirmation',
    async reach(page) {
      // By label, not position: inserting a screen above this one has
      // already once shifted every numeric index below it silently.
      await screens.find(s => s.label === 'status (sent, payable)').reach(page);
      await page.click('button:has-text("Pay $")');
      await page.waitForURL('**/confirmation**', { timeout: 15000 });
      await page.waitForSelector('.confirmation-card', { timeout: 15000 });
    },
  },
];

(async () => {
  const browser = await chromium.launch();
  let hadIssue = false;
  let measured = 0;
  let a11yMeasured = 0;

  for (const viewport of VIEWPORTS) {
    for (const screen of screens) {
      // A context per screen, so one scenario's requests never decorate the
      // next one's measurement.
      const { context, page } = await freshPage(browser, viewport);
      try {
        await screen.reach(page);
        const result = await checkOverflow(page);
        const status = result.scrollWidth > result.docWidth + 1 ? 'OVERFLOW' : 'ok';
        measured += 1;
        if (status === 'OVERFLOW') hadIssue = true;
        console.log(`[${viewport.name} ${viewport.width}px] ${screen.label} (${screen.path}) -> ${status} (doc=${result.docWidth} scroll=${result.scrollWidth})`);
        for (const o of result.overflowing) {
          console.log(`    ${o.tag}.${o.cls} right=${o.right} width=${o.width}`);
        }
        await page.screenshot({ path: `.forge/shots/${viewport.name}-${screen.path.replace(/[/?=&]/g, '_') || 'root'}.png`, fullPage: true });

        // #107: AA contrast and 44px tap targets, at the phone viewport,
        // hard-failing the run rather than only reporting -- the numbers
        // themselves come from contrast-measure.mjs, the same fixed logic
        // a11y-85-measure.mjs's report uses, so a fix or a regression in
        // that logic shows up in both places at once, not just one.
        if (usesA11y(viewport)) {
          const a11y = await measure(page, screen.label);
          a11yMeasured += 1;
          // Text over a background image is flagged as not computed, same
          // as the report: it is not a passing result standing in for a
          // real check, so it cannot fail one either.
          const contrastFails = a11y.texts.filter(t => !t.pass && !t.image);
          const tapFails = a11y.interactive.filter(i => !i.tapPass);
          if (contrastFails.length || tapFails.length) hadIssue = true;
          const a11yStatus = contrastFails.length || tapFails.length ? 'FAIL' : 'ok';
          console.log(`[${viewport.name} ${viewport.width}px] ${screen.label} (${screen.path}) -> a11y ${a11yStatus} (contrast ${contrastFails.length}, tap-target ${tapFails.length})`);
          // Deduped for the log only -- twenty identical checkboxes print as
          // one line. The count above, and the fail/pass verdict, are off
          // the raw list: a screen full of the same broken checkbox is still
          // a screen full of broken checkboxes.
          for (const t of dedupe(contrastFails, x => [x.fgHex, x.bgHex, x.tag, x.cls, x.size, x.weight].join('|'))) {
            console.log(`    contrast: <${t.tag}${t.cls ? '.' + t.cls : ''}> "${t.text}" fg ${t.fgHex} on bg ${t.bgHex} @ ${t.size}px/${t.weight} -> ${t.ratio}:1, needs ${t.threshold}:1`);
          }
          for (const i of dedupe(tapFails, x => [x.tag, x.cls, x.id, x.text, Math.round(x.w), Math.round(x.h)].join('|'))) {
            console.log(`    tap target: <${i.tag}${i.cls ? '.' + i.cls : ''}> "${i.text}" -> ${i.w} x ${i.h} px, needs 44 x 44`);
          }
        }
      } catch (error) {
        hadIssue = true;
        // A screen that cannot be reached is a worse result than one that
        // overflows, and it must not read as silence.
        console.log(`[${viewport.name} ${viewport.width}px] ${screen.label} (${screen.path}) -> UNREACHABLE: ${error.message.split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();

  // An UNREACHABLE screen is not measured, so it shows up here twice: as the
  // issue it is, and as a count that fell short of the baseline.
  console.log(`\n${measured} of ${EXPECTED_CHECKS} expected screens measured`);
  if (measured < EXPECTED_CHECKS) {
    console.error(`FAIL: only ${measured} of ${EXPECTED_CHECKS} screens were measured. A screen that was not measured did not pass.`);
    hadIssue = true;
  } else if (measured > EXPECTED_CHECKS) {
    console.error(`FAIL: ${measured} screens measured but EXPECTED_CHECKS is ${EXPECTED_CHECKS}. Update it in the same commit as the new screen.`);
    hadIssue = true;
  }

  console.log(`${a11yMeasured} of ${EXPECTED_A11Y_CHECKS} expected #107 (a11y) checks measured`);
  if (a11yMeasured < EXPECTED_A11Y_CHECKS) {
    console.error(`FAIL: only ${a11yMeasured} of ${EXPECTED_A11Y_CHECKS} #107 checks ran. A screen that was not measured did not pass.`);
    hadIssue = true;
  } else if (a11yMeasured > EXPECTED_A11Y_CHECKS) {
    console.error(`FAIL: ${a11yMeasured} #107 checks ran but EXPECTED_A11Y_CHECKS is ${EXPECTED_A11Y_CHECKS}. Update it in the same commit as the new screen.`);
    hadIssue = true;
  }
  process.exit(hadIssue ? 1 : 0);
})();
