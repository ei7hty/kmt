const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['apos', "'"], ['copy', '©'], ['gt', '>'], ['hellip', '…'],
  ['lt', '<'], ['mdash', '—'], ['middot', '·'], ['nbsp', ' '], ['ndash', '–'],
  ['quot', '"'], ['reg', '®'], ['trade', '™'],
])

const BLOCK_TAGS = new Set(['br', 'div', 'p', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])
const DISCARD_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed'])

function decodeEntity(entity) {
  if (entity[0] !== '#') return NAMED_ENTITIES.get(entity.toLowerCase())
  const hexadecimal = entity[1]?.toLowerCase() === 'x'
  const digits = entity.slice(hexadecimal ? 2 : 1)
  if (!digits || !new RegExp(hexadecimal ? '^[0-9a-f]+$' : '^\\d+$', 'i').test(digits)) return undefined
  const point = Number.parseInt(digits, hexadecimal ? 16 : 10)
  if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined
  return String.fromCodePoint(point)
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (match, entity) => decodeEntity(entity) ?? match)
}

function markupNameAt(value, start) {
  let cursor = start + 1
  while (/\s/.test(value[cursor] || '')) cursor++
  const closing = value[cursor] === '/'
  if (closing) cursor++
  while (/\s/.test(value[cursor] || '')) cursor++
  const nameStart = cursor
  while (/[a-z0-9]/i.test(value[cursor] || '')) cursor++
  return { closing, name: value.slice(nameStart, cursor).toLowerCase() }
}

/** Copy text one character at a time; markup delimiters are never copied. */
function stripMarkup(value) {
  let result = ''
  const lower = value.toLowerCase()
  for (let cursor = 0; cursor < value.length;) {
    if (value[cursor] === '>') { cursor++; continue }
    if (value[cursor] !== '<') { result += value[cursor++]; continue }

    if (value.startsWith('<!--', cursor)) {
      const end = value.indexOf('-->', cursor + 4)
      result += ' '
      cursor = end === -1 ? value.length : end + 3
      continue
    }

    const { closing, name } = markupNameAt(value, cursor)
    if (!closing && DISCARD_CONTENT_TAGS.has(name)) {
      const closingStart = lower.indexOf(`</${name}`, cursor + 1)
      if (closingStart === -1) break
      const closingEnd = value.indexOf('>', closingStart + name.length + 2)
      result += ' '
      cursor = closingEnd === -1 ? value.length : closingEnd + 1
      continue
    }

    const end = value.indexOf('>', cursor + 1)
    if (BLOCK_TAGS.has(name)) result += ' '
    cursor = end === -1 ? value.length : end + 1
  }
  return result
}

/**
 * Turn supplier-authored description fragments into inert, readable text.
 *
 * This is deliberately not an HTML renderer. Supplier tags and attributes are
 * never trusted; the small entity vocabulary only preserves characters a tire
 * description can meaningfully carry. The public catalog also calls this on
 * read so rows stored before this boundary was added are fixed immediately.
 */
export function cleanCatalogDescription(input) {
  if (typeof input !== 'string' || input === '') return ''
  if (!/[<&]/.test(input)) return input

  let text = input
  // A supplier can send encoded markup, or markup encoded twice. Bound the
  // passes so hostile/self-referential input cannot turn this into a loop.
  for (let pass = 0; pass < 3; pass++) {
    const decoded = decodeEntities(text)
    if (decoded === text) break
    text = decoded
  }

  text = stripMarkup(text)
  return text.replace(/\s+/gu, ' ').trim()
}
