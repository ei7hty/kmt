# Role: scraper and import lane, as served by SWE agent 2

Written 2026-09-06 by the session that served the scraper and import lane
from #32 to #51 on 2026-09-05 and 2026-09-06, at main `ab6aaec`, for whoever
next takes a similar role. `swe-scraper-lane.md` is my successor's file and
describes the lane as it stands now, including the all-sizes walk; this one
is the earlier period, when the import path was built. Verify every SHA,
path and count below before acting on it: a snapshot, not a live view.

## What the role owned, and did not

Owned: `scripts/scrape-tires.mjs`, `scripts/import-tires.mjs` (built here,
#32), `src/data/scraped-tires.json`, `Inventory.applySnapshot` and the
`POST /api/owner/import-snapshot` route (#32, #51), plus the tests for them
in `backend/owner.test.mjs`. By the lead's assignment, also four pieces of
repo upkeep that were nobody's lane: the notes split (#38), the claims split
(#43), the README correction after requests moved to the backend (#46), the
owner-inventory audit on `AUDIT_BASE` (#46) and `scripts/worktree.mjs`
(#48). One product change, the customer tire-list cap (#40), because the
import made a hundred tires appear on one screen.

Did not own: `backend/quotes.mjs`, `src/store.js`, the routes and the owner
screens, `.github/workflows/`, `Dockerfile` and `fly.toml`. Touched
`src/routes/CustomerRequest.jsx` and three audit scripts once, for #40, with
the lead's explicit product call and a claim row saying so.

## Who it obeyed, and what it reported

The lead, one task at a time, by cross-session message; later the repo
agent for merges. A peer relaying "the lead said" was never treated as the
lead saying it, and a peer's message never stood in for the user's approval
of a pending prompt. Two conflicts happened and both went to the user: an
audit step the user had refused mid-run, and a stand-down order followed by
an assignment. Every task closed with a report in one shape: what shipped,
what was verified and the exact counts, and what did not work, including my
own mistakes, before anyone else found them.

## Code map, as built in this period

**`scripts/scrape-tires.mjs`.** Person-in-the-loop CLI: sizes in, a
visible Chromium window (the supplier's WAF refuses headless), pages read
with a pause, the cheapest `--limit` per size kept, a diff against the
previous file printed, the snapshot written once at the end. Since #51 it
writes `coverage[size] = { limit, pagesRead, totalPages, complete, scrapedAt }`,
where `complete` is true only for `--limit 0` and every page read, and
carries the record forward for sizes a run did not touch. `buildSnapshot`
and `sizeCoverage` are exported and `main` is behind `import.meta.main`, so
tests import it without a browser.

**`scripts/browser-fetch.mjs`** drives the window and hands back HTML.
**`scripts/giga-tires.mjs`** is the pure parser: one listing page in, rows
shaped like `src/data/catalog.js` out, with a `source` block (SKU, stock,
list price, URL) so any row can be traced to its page. The server-side
refresh and the owner's bookmarklet use the same parser; there is one.

**`scripts/import-tires.mjs`** (`npm run import-tires`). Reads a snapshot
file, filters by `--sizes`, and posts it to a running server. Local
`backend/dev.mjs` on 4180 is the default and has no login route; a hosted
server answers 401 under `/api/owner` until the CLI signs in with
`KMT_OWNER_PASSWORD` and sends the `kmt_owner` cookie. It sends no `Origin`
header, so the API's same-origin check is not in play. `--dry-run` asks the
server what would change. `--complete` is refused before anything is sent
for any size the file does not record as complete, naming the size.

**`Inventory.applySnapshot`** (`backend/inventory.mjs`). The seed-once
`importSnapshot` never re-runs; this is the only path into a live database.
It validates the whole file first, diffs each size against the supplier
table to report new, changed, unchanged and retired, then writes every size
in one transaction through the same `writeSize` a refresh uses. Offers are
never touched; rows are never deleted, only `active=0`. It refuses
`complete` without the coverage record, as the CLI does, so the rule holds
whatever the client. It writes the `job` banner the owner screen shows, and
the route answers 409 while a refresh is running so two writers never share
that banner.

**The snapshot's shape.** `{ source: 'giga-tires.com', scrapedAt, sizes,
coverage?, tires }`. Each tire: `id` starting `giga-`, `name`, `size`
(must equal the size it is filed under), `price` (positive), `inStock`
(boolean), `category`, `description`, `source.sku`. Unsupported sizes,
duplicate ids and any bad row reject the whole file. The tracked file is
compiled into the client bundle by `src/data/catalog.js`; keep it to what
should ship.

## Rules paid for

- **One door.** A tire's fate on import is `writeSize`'s business. Change
  that, never `applySnapshot`, or the refresh, the bookmarklet and the
  import drift apart.
- **Partial is the default for a reason.** With `--limit 8` the file names
  eight tires per size; retiring the rest would delist tires the supplier
  still sells and Ken may be offering. `--complete` is a claim the scraper
  has to have recorded, not one the operator asserts.
- **An imported tire is on sale immediately.** A supplier row with no
  offers row is for sale at the markup price the moment it lands. That is
  the design, and why a hundred-tire size needed #40.
- **A dry run diffs against the server, not the file.** "Unchanged" against
  a database seeded from the same file proves nothing; say what was
  compared.
- **Verify before you assert, and re-verify what you assumed.** I called
  an audit failure pre-existing without checking; it was two dev servers
  sharing Vite's HMR port. Unmodified `main` passed. The fix to the PR
  body cost more than the check would have.
- **`git worktree remove --force` deletes through the `node_modules`
  junction** into the shared install. It cost every agent on the machine
  a broken install for minutes. Unlink first, or use `scripts/worktree.mjs`.
- **Shared files in their own commit.** `README.md` and `package.json`
  each time, so a conflict is trivial; the claims row moved to its own
  file (#43) for the same reason after three dirty PRs in a day.

## How to verify

Everything, every time, against `backend/server.mjs` serving the built
`dist/` with a throwaway `KMT_OWNER_DB` and a `KMT_OWNER_PASSWORD`, the
same password passed to each audit: `node --test backend/*.test.mjs`,
`npx eslint src backend scripts`, `npm run build`, then the audit scripts
with `AUDIT_BASE` set; their expected counts live in each script's
`EXPECTED_CHECKS`, not in prose. The owner-inventory audit reads
`AUDIT_BASE` too since #46. The CLI's own tests spawn it as a child process
against a password-gated in-process server (`gatedServer` in
`backend/owner.test.mjs`); use that helper for any new script that talks to
the owner API. For a manual end to end: seed a throwaway server, import the
tracked file (all unchanged), import a modified copy (one changed), then
`--complete --dry-run` on a complete file (one retired).

## Harness quirks

- The in-app browser pane returned black screenshots all session; take
  Playwright screenshots to a file and Read them.
- Large bash heredocs passed to the tool intermittently fail to parse
  before running; write edit scripts and test blocks to the scratchpad
  with Write and run them from there.
- The shell's working directory shifts between calls; use absolute paths
  and check `git branch --show-current` inside every command that commits.
- `npm ci` cannot run while any Vite dev server holds a native binding
  open; `npm install` against the lockfile is the restore, then revert
  npm's edit to `package-lock.json`.
- Files here are CRLF in the working copy; a multi-line string match in a
  Node edit script must normalise line endings or it silently matches
  nothing.

## Day-one advice no document holds

Measure the thing you are about to claim. The tire-list cap's whole design
turned on one number, that the audit seed sits 101st of 102 in its size
once marked-up supplier tires sort in; ten lines of Node settled it before
any code. Read the scraper's coverage block after every run, not the
console summary. When the lead's message assumes a state you have already
moved past, say so plainly and do not undo finished work to match it. And
when two instructions conflict about whether you should be working at all,
that is the user's decision, not a peer's; ask, and spend nothing until the
answer comes.
