/**
 * What this site asks a search engine to index, asserted across both files
 * that get a say.
 *
 * The sitemap invites Google to a page; the `<meta name="robots">` App.jsx
 * injects tells it what to do once there. Those two live in different files
 * and can disagree without anything failing -- a page listed in the sitemap
 * AND told `noindex` is a crawl budget spent to be refused, and a page meant
 * to stay out of results that is still advertised is a page that keeps coming
 * back. This is the only thing that reads them together.
 *
 * WHY IT READS SOURCE. `App.jsx` cannot be imported by `node --test`: there is
 * no JSX runner and no jsdom in this repository, which is the same reason
 * every other decision here lives in a `.js` beside its component. The two
 * path sets are four lines of a React file, and reading them is cheaper and
 * more honest than moving routing state out to make a test happy.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8')
const SITEMAP = readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8')
const ROBOTS = readFileSync(path.join(ROOT, 'public', 'robots.txt'), 'utf8')

/** The literal paths in a `new Set([...])` assigned to `name`. */
function pathSet(name) {
  const found = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`).exec(APP)
  assert.ok(found, `${name} is not in App.jsx as a literal Set; this test cannot read what it guards`)
  return new Set([...found[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
}

const sitemapPaths = new Set([...SITEMAP.matchAll(/<loc>https:\/\/kensmobiletire\.com(\/[^<]*)?<\/loc>/g)]
  .map(match => match[1] ?? '/'))

test('nothing is both advertised to Google and told not to index', () => {
  const canonical = pathSet('CANONICAL_PATHS')
  const noindex = pathSet('NOINDEX_PATHS')
  assert.ok(canonical.size > 0 && noindex.size > 0, 'an empty set makes every assertion below vacuous')

  const both = [...noindex].filter(route => sitemapPaths.has(route))
  assert.deepEqual(both, [],
    'these are in sitemap.xml and carry a noindex: a crawl spent to be refused, every time')

  const contradictory = [...noindex].filter(route => canonical.has(route))
  assert.deepEqual(contradictory, [],
    'a canonical says "this URL is the real one for this content" and noindex says "do not list it" -- pick one')
})

test('the privacy notice is out of search: crawlable, noindexed, unlisted', () => {
  // Ken, 2026-09-13: "i dont want the privacy page to index on google search".
  assert.ok(pathSet('NOINDEX_PATHS').has('/privacy'), '/privacy lost its noindex')
  assert.ok(!sitemapPaths.has('/privacy'), '/privacy is still advertised in sitemap.xml')

  // AND STILL CRAWLABLE, which is the half that looks wrong and is not. A
  // `Disallow` would stop Google fetching the page; a page it cannot fetch can
  // still be indexed from someone else's link, and it would never read the
  // noindex sitting on it. The URL then sits in results with no description
  // and no way to ask for its removal. Crawlable is what makes noindex work.
  const disallowed = [...ROBOTS.matchAll(/^Disallow:\s*(\S+)/gm)].map(match => match[1])
  assert.ok(!disallowed.includes('/privacy'),
    'robots.txt now blocks /privacy, so Google can never fetch it to read the noindex that would remove it')
  // The control: robots.txt really does disallow things, so the assertion
  // above is about /privacy specifically and not an empty list.
  assert.ok(disallowed.length > 0, 'robots.txt disallows nothing at all; this check is measuring nothing')
  assert.ok(disallowed.includes('/owner'), 'the owner screen should still be disallowed')
})

test('every page the sitemap lists has a canonical URL to point at', () => {
  const canonical = pathSet('CANONICAL_PATHS')
  for (const route of sitemapPaths) {
    assert.ok(canonical.has(route),
      `${route} is in sitemap.xml but App.jsx gives it no canonical, so Google picks one for it`)
  }
  assert.ok(sitemapPaths.size > 0, 'the sitemap lists nothing; this check is measuring nothing')
})
