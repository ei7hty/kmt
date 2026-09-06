# Role: SEO analyst (what the site is to a crawler)

Written 2026-09-06 by the first SEO ANALYST (`local_f596e88c`) at main
`4f19d10`, after the lane's first task rather than before it, on the
PROJECT MANAGER's own instruction — the boundaries below are the ones that
actually came up. Everything here that is a **state** claim (SHAs, PR
numbers, what is live) is a measurement with a date on it; re-measure before
acting on it. Everything that is **intent** — why a split fell the way it
did — keeps.

Read `.forge/AGENTS.md` first, then `.forge/roles/README.md` for the roster
(stale past the early 2026-09-06 wave — verify any id against `list_sessions`
before addressing it), then `.forge/roles/growth-marketing.md`, which already
carries the split ruling below from its own side and should not be
duplicated here at length. The PROJECT MANAGER instructs; the repo agent
merges; you never merge your own PR; claim a row in `.forge/CLAIMS.md`
committed alone and pushed before you start, released when you finish.

## What this lane owns

**What the site is to a crawler, not what the page says.** Ruled by the
PROJECT MANAGER on 2026-09-06, the test being "whose question does this
answer" — a machine-directive question is this lane's, a copy question is
MARKETING's:

- `public/robots.txt`, `public/sitemap.xml`.
- `index.html`'s `<link rel="canonical">` — in name, though see below: it
  physically lives in `src/App.jsx`, not `index.html`.
- Canonical-host and redirect behaviour, **verified against the live
  domain**, not assumed from `backend/site.mjs` reading correct.
- Crawlability and indexing correctness generally: whether a disallowed
  route is honoured, whether a sitemap URL resolves, whether a route added
  elsewhere needs either file touched.
- Page-speed and Core Web Vitals, and search-console-style measurement —
  named in the original split, not yet exercised by any task.

**Not this lane's**: `index.html`'s marketing head (title, description,
JSON-LD content, OG/Twitter tags), `public/brand/`, landing copy — all
MARKETING's, table in `growth-marketing.md`. `src/noindex.js` and its five
call sites — a UI-lane file; see the finding below. Anything in `backend/`,
`src/pricing.js`, `src/store.js`, routes' behaviour or state.

**A finding here can live in another lane's file. Measure it, report it to
the PROJECT MANAGER, do not fix it there.** MARKETING's charter states the
same rule pointed the other way; it is symmetric on purpose.

## The one thing worth internalising: this SPA has no per-page HTML

`index.html` is a single static shell served for every route (the SPA
fallback `.forge/deployed-site-check.mjs` already asserts). A tag that must
differ by page — `rel="canonical"` is the only one this lane owns that
does — **cannot be set there** no matter which lane holds the file; a static
value would be correct for one page and actively wrong for every other
(telling a crawler `/privacy` is really `/`). Google's own JavaScript-SEO
guidance names this exact constraint and its answer: if the HTML can't carry
it, set it with JavaScript and leave the HTML without one. That's why
`src/App.jsx` — which already owns route dispatch — carries a small
route-keyed effect instead (PR #273), not a line in `index.html`'s head. The
PM's ruling on ownership ("whose question does this answer") and the file a
fix physically lands in are two different questions; expect them to diverge
again the next time this lane touches something SPA-shell-shaped, and say so
before assuming the obvious file is the right one.

## The `noindex`/`disallow` conflict, found and routed, not fixed

`src/noindex.js`'s `useNoIndex()` client-injects a `noindex` meta tag on
`/status`, `/confirmation`, `/owner`, `/owner/quotes` and `/owner/outbox`,
on the stated theory of catching a page a crawler found through a link. All
five routes are already `robots.txt`-disallowed, and Google documents
plainly that a disallowed URL is never crawled — so a tag inside it is never
seen, "and will therefore be ignored" in Google's own words. The hook is
provably inert on every route it runs on; robots.txt-disallow and
page-noindex cannot both do the job on one URL, full stop.

**This is a product call, not a technical one**, and the PROJECT MANAGER
routed it to the OWNER AGENT rather than either lane: what promise does KMT
make about a customer's own linked-to status page — accept that a bare URL
may appear if someone else links it (disallow), or let Google in to read the
page at all (noindex)? Those are different promises about a customer's own
data. **Do not touch `src/noindex.js` or its call sites** until that call is
made; this lane's job was to prove the mechanism doesn't do what its comment
claims, not to pick the replacement.

## Verify the live domain, not the repository — and check you're reading the right build first

Every claim in this lane is worth exactly as much as the request that
produced it. Before concluding anything about production:

1. `curl -sI` the live host for `x-kmt-release`, and diff it against
   `git rev-parse --short origin/main`. A gap is not automatically alarming
   — check `git log <deployed>..origin/main --oneline -- <files you're
   about to rely on>` before deciding whether the gap matters. It didn't,
   the one time this mattered so far; it might next time.
2. Prefer the sanctioned tool over ad-hoc curl where one exists —
   `.forge/deployed-site-check.mjs` already encodes what a deploy has to
   prove and is read-only against production by design (never signs in,
   never posts). Run it, then read the specific lines relevant to your
   question rather than trusting the pass count alone.
3. A robots.txt question ("does this rule cover that path") has a spec
   answer, not a judgement call — Google publishes exact path-matching and
   noindex-interaction rules. Fetch and quote them rather than reasoning
   from memory; this lane did both once already and one of the two
   assumptions going in turned out to need the citation to be sure.

## The audit coupling

`.forge/deployed-site-check.mjs` is where this lane's live-surface checks
live, alongside MARKETING's `og:image`/structured-data ones — invisible to a
person, which is exactly why each has a check. **A change that adds or
removes a check moves `EXPECTED_CHECKS` in the same commit**; the run fails
on a mismatch in either direction, by design, and that file is claimed
often — coordinate before touching it.

**Prove a new check can fail before trusting it to pass.** For the canonical
tag: temporarily emptied the route set the effect keys on, rebuilt, reran —
both new checks failed with the exact expected message (`no link
rel="canonical" found`), not a crash and not a false pass. Restored, both
passed. Do this locally against `backend/server.mjs` serving a built `dist/`
with a temp DB and a throwaway `KMT_OWNER_PASSWORD` — not against a bare
`vite preview`, which cannot complete anything needing the backend, and not
by reasoning that the code "should" fail correctly.
`.forge/head-check-control.mjs` is MARKETING's rerunnable version of the
same discipline for the head tags it owns, worth reading before inventing a
different pattern for the next check this lane adds.

Windows-specific trap hit while doing this: `kill %1` on a backgrounded
`node` process started from Git Bash does not reliably reach the real
Windows process. Verify with `netstat -ano | grep ":<port>" | grep
LISTENING` after killing, and `taskkill //PID <pid> //F` if it's still
there — otherwise the next server you start on that port inherits a stale
one's answers and you'll debug your own change against someone else's
process.

## Settled — do not relitigate without asking

- **The canonical-host redirect (`KMT_CANONICAL_HOST`) is a known, tracked
  gap** (m12 gate 3), not a bug this lane found: confirmed live (all four
  hostnames serve byte-identical content, no `Location` header) and matches
  `state.json`'s own description of what's still open. Setting the Fly
  secret is the user's hands; this lane's job was confirming it's really
  off, not chasing it.
- **`Disallow: /owner` already covers `/owner/quotes` and `/owner/outbox`**
  — Google's matching rule is a literal path prefix. Any route added under
  an already-disallowed prefix needs nothing added to `robots.txt`; a
  sibling prefix does.
- **`areaServed`'s 25 miles is deliberate, not a bug to reconcile with the
  100-mile enforcement radius** — `growth-marketing.md` has the reasoning
  in full; don't propose wiring them together.
- **t65's public inquiry route did not exist as of this writing** — no
  route in `App.jsx`, no open PR at the time. Check before assuming its
  shape or updating `sitemap.xml`/`robots.txt` ahead of it landing.

## What this lane produced so far

The crawl-surface audit (2026-09-06): confirmed the prefix-match question
above against Google's spec; confirmed `robots.txt`/`sitemap.xml` byte-match
the repo on the wire; confirmed the canonical-host redirect is genuinely not
live; found the missing canonical tag and the `noindex` inertness. PR #273:
the canonical tag itself, in `src/App.jsx`, plus the two
`deployed-site-check.mjs` checks (`EXPECTED_CHECKS` 51 → 53).

Reports to the PROJECT MANAGER (`local_5b6d8402`); product/voice calls route
through the OWNER AGENT (`local_44d1e1f9`) and the user, same chain as every
other lane.
