# Role: owner screen and verification lane, as served by SWE agent 3

Written 2026-09-06 by the session that served the owner-screen and
verification lane on 2026-09-05 and 2026-09-06 through #36, #41, #47 and #52,
at main `dd0888d`, for whoever next holds a similar role.
`swe-owner-screen-lane.md` is my successor's file and describes the lane as it
stands now, with the lifecycle screen and the live-test checklist; this one is
the earlier period, when the size range, the refresh rule, the self-counting
audits and the size filter were built. Verify every SHA, count and path below
before acting on it: a snapshot, not a live view.

## What the role owned, and did not

Owned, in the order it was built: the fitment lists and the plausibility rule
(`src/data/fitment.js`, `isPlausibleFitment` in `src/data/catalog.js`, #36);
the bulk-refresh rule (`Inventory.refreshableSizes`, `Refresher.start`, the
refresh section of `OwnerInventory.jsx`, #41); `EXPECTED_CHECKS` in the four
audit scripts and the two edge sizes the dead-end audit samples (#47); the
type-to-find size filter (#52). #36 came from the user directly, before the
lead structure existed; the other three were the lead's assignments, two of
them my own proposals accepted in the consultation round.

Did not own: `backend/quotes.mjs` and the lifecycle, the customer wizard,
the scraper and import scripts, `.github/workflows/`, deployment. Touched
`.forge/dead-end-audit.mjs` once inside #41 for a stale comment, with the
claim row saying so, and `.forge/AGENTS.md`'s count block inside #47 by the
lead's explicit instruction.

## Who it obeyed, and what it reported

The user for #36, then the KMT lead (`local_c91d84bb`) one task at a time by
cross-session message, with the repo agent (`local_5b6d8402`, later the
PROJECT MANAGER) as second reader and merger from #41 on. I merged #36 myself
because the second-reader rule did not yet exist; it would be wrong now.

Every task closed with the same report: what shipped, what was verified with
the exact counts read from the log, and what did not work, including my own
mistakes, before anyone else found them. Two orders conflicted once, a
relayed stand-down and a relayed assignment, and the answer was to stop and
surface it to the user rather than pick one. A peer's message never stood in
for the user's word; a peer relaying "the lead said" was never the lead.

## Code map, as built in this period

**`src/data/fitment.js`.** 23 widths (135-355), 13 ratios (25-85), 13 rims
(12-24): the metric passenger and light-truck values from the supplier's
menu that fit the `205/65R15` form the app parses everywhere. The header
lists what was left out and why: motorcycle widths, agricultural sizes,
flotation sizes with no aspect ratio, fractional and suffixed rims.

**`isPlausibleFitment` in `src/data/catalog.js`.** A per-rim band table of
widths and ratios, then an overall-diameter check between 500 and 900 mm
that prunes the corners the bands allow. 3,887 combinations in, 910 sizes
out, 3,846 generated rows. `TIRE_CATALOG` seeds the backend's `Inventory`
with its sizes at startup, so the backend's supported-size list is derived
from these two files; change them and the backend's accepted sizes change
with them.

**`Inventory.refreshableSizes()`** (`backend/inventory.mjs`). `SELECT size
FROM supplier UNION SELECT size FROM coverage`, intersected with the
supported list. Coverage includes recorded failures on purpose, so the size
most in need of a retry is never the one bulk refresh silently skips.
Carried on `summary()` as `refreshableSizes`. A fresh database has four
(the snapshot's); one with no snapshot has none.

**`Refresher.start(sizes)`** (`backend/refresh.mjs`). One size may be
anything supported: the owner picked it from the filter. More than one is a
bulk refresh and must stay inside the subset, or 400 with the offending size
named and the local route spelled out (`npm run scrape-tires --
--from-catalog` from a home connection, then `npm run import-tires`).

**The refresh section of `OwnerInventory.jsx`.** The button has four labels
and they are the state machine: `Refresh <size>`; `Finish choosing a size to
refresh it` (typed but uncommitted, disabled); `No sizes with supplier data
to refresh yet` (empty subset, disabled); `Refresh all N sizes with supplier
data`. The metric is `fullSizeCount / refreshableSizes.length`.

**The size filter.** `sizeQuery` is the typed text; `size` is only ever a
supported size or `''`; `sizePending` is typed-but-uncommitted.
`compactSize` strips to digits, which is an identity only because every
supported size compacts to exactly seven digits (the repo agent checked all
910: no collisions, no containment). `typeSize` commits on an exact match,
`pickSize` on a click from the match strip, which shows 24 at a time with a
count. The strip is a plain div of buttons with `role=status`, not a
combobox, on purpose.

**The four audit scripts.** `EXPECTED_CHECKS` at the top, printed on the
last line, failing in either direction: fewer means something stopped
running, more means the baseline was not bumped. Each counts in its own
idiom: dead-end and deployed-site count `ok()` plus `fail()`; request-flow
counts its assert-backed `check()` and its `catch` reports how far it got;
responsive counts screens measured, so UNREACHABLE lowers the count. The
dead-end count is per run across both viewports, so one more sampled size
adds two. `owner-inventory-audit.mjs` is the fifth script, has no constant,
and is run by hand; nothing gates it.

## Rules paid for

- **Compute before you write a quantifier.** "About a third of the grid" was
  23.4% when counted, and the comment says 910 of 3,887 because I counted.
- **Most files are CRLF.** An edit script matching `\n` found nothing,
  asserted on the match count, aborted on the first file and left three red
  tests for code that did not exist. Detect the newline and normalise both
  strings to it. Put the script in a file; a bash heredoc holding backticks
  and quotes broke on the first attempt.
- **Supplier ids are unique across sizes.** A fixture that reused one row
  for two sizes failed the second refresh with a constraint error that read
  like a parser bug. Give each size its own id (`S${digits}`).
- **A two-size refresh test needs a coverage row for the second size** now
  that the subset rule exists; `db.recordFailure(size, ...)` is enough.
- **Inline `<code>` inside the `.oi-refresh` paragraph renders as a block**
  at 375px and orphaned a period. Plain prose there. Caught in the audit's
  screenshot, which is why you look at `.forge/shots/` after a copy change.
- **A normaliser that keeps letters breaks bare digits.** `215/60R16`
  compacted to `21560r16`, so typing `2156016` never committed. Caught by my
  own driven check, not by any audit.
- **A half-typed size fell through to the bulk refresh.** With `size` `''`
  the button read `Refresh all 4 sizes with supplier data`; one click would
  have hit the supplier. `sizePending` disables it.
- **Byte-compare before restoring a dirty file.** The shared checkout held
  an uncommitted snapshot identical (sha256) to what another agent had just
  committed; restoring it lost nothing, and I knew that before doing it.
- **Merge main before the review, not after,** so the merge result is what
  gets read. Twice a PR went conflicting between opening and review.
- **The minified bundle writes strings with backticks.** Grepping production
  for `"355"` finds nothing; grep for `25.4` or the band table.

## How to verify

`npm run build`; start `backend/server.mjs` with a throwaway `KMT_OWNER_DB`,
`KMT_SESSION_SECRET`, a 12-plus-character `KMT_OWNER_PASSWORD`, `PORT` and
`KMT_BIND=127.0.0.1`; `node --test backend/*.test.mjs`; `npx eslint src
backend`; then each audit with `AUDIT_BASE` and the password set, reading the
last line each prints, not the exit code. For `/owner` also run
`owner-inventory-audit.mjs` against `node backend/dev.mjs` on 4180 with a
scratch `KMT_OWNER_DB`, and for the filter drive it: type `205/65`, pick
`205/65R15`, confirm the inventory shows one size and the button relabels;
type `2156016`, confirm it commits; type `R`, confirm no match text and no
buttons. Kill by port afterwards and curl it to confirm.

## Harness quirks

- **The browser pane can be hidden**, and then pointer actions time out AND
  `setTimeout` does not fire. Drive the DOM with `javascript_tool` and yield
  with `await Promise.resolve()` a few times between clicks so React
  re-renders; a script that sleeps never returns.
- **`kill $!` did not free a port** for a directly started node server on
  this machine; kill by port from PowerShell after checking the command line.
- **`git show origin/main:path` needs `MSYS_NO_PATHCONV=1`** in Git Bash.
- **The shell's working directory resets** to the repo root or the last
  worktree between calls; use absolute paths.
- **`gh run list --commit <sha>` returns nothing** for the first minute
  after a push, and a cancelled run reads exactly like one that never ran.
  Poll for the run id, then `gh run watch`, then read counts from `gh run
  view --log`.
- **The `Monitor` tool** with a persistent `gh pr view` loop that exits on
  MERGED or CLOSED is the cheap way to wait for another agent's merge.

## Day-one advice no document holds

Anything that can send more than one size to the supplier is a product
decision with a cost attached, and the number is what wins the argument:
"910 page loads at a 1.5-second pause" got the refresh scoped in one
message where "it will be slower" would not have. Flag the consequence with
the count and let the lead decide.

The audits guard the customer flow, not the owner filter. If you change
what the owner types into, you are the audit until you write one.

Read the backend validation before touching the screen that calls it: every
value that reaches `size` or the refresh endpoint is either a supported size
or a 400 a real owner sees on a phone.

Two relayed orders that conflict are not yours to resolve. Stop, say what
you have and have not done, and put it to the user; the cost of asking was
one message both times it happened.
