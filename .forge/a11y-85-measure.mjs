/**
 * Measure issue #85 at 375px against a running server: contrast ratios for
 * every visible text element (with every brand-red pairing called out) and
 * the size of every interactive element against a 44x44 CSS-px target.
 *
 * Read-only. Drives the app the way a person does, through the same helpers
 * the audits use, so every screen measured is one a customer or owner can
 * reach. Numbers come out of this script, not off a screenshot.
 *
 *   AUDIT_BASE=http://127.0.0.1:4301 KMT_OWNER_PASSWORD=... node .forge/a11y-85-measure.mjs
 *   AUDIT_BASE=... KMT_OWNER_SESSION_COOKIE=$(node scripts/mint-session.mjs --quiet) node .forge/a11y-85-measure.mjs
 *
 * Writes .forge/a11y-85-results.json (everything) and prints a summary.
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { cleanTireFor, exceptionTireFor, expandTireList, freshPage, openOwnerQuotes, signInIfAsked, submitRequest, waitForStatus } from './audit-ui.mjs'
import { dedupe, hex, lum, measure, ratio } from './contrast-measure.mjs'
// Imported, never restated. backend/migration.test.mjs already iterates this
// constant four times and builds the CHECK constraint from it; this is that
// convention applied to a second place rather than a new idea.
import { QUOTE_STATUSES } from '../backend/quotes.mjs'

const BASE = process.env.AUDIT_BASE
if (!BASE) { console.error('Set AUDIT_BASE explicitly; this refuses to guess which target to audit.'); process.exit(2) }
const EXCEPTION_TIRE = await exceptionTireFor(BASE)
const VIEWPORT = { width: 375, height: 812 }

/**
 * Which quote statuses this run actually rendered on /status.
 *
 * Why a set rather than a count: this script measured fourteen states and
 * reached two of the seven statuses, which is why it found one of the three
 * sites of the contrast defect #404 fixed. The two it missed were `rejected`
 * and `cancelled` -- the screens where a customer has just been told no and
 * most needs to reach Ken. A coverage number is a claim about what you looked
 * at, not about what is there.
 */
const reached = new Set()
/** What POST /api/owner/quotes/:id/approve actually leaves the status as. */
let approveYields
/** One address per script, not shared across the gate -- see audit-ui.mjs's submitRequest. */
const AUDIT_EMAIL = 'jamie+a11y-85-measure@example.com'

/**
 * A preferred date well clear of today: the server refuses anything inside
 * a week of today (t48's date floor). A fixed literal ('2026-09-10') used to
 * sit at every call site below; once that date moved inside the floor every
 * submission in this script started failing for a reason it wasn't testing.
 */
const SOON = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)

// ---------- colour maths (WCAG 2.x) ----------
// lum/ratio/hex and the fixed measure() function live in contrast-measure.mjs
// now, shared with responsive-check.mjs's #107 gate so the two never drift
// the way one copy of this logic already did (#217, the clipped-text fix).
// What stays here (rgbToHsl/hslToRgb/nearestPassing) is specific to this
// script's proposed-fix suggestions, which the gate has no use for.
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h, s, l }
}
function hslToRgb({ h, s, l }) {
  const k = (n) => (n + h * 12) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: 1 }
}
/**
 * The nearest shade of `color` (same hue and saturation, lightness moved in
 * the given direction) that reaches `target` against `other`. Returns null
 * when no lightness does, which happens when the hue itself is the problem.
 */
function nearestPassing(color, other, target, direction) {
  const hsl = rgbToHsl(color)
  for (let step = 1; step <= 100; step++) {
    const l = hsl.l + direction * step / 100
    if (l < 0 || l > 1) break
    const candidate = hslToRgb({ ...hsl, l })
    const r = ratio(candidate, other)
    if (r >= target) return { hex: hex(candidate), ratio: +r.toFixed(2) }
  }
  return null
}

// ---------- the states ----------
const results = []
const browser = await chromium.launch()
try {
  const clean = await cleanTireFor(BASE)
  const clean2 = clean

  // Customer wizard, each step, then the acknowledgement.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    results.push(await measure(page, 'home + step 1 (fitment)'))
    const [width, rest] = clean.size.split('/'); const [ratioPart, diameter] = rest.split('R')
    for (const v of [width, ratioPart, diameter]) await page.getByTestId(`fitment-option-${v}`).click({ timeout: 15000 })
    await page.fill('#fitmentZip', '02149').catch(() => {})
    results.push(await measure(page, 'step 1 with size chosen'))
    await page.getByTestId('continue-to-tires').click({ timeout: 15000 })
    await page.waitForSelector('.tire-option', { timeout: 15000 })
    // The "Show all" one-shot button became paged "Show N more" (#187);
    // expandTireList() already loops on the paged control's stable class.
    await expandTireList(page)
    results.push(await measure(page, 'step 2 (tires, before choosing)'))
    await page.getByTestId(`tire-option-${clean.tireId}`).click({ timeout: 15000 })
    await page.locator('.manual-vehicle summary').click()
    await page.fill('#vehicleInfo', '2019 Honda Civic', { timeout: 15000 })
    results.push(await measure(page, 'step 2 (tire selected, vehicle typed)'))
    await page.getByTestId('continue-to-mobile-service').click({ timeout: 15000 })
    await page.waitForSelector('#location', { timeout: 15000 })
    results.push(await measure(page, 'step 3 (service details, empty)'))
    await page.fill('#location', '12 Example St, Everett, MA 02149')
    await page.fill('#date', SOON)
    await page.fill('#customerName', 'Jamie Rivera')
    await page.fill('#customerEmail', AUDIT_EMAIL)
    await page.click('button[type="submit"]', { timeout: 15000 })
    await page.waitForSelector('.success-message', { timeout: 15000 })
    results.push(await measure(page, 'acknowledgement (submitted)'))
    await page.goto(BASE + '/status', { waitUntil: 'networkidle' })
    await waitForStatus(page)
    results.push(await measure(page, '/status (draft)')); reached.add('draft')
    await context.close()
  }

  // Owner: sign-in, inventory, quotes with a draft and an exception; approve one.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await submitRequest(page, { base: BASE, customerEmail: AUDIT_EMAIL, ...EXCEPTION_TIRE, vehicle: '2020 Ford F-150 Pickup Truck', location: '12 Example St, Everett, MA 02149', date: SOON, notes: 'Behind the building' })
    // R4 retires the customer-facing "Owner review" link; direct navigation
    // replaces the click, the same fix openOwnerQuotes() got in audit-ui.mjs.
    await page.goto(`${new URL(page.url()).origin}/owner`)
    await page.waitForSelector('.oi-signin, .owner-content, .oi-results, .oi-error', { timeout: 15000 }).catch(() => {})
    if (await page.locator('.oi-signin').count()) results.push(await measure(page, '/owner sign-in form'))
    await signInIfAsked(page)
    await page.waitForSelector('.owner-content, .oi-results, .oi-error, [role="tablist"]', { timeout: 15000 }).catch(() => {})
    results.push(await measure(page, '/owner inventory'))
    await page.getByTestId('nav-quote-requests').click()
    await page.waitForURL('**/owner/quotes')
    await signInIfAsked(page)
    await page.waitForSelector('.owner-request, .panel', { timeout: 15000 })
    results.push(await measure(page, '/owner/quotes (draft + exception)'))
    // Approve the clean one if an approve control exists.
    const approve = page.locator('button:has-text("Approve")')
    if (await approve.count()) {
      await approve.first().click()
      await page.waitForTimeout(800)
      results.push(await measure(page, '/owner/quotes (after approve)'))
    }
    await context.close()
  }

  // Customer: /status with a sent quote (Pay), then /confirmation.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await submitRequest(page, { base: BASE, customerEmail: AUDIT_EMAIL, ...clean2, vehicle: '2019 Honda Civic', location: '12 Example St, Everett, MA 02149', date: SOON })
    await openOwnerQuotes(page)
    const approve = page.locator('.owner-request:has-text("Honda Civic") button:has-text("Approve"), button:has-text("Approve")')
    if (await approve.count()) { await approve.first().click(); await page.waitForTimeout(800) }
    await page.goto(BASE + '/status', { waitUntil: 'networkidle' })
    await waitForStatus(page)
    results.push(await measure(page, '/status (sent, Pay available)')); reached.add('sent')
    const pay = page.locator('button:has-text("Pay")')
    if (await pay.count()) {
      await pay.first().click()
      await page.waitForURL('**/confirmation**', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(800)
      results.push(await measure(page, '/confirmation (paid)'))
    }
    await context.close()
  }

  // The statuses nobody was driving.
  //
  // Above this point the script reached `draft` and `sent`. QUOTE_STATUSES has
  // seven, and every one renders distinct customer-visible markup on /status --
  // `stopped` even removes the stepper for the two closed ones. The five it
  // never opened included both states where #404's contrast defect was live and
  // unmeasured, which is why one of three sites was found.
  //
  // Driven through the API rather than the UI on purpose: what is measured is
  // the rendered /status page in each state, not the path that gets there, and
  // the flow audits already prove the paths. The cost of each is recorded beside
  // it, because the expensive ones are where a future exclusion gets added
  // "just for now".
  {
    // One signed-in owner context, reused: the owner transitions below need a
    // session, and signing in per status would spend the login throttle for no
    // reason (backend/limits.mjs: five failures per address per fifteen minutes).
    const owner = await freshPage(browser, VIEWPORT)
    await owner.page.goto(BASE + '/owner/quotes')
    await signInIfAsked(owner.page)

    /** The quote's current version. Every owner move needs it or answers 409. */
    const versionOf = async (id) =>
      (await (await owner.page.request.get(`${BASE}/api/requests/${id}`)).json())?.quote?.version

    /** Submit as a customer, read the id back, and return both. */
    const submitAndId = async (page) => {
      await submitRequest(page, { base: BASE, customerEmail: AUDIT_EMAIL, ...clean, vehicle: '2019 Honda Civic', location: '12 Example St, Everett, MA 02149', date: SOON })
      const key = await page.evaluate(() => localStorage.getItem('kmt_customer_key'))
      const listed = await (await page.request.get(`${BASE}/api/requests?customer=${key}`)).json()
      // Each element is { request, quote } -- `element.id` is undefined and fails
      // later as a 404 on the move rather than as a lookup error (FRONT END LANE).
      const id = listed.requests?.[0]?.request?.id ?? listed?.[0]?.request?.id
      if (!id) throw new Error(`could not read a request id back for customer ${key}`)
      return id
    }

    /** Submit, move the quote into `status`, and measure /status showing it. */
    const drive = async (label, status, move) => {
      const { context, page } = await freshPage(browser, VIEWPORT)
      const id = await submitAndId(page)
      await move(id, page)
      await page.goto(BASE + '/status', { waitUntil: 'networkidle' })
      await waitForStatus(page)
      results.push(await measure(page, label))
      reached.add(status)
      await context.close()
    }

    // cancelled -- public, one fetch, no session (api.mjs PUBLIC_POST_PATHS).
    await drive('/status (cancelled)', 'cancelled', async (id, page) => {
      await page.request.post(`${BASE}/api/requests/${id}/cancel`, { data: { reason: 'a11y measurement' } })
    })

    // rejected -- owner session AND the quote's current version.
    await drive('/status (rejected)', 'rejected', async (id) => {
      await owner.page.request.post(`${BASE}/api/owner/quotes/${id}/reject`, { data: { version: await versionOf(id), reason: 'a11y measurement' } })
    })

    // paid -- public, but only after the owner has sent it: two actors.
    await drive('/status (paid)', 'paid', async (id, page) => {
      await owner.page.request.post(`${BASE}/api/owner/quotes/${id}/approve`, { data: { version: await versionOf(id) } })
      await page.request.post(`${BASE}/api/requests/${id}/pay`, { data: {} })
    })

    // done -- the most expensive: owner, after a payment, three moves deep.
    await drive('/status (done)', 'done', async (id, page) => {
      await owner.page.request.post(`${BASE}/api/owner/quotes/${id}/approve`, { data: { version: await versionOf(id) } })
      await page.request.post(`${BASE}/api/requests/${id}/pay`, { data: {} })
      await owner.page.request.post(`${BASE}/api/owner/quotes/${id}/done`, { data: { version: await versionOf(id) } })
    })

    // `approved` is accounted for by an assertion, not by a skip list.
    //
    // Nothing produces it. backend/api.mjs is
    //   quotes.decide(id, action === 'approve' ? 'sent' : 'rejected', ...)
    // so the route NAMED approve sets `sent`, and decide() refuses anything else.
    // Asserting that here means the day someone "fixes" the naming, this fails
    // and whoever did it has to teach this script to reach the new state --
    // which is exactly what an exclusion list would have quietly permitted.
    {
      const { context, page } = await freshPage(browser, VIEWPORT)
      const id = await submitAndId(page)
      await owner.page.request.post(`${BASE}/api/owner/quotes/${id}/approve`, { data: { version: await versionOf(id) } })
      approveYields = (await (await page.request.get(`${BASE}/api/requests/${id}`)).json())?.quote?.status
      await context.close()
    }

    await owner.context.close()
  }

  // Not-found route, for completeness.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await page.goto(BASE + '/no-such-page', { waitUntil: 'networkidle' })
    results.push(await measure(page, '/no-such-page'))
    await context.close()
  }
} finally {
  await browser.close()
}

// ---------- summary ----------
const allTexts = results.flatMap(s => s.texts.map(t => ({ state: s.label, ...t })))
const allTaps = results.flatMap(s => s.interactive.map(i => ({ state: s.label, ...i })))
const brandRed = dedupe(allTexts.filter(t => t.brandRed), t => [t.fgHex, t.bgHex, t.tag, t.cls, t.size, t.weight].join('|'))
const textFailAll = allTexts.filter(t => !t.pass && !t.image)
const textFails = dedupe(textFailAll, t => [t.fgHex, t.bgHex, t.tag, t.cls, t.size, t.weight].join('|'))
/**
 * How many states each deduped finding actually occurs in.
 *
 * The dedupe is by style signature, not by state, so one entry can stand for
 * the same control failing on several screens -- and the printed count then
 * understates the reach. That is not academic: this script reported ONE
 * contrast failure for a rule that broke the same anchor on three screens, and
 * the one it named was the only state it visited. Saying where each finding
 * occurs keeps the number from reading as an instance count.
 */
const statesOf = (t) => [...new Set(textFailAll
  .filter(x => [x.fgHex, x.bgHex, x.tag, x.cls, x.size, x.weight].join('|') === [t.fgHex, t.bgHex, t.tag, t.cls, t.size, t.weight].join('|'))
  .map(x => x.state))]
const overImage = dedupe(allTexts.filter(t => t.image), t => [t.fgHex, t.tag, t.cls].join('|'))
const tapFails = dedupe(allTaps.filter(i => !i.tapPass), i => [i.tag, i.cls, i.id, i.text, Math.round(i.w), Math.round(i.h)].join('|'))
const tapAll = dedupe(allTaps, i => [i.tag, i.cls, i.id, i.text, Math.round(i.w), Math.round(i.h)].join('|'))

const fixes = []
for (const t of dedupe([...brandRed, ...textFails], t => [t.fgHex, t.bgHex, t.large].join('|'))) {
  if (t.pass) continue
  const target = t.threshold
  const fgIsRed = t.fgHex === '#ed1c24' || t.fgHex === '#b80e14'
  const bgIsRed = t.bgHex === '#ed1c24' || t.bgHex === '#b80e14'
  const entry = { fg: t.fgHex, bg: t.bgHex, size: t.size, weight: t.weight, large: t.large, ratio: t.ratio, target, options: [] }
  if (bgIsRed) {
    const darker = nearestPassing(t.bg, t.fg, target, -1)
    if (darker) entry.options.push({ change: `background ${t.bgHex} -> ${darker.hex} (same hue, darker)`, ratio: darker.ratio })
    const largeSize = t.weight >= 700 ? 18.66 : 24
    entry.options.push({ change: `keep ${t.bgHex}; make the text large (>= ${largeSize}px${t.weight >= 700 ? ' bold' : ''}) so the AA threshold is 3:1`, ratio: t.ratio })
  } else if (fgIsRed) {
    const lighter = nearestPassing(t.fg, t.bg, target, +1)
    if (lighter) entry.options.push({ change: `text ${t.fgHex} -> ${lighter.hex} (same hue, lighter)`, ratio: lighter.ratio })
  } else {
    const dir = lum(t.fg) > lum(t.bg) ? +1 : -1
    const moved = nearestPassing(t.fg, t.bg, target, dir)
    if (moved) entry.options.push({ change: `text ${t.fgHex} -> ${moved.hex} (same hue, ${dir > 0 ? 'lighter' : 'darker'})`, ratio: moved.ratio })
    const movedBg = nearestPassing(t.bg, t.fg, target, -dir)
    if (movedBg) entry.options.push({ change: `background ${t.bgHex} -> ${movedBg.hex} (same hue, ${-dir > 0 ? 'lighter' : 'darker'})`, ratio: movedBg.ratio })
  }
  if (!entry.options.length) entry.options.push({ change: 'no same-hue lightness change reaches the target; the hue itself must change', ratio: t.ratio })
  fixes.push(entry)
}

// One token, two jobs: --accent is the fill under white text on every primary
// action AND the colour of red text on the dark ground. A candidate has to
// pass both. This table says whether any single red does, and at what cost.
const WHITE = { r: 255, g: 255, b: 255, a: 1 }
const GROUND = { r: 8, g: 8, b: 8, a: 1 }
const PANEL_LIGHT = { r: 28, g: 28, b: 28, a: 1 } // the .panel gradient's light stop
const accentHsl = rgbToHsl({ r: 237, g: 28, b: 36 })
const tokenTable = []
for (let l = Math.round(accentHsl.l * 100) - 14; l <= Math.round(accentHsl.l * 100) + 8; l++) {
  const c = hslToRgb({ ...accentHsl, l: l / 100 })
  tokenTable.push({ hex: hex(c), lightness: l, whiteOnIt: +ratio(WHITE, c).toFixed(2), onGround: +ratio(c, GROUND).toFixed(2), onPanelLight: +ratio(c, PANEL_LIGHT).toFixed(2) })
}
tokenTable.push({ hex: '#ed1c24 (current --accent)', lightness: Math.round(accentHsl.l * 100), whiteOnIt: +ratio(WHITE, { r: 237, g: 28, b: 36 }).toFixed(2), onGround: +ratio({ r: 237, g: 28, b: 36 }, GROUND).toFixed(2), onPanelLight: +ratio({ r: 237, g: 28, b: 36 }, PANEL_LIGHT).toFixed(2) })
tokenTable.push({ hex: '#b80e14 (current --accent-dark)', lightness: Math.round(rgbToHsl({ r: 184, g: 14, b: 20 }).l * 100), whiteOnIt: +ratio(WHITE, { r: 184, g: 14, b: 20 }).toFixed(2), onGround: +ratio({ r: 184, g: 14, b: 20 }, GROUND).toFixed(2), onPanelLight: +ratio({ r: 184, g: 14, b: 20 }, PANEL_LIGHT).toFixed(2) })

const out = { base: BASE, viewport: VIEWPORT, measuredAt: new Date().toISOString(), states: results.map(s => ({ label: s.label, url: s.url, texts: s.texts.length, interactive: s.interactive.length, docWidth: s.docWidth, scrollWidth: s.scrollWidth })), brandRed, textFails, overImage, tapFails, tapAll, fixes, tokenTable, raw: results }
writeFileSync(new URL('./a11y-85-results.json', import.meta.url), JSON.stringify(out, null, 2))

const fmt = (t) => `${t.state} | <${t.tag}${t.id ? '#' + t.id : ''}${t.cls ? '.' + t.cls : ''}> "${t.text}" | fg ${t.fgHex}${t.clippedText ? ' (clipped-text fill, worst stop)' : ''} on bg ${t.bgHex}${t.gradient ? ` (gradient, worst stop; best ${t.bgBestHex} ${t.ratioBest}:1)` : ''} | ${t.size}px/${t.weight}${t.large ? ' (large)' : ''} | ${t.ratio}:1 vs ${t.threshold}:1 | ${t.pass ? 'PASS' : 'FAIL'}`
console.log(`\nStates measured: ${results.length}`)
for (const s of results) console.log(`  ${s.label}  (${s.url})  texts=${s.texts.length} interactive=${s.interactive.length} overflow=${s.scrollWidth > s.docWidth + 1 ? 'YES' : 'no'}`)
console.log(`\nBRAND RED PAIRINGS (${brandRed.length}):`)
for (const t of brandRed) console.log('  ' + fmt(t))
console.log(`\nTEXT CONTRAST FAILURES, all colours (${textFails.length} distinct, ${textFailAll.length} instances):`)
for (const t of textFails.sort((a, b) => a.ratio - b.ratio)) { const where = statesOf(t); console.log('  ' + fmt(t)); console.log(`      in ${where.length} state(s): ${where.join(', ')}`) }
console.log(`\nTEXT OVER A BACKGROUND IMAGE, not computed (${overImage.length}):`)
for (const t of overImage) console.log(`  ${t.state} | <${t.tag}.${t.cls}> "${t.text}" | fg ${t.fgHex}`)
console.log(`\nTAP TARGETS UNDER 44x44 (${tapFails.length} of ${tapAll.length} distinct interactive elements):`)
for (const i of tapFails.sort((a, b) => a.h - b.h)) console.log(`  ${i.state} | <${i.tag}${i.id ? '#' + i.id : ''}${i.cls ? '.' + i.cls : ''}> "${i.text}" | ${i.w} x ${i.h} px${i.disabled ? ' (disabled)' : ''}`)
console.log(`\nPROPOSED VALUES (computed, not applied):`)
for (const f of fixes) { console.log(`  ${f.fg} on ${f.bg} at ${f.size}px/${f.weight}: ${f.ratio}:1, needs ${f.target}:1`); for (const o of f.options) console.log(`     - ${o.change} => ${o.ratio}:1`) }
console.log(`\nONE RED TOKEN, TWO JOBS (white text on it / it as text on #080808 / it as text on the .panel light stop #1c1c1c):`)
for (const row of tokenTable) console.log(`  ${row.hex.padEnd(34)} L${String(row.lightness).padStart(3)}  white-on-it ${String(row.whiteOnIt).padStart(5)}  on-ground ${String(row.onGround).padStart(5)}  on-panel ${String(row.onPanelLight).padStart(5)}  ${row.whiteOnIt >= 4.5 && row.onGround >= 4.5 && row.onPanelLight >= 4.5 ? 'passes all three' : row.whiteOnIt >= 4.5 && row.onGround >= 4.5 ? 'passes fill + ground' : ''}`)
console.log(`\n${results.length} states, ${allTexts.length} text elements, ${allTaps.length} interactive elements measured. Results in .forge/a11y-85-results.json`)

// ---------------------------------------------------------------------------
// The failure mode. Until now this script could not fail.
//
// Its only `process.exit` was `exit(2)` on a missing AUDIT_BASE -- nothing for
// what it measured. It printed contrast and tap-target failures and exited 0,
// so "trust the exit code", which is correct for every other script in this
// repository, silently gave the wrong answer for this one. The person who
// follows that convention is being consistent, not careless, and consistency is
// not a thing you can ask people to stop doing: only the instrument can change.
//
// That is why this exists, and why one contrast failure sat unreported through
// however many runs nobody made.
const findings = textFails.length + tapFails.length

// Coverage, derived rather than enumerated.
//
// QUOTE_STATUSES is imported, never restated -- migration.test.mjs already
// iterates it four times and builds the CHECK constraint from it. Every member
// must be either rendered above or accounted for by an assertion about what
// actually produces it. There is deliberately no exclusion list: a list is what
// a future status gets appended to at 2am with a good reason, and the count
// then looks like rigour over a hole.
//
// `approved` is the accounted-for case. Nothing creates it -- the route named
// approve sets `sent` -- so it is covered by that assertion rather than skipped,
// and if the naming is ever "fixed" this goes red instead of quietly passing.
const accountedFor = new Set(reached)
const approveIsSent = approveYields === 'sent'
if (approveIsSent) accountedFor.add('approved')
const uncovered = QUOTE_STATUSES.filter(status => !accountedFor.has(status))

console.log(`\nQUOTE STATUS COVERAGE (${accountedFor.size} of ${QUOTE_STATUSES.length}):`)
for (const status of QUOTE_STATUSES) {
  const how = reached.has(status) ? 'rendered on /status'
    : status === 'approved' ? `not produced by any code path; POST /approve yields "${approveYields}"`
      : 'NOT COVERED'
  console.log(`  ${status.padEnd(10)} ${how}`)
}
if (!approveIsSent) {
  console.error(`\nFAIL: POST /api/owner/quotes/:id/approve left the status as ${JSON.stringify(approveYields)}, not "sent".`)
  console.error('      `approved` was covered by that assertion rather than by being rendered.')
  console.error('      If a code path now produces it, this script has to reach and measure it.')
}
if (uncovered.length) {
  console.error(`\nFAIL: ${uncovered.length} quote status(es) neither rendered nor accounted for: ${uncovered.join(', ')}.`)
  console.error('      Teach the `drive()` block above how to reach each one -- there is no exclusion list to add to,')
  console.error('      and that is deliberate: a status this script cannot open is a screen nothing has ever measured.')
}
if (findings) {
  console.error(`\nFAIL: ${textFails.length} contrast failure(s) and ${tapFails.length} tap target(s) under 44x44, listed above.`)
}

const ok = findings === 0 && uncovered.length === 0 && approveIsSent
console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${results.length} states, ${accountedFor.size}/${QUOTE_STATUSES.length} statuses, ${findings} finding(s).`)
process.exitCode = ok ? 0 : 1
