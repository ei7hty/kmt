const NAMED_ENTITIES = new Map([
  ['amp', '&'], ['apos', "'"], ['copy', '©'], ['gt', '>'], ['hellip', '…'],
  ['lt', '<'], ['mdash', '—'], ['middot', '·'], ['nbsp', ' '], ['ndash', '–'],
  ['quot', '"'], ['reg', '®'], ['trade', '™'],
])

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

  text = text.replace(/<!--[^]*?(?:-->|$)/g, ' ')
  // Content from executable/embedded elements is not product copy. Remove the
  // whole block, including a malformed block with no closing tag.
  text = text.replace(/<\s*(script|style|template|noscript|iframe|object|embed)\b[^>]*>[^]*?(?:<\/\s*\1\s*>|$)/gi, ' ')
  text = text.replace(/<\s*\/?\s*(?:br|div|p|li|tr|td|th|h[1-6]|hr)\b[^>]*>/gi, ' ')
  text = text.replace(/<[^>]*>/g, '')
  // Stray brackets from malformed tags are not useful customer text and must
  // not leak a markup-shaped fragment through the JSON boundary.
  text = text.replace(/[<>]/g, '')
  return text.replace(/\s+/gu, ' ').trim()
}
