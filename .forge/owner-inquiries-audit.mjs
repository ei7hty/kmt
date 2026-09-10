import { chromium } from 'playwright'
import { signInIfAsked } from './audit-ui.mjs'

// No default, on purpose. A script that silently audits SOMETHING rather than
// refusing to audit NOTHING answers confidently about a target nobody chose.
// Three instances of that cost real work here: this file and
// owner-inquiries-audit defaulted to a shared local port, which is how one
// session's audit reached another's server and produced a finding that had to
// be retracted; and deployed-site-check defaulted to a host, so a run given
// DEPLOY_URL instead of AUDIT_BASE passed 69/69 against a host CI was not
// testing and that pass was relayed as reassurance. AGENTS.md documents the
// trap; a11y-85-measure was the only one already refusing.
const BASE = process.env.AUDIT_BASE
if (!BASE) { console.error('Set AUDIT_BASE explicitly; the audits default to different ports and this one refuses to guess.'); process.exit(2) }
const EXPECTED_CHECKS = 22
let passed = 0
let failed = 0
const ok = message => { passed++; console.log(`OK: ${message}`) }
const fail = message => { failed++; process.exitCode = 1; console.error(`FAIL: ${message}`) }
const check = (condition, message) => condition ? ok(message) : fail(message)

const browser = await chromium.launch({ headless: true })
for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const label = `${viewport.width}px`

  await page.route('**/api/owner/inquiries', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"counts":{"new":0,"replied":0,"closed":0},"inquiries":[]}' }))
  await page.goto(`${BASE}/owner/inquiries`)
  await signInIfAsked(page)
  await page.waitForSelector('[data-testid="inquiries-empty"]')
  check(await page.getByTestId('inquiries-empty').isVisible(), `${label}: empty state explains that no inquiries exist`)
  await page.unrouteAll({ behavior: 'wait' })

  const marker = `Audit ${viewport.width} ${Date.now()}`
  const created = await page.request.post(`${BASE}/api/inquiries`, { data: { name: marker, contact: `audit${viewport.width}@example.com`, message: 'Need brake help' } })
  check(created.status() === 201, `${label}: public intake creates the owner-visible fixture`)
  await page.goto(`${BASE}/owner`)
  await signInIfAsked(page)
  await page.waitForSelector('[data-testid="nav-inquiries"]')
  check((await page.getByTestId('nav-inquiries').innerText()).includes('1'), `${label}: owner navigation badges the new inquiry`)
  await page.getByTestId('nav-inquiries').click()
  await page.waitForURL('**/owner/inquiries')
  check(true, `${label}: the badge navigates to the inquiry list`)
  await page.waitForSelector('.inquiry-card')
  check(await page.locator('.inquiry-card').first().getAttribute('data-status') === 'new', `${label}: newest inquiry appears as new`)
  check(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `${label}: inquiry screen does not scroll sideways`)

  await page.getByRole('button', { name: 'Mark replied' }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="replied"]')
  check(true, `${label}: owner can mark an inquiry replied`)
  await page.getByRole('button', { name: 'Close', exact: true }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="closed"]')
  check(true, `${label}: owner can close a replied inquiry`)
  await page.getByRole('button', { name: 'Reopen as replied' }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="replied"]')
  check(true, `${label}: owner can correct a mistaken close`)
  await page.getByRole('button', { name: 'Mark new' }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="new"]')
  check(true, `${label}: owner can correct a mistaken replied state`)
  // Leave the shared test database with no new rows so the next viewport's
  // badge has one exact fixture rather than inheriting this viewport's row.
  await page.getByRole('button', { name: 'Mark replied' }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="replied"]')
  await page.getByRole('button', { name: 'Close', exact: true }).first().click()
  await page.waitForSelector('.inquiry-card[data-status="closed"]')

  await page.route('**/api/owner/inquiries', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"broken"}' }))
  await page.reload()
  await signInIfAsked(page)
  await page.waitForSelector('[role="alert"]')
  check(await page.getByRole('button', { name: 'Try again' }).isVisible(), `${label}: load failure is distinct and retryable`)
  await context.close()
}
await browser.close()

const ran = passed + failed
if (ran !== EXPECTED_CHECKS) {
  console.error(`FAIL: expected ${EXPECTED_CHECKS} checks, ran ${ran}`)
  process.exitCode = 1
}
console.log(`${passed}/${EXPECTED_CHECKS} owner inquiry checks passed`)
