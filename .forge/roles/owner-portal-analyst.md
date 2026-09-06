# Role: owner portal analyst

Written 2026-09-06 by the outgoing OWNER PORTAL ANALYST (session
`local_a76ad1cd`) at the user's spin-down, at main `09bccf4` or later.
The role had no charter when it started: the user opened the session with
one sentence, "coordinate with the product manager to improve the owner
portal, CRM, inventory selector, database lookup", and the shape below is
what that turned into over one day. Verify every SHA, PR and state here
before acting on it; it is a snapshot.

## What the role is, and is not

It measures and it judges; it does not build. It reads the code and the
live site, drives throwaway servers read-only, produces numbers from
scripts rather than from screens, ranks by harm to a person, and writes
the what and the why into `.forge/` so the lanes that own the files can
build from numbers instead of suspicion. Under the m12 sprint it was
analysis-and-briefs only, because `OwnerInventory.jsx` and
`QuoteRequests.jsx` belong to LEAD UI ENGINEER and the owner API to LEAD
BACKEND DEV, and a third session in those files is the collision this
repository spent a night avoiding. After gate 3 the PROJECT MANAGER said it
could take tasks under claim; it never needed to.

It reports to the PROJECT MANAGER and takes instruction only from there;
product calls (voice, wording, what Ken sees) go to the DEV-PRODUCT
MANAGER and the user, copied on every product-shaped message. It never
messages the QA TESTER directly, never enters the owner password, never
submits, pays or cancels on production, and never merges its own PR.

What it produced, for the record and so nothing is redone:
`.forge/m13-owner-day-to-day.md` (the post-launch owner milestone with
the measurements attached), `docs/owner-guide.md` (Ken's one-page guide),
the t62 voice list and the t65 line (approved, in the lead's hands), the
QA TESTER's twenty-line charter, two rankings (the six customer-facing
issues, then the remaining 25), and the post-merge review of t59.

## The voice rule (t62), which governs every string written after this

Approved by the lead on 2026-09-06 and applied by JUNIOR FRONT END DEV's
sweep. Ken is one person, so the site speaks as him, but "we becomes I" is
false in three places, and the rule is:

- **First person where a person could truthfully say it.** "I come to
  you", "I'll meet you there", "tell me where to find you", "that tire
  isn't one I offer right now".
- **No pronoun where the speaker is not Ken.** A loading state ("Still
  checking today's prices for 205/55R16. One moment."), the browser
  failing to reach the server ("Couldn't reach the shop."), a server error
  ("The shop's site isn't answering right now."), a lookup table with a
  gap ("That ZIP code isn't one I recognize" is the furthest it goes), a
  catalogue's absence ("205/55R16 isn't a size I list here", subject moved
  to the size, because a catalogue gap is not Ken's failing and "I don't
  have" reads as if he checked the van).
- **The privacy page stays in the third person.** It already speaks about
  Ken by name; it is a statement of obligations, not a conversation, and
  "I" there would read as informal about the one thing that should not
  be. This is an exception to the rule above, argued for on purpose.
- **Every "call us" is "text me"** under t63, which removes calling from
  every customer-facing control. The owner card's `tel:` link stays
  (PROJECT MANAGER's ruling): that is Ken calling a customer back, the
  opposite direction.
- **The business name is not a pronoun.** "Ken's Mobile Tire" is untouched
  everywhere; in email it appears only in the From line and the footer,
  and every body is signed "Ken".
- **The refusal at the worst moment carries the way back.** The
  out-of-area refusal reads "about N miles from Malden, outside the M
  miles I cover", with the text number in the sentence, because the
  customer reading it is at a roadside being told no.

The five email bodies (t37) were specified in this voice before they
existed, with one-line sketches, so they are built in it rather than swept
later.

## How to find every sentence a voice change touches

A grep for `we` misses two things: lines that also contain a word the
filter excluded (every line of `Status.jsx` contains `status`), and
sentences assembled from two literals or spanning lines of JSX. The method
that found all 32:

1. Extract every string literal (`'…'`, `"…"`, `` `…` ``) and every JSX
   text node (`>…<`) from `src/`, `backend/` (not tests) and
   `index.html`, with comments blanked first so code comments do not
   count. Test each string, not each line, for the pronoun with a word
   boundary that also stops `US` and `en-US` from matching `us`.
2. Then a second pass over the rendered text of each route file: strip
   tags and `{…}` expressions, join whitespace, split into sentences, and
   test the sentences. This is the pass that catches "We don't stock
   {size} for online ordering." and "We can still source it.", which are
   assembled across lines and invisible to the first pass.
3. Backend messages count: `InputError` strings in `quotes.mjs`,
   `api.mjs` and `service-area.mjs` reach the customer's screen verbatim.

The script that did pass 1 is below; pass 2 was a one-liner per file with
`sed 's/<[^>]*>/ /g'` and a sentence split. Write scripts like this with
an editor or the Write tool: on this machine both `node -e "…"` inside a
double-quoted shell string and a quoted heredoc mangled backticks and
backslashes, and one commit of `m13.6` went out with every code mark
stripped before it was noticed.

```js
// voice-scan.mjs: every string literal and JSX text node carrying we/our/us
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
const ROOT = process.cwd()
const files = []
const walk = d => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n); const s = statSync(p)
    if (s.isDirectory()) { if (!/node_modules|dist|[\\/]data$/.test(p)) walk(p) }
    else if (/\.(jsx?|mjs|html)$/.test(n) && !/\.test\./.test(n)) files.push(p)
  }
}
walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'backend')); files.push(path.join(ROOT, 'index.html'))
const pron = /(^|[^\w'’])(we|we're|we'll|we've|we&apos;re|we&apos;ll|we’re|we’ll|our|ours|us|let's|let&apos;s|let’s)(?=$|[^\w'’])/i
const blank = m => m.replace(/[^\n]/g, ' ')
const out = []
for (const f of files) {
  let src = readFileSync(f, 'utf8')
  src = src.replace(/\/\*[\s\S]*?\*\//g, blank)
  src = src.replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, a) => a + ' '.repeat(m.length - a.length))
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}]+)</g
  src.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      const s = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()
      if (s.length > 3 && pron.test(s)) out.push(`${path.relative(ROOT, f)}:${i + 1}  ${s}`)
    }
  })
}
console.log(out.join('\n'))
```

## How the 375 px numbers were made, so they can be made again

Every figure in `m13-owner-day-to-day.md` and in the t59 review came from
this, never from reading a screen:

1. `backend/dev.mjs` on a port nobody else uses (`KMT_OWNER_PORT=4291`),
   with `KMT_OWNER_DB` pointed at a scratch file, so the database seeds
   itself from the tracked snapshot (`src/data/scraped-tires.json`) and
   nothing touches production or the checkout's own database. Check the
   port is free first and confirm it is closed after; `kill` does not free
   ports here, kill by port from PowerShell (see `NOTES.md`).
2. Seed what the screen needs through the public API: one `POST
   /api/requests` per draft, a 32-hex-character `customerKey`, the vehicle
   marked TEST, two drafts two seconds apart when order matters.
3. Playwright Chromium at 375 × 812, device scale 2. Read
   `getBoundingClientRect()` and `scrollHeight` from the DOM and write a
   JSON; screenshot the viewport for the human reader, but quote the
   JSON. `.forge/shots/` is ignored by design, so screenshots are never
   tracked; the method regenerates them in under a minute.
4. Measure the same things before and after a change, at named SHAs, and
   say which SHA each number is from. Say what a number includes (475 px
   with the card's outer padding against another agent's 456 without) so
   two correct measurements of different things do not become a phantom
   disagreement.
5. Re-measure after the merge, on main, not on the branch. The t59 review
   found two things the PR's own report said had landed and had not (the
   size-committed view 2 px over the target; the `/owner/quotes` nav still
   wrapping at 375). A measurement disagreeing with a claim is a finding.

The driver, as run:

```js
// owner-shots.mjs: /owner on open, one size committed, /owner/quotes at 375
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:4291'
const SIZE = process.env.SHOT_SIZE || '215/60R16'
const VIEW = { width: 375, height: 812 }
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 })
const results = { base: BASE, size: SIZE, viewport: VIEW }
async function signIn() {
  await page.waitForSelector('.oi-signin, .oi-results, .owner-content, .oi-error', { timeout: 15000 }).catch(() => {})
  if (await page.locator('.oi-signin').count()) {
    await page.fill('#owner-password', process.env.KMT_OWNER_PASSWORD || '')
    await page.click('button:has-text("Sign in")')
    await page.waitForSelector('.oi-signin', { state: 'detached', timeout: 15000 })
  }
}
await page.goto(`${BASE}/owner`); await signIn()
await page.waitForSelector('.oi-results', { timeout: 15000 })
await page.waitForFunction(() => document.querySelectorAll('.oi-tire').length > 0 || document.querySelector('.oi-empty'), null, { timeout: 15000 })
await page.screenshot({ path: 'owner-open-viewport.png' })
results.landing = await page.evaluate(() => {
  const first = document.querySelector('.oi-tire'), filters = document.querySelector('.oi-filters')
  return {
    pageHeight: document.documentElement.scrollHeight,
    firstTireTop: first ? Math.round(first.getBoundingClientRect().top + window.scrollY) : null,
    filtersTop: filters ? Math.round(filters.getBoundingClientRect().top + window.scrollY) : null,
    matchingTiresText: document.querySelector('.oi-results-heading p')?.textContent,
  }
})
await page.fill('input[aria-label="Tire size"]', SIZE)
await page.waitForTimeout(600)
await page.waitForFunction(() => !document.querySelector('.oi-results[aria-busy="true"]'), null, { timeout: 15000 })
await page.waitForTimeout(300)
results.size = await page.evaluate(view => {
  const cards = [...document.querySelectorAll('.oi-tire')]
  const heights = cards.map(c => Math.round(c.getBoundingClientRect().height))
  return {
    matchingTiresText: document.querySelector('.oi-results-heading p')?.textContent,
    cardsOnPage: cards.length,
    meanCardHeightPx: heights.length ? Math.round(heights.reduce((a, b) => a + b, 0) / heights.length) : null,
    firstCardTop: cards[0] ? Math.round(cards[0].getBoundingClientRect().top + window.scrollY) : null,
    pageHeightPx: document.documentElement.scrollHeight,
    screensAt812: Math.ceil(document.documentElement.scrollHeight / view.height),
    saveButtons: document.querySelectorAll('.oi-offer button[type="submit"]').length,
    pagination: document.querySelector('.oi-pagination span')?.textContent || null,
  }
}, VIEW)
await page.evaluate(() => document.querySelector('.oi-tire')?.scrollIntoView())
await page.screenshot({ path: 'owner-size-first-card-viewport.png' })
await page.goto(`${BASE}/owner/quotes`); await signIn()
await page.waitForSelector('.owner-content', { timeout: 15000 })
await page.waitForFunction(() => !/Loading/.test(document.querySelector('.owner-subhead')?.textContent || ''), null, { timeout: 15000 })
await page.screenshot({ path: 'owner-quotes-viewport.png' })
results.quotes = await page.evaluate(() => ({
  summary: document.querySelector('.owner-subhead')?.textContent,
  tabs: [...document.querySelectorAll('.owner-view')].map(b => b.textContent.trim()),
  searchInputs: document.querySelectorAll('.owner-content input').length,
  cards: document.querySelectorAll('.owner-request').length,
  refs: [...document.querySelectorAll('.owner-request-ref')].map(e => e.textContent),
  ages: [...document.querySelectorAll('.owner-request-age')].map(e => e.textContent),
  navRows: new Set([...document.querySelectorAll('.internal-nav button')].map(x => Math.round(x.getBoundingClientRect().top))).size,
}))
await page.click('button[role="tab"]:has-text("Needs you")'); await page.waitForTimeout(800)
results.needsYouOrder = await page.evaluate(() => [...document.querySelectorAll('.owner-request-vehicle')].map(e => e.textContent))
writeFileSync('owner-shots.json', JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
await browser.close()
```

Run from a scratch directory with `NODE_PATH` unset: ESM ignores it, so
import Playwright by absolute `file:///…/node_modules/playwright/index.mjs`
if the script is not inside the checkout.

The two query paths (catalog and owner search) were timed the same way
with a cloned database: real rows copied to new ids across other sizes
until the target count, `catalog()` and `list()` timed over five warm runs,
the JSON measured raw and gzipped. Those figures are in
`m13-owner-day-to-day.md`; the finding that mattered was that neither path
is bound by SQLite at any count, the customer's cost is transfer per visit,
and the platform's edge already compresses (the live catalog was 35.7 KB
brotli for 1,083 tires, 173,723 bytes after the import). Read the wire, not
the raw size, before calling anything slow.

## How to rank

Verify every issue against `origin/main` and, where it applies, the live
site read-only, before ranking any of them; name the method beside each
(a `curl`, a line number, a grep). Then order by who it hurts and how much:
a customer at a specific moment first, then every customer at once but
latent (monitoring, backups), then the team's ability to protect customers
(the gate, the docs that mislead a new agent), then hygiene. Say when an
item is already in motion, so the ranking is about attention rather than
new work. Say when an item is smaller than it looks (the 401 message on
unmatched API paths) and when it is larger (the size box that refuses the
app's own size format). One ranking's only real move, docs-only merges
redeploying production on import day, changed a merge order the PROJECT
MANAGER had already decided the other way; the argument that carried it
was the consequence in the customer's terms, six restarts in one day, not
the mechanism.

## What was deliberately not filled in

- **Ken's other work.** The t65 line under "Looking for more than just
  tires?" is drawn only from Ken's own hero copy, "Tires. Repairs.
  Roadside assistance.", and reads "Flat repairs, roadside help and
  anything else that keeps you moving. Tell me what you need." The gap
  (TPMS, balancing, seasonal swaps, fleet work, or none of those) is the
  user's to fill from Ken. A plausible list would be indistinguishable
  from a real one and wrong. Do not invent it.
- **The maintainer's name and number, and the shop's phone number** in
  `docs/owner-guide.md` are placeholders the user fills. No personal
  contact detail belongs in a tracked file.
- **Whether the seed should write `'full'` coverage** for sizes the
  snapshot marks complete. The metric wording was fixed (#149) so "0 of 4
  read to the last page" is now a true statement of a semantics gap rather
  than a failure; the seed semantics change was recorded by the PROJECT
  MANAGER and not taken during the import week. Someone will meet it
  again.

## Where the pending things are

- The two review findings on t59 (the size-committed view at 814 px against
  a 812 px target; the `/owner/quotes` nav wrapping to two rows at 375) are
  in the polish batch. Re-measure both on main after it lands, with the
  driver above; the lead's preferred fix for the first is folding the
  coverage line into the collapsed tools panel.
- The QA TESTER's Part B (one TEST submit, on the PROJECT MANAGER's word)
  and Part C (the owner journey) of the charter were not run at this
  spin-down; their findings, when they come, are ranked the way the first
  five were.
- `m13-owner-day-to-day.md` is the spec; m13.1 (owner lookup) is first
  because it is what Ken needs on the first phone call, and the customer-
  side lookup rejection in `decisions.md` does not bar it, since the owner
  is behind the session. Say that in the brief, or a misremembered
  precedent will kill a good idea.

## Working in this harness, what cost a round

- The PROJECT MANAGER will say when a PR is ready for review; a background
  poll on GitHub is noise beside that signal. Hold a review until the head
  carries the change it is meant to measure; a review of the wrong head
  produces numbers against a moving target.
- `.forge/shots/` is git-ignored; a docs PR that adds screenshots there
  fails silently at `cp` and the commit goes out without them.
- The same-name claim rows: a docs PR that adds a claim row and is merged
  without releasing it leaves the row on main. Release in the PR's last
  commit, or a one-line follow-up (#201) closes it.
- Worktrees via `node scripts/worktree.mjs`, never `--force`; the shared
  `node_modules` junction is the trap `NOTES.md` describes.
