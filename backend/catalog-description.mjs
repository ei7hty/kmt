import { parseFragment } from 'parse5'

const BLOCK_TAGS = new Set(['br', 'div', 'p', 'li', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])
const DISCARD_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed'])

function validScalar(point) {
  return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
}

/** Reject numeric references that cannot represent a Unicode scalar value. */
function rejectInvalidNumericReferences(value) {
  return value.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (reference, hex, decimal) => {
    const point = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16)
    return validScalar(point) ? reference : ''
  })
}

function textContent(root) {
  const output = []
  const stack = [{ node: root, closeBlock: false }]

  while (stack.length > 0) {
    const { node, closeBlock } = stack.pop()
    if (closeBlock) {
      output.push(' ')
      continue
    }
    if (node.nodeName === '#text') {
      output.push(node.value)
      continue
    }
    if (node.nodeName === '#comment' || DISCARD_CONTENT_TAGS.has(node.tagName)) continue

    const block = BLOCK_TAGS.has(node.tagName)
    if (block) {
      output.push(' ')
      stack.push({ node, closeBlock: true })
    }
    const children = node.childNodes || []
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], closeBlock: false })
    }
  }

  return output.join('')
}

function parseAsText(value) {
  const fragment = parseFragment(rejectInvalidNumericReferences(value))
  return textContent(fragment)
}

function withoutAngles(value) {
  let result = ''
  for (const character of value) if (character !== '<' && character !== '>') result += character
  return result
}

function replaceInvalidSurrogates(value) {
  let result = ''
  for (let cursor = 0; cursor < value.length; cursor++) {
    const unit = value.charCodeAt(cursor)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(cursor + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[cursor] + value[++cursor]
      } else {
        result += '\ufffd'
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += '\ufffd'
    } else {
      result += value[cursor]
    }
  }
  return result
}

/**
 * Turn supplier-authored description fragments into inert, readable text.
 *
 * parse5 applies the HTML parsing and complete entity-decoding rules without
 * executing anything. Only text nodes are copied; comments, every attribute,
 * and executable/embedded element subtrees are discarded. The public catalog
 * also calls this on read so rows stored before this boundary was added are
 * fixed immediately.
 */
export function cleanCatalogDescription(input) {
  if (typeof input !== 'string' || input === '') return ''
  const scalarSafe = replaceInvalidSurrogates(input)
  if (!/[<&]/.test(scalarSafe)) return scalarSafe

  let text = scalarSafe
  // Supplier feeds can encode a fragment twice. Each parse is inert and its
  // output is parsed again only to turn decoded markup into text-node content.
  for (let pass = 0; pass < 3; pass++) {
    const parsed = parseAsText(text)
    if (parsed === text) break
    text = parsed
  }

  return withoutAngles(text).replace(/\s+/gu, ' ').trim()
}
