import { chromium } from 'playwright';
import { CLEAN_TIRE, EXCEPTION_TIRE, freshPage, openOwnerQuotes, submitRequest } from './audit-ui.mjs';

const BASE = process.env.AUDIT_BASE || 'http://localhost:4173';
const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 },
];

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
    label: 'owner quote list (draft, exception)',
    path: '/owner/quotes',
    async reach(page) {
      await submitRequest(page, {
        base: BASE, ...EXCEPTION_TIRE,
        vehicle: '2020 Ford F-150 Pickup Truck Long Bed XLT',
        location: '123 Very Long Street Address Name, Springfield, ST 00000',
        date: '2026-09-10',
        notes: 'Behind the building, blue truck by the loading bay',
      });
      await openOwnerQuotes(page);
    },
  },
  {
    label: 'status (approved, payable)',
    path: '/status',
    async reach(page) {
      await submitRequest(page, {
        base: BASE, ...CLEAN_TIRE,
        vehicle: '2020 Toyota Corolla',
        location: '456 Demo Ave, Everett, MA 02149',
        date: '2026-09-10',
      });
      await openOwnerQuotes(page);
      await page.click('button:has-text("Approve")');
      await page.waitForSelector('text=APPROVED', { timeout: 15000 });
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
      await screens[2].reach(page);
      await page.click('button:has-text("Pay $")');
      await page.waitForURL('**/confirmation**', { timeout: 15000 });
      await page.waitForSelector('.confirmation-card', { timeout: 15000 });
    },
  },
];

(async () => {
  const browser = await chromium.launch();
  let hadIssue = false;

  for (const viewport of VIEWPORTS) {
    for (const screen of screens) {
      // A context per screen, so one scenario's requests never decorate the
      // next one's measurement.
      const { context, page } = await freshPage(browser, viewport);
      try {
        await screen.reach(page);
        const result = await checkOverflow(page);
        const status = result.scrollWidth > result.docWidth + 1 ? 'OVERFLOW' : 'ok';
        if (status === 'OVERFLOW') hadIssue = true;
        console.log(`[${viewport.name} ${viewport.width}px] ${screen.label} (${screen.path}) -> ${status} (doc=${result.docWidth} scroll=${result.scrollWidth})`);
        for (const o of result.overflowing) {
          console.log(`    ${o.tag}.${o.cls} right=${o.right} width=${o.width}`);
        }
        await page.screenshot({ path: `.forge/shots/${viewport.name}-${screen.path.replace(/[/?=&]/g, '_') || 'root'}.png`, fullPage: true });
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
  process.exit(hadIssue ? 1 : 0);
})();
