import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanCatalogDescription } from './catalog-description.mjs'

test('supplier superscript markup becomes readable registered-mark text', () => {
  assert.equal(cleanCatalogDescription('score&lt;sup&gt;®&lt;/sup&gt; system'), 'score® system')
})

test('common named and numeric entities decode without losing meaningful marks', () => {
  assert.equal(
    cleanCatalogDescription('Touring&nbsp;&amp;&nbsp;Road &mdash; quiet &#174; &#x2122; &quot;Plus&quot;'),
    'Touring & Road — quiet ® ™ "Plus"',
  )
})

test('malformed and nested presentation tags leave their text in order', () => {
  assert.equal(cleanCatalogDescription('<b>All <i>Season</b></i><br>95H'), 'All Season 95H')
})

test('script blocks, comments, and event-bearing tags are removed rather than rendered', () => {
  assert.equal(
    cleanCatalogDescription('Safe<script>alert(1)</script><!-- secret --><img src=x onerror="alert(2)"> tire'),
    'Safe tire',
  )
  assert.equal(cleanCatalogDescription('Safe&lt;script&gt;alert(1)'), 'Safe')
})

test('ordinary plain descriptions are returned byte for byte unchanged', () => {
  const description = 'Quiet ride, long tread life · 95H BSW'
  assert.equal(cleanCatalogDescription(description), description)
})
