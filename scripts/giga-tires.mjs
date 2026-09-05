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
 * Their robots.txt allows /tires/. It disallows /cart, /checkout, /my-account,
 * /price/calculate, the /tires/o/ deals pages, and any `?filtering=` faceted
 * URL -- this scraper touches none of those.
 */

const ORIGIN = 'https://www.giga-tires.com'

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

export function toCategory(style) {
  const found = CATEGORY_RULES.find(rule => rule.pattern.test(style || ''))
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
  const start = html.indexOf('window.productPrices.initialData')
  if (start === -1) return {}
  const open = html.indexOf('{', start)
  if (open === -1) return {}

  // Brace-count rather than regex: the blob is nested and a lazy match stops at
  // the first inner `}`.
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(open, i + 1))
        } catch {
          return {}
        }
      }
    }
  }
  return {}
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
      category: toCategory(`${card.style || ''} ${card.name || ''}`),
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

/** Highest ?page= in the pager, so a caller knows when to stop. */
export function readTotalPages(html) {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map(match => Number(match[1]))
  return pages.length ? Math.max(...pages) + 1 : 1
}

export async function fetchSizePage(size, page = 0, options = {}) {
  const { fetchImpl = fetch, userAgent } = options
  const path = `/tires/${toSizePath(size)}${page > 0 ? `?page=${page}` : ''}`
  const response = await fetchImpl(`${ORIGIN}${path}`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': userAgent,
    },
  })
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${response.status} ${response.statusText}`)
  }
  return { html: await response.text(), url: `${ORIGIN}${path}` }
}
