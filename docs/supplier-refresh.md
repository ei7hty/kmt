# Monthly supplier refresh

A runbook for taking the tracked snapshot from a few sizes to full coverage
of the 910-size selector, and for keeping it current afterward. It assumes
you have read the "Updating the tire catalog snapshot" section of the
[README](../README.md), which explains what `scrape-tires.mjs` and
`import-tires.mjs` each do; this page is the process for running them
across the whole catalog, on a schedule, without losing an evening to it.

## Why this is a person, not a cron job

`scrape-tires.mjs` opens a real, visible browser window and reads pages the
way a person would, because the supplier sits behind AWS WAF and a headless
request is refused outright. There is no stealth plugin and no spoofed user
agent. That is a deliberate choice, not a limitation to work around: it is
what makes the scraping reasonable to do at all, and it means someone has to
sit with it, at least until they trust the batch boundaries. Do not add
stealth, do not shorten the pacing described below, and if the supplier ever
answers with a real block, stop that batch and say so rather than retrying
past it.

**Two paces, and neither is optional.** `--delay` (1.5s, default) is between
pages within one size's own multi-page read. `--min-interval` (10s, default)
is between the start of one size's request and the next, and it holds
**regardless of outcome** -- empty, full, or failed alike. That second
number exists because of what happened without it: before the empty-listing
fix in #81/#129, a size with no results took the fetcher ~20 seconds to give
up on, which paced every request as an accidental side effect of a slow
failure. Once #129 made an empty size resolve in ~1.7 seconds -- correctly,
and much faster -- that accidental pacing disappeared on exactly the runs
that are mostly empty, and the very next real walk got a `429` from the
supplier after 44 back-to-back empty results at the new, unthrottled rate.
`--min-interval` is that pacing restored on purpose instead of by accident.
Do not shorten it because a stretch of empties feels wasteful to wait
through -- that feeling is the bug coming back.

## Before you start

- A stable connection with a real screen -- not a headless CI runner. Run it
  from your own machine, on a home connection, the way the README's "Pushing
  a scrape into a running server" section assumes.
- A checkout on `main`, so `.forge/CLAIMS.md` and the coverage rules in
  `scripts/scrape-tires.mjs` match what is actually deployed.
- Time. See "How long this takes" below before you start a batch you cannot
  finish in one sitting -- a run without `--replace` is safe to stop and
  resume, but a batch left half-scraped is a batch you have to remember to
  come back to.

## The batches

Batches are ordered by how common the size is, most common first, so the
customer catalog gets real coverage on the sizes most people are actually
driving on before it gets to the rare ones. As of this writing the 910
selector sizes break down by rim diameter like this (recount with the node
one-liner below if `src/data/fitment.js` has changed since):

| Rim | Sizes | Rim | Sizes |
| --- | --- | --- | --- |
| 12" | 15 | 19" | 111 |
| 13" | 35 | 20" | 108 |
| 14" | 42 | 21" | 54 |
| 15" | 77 | 22" | 64 |
| 16" | 108 | 23" | 24 |
| 17" | 113 | 24" | 18 |
| 18" | 141 | | |

Run from the repo root, same as every other command on this page:

```bash
node --input-type=module -e "
import('./src/data/catalog.js').then(({TIRE_CATALOG}) => {
  const sizes = new Set(TIRE_CATALOG.map(t => t.size));
  const byDiameter = {};
  for (const size of sizes) {
    const m = size.match(/^(\d+)\/(\d+)R(\d+)$/);
    if (!m) continue;
    byDiameter[m[3]] = (byDiameter[m[3]] || 0) + 1;
  }
  for (const [d, c] of Object.entries(byDiameter).sort((a, b) => a[0] - b[0])) console.log(d + '\"', c);
});
"
```

Run the 15-18" band first (439 sizes: the common passenger range), then
12-14" (92 sizes), then 19-24" (379 sizes: light truck and larger, least
common last). Within a band, split into runs of roughly 25-30 sizes each --
small enough that one blocked or slow run does not cost you the whole
band, large enough that you are not babysitting single-digit batches all
day. List the exact sizes for a chunk with the same one-liner, filtering
`byDiameter` down to one rim and slicing the result.

Every batch after the first uses the same command shape, **without**
`--replace`, so earlier batches survive:

```bash
npm run scrape-tires -- 205/65R15 215/60R16 ... --limit 0 --pages 40
```

`--limit 0` means read every page rather than keeping only the cheapest few.
`--pages 40` is a safety cap, not a target -- pick it comfortably above what
you expect the deepest size in the batch to need (see the next section), so
a real size does not get cut off and marked partial by an arbitrary cap the
way the first run of this snapshot was. If a batch does come back partial,
that is what `sizeCoverage` is for: re-run just the short sizes with a
higher `--pages` and no `--replace`, and the earlier complete sizes are
untouched.

## How long this takes

Four sizes, scraped complete, took this many pages:

| Size | Pages |
| --- | --- |
| 205/65R15 | 18 |
| 215/60R16 | 29 |
| 225/50R17 | 33 |
| 265/70R16 | 31 |

That is 111 pages, and the run took longer than ten minutes -- more than the
166.5 seconds the mandated 1.5-second pause alone would predict, because
each page also has to load and render in a real browser and its listings
extracted. Budget roughly 5-6 seconds per page, not 1.5, for a deep,
multi-page-per-size run like this one.

**A breadth pass (`--pages 1`) is governed by `--min-interval` instead**,
not this per-page figure -- it only ever reads one page per size, so the
10-second floor between sizes is most of the cost. Budget ~10-11 seconds
per size for a breadth pass (the 10s floor plus the page's own load time),
not the 5-6s/page table above; that number does not apply to a single-page
run at all.

**Do not extrapolate that per-size depth across all 910 sizes.** Those four
were chosen because they already had real supplier inventory; most of the
910 plausible-fitment sizes in the wider bands, especially 19-24" and the
less common ratios, will have far thinner listings -- a handful of pages or
none at all. A straight-line estimate from four of the deepest sizes to all
910 overstates the true total by a wide margin. Run one pilot batch of
25-30 sizes from the 15" band first, note its actual total pages and wall
time, and use that -- not this table -- to plan how many sessions the rest
of a band will take.

## After each batch: prove it before it ships

1. **Confirm coverage.** Every size in the batch should read `complete:
   true` in `src/data/scraped-tires.json`'s `coverage` block. A size that
   hit the `--pages` cap reads `complete: false` with `pagesRead` short of
   `totalPages` -- re-run just that size with a higher cap before moving on.
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync('src/data/scraped-tires.json','utf8')).coverage)"
   ```
2. **Dry-run the import**, against a local server so nothing is written
   anywhere real yet:
   ```bash
   node backend/dev.mjs
   ```
   Leave that server running in the foreground in its own terminal, then run
   the dry run from another terminal:
   ```bash
   npm run import-tires -- --dry-run
   ```
   Stop the local server with Ctrl-C when the dry run is done.
   Read the per-size new/changed/unchanged counts. A dry run against a
   database already seeded from this exact file will report everything
   unchanged -- that is expected, and proves the file parses and every tire
   passes validation, not that it differs from older data. To see a
   meaningful diff, dry-run against a server holding the *previous*
   snapshot instead.
3. **Import with `--complete` only for sizes the coverage block marks
   complete.** The CLI and the server both refuse `--complete` for any size
   not recorded as read in full, naming the size, so this is enforced, not
   just a convention -- but do not fight it by re-running with a lower bar
   just to make the flag accept. If a size still is not complete, leave it
   partial for this round and pick it up in the next refresh.
   ```bash
   KMT_OWNER_PASSWORD='...' npm run import-tires -- --to https://kensmobiletire.com --complete
   ```
   Set `KMT_OWNER_PASSWORD` in your own shell, in your own environment.
   Nobody else needs to see it, and no PR should ever carry it. If the
   password has been retired for Google-only owner sign-in, mint a session
   instead (`flyctl ssh console -a kmt -C "node /app/scripts/mint-session.mjs"`)
   and pass it as `KMT_OWNER_SESSION_COOKIE` in place of `KMT_OWNER_PASSWORD`
   above -- `import-tires.mjs` checks for it first.
4. **Confirm on `/owner`.** Sign in, check that the batch's sizes show the
   tire counts you expect, and that a tire the batch retired (if any) reads
   as out of stock rather than vanishing. `--complete` marks unlisted tires
   as no longer offered; it never deletes a row or an owner's price.

## When the supplier blocks a run

A real block is now its own thing, not a guess from a page's title: the
fetcher reads the actual HTTP status, and a `429` throws a distinguishable
error that stops the whole run immediately, on its own, before it reaches
another size. If you see it: do not retry, do not add a delay-shortening
workaround, do not switch to a different fetch strategy, and do not treat a
`429` as something to back off from and continue past -- "we backed off and
kept going" is exactly the workaround this rule forbids. Note which size it
happened on, whether a `Retry-After` was logged, leave the rest of that
batch for later, and say so plainly wherever this refresh is being tracked.
A stretch of ordinary empty results is not a block and does not stop a run
-- only a real `429` (or any other abnormal response) does. The scraper
staying small, visible and paced on purpose is what makes it reasonable to
run at all; treating a block as a puzzle to route around is the direction
that stops being true.

Wait at least an hour before resuming after a `429`, whatever else is
ready. The supplier just told you the rate was too high; running again
sooner is asking the same question again before it changed its mind.

## Committing the result

Same shape as any other change here: claim the branch in
`.forge/CLAIMS.md`, one commit for the snapshot with per-size counts and
coverage flags in the message, merge `origin/main` in before opening the
PR, and let the repo agent merge -- never the author. See
[`AGENTS.md`](../AGENTS.md) for the full protocol.
