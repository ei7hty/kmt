/* global document, getComputedStyle, location */ // used inside page.evaluate, which runs in the browser
/**
 * The fixed #85 measurement (WCAG contrast, including background-clip:text
 * headlines, and 44x44 tap targets), factored out so a11y-85-measure.mjs's
 * investigative report and responsive-check.mjs's #107 gate assert off the
 * same numbers instead of two copies that can drift apart the way the
 * clipped-text bug (#217) showed a single copy already can.
 */

// ---------- colour maths (WCAG 2.x) ----------
export function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}
export function hex({ r, g, b }) { return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') }

/** First row per key, dropping repeats -- e.g. twenty identical checkboxes reported once. */
export function dedupe(rows, key) { const seen = new Map(); for (const r of rows) { const k = key(r); if (!seen.has(k)) seen.set(k, r) } return [...seen.values()] }

// ---------- in-page measurement ----------
export async function measure(page, label) {
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
    // background-clip: text paints a background only inside that element's
    // own glyphs -- it is the text's fill, not a backdrop, and it does not
    // paint at all for anything else (its own padding, or a descendant's
    // content). Reading it as a background produced "#f0f0f0 on #f4f4f4"
    // for a silver-on-black headline: both numbers were the same gradient,
    // once as fg-via-cs.color (usually transparent, parsed wrong) and once
    // as bg.
    const hasClipText = (cs) => cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text'

    // Effective background: composite every ancestor's background-color from
    // the element upward until one is opaque. Gradients contribute each of
    // their stops as a candidate; the caller reports the worst ratio.
    // A node whose own background is clipped to its text never contributes
    // a background layer -- for the element being measured, that gradient
    // is its fill instead (returned separately, as clipStops, since it is
    // not something behind the text); for an ancestor, it is skipped
    // entirely and the walk continues to its parent, since a clipped
    // ancestor's gradient shows only inside that ancestor's own glyphs, not
    // as a backdrop for its children.
    const effectiveBg = (el) => {
      let node = el
      let candidates = [null]
      let image = false
      let gradient = false
      let clipStops = null
      const done = (cands) => cands.every(c => c && c.a >= 1)
      while (node && node !== document) {
        const cs = getComputedStyle(node)
        const clipped = hasClipText(cs)
        if (clipped && node === el) {
          const stops = gradientStops(cs.backgroundImage || '')
          const solid = parse(cs.backgroundColor)
          clipStops = stops.length ? stops : (solid && solid.a > 0 ? [solid] : null)
        }
        const bi = clipped ? 'none' : (cs.backgroundImage || 'none')
        let layers = []
        if (bi !== 'none') {
          if (/url\(/i.test(bi)) image = true
          const stops = gradientStops(bi)
          if (stops.length) { gradient = true; layers = stops.filter(c => c.a > 0) }
        }
        const c = clipped ? null : parse(cs.backgroundColor)
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
      return { bg: bgs[0], bgs, image, gradient, clipStops }
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
      const { bg, bgs, image, gradient, clipStops } = effectiveBg(el)
      // Clipped text's fill is the gradient (or solid colour) it is clipped
      // to, not cs.color -- which the fill-color property usually leaves
      // transparent, exactly because the clip is meant to show through to
      // it. Each stop is a candidate fg the same way a gradient background
      // is a candidate bg elsewhere in this file.
      const plainFg = parse(cs.color)
      const fgCandidates = clipStops && clipStops.length ? clipStops : (plainFg ? [plainFg] : [])
      if (!fgCandidates.length) continue
      const size = parseFloat(cs.fontSize)
      const weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400)
      texts.push({
        ...ident(el), text: own.replace(/\s+/g, ' ').slice(0, 48),
        fg: fgCandidates[0], fgCandidates, clippedText: Boolean(clipStops && clipStops.length),
        bg, bgs, image, gradient, size, weight, opacity: +cs.opacity,
      })
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
    // Worst case across every candidate background (gradient stops) and,
    // for clipped text, every candidate fill (the gradient's own stops) --
    // the best case sits alongside so a gradient's range is visible in the
    // record either way.
    const bgList = t.bgs && t.bgs.length ? t.bgs : [t.bg]
    const fgList = t.fgCandidates && t.fgCandidates.length ? t.fgCandidates : [t.fg]
    const ratios = []
    for (const f of fgList) for (const b of bgList) ratios.push({ f, b, r: ratio(f, b) })
    ratios.sort((x, y) => x.r - y.r)
    const worst = ratios[0], best = ratios[ratios.length - 1]
    const r = +worst.r.toFixed(2)
    const large = isLarge(t)
    const threshold = large ? 3 : 4.5
    const fg = worst.f
    const bg = worst.b
    return {
      ...t, fg, bg, fgHex: hex(fg), bgHex: hex(bg), bgBestHex: hex(best.b), ratioBest: +best.r.toFixed(2),
      ratio: r, large, threshold, pass: r >= threshold,
      brandRed: hex(fg) === '#ed1c24' || hex(bg) === '#ed1c24' || hex(fg) === '#b80e14' || hex(bg) === '#b80e14',
    }
  })
  const interactive = raw.interactive.map(i => ({ ...i, fgHex: hex(i.fg), bgHex: hex(i.bg), tapPass: i.w >= 44 && i.h >= 44 }))
  return { label, url: raw.url, docWidth: raw.docWidth, scrollWidth: raw.scrollWidth, texts, interactive }
}
