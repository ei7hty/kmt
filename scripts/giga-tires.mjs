/**
 * Scraper for giga-tires.com listing pages.
 *
 * Kept separate from the CLI in scrape-tires.mjs so the parsing rules can be
 * read (and fixed) without wading through argument handling. Everything here is
 * pure apart from `fetchSizePage`.
 *
 * Why plain fetch and not Playwright: giga-tires renders its listing pages on
 * the server. The product grid and, more importantly, a `window.productPrices`
 * script holding per-SKU price and stock are both present in the raw HTML, so a
 * browser buys us nothing and costs a lot. Playwright stays in devDependencies
 * as the fallback if that ever stops being true.
 *
 * Their robots.txt is allow-by-default: `User-agent: *` carries no `Disallow: /`
 * and no `Allow: /tires/` either -- everything is permitted except eight named
 * exclusions, and `/tires/` is merely one of the many things the list does not
 * forbid, not a specific grant. Read live on 2026-09-10 (the owner's one
 * authorised request, since spent -- no further live request to giga-tires.com
 * is permitted; this comment is the record of what it said, not a standing
 * belief to re-derive from). If they change robots.txt, this comment and
 * `productUrl()`'s DISALLOWED_* constants below are what goes stale, not this
 * scraper's behaviour -- there is no live check, so nothing here would notice
 * on its own.
 *
 * The eight exclusions, verbatim from their file: `/cart`, `/checkout`,
 * `/my-account`, `/price/calculate` (each a path PREFIX, no wildcard needed
 * per robots convention), a wildcard path followed by `?filtering=` or
 * `&filtering=` (a `filtering` query parameter, in any position), and
 * `/tires/o/` plus the same page nested under a size segment (two rules, not
 * one -- see `productUrl()` for why both are needed). This scraper touches
 * none of those.
 */

const ORIGIN = 'https://www.giga-tires.com'

export const USER_AGENT = 'KMT-catalog-updater/0.1 (manual catalog sync; +https://github.com/kmt)'

/** A supplier refusal is run-global: never turn it into a per-page failure. */
export class ProviderRefusalError extends Error {
  constructor(message, { status = null, reason = 'provider-refusal', retryAfter = null } = {}) {
    super(message)
    this.name = 'ProviderRefusalError'
    this.status = status
    this.reason = reason
    this.retryAfter = retryAfter
  }
}

const REFUSAL_MARKERS = [
  ['access denied', /access denied/i],
  ['request could not be satisfied', /request could not be satisfied/i],
  ['forbidden', /\bforbidden\b/i],
  ['too many requests', /too many requests/i],
  ['temporarily blocked', /temporarily blocked/i],
  ['captcha', /\bcaptcha\b/i],
  ['verify you are human', /verify (?:that )?you are human/i],
  ['robot check', /robot check|automated access/i],
  ['disallowed by robots', /disallow(?:ed)?\s+by\s+robots(?:\.txt)?/i],
]

export function refusalReason(html) {
  const match = REFUSAL_MARKERS.find(([, pattern]) => pattern.test(String(html || '')))
  return match?.[0] || null
}

export function assertProviderResponse(url, response, html) {
  const status = typeof response?.status === 'function' ? response.status() : response?.status ?? null
  const headers = typeof response?.headers === 'function' ? response.headers() : response?.headers
  if (status === 403 || status === 429) {
    throw new ProviderRefusalError(`${status} from ${url}`, {
      status,
      reason: status === 429 ? 'rate-limit' : 'forbidden',
      retryAfter: headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? null,
    })
  }
  const reason = refusalReason(html)
  if (reason) {
    throw new ProviderRefusalError(`Provider refusal from ${url}: ${reason}`, { status, reason })
  }
}

export function assertExpectedPage(url, html, kind) {
  const expected = kind === 'product'
    ? html.includes('application/ld+json') || html.includes('tirecode')
    : html.includes('window.productPrices') || html.includes('plp-list__item-container') || html.includes('is not available at this time')
  if (!expected) throw new ProviderRefusalError(`Blocked or unexpected ${kind} page from ${url}`, { reason: 'unexpected-provider-page' })
}

/** Path prefixes their robots.txt disallows outright -- no wildcard needed, a bare prefix match. */
const DISALLOWED_PREFIXES = ['/cart', '/checkout', '/my-account', '/price/calculate']

/**
 * `/tires/o/` (the basic deals index) and the same page nested under a size
 * segment are two separate robots.txt rules, not one written twice: a bare
 * wildcard never matches a missing path segment, so checking only the sized
 * form would miss the basic form `/tires/o/deals`, and checking only the
 * basic form would miss a sized one like `/tires/205-65-15/o/x`. Both are
 * checked here for that reason -- dropping either one silently re-opens the
 * gap the other rule exists to close.
 */
const TIRES_O_BASIC = /^\/tires\/o\//
const TIRES_O_STARRED = /^\/tires\/.+\/o\//

/** True when `url` matches one of the eight things their robots.txt disallows. */
function isDisallowedByRobots(url) {
  if (DISALLOWED_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return true
  if (url.searchParams.has('filtering')) return true
  return TIRES_O_BASIC.test(url.pathname) || TIRES_O_STARRED.test(url.pathname)
}

export function productUrl(value) {
  let url
  try { url = new URL(value, ORIGIN) } catch { throw new Error(`Not a product URL: ${value}`) }
  // `/tirecode/` is OUR requirement for a product page, not a robots.txt rule --
  // every real product URL carries it and a listing or category page does not.
  // `username`/`password` catch embedded credentials (`user:pass@host`):
  // `url.origin` never includes them, so the origin check alone would accept
  // one silently -- the same shape `prepareImagePilot` (scripts/image-pilot-packet.mjs)
  // already refuses at its own layer, refused here too rather than assumed.
  if (url.origin !== ORIGIN || url.username || url.password || isDisallowedByRobots(url) || !url.pathname.includes('/tirecode/')) {
    throw new Error(`Not a giga-tires product URL: ${value}`)
  }
  url.hash = ''
  return url.toString()
}

/** Accepts 215/60R16 and 215-60-16, returns the parts or null. */
export function parseSize(size) {
  const match = String(size).trim().match(/^(\d{3})[/-](\d{2})[R-](\d{2})$/i)
  return match ? { width: match[1], ratio: match[2], diameter: match[3] } : null
}

/** Their URL segment for a size: 215/60R16 -> 215-60-16. */
export function toSizePath(size) {
  const parsed = parseSize(size)
  if (!parsed) throw new Error(`Not a tire size: ${size}`)
  return `${parsed.width}-${parsed.ratio}-${parsed.diameter}`
}

export function canonicalSize(size) {
  const parsed = parseSize(size)
  return parsed ? `${parsed.width}/${parsed.ratio}R${parsed.diameter}` : null
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }

const decode = (text) => String(text)
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name])
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Map a giga-tires style string onto one of KMT's five categories.
 *
 * Order matters, and the interesting case is "High Performance All Season": it
 * matches both `performance` and `all-season`, and it is an all-season tire
 * with a performance-sounding name. Season is what a customer is actually
 * choosing on, so season wins and `performance` only catches what is left --
 * summer and track rubber that names no season at all.
 */
const CATEGORY_RULES = [
  { category: 'winter', pattern: /winter|snow|\bice\b|studd|3pms/i },
  { category: 'off-road', pattern: /all.?terrain|\bmud\b|off.?road|rugged|trail/i },
  { category: 'all-season', pattern: /all.?season|touring|highway/i },
  { category: 'performance', pattern: /performance|racing|sport|summer|track/i },
  { category: 'eco', pattern: /\beco\b|low rolling|fuel/i },
]

/**
 * `style` is the site's own classification and wins outright; `name` is only
 * consulted when the style says nothing useful. Otherwise a model called
 * "Multifresh Touring" that the site files under Racing gets read off its
 * marketing name instead of its actual classification.
 */
export function toCategory(style, name = '') {
  const match = (text) => CATEGORY_RULES.find(rule => rule.pattern.test(text || ''))
  const found = match(style) || match(name)
  return found ? found.category : 'all-season'
}

/** First match of `pattern` in `html`, decoded, or null. */
function pick(html, pattern, group = 1) {
  const match = html.match(pattern)
  return match ? decode(match[group]) : null
}

/**
 * Per-SKU price and stock, lifted from the `window.productPrices` script.
 *
 * This is the one part of the page that is real structured data rather than
 * markup, so price and stock come from here and never from the rendered text:
 * the visible price sits among strikethroughs and financing lines that are easy
 * to grab by mistake.
 */
export function extractPriceData(html) {
  const prices = {}

  // Each card carries its own assignment, and the outer object is JS rather
  // than JSON -- `quantity: '4'`, unquoted keys, single quotes. Only the
  // `priceData:` value is strict JSON, so that is the only part we parse:
  //
  //   window.productPrices.initialData['FERE0011621560H'] = {
  //       quantity: '4',
  //       priceData: {"initialPricePerTire":33.92, ...}
  //   };
  //
  // (Reading `window.productPrices` in a live page shows one merged object.
  // That is the result of these scripts having run, and it is not in the HTML.)
  const assignments = html.matchAll(/initialData\[['"]([^'"]+)['"]\]\s*=/g)

  for (const match of assignments) {
    const sku = match[1]
    const marker = html.indexOf('priceData:', match.index)
    if (marker === -1) continue

    const json = matchBraces(html, html.indexOf('{', marker))
    if (!json) continue

    try {
      prices[sku] = { priceData: JSON.parse(json) }
    } catch {
      // Leave it out. parseListingPage reports the SKU as skipped.
    }
  }

  return prices
}

/**
 * The `{...}` starting at `open`, brace-counted.
 *
 * Lazy regex is not enough here: priceData nests (`lightningSavings` is an
 * object when a promotion is running), so `\{[\s\S]*?\}` stops at the wrong
 * brace exactly on the rows that are on sale.
 */
function matchBraces(text, open) {
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

/**
 * Split the listing grid into one chunk per product card.
 *
 * `plp-list__item-container` wraps exactly the paginated results. The three
 * "Best Value / Best Deal / Top Rated" cards above the grid use different
 * markup and are deliberately not picked up: they are duplicates of rows that
 * already appear in the grid.
 */
export function splitCards(html) {
  return html.split('plp-list__item-container').slice(1)
}

export function parseCard(chunk, requestedSize) {
  const sku = pick(chunk, /data-product-code="([^"]+)"/)
  if (!sku) return null

  const anchor = chunk.match(/<a\b([^>]*j-override-clipboard[^>]*)>([\s\S]*?)<\/a>/)
  const title = anchor ? decode(anchor[2].replace(/<[^>]*>/g, ' ')) : null
  const href = anchor ? pick(anchor[1], /href="([^"]+)"/) : null

  // Exactly `class="p-regular-md"`: the delivery and shipping lines are also
  // <p> tags carrying p-regular-md, but always alongside other classes.
  const style = pick(chunk, /<p class="p-regular-md">([\s\S]*?)<\/p>/)
  const segment = pick(chunk, /href="\/tires\/c\/[^"]*"[^>]*>([\s\S]*?)<\/a>/)

  // "Ferentino Eternopresa 215/60R16 95H BSW" -> name, then the spec tail.
  const sizeInTitle = title ? title.match(/\d{3}\/\d{2}R\d{2}/) : null
  const name = sizeInTitle ? title.slice(0, sizeInTitle.index).trim() : title
  const spec = sizeInTitle ? title.slice(sizeInTitle.index + sizeInTitle[0].length).trim() : ''

  return {
    sku,
    name: name || sku,
    title,
    spec,
    style,
    segment,
    size: canonicalSize(requestedSize),
    url: href ? `${ORIGIN}${href}` : null,
  }
}

/**
 * One listing page, as rows in the shape src/data/catalog.js already uses.
 *
 * A card with no matching price entry is dropped rather than guessed at: a tire
 * with no price is not something the quoting flow can do anything with. Those
 * SKUs come back in `skipped` so a silent drop still shows up in the report.
 */
export function parseListingPage(html, requestedSize) {
  const prices = extractPriceData(html)
  const rows = []
  const skipped = []

  for (const chunk of splitCards(html)) {
    const card = parseCard(chunk, requestedSize)
    if (!card) continue

    const priceData = prices[card.sku]?.priceData
    const price = priceData?.totalCostPerTire ?? priceData?.initialPricePerTire
    if (typeof price !== 'number') {
      skipped.push(card.sku)
      continue
    }

    const stock = typeof priceData.stock === 'number' ? priceData.stock : null

    rows.push({
      id: `giga-${card.sku.toLowerCase()}`,
      name: card.name,
      size: card.size,
      price: Math.round(price * 100) / 100,
      inStock: stock === null ? true : stock > 0,
      category: toCategory(card.style, card.name),
      description: [card.style, card.spec].filter(Boolean).join(' · ') || card.title,
      // Provenance. The app never reads this, but it is what makes a stale or
      // wrong row traceable back to the page it came from.
      source: {
        sku: card.sku,
        stock,
        listPrice: priceData.strikeThroughPricePerTire ?? null,
        segment: card.segment,
        url: card.url,
      },
    })
  }

  return { rows, skipped, totalPages: readTotalPages(html) }
}

const asText = value => typeof value === 'string' && value.trim() ? decode(value) : null
const asStringArray = value => [...new Set((Array.isArray(value) ? value : [value]).map(asText).filter(Boolean))]

function productJsonLd(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const decoded = JSON.parse(match[1])
      const nodes = Array.isArray(decoded) ? decoded : decoded?.['@graph'] || [decoded]
      const product = nodes.find(node => {
        const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']]
        return types.includes('Product')
      })
      if (product) return product
    } catch { /* A malformed analytics block must not discard the page. */ }
  }
  return null
}

function stripRawTextElements(html, tag) {
  const lower = html.toLowerCase()
  let cursor = 0, output = ''
  while (cursor < html.length) {
    const open = lower.indexOf(`<${tag}`, cursor)
    if (open === -1) return output + html.slice(cursor)
    output += html.slice(cursor, open)
    const close = lower.indexOf(`</${tag}`, open + tag.length + 1)
    if (close === -1) return output
    const end = lower.indexOf('>', close + tag.length + 2)
    if (end === -1) return output
    cursor = end + 1
  }
  return output
}

const labelValue = (html, labels) => {
  const withoutRawText = stripRawTextElements(stripRawTextElements(html, 'script'), 'style')
  const plain = decode(withoutRawText.replace(/<[^>]*>/g, '\n'))
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const found = plain.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:\\n]\\s*([^\\n]+)`, 'i'))
    if (found) return decode(found[1])
  }
  return null
}

const explicitBoolean = value => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  if (/^(yes|true|run[- ]?flat)$/i.test(value.trim())) return true
  if (/^(no|false|not run[- ]?flat)$/i.test(value.trim())) return false
  return undefined
}

/** Parse durable product details without inventing values for fields the page omits. */
export function parseProductPage(html, { url, fallback = {}, fetchedAt = new Date().toISOString() } = {}) {
  const product = productJsonLd(html) || {}
  const properties = Object.fromEntries((Array.isArray(product.additionalProperty) ? product.additionalProperty : [])
    .filter(item => asText(item?.name) && item?.value !== undefined)
    .map(item => [decode(item.name).toLowerCase(), item.value]))
  const field = (names, labels = names) => {
    for (const name of names) if (properties[name.toLowerCase()] !== undefined) return asText(properties[name.toLowerCase()])
    return labelValue(html, labels)
  }
  const name = asText(product.name) || asText(fallback.name)
  const size = canonicalSize(field(['tire size', 'size']) || name?.match(/\d{3}[/-]\d{2}R?[-/]?\d{2}/i)?.[0]) || fallback.size || null
  const sku = asText(product.sku) || asText(product.mpn) || asText(fallback.source?.sku)
  const brand = asText(typeof product.brand === 'object' ? product.brand?.name : product.brand) || field(['brand'])
  const model = field(['model', 'model name']) || (brand && name?.toLowerCase().startsWith(brand.toLowerCase()) ? name.slice(brand.length).trim() : null)
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers
  const price = Number(offers?.price)
  const availability = asText(offers?.availability)
  const runFlatText = field(['run flat', 'run-flat', 'runflat'])
  const runFlat = explicitBoolean(runFlatText)
  const imageUrls = asStringArray(product.image).map(value => new URL(value, url || ORIGIN).toString())
  const productId = asText(product.productID) || asText(product['@id']) || sku
  const details = {
    brand, model, imageUrls,
    description: asText(product.description) || field(['description']),
    season: field(['season']),
    productCategory: field(['category', 'vehicle type']),
    loadIndex: field(['load index', 'load rating']),
    speedRating: field(['speed rating', 'speed index']),
    sidewall: field(['sidewall', 'sidewall description']),
    treadwear: field(['treadwear']),
    utqg: field(['utqg', 'utqg rating']),
    warranty: field(['warranty', 'mileage warranty']),
    ...(runFlat === undefined ? {} : { runFlat }),
  }
  const compactDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== null && value !== undefined && (!Array.isArray(value) || value.length)))
  const row = {
    ...fallback,
    ...(name ? { name } : {}),
    ...(size ? { size } : {}),
    ...(Number.isFinite(price) && price > 0 ? { price: Math.round(price * 100) / 100 } : {}),
    ...(availability ? { inStock: !/outofstock|soldout|discontinued/i.test(availability) } : {}),
    ...compactDetails,
    source: {
      ...(fallback.source || {}),
      ...(sku ? { sku } : {}),
      ...(productId ? { productId } : {}),
      ...(compactDetails.productCategory ? { productCategory: compactDetails.productCategory } : {}),
      url: productUrl(url || fallback.source?.url),
      fetchedAt,
      // Keep unrecognised structured fields so a later importer can recover
      // them without another supplier request. JSON payload storage preserves it.
      raw: product,
    },
  }
  if (!row.id && sku) row.id = `giga-${sku.toLowerCase()}`
  delete row.productCategory
  if (!row.category) row.category = toCategory(compactDetails.productCategory || compactDetails.season, name)
  if (!row.description) row.description = compactDetails.description || [compactDetails.season, compactDetails.loadIndex, compactDetails.speedRating].filter(Boolean).join(' · ')
  return row
}

/**
 * Highest ?page= in the pager, so a caller knows when to stop.
 *
 * The pager is 1-indexed, so the highest link *is* the page count -- 281
 * results at ten a page links up to `?page=29`, and there are 29 pages.
 */
export function readTotalPages(html) {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map(match => Number(match[1]))
  return pages.length ? Math.max(...pages) : 1
}

/**
 * Listing URL for a size, paginated from 1.
 *
 * Their pager is 1-indexed and `?page=1` serves the same rows as the bare URL,
 * so page 1 is requested without the parameter. Emitting it anyway means the
 * first two pages of a multi-page run are the same ten tires.
 */
export function sizeUrl(size, page = 1) {
  return `${ORIGIN}/tires/${toSizePath(size)}${page > 1 ? `?page=${page}` : ''}`
}

/**
 * Plain HTTP fetch of a listing page.
 *
 * Usually not the one you want: the site sits behind AWS WAF, which answers
 * a bare fetch with a challenge page instead of the catalog. Kept because it
 * is the cheapest path if that ever changes, and it is what --plain-fetch runs.
 */
export async function fetchSizePage(size, page = 1, options = {}) {
  const { fetchImpl = fetch, userAgent = USER_AGENT } = options
  const url = sizeUrl(size, page)
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': userAgent,
    },
  })
  const html = await response.text()
  assertProviderResponse(url, response, html)
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`)
  assertExpectedPage(url, html, 'listing')
  return { html, url }
}

export async function fetchProductPage(input, options = {}) {
  const { fetchImpl = fetch, userAgent = USER_AGENT } = options
  const url = productUrl(input)
  const response = await fetchImpl(url, { headers: {
    Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': userAgent,
  } })
  const html = await response.text()
  assertProviderResponse(url, response, html)
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`)
  assertExpectedPage(url, html, 'product')
  return { html, url }
}
