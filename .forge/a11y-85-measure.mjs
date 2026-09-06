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
 *
 * Writes .forge/a11y-85-results.json (everything) and prints a summary.
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { EXCEPTION_TIRE, cleanTireFor, freshPage, openOwnerQuotes, signInIfAsked, submitRequest, waitForStatus } from './audit-ui.mjs'

const BASE = process.env.AUDIT_BASE
if (!BASE) { console.error('Set AUDIT_BASE explicitly; the audits default to different ports and this one refuses to guess.'); process.exit(2) }
const VIEWPORT = { width: 375, height: 812 }
const BRAND_RED = 'rgb(237, 28, 36)'
const ACCENT_DARK = 'rgb(184, 14, 20)'

// ---------- colour maths (WCAG 2.x) ----------
function parseColor(s) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s || '')
  if (!m) return null
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
}
function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}
function hex({ r, g, b }) { return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') }
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

// ---------- in-page measurement ----------
async function measure(page, label) {
  const raw = await page.evaluate(() => {
    const parse = (s) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s || ''); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null }
    const visible = (el) => {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    })
    // Every colour a gradient string names, so text over a gradient is
    // measured against each stop and the worst case is the number reported.
    // A url() image has no stops; that text is flagged and not computed.
    const gradientStops = (s) => {
      const out = []
      const re = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi
      for (const m of s.match(re) || []) {
        if (m.startsWith('#')) {
          let h = m.slice(1)
          if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('')
          out.push({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 })
        } else {
          const c = parse(m); if (c) out.push(c)
        }
      }
      return out
    }
    // Effective background: composite every ancestor's background-color from
    // the element upward until one is opaque. Gradients contribute each of
    // their stops as a candidate; the caller reports the worst ratio.
    const effectiveBg = (el) => {
      let node = el
      let candidates = [null]
      let image = false
      let gradient = false
      const done = (cands) => cands.every(c => c && c.a >= 1)
      while (node && node !== document) {
        const cs = getComputedStyle(node)
        const bi = cs.backgroundImage || 'none'
        let layers = []
        if (bi !== 'none') {
          if (/url\(/i.test(bi)) image = true
          const stops = gradientStops(bi)
          if (stops.length) { gradient = true; layers = stops.filter(c => c.a > 0) }
        }
        const c = parse(cs.backgroundColor)
        if (!layers.length && c && c.a > 0) layers = [c]
        else if (layers.length && c && c.a > 0) layers = layers.map(l => (l.a >= 1 ? l : over(l, c)))
        if (layers.length) {
          const next = []
          for (const cand of candidates) for (const l of layers) next.push(cand ? over(cand, l) : l)
          candidates = next.slice(0, 8)
          if (done(candidates)) break
        }
        node = node.parentElement
      }
      const root = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 8, g: 8, b: 8, a: 1 }
      const bgs = candidates.map(c => (c ? (c.a >= 1 ? c : over(c, root)) : root))
      return { bg: bgs[0], bgs, image, gradient }
    }
    const ident = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).slice(0, 4).join('.'),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 48),
    })
    const texts = []
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ')
      if (!own) continue
      const cs = getComputedStyle(el)
      const fg = parse(cs.color)
      if (!fg) continue
      const { bg, bgs, image, gradient } = effectiveBg(el)
      const size = parseFloat(cs.fontSize)
      const weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400)
      texts.push({ ...ident(el), text: own.replace(/\s+/g, ' ').slice(0, 48), fg, bg, bgs, image, gradient, size, weight, opacity: +cs.opacity })
    }
    const interactive = []
    const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"]), label.oi-check'
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const fg = parse(cs.color)
      const { bg, image } = effectiveBg(el)
      interactive.push({ ...ident(el), type: el.getAttribute('type') || el.getAttribute('role') || '', w: +r.width.toFixed(1), h: +r.height.toFixed(1), disabled: !!el.disabled, fg, bg, image, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400 })
    }
    return { url: location.pathname + location.search, texts, interactive, docWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }
  })
  const isLarge = (t) => t.size >= 24 || (t.size >= 18.66 && t.weight >= 700)
  const texts = raw.texts.map(t => {
    // Worst case across every candidate background (gradient stops), and the
    // best case alongside so a gradient's range is visible in the record.
    const ratios = (t.bgs && t.bgs.length ? t.bgs : [t.bg]).map(b => ({ b, r: ratio(t.fg, b) })).sort((x, y) => x.r - y.r)
    const worst = ratios[0], best = ratios[ratios.length - 1]
    const r = +worst.r.toFixed(2)
    const large = isLarge(t)
    const threshold = large ? 3 : 4.5
    const bg = worst.b
    return { ...t, bg, fgHex: hex(t.fg), bgHex: hex(bg), bgBestHex: hex(best.b), ratioBest: +best.r.toFixed(2), ratio: r, large, threshold, pass: r >= threshold, brandRed: hex(t.fg) === '#ed1c24' || hex(bg) === '#ed1c24' || hex(t.fg) === '#b80e14' || hex(bg) === '#b80e14' }
  })
  const interactive = raw.interactive.map(i => ({ ...i, fgHex: hex(i.fg), bgHex: hex(i.bg), tapPass: i.w >= 44 && i.h >= 44 }))
  return { label, url: raw.url, docWidth: raw.docWidth, scrollWidth: raw.scrollWidth, texts, interactive }
}

// ---------- the states ----------
const results = []
const browser = await chromium.launch()
const password = process.env.KMT_OWNER_PASSWORD || ''
try {
  const clean = await cleanTireFor(BASE)
  const clean2 = clean

  // Customer wizard, each step, then the acknowledgement.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    results.push(await measure(page, 'home + step 1 (fitment)'))
    const [width, rest] = clean.size.split('/'); const [ratioPart, diameter] = rest.split('R')
    for (const v of [width, ratioPart, diameter]) await page.click(`.fitment-option:has-text("${v}")`, { timeout: 15000 })
    await page.fill('#fitmentZip', '02149').catch(() => {})
    results.push(await measure(page, 'step 1 with size chosen'))
    await page.click('button:has-text("Continue to tires")', { timeout: 15000 })
    await page.waitForSelector('.tire-option', { timeout: 15000 })
    const showAll = page.locator('button:has-text("Show all")'); if (await showAll.count()) await showAll.first().click()
    results.push(await measure(page, 'step 2 (tires, before choosing)'))
    await page.click(`.tire-option:has-text("${clean.tireName}")`, { timeout: 15000 })
    await page.locator('.manual-vehicle summary').click()
    await page.fill('#vehicleInfo', '2019 Honda Civic', { timeout: 15000 })
    results.push(await measure(page, 'step 2 (tire selected, vehicle typed)'))
    await page.click('button:has-text("Continue to mobile service")', { timeout: 15000 })
    await page.waitForSelector('#location', { timeout: 15000 })
    results.push(await measure(page, 'step 3 (service details, empty)'))
    await page.fill('#location', '12 Example St, Everett, MA 02149')
    await page.fill('#date', '2026-09-10')
    await page.fill('#customerName', 'Jamie Rivera')
    await page.fill('#customerEmail', 'jamie@example.com')
    await page.click('button[type="submit"]', { timeout: 15000 })
    await page.waitForSelector('.success-message', { timeout: 15000 })
    results.push(await measure(page, 'acknowledgement (submitted)'))
    await page.goto(BASE + '/status', { waitUntil: 'networkidle' })
    await waitForStatus(page)
    results.push(await measure(page, '/status (draft)'))
    await context.close()
  }

  // Owner: sign-in, inventory, quotes with a draft and an exception; approve one.
  {
    const { context, page } = await freshPage(browser, VIEWPORT)
    await submitRequest(page, { base: BASE, ...EXCEPTION_TIRE, vehicle: '2020 Ford F-150 Pickup Truck', location: '12 Example St, Everett, MA 02149', date: '2026-09-10', notes: 'Behind the building' })
    await page.click('button:has-text("Owner review")', { timeout: 15000 })
    await page.waitForURL('**/owner')
    await page.waitForSelector('.oi-signin, .owner-content, .oi-results, .oi-error', { timeout: 15000 }).catch(() => {})
    if (await page.locator('.oi-signin').count()) results.push(await measure(page, '/owner sign-in form'))
    await signInIfAsked(page)
    await page.waitForSelector('.owner-content, .oi-results, .oi-error, [role="tablist"]', { timeout: 15000 }).catch(() => {})
    results.push(await measure(page, '/owner inventory'))
    await page.getByRole('button', { name: 'Quote requests' }).click()
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
    await submitRequest(page, { base: BASE, ...clean2, vehicle: '2019 Honda Civic', location: '12 Example St, Everett, MA 02149', date: '2026-09-10' })
    await openOwnerQuotes(page)
    const approve = page.locator('.owner-request:has-text("Honda Civic") button:has-text("Approve"), button:has-text("Approve")')
    if (await approve.count()) { await approve.first().click(); await page.waitForTimeout(800) }
    await page.goto(BASE + '/status', { waitUntil: 'networkidle' })
    await waitForStatus(page)
    results.push(await measure(page, '/status (sent, Pay available)'))
    const pay = page.locator('button:has-text("Pay")')
    if (await pay.count()) {
      await pay.first().click()
      await page.waitForURL('**/confirmation**', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(800)
      results.push(await measure(page, '/confirmation (paid)'))
    }
    await context.close()
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
const dedupe = (rows, key) => { const seen = new Map(); for (const r of rows) { const k = key(r); if (!seen.has(k)) seen.set(k, r) } return [...seen.values()] }
const allTexts = results.flatMap(s => s.texts.map(t => ({ state: s.label, ...t })))
const allTaps = results.flatMap(s => s.interactive.map(i => ({ state: s.label, ...i })))
const brandRed = dedupe(allTexts.filter(t => t.brandRed), t => [t.fgHex, t.bgHex, t.tag, t.cls, t.size, t.weight].join('|'))
const textFails = dedupe(allTexts.filter(t => !t.pass && !t.image), t => [t.fgHex, t.bgHex, t.tag, t.cls, t.size, t.weight].join('|'))
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

const fmt = (t) => `${t.state} | <${t.tag}${t.id ? '#' + t.id : ''}${t.cls ? '.' + t.cls : ''}> "${t.text}" | fg ${t.fgHex} on bg ${t.bgHex}${t.gradient ? ` (gradient, worst stop; best ${t.bgBestHex} ${t.ratioBest}:1)` : ''} | ${t.size}px/${t.weight}${t.large ? ' (large)' : ''} | ${t.ratio}:1 vs ${t.threshold}:1 | ${t.pass ? 'PASS' : 'FAIL'}`
console.log(`\nStates measured: ${results.length}`)
for (const s of results) console.log(`  ${s.label}  (${s.url})  texts=${s.texts.length} interactive=${s.interactive.length} overflow=${s.scrollWidth > s.docWidth + 1 ? 'YES' : 'no'}`)
console.log(`\nBRAND RED PAIRINGS (${brandRed.length}):`)
for (const t of brandRed) console.log('  ' + fmt(t))
console.log(`\nTEXT CONTRAST FAILURES, all colours (${textFails.length}):`)
for (const t of textFails.sort((a, b) => a.ratio - b.ratio)) console.log('  ' + fmt(t))
console.log(`\nTEXT OVER A BACKGROUND IMAGE, not computed (${overImage.length}):`)
for (const t of overImage) console.log(`  ${t.state} | <${t.tag}.${t.cls}> "${t.text}" | fg ${t.fgHex}`)
console.log(`\nTAP TARGETS UNDER 44x44 (${tapFails.length} of ${tapAll.length} distinct interactive elements):`)
for (const i of tapFails.sort((a, b) => a.h - b.h)) console.log(`  ${i.state} | <${i.tag}${i.id ? '#' + i.id : ''}${i.cls ? '.' + i.cls : ''}> "${i.text}" | ${i.w} x ${i.h} px${i.disabled ? ' (disabled)' : ''}`)
console.log(`\nPROPOSED VALUES (computed, not applied):`)
for (const f of fixes) { console.log(`  ${f.fg} on ${f.bg} at ${f.size}px/${f.weight}: ${f.ratio}:1, needs ${f.target}:1`); for (const o of f.options) console.log(`     - ${o.change} => ${o.ratio}:1`) }
console.log(`\nONE RED TOKEN, TWO JOBS (white text on it / it as text on #080808 / it as text on the .panel light stop #1c1c1c):`)
for (const row of tokenTable) console.log(`  ${row.hex.padEnd(34)} L${String(row.lightness).padStart(3)}  white-on-it ${String(row.whiteOnIt).padStart(5)}  on-ground ${String(row.onGround).padStart(5)}  on-panel ${String(row.onPanelLight).padStart(5)}  ${row.whiteOnIt >= 4.5 && row.onGround >= 4.5 && row.onPanelLight >= 4.5 ? 'passes all three' : row.whiteOnIt >= 4.5 && row.onGround >= 4.5 ? 'passes fill + ground' : ''}`)
console.log(`\n${results.length} states, ${allTexts.length} text elements, ${allTaps.length} interactive elements measured. Results in .forge/a11y-85-results.json`)
