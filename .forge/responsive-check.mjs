import { chromium } from 'playwright';

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
      // find elements wider than viewport
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.right > docWidth + 1 || rect.width > docWidth + 1) {
          overflowing.push({
            tag: el.tagName,
            cls: el.className && el.className.toString().slice(0, 80),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          });
        }
      }
    }
    return { docWidth, scrollWidth, overflowing: overflowing.slice(0, 10) };
  });
}

async function seed(page, data) {
  await page.evaluate((d) => {
    localStorage.setItem('kmt_store', JSON.stringify(d));
  }, data);
}

function makeStore({ quoteStatus = 'draft', exception = false } = {}) {
  const request = {
    id: 'req-1',
    vehicleInfo: '2020 Ford F-150 Pickup Truck Long Bed XLT',
    tireSelection: 'tire-1',
    location: '123 Very Long Street Address Name, Springfield, ST 00000',
    date: '2025-01-01',
    createdAt: new Date().toISOString(),
    status: 'submitted',
  };
  const quote = {
    id: 'quote-1',
    requestId: 'req-1',
    lineItems: [
      { description: 'All-Season Touring Tire 225/65R17', quantity: 1, unitPrice: 129.99 },
      { description: 'Mobile installation service', quantity: 1, unitPrice: 49.99 },
    ],
    total: 179.98,
    exception,
    exceptionReasons: exception ? ['Truck, pickup, van, and SUV requests require owner review', 'Off-road tire requires owner review'] : [],
    createdAt: new Date().toISOString(),
    status: quoteStatus,
  };
  return { requests: [request], quotes: [quote], version: 1 };
}

const screens = [
  { path: '/', label: 'home/request-form', seedData: null },
  { path: '/owner', label: 'owner-list (draft, exception)', seedData: makeStore({ quoteStatus: 'draft', exception: true }) },
  { path: '/status', label: 'status (approved -> pay)', seedData: makeStore({ quoteStatus: 'approved' }) },
  { path: '/confirmation?quoteId=quote-1', label: 'confirmation', seedData: makeStore({ quoteStatus: 'paid' }) },
];

(async () => {
  const browser = await chromium.launch();
  let hadIssue = false;
  for (const viewport of VIEWPORTS) {
    for (const screen of screens) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      if (screen.seedData) {
        await seed(page, screen.seedData);
      } else {
        await page.evaluate(() => localStorage.removeItem('kmt_store'));
      }
      await page.goto(BASE + screen.path, { waitUntil: 'networkidle' });
      const result = await checkOverflow(page);
      const status = result.scrollWidth > result.docWidth + 1 ? 'OVERFLOW' : 'ok';
      if (status === 'OVERFLOW') hadIssue = true;
      console.log(`[${viewport.name} ${viewport.width}px] ${screen.label} (${screen.path}) -> ${status} (doc=${result.docWidth} scroll=${result.scrollWidth})`);
      if (result.overflowing.length) {
        for (const o of result.overflowing) {
          console.log(`    ${o.tag}.${o.cls} right=${o.right} width=${o.width}`);
        }
      }
      await page.screenshot({ path: `.forge/shots/${viewport.name}-${screen.path.replace(/[/?=&]/g, '_') || 'root'}.png`, fullPage: true });
      await page.close();
    }
  }
  await browser.close();
  process.exit(hadIssue ? 1 : 0);
})();
