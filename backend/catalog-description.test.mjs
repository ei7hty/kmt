import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanCatalogDescription } from './catalog-description.mjs'

test('supplier superscript markup becomes readable registered-mark text', () => {
  assert.equal(cleanCatalogDescription('score&lt;sup&gt;®&lt;/sup&gt; system'), 'score® system')
})

test('complete named and numeric entities decode without losing meaningful marks', () => {
  assert.equal(
    cleanCatalogDescription('&Eacute;lan&ensp;90&deg; &le; 100 &ldquo;quiet&rdquo; &reg; &trade; &#174; &#x2122;'),
    'Élan 90° ≤ 100 “quiet” ® ™ ® ™',
  )
})

test('malformed and nested presentation tags leave their text in order', () => {
  assert.equal(cleanCatalogDescription('<b>All <i>Season</b></i><br>95H'), 'All Season 95H')
})

test('nested executable elements, comments, and event-bearing tags are removed rather than rendered', () => {
  assert.equal(
    cleanCatalogDescription('Safe<script>alert(1)<style>body{}</style></script><!-- secret --><img src=x onerror="alert(2)"> tire'),
    'Safe tire',
  )
  assert.equal(cleanCatalogDescription('Safe&lt;script&gt;alert(1)'), 'Safe')
})

test('quoted brackets in attributes and unterminated event tags never become text', () => {
  assert.equal(cleanCatalogDescription('<span title="2 > 1" onmouseover="alert(1)">Grip</span> tire'), 'Grip tire')
  assert.equal(cleanCatalogDescription('Safe<img src=x onerror="alert(1)"'), 'Safe')
  assert.equal(cleanCatalogDescription('Safe&lt;img src=x onerror=&quot;alert(1)&quot;&gt; tire'), 'Safe tire')
})

test('unknown and semicolon-edge entities follow HTML rules, while invalid scalars are rejected', () => {
  assert.equal(cleanCatalogDescription('A &madeup; B &copy C &amp D'), 'A &madeup; B © C & D')
  assert.equal(cleanCatalogDescription('before &#0; &#xD800; &#x110000; after'), 'before after')
})

test('bounded repeated decoding handles double-encoded markup without exposing it', () => {
  const result = cleanCatalogDescription('score&amp;lt;sup&amp;gt;®&amp;lt;/sup&amp;gt; &amp;lt;script&amp;gt;bad')
  assert.equal(result, 'score®')
  assert.doesNotMatch(result, /[<>]|script|bad|onerror/i)
})

test('ordinary plain descriptions are returned byte for byte unchanged', () => {
  const description = 'Quiet ride, long tread life · 95H BSW'
  assert.equal(cleanCatalogDescription(description), description)
})
