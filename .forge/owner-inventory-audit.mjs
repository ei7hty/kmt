import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
const base = 'http://127.0.0.1:4180'
const browser = await chromium.launch()
const errors = []
const initial = (await (await fetch(base + '/api/owner/inventory')).json()).items[0]
mkdirSync('.forge/shots', {recursive:true})
try {
  for (const viewport of [{width:1280,height:900},{width:375,height:812}]) {
    const page = await browser.newPage({viewport})
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base + '/owner')
    await page.locator('.oi-tire').first().waitFor()
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    const card = page.locator('.oi-tire').first()
    await card.getByLabel('Your price per tire ($)').fill('89.99')
    await card.getByLabel('Offer this tire').check()
    await card.getByLabel('Owner notes').fill('Owner UI verification')
    await card.getByRole('button', {name:'Save offer'}).click()
    await page.getByText('Offer saved. Your selection and price are stored in the owner database.').waitFor()
    await page.reload()
    await page.locator('.oi-tire').first().waitFor()
    assert.equal(await card.getByLabel('Your price per tire ($)').inputValue(), '89.99')
    assert.equal(await card.getByLabel('Offer this tire').isChecked(), true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({path:'.forge/shots/owner-inventory-' + viewport.width + '.png'})
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    assert.equal(overflow, false, 'Owner viewport overflow')
    await page.getByRole('button', {name:'Quote requests'}).click()
    await page.locator('h1').filter({hasText:'Quote Requests'}).waitFor()
    await page.getByRole('button', {name:'Inventory', exact:false}).click()
    await page.locator('.oi-tire').first().waitFor()
    await page.getByLabel('Search tires or SKU').fill('NO-SUCH-TIRE-XYZ')
    await page.getByText('No tires to show yet').waitFor()
    await page.goto(base + '/')
    await page.getByRole('heading', {name:'Mobile Tire Service'}).waitFor()
    console.log('PASS owner save/reload, navigation, search, customer home, and no overflow at ' + viewport.width)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS no browser runtime errors')
} finally {
  const latest = (await (await fetch(base + '/api/owner/inventory?search=' + encodeURIComponent(initial.id))).json()).items.find(t => t.id === initial.id)
  if (latest) await fetch(base + '/api/owner/offers/' + encodeURIComponent(initial.id), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...initial.offer, version:latest.offer.version})})
  await browser.close()
}
