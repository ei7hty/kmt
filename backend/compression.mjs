/**
 * Compressing an API response, because nothing else here does.
 *
 * WHY THIS EXISTS. The post-deploy audit has been failing on
 * `GET /api/catalog compressed transfer stays under 204,800 bytes` since before
 * anyone noticed, and #525 roughly doubled the overage by adding a decoded spec
 * to all 6,103 rows (237,271 -> 329,041 bytes). Measured on the live payload:
 *
 *   raw JSON                          2,575,347 bytes
 *   what the edge actually sends        ~325,000   <- the failing number
 *   node brotli quality 1                265,179
 *   node brotli quality 5                147,726   <- 17ms, 28% under budget
 *   node brotli quality 11               118,040
 *
 * The edge is doing worse than brotli's LOWEST setting, and there is no dial
 * for it: there is no compression anywhere in `backend/`, nothing in `fly.toml`
 * configures any, and the encoding is supplied by Fly's proxy -- which
 * `.forge/deployed-site-check.mjs` already says in as many words. An
 * application that compresses its own body is the only place the quality can
 * be chosen, and a `content-encoding` we set is passed through rather than
 * redone.
 *
 * So this is not "make the catalogue smaller". Not one field is dropped. The
 * same bytes, compressed properly, fit the budget with room to spare.
 *
 * QUALITY 5 IS A MEASURED CHOICE, not a default. On the largest response this
 * server can produce it costs 17ms and lands at 147,726 bytes; quality 11 saves
 * a further 29,686 bytes and costs an order of magnitude more CPU on a machine
 * that also serves the owner screen. Quality 4 (180,990) would pass today with
 * only 12% of headroom, which the catalogue would eat as it grows.
 */
import { brotliCompress, constants, gzip } from 'node:zlib'
import { promisify } from 'node:util'

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/**
 * Brotli quality. See the table above; re-measure rather than nudge.
 */
export const BROTLI_QUALITY = 5

/**
 * Below this, compression costs more than it saves.
 *
 * A few hundred bytes of JSON -- `{"ok":true}`, an error, a one-size catalogue
 * for a size nobody stocks -- comes back the same size or larger once a brotli
 * header is on it, and every one of those pays the CPU anyway. The customer
 * response this exists for is 23,319 bytes and the audit's is 2.5MB; both are
 * far above any threshold in this range, so the exact number is not delicate.
 */
export const COMPRESS_MIN_BYTES = 1024

/**
 * Which encoding this client actually accepts, or null for none.
 *
 * PARSED, not pattern-matched. `Accept-Encoding: gzip, br;q=0` explicitly
 * REFUSES brotli, and a `/\bbr\b/` test answers that header with "br" and sends
 * a body the client cannot read. Same for `identity;q=0, *` and the rest of
 * RFC 9110 §12.5.3 -- the q-value is the whole point of the header and reading
 * it as a word list gets the refusals backwards.
 *
 * `*` counts as acceptance for anything not named, which is what lets a curl
 * with `Accept-Encoding: *` get a compressed body, but an explicit `br;q=0`
 * still wins over it because a named entry is more specific than the wildcard.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: honour the client's ORDERING.
 * `br;q=0.5, gzip;q=1.0` asks for gzip more strongly and still gets brotli,
 * because both are accepted and this returns the first of its own preferences
 * that the client has not refused. The body is always readable, so this is a
 * preference miss and not a correctness defect -- and changing it would change
 * what production negotiates for every client that states a preference, which
 * is a bigger decision than the refusal handling above. Named here so the next
 * reader knows it is a choice rather than an oversight.
 */
export function negotiateEncoding(header) {
  const entries = String(header ?? '')
    .split(',')
    .map(part => {
      const [name, ...parameters] = part.trim().split(';')
      // WHITESPACE AROUND THE EQUALS IS TOLERATED, and unparseable is a
      // REFUSAL. Those are one fix, not two, because the defect was that this
      // failed in two directions at once: `q=abc` gave NaN and was read as
      // quality 0 (the encoding is not used -- safe), while `q = 0` was not
      // recognised as a q parameter at all, fell back to the default quality
      // of 1, and sent brotli to a client that had just refused it.
      //
      // Which direction is safe is not symmetric. A client that gets plain
      // JSON when it would have taken brotli pays some bytes. A client that
      // gets brotli after refusing it cannot read the response at all. So
      // anything that is not a well-formed qvalue in [0,1] means "do not use
      // this encoding", and a value we do not understand is never read as
      // permission.
      // MATCHED AGAINST THE GRAMMAR, not merely coerced to a number and range
      // checked. RFC 9110 §12.4.2 defines qvalue as `( "0" [ "." 0*3DIGIT ] )
      // / ( "1" [ "." 0*3("0") ] )` and nothing else, so `1e-9` is not a
      // qvalue -- and `Number('1e-9')` is a perfectly finite 1e-9 that a range
      // check waves through. The rule is that input we do not fully understand
      // never becomes permission; a numeric check quietly made an exception to
      // that for every spelling JavaScript happens to parse.
      const parameter = parameters.map(p => p.trim()).find(p => /^q\s*=/i.test(p))
      const raw = parameter === undefined ? '1' : parameter.slice(parameter.indexOf('=') + 1).trim()
      const wellFormed = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)
      return { name: name.trim().toLowerCase(), quality: wellFormed ? Number(raw) : 0 }
    })
    .filter(entry => entry.name)

  const wildcard = entries.find(entry => entry.name === '*')
  for (const candidate of ['br', 'gzip']) {
    const named = entries.find(entry => entry.name === candidate)
    if (named) {
      if (named.quality > 0) return candidate
      continue
    }
    if (wildcard && wildcard.quality > 0) return candidate
  }
  return null
}

/**
 * The body and headers to send for one JSON payload.
 *
 * Returns `{ body, headers }` rather than writing anything, so the decision is
 * testable without a socket and so a caller keeps control of its own status
 * code and cache headers.
 *
 * `Vary: Accept-Encoding` IS NOT OPTIONAL and ships even when the body comes
 * back uncompressed. `/api/catalog` answers `public, max-age=300` whenever no
 * image packet exists, and a shared cache that stored one client's brotli body
 * under a key that ignores the encoding will hand it to the next client as
 * plain JSON. That failure looks like a corrupt catalogue on someone else's
 * phone, hours later, with nothing in our logs.
 */
export async function compressedJson(payload, acceptEncoding) {
  const json = Buffer.from(JSON.stringify(payload))
  const encoding = json.length >= COMPRESS_MIN_BYTES ? negotiateEncoding(acceptEncoding) : null
  if (!encoding) {
    return { body: json, headers: { 'Content-Length': String(json.length), Vary: 'Accept-Encoding' } }
  }

  const body = encoding === 'br'
    ? await brotliAsync(json, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        // Brotli picks its window and its internal heuristics from the size it
        // expects. Without the hint it plans for a small body and gives back a
        // worse ratio on a 2.5MB one -- which is the most likely explanation
        // for the edge's ~325,000 against quality 1's 265,179 on the same
        // bytes, and the reason this is passed rather than left default.
        [constants.BROTLI_PARAM_SIZE_HINT]: json.length,
      },
    })
    : await gzipAsync(json, { level: 6 })

  return {
    body,
    headers: {
      'Content-Encoding': encoding,
      // The COMPRESSED length. Declaring the uncompressed one does not fail --
      // it HANGS: the client waits for bytes that will never arrive, holding
      // the socket until something else times out. Found by mutating this line
      // and watching the test suite stop responding instead of going red,
      // which is why the test below now reads with a deadline.
      'Content-Length': String(body.length),
      Vary: 'Accept-Encoding',
    },
  }
}
