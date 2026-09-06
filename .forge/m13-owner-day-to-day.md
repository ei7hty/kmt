# m13 — Ken's day-to-day: finding a request, remembering a customer, pricing a size

Written by the OWNER PORTAL ANALYST on 2026-09-06 at main `deb0aed`, on the
PROJECT MANAGER's instruction after the DEV-PRODUCT MANAGER's rulings of the
same day. This is the what and the why of the first post-launch milestone for
the owner portal, and the measurements those rulings were made against, kept
here so they are not taken again. The PROJECT MANAGER turns it into briefs;
the REPO AGENT owns the gate and every merge; product calls stay with the lead
and the user. Nothing in it starts before gate 3 of `sprint-live.md`.

## The goal, in one sentence

Ken opens the owner portal on his phone, finds the request a customer is
calling about in one search, remembers what he told them last time, and
prices a whole size in one action instead of one tire at a time.

## Why this milestone exists

The owner portal today lets Ken act on a request and curate a tire, and
neither screen lets him find anything again. Measured on 2026-09-06 (method
and figures below):

- `/owner/quotes` has no input element. The owner API takes one parameter,
  the status view. A customer who reads the first characters of their status
  link over the phone cannot be matched to a card except by scrolling, and
  the card does not show the request id.
- Nothing links two requests from the same person. The customer key is per
  browser; the email is stored but never searched or grouped. The only free
  text Ken can attach to a request is a cancel reason through a browser
  prompt.
- `/owner` for one size, `215/60R16`, shows 281 supplier tires over 12 pages
  of 24. Each card averages 791 px tall at 375 px wide, so one tire is one
  phone screen; page 1 alone is 27 screens and 24 separate Save buttons.
  Curating that size by hand is 281 saves and roughly 320 screens.
- The first tire on `/owner` began 2,048 px below the top, behind two and a
  half screens of refresh, import and markup controls. The lead moved that
  composition fix into t59 (the tire list first, controls in one collapsed
  panel, shorter cards, first tire within one screen). m13 does not repeat
  it; the per-size table below assumes it has landed.

Card-by-card curation is optional today: the customer catalog composes every
active supplier row at the markup rate automatically, and a per-tire offer is
an override, not a gate (`src/markup.js`, `quotedPrice`). That is why none of
this blocked launch, and why m13 comes after it.

## What m13 delivers, in order

The order is the lead's: search first because it is what Ken needs on the
first phone call, the note second because it needs a schema change, the table
third because it is the largest change to what Ken sees.

### m13.1 Owner request lookup

`GET /api/owner/requests` gains `q`. Matched server-side, owner session only,
against the customer's name, email, phone (normalised, so `617 555 0100`
finds `+16175550100`), the vehicle text and the request id (prefix match, so
the first characters read over the phone are enough). Counts for the five
views stay as they are, computed over the unfiltered list, so the tabs still
say what is waiting whatever was typed. An empty match answers an empty list,
not an error.

UI: one search box above the tabs on `/owner/quotes`; the request id and
"submitted N hours ago" on the card, if t59 has not already added them.

Why the customer-side precedent does not apply: `decisions.md` (2026-09-05)
rejected email-or-phone lookup for **customers** because it makes a phone
number the password. The owner is behind the session; an owner-side search
is exactly the thing that decision left room for.

Acceptance: one backend test per matched field and one for the empty match;
the counts unchanged by `q`; the dead-end audit's owner step still finds its
request with the box empty; `EXPECTED_CHECKS` untouched unless a check is
added.

### m13.2 A note on a request, and who this customer is

A nullable `owner_note` text column on `requests` (limit 2000 characters, the
same as an offer's notes), added through `migrate()` with a test that starts
from the old schema, per the migration contract in `owner-backend.md` and the
NOTES.md rule that a `CREATE TABLE IF NOT EXISTS` change passes every test
and fails on production's first write. Saved through a thin caller over
`moveTo()` in `backend/quotes.mjs` so the version bumps and two owner windows
409 rather than overwrite. The note is Ken's and never reaches the customer
shape (`CUSTOMER_REQUEST_FIELDS` is a list of what a customer read carries;
the note is not on it).

On the card: a textarea with its own Save, and one line of history,
"2 earlier requests from this email", computed from the same rows the list
already holds. Nothing more: accounts stay rejected, and a note is not a
customer record.

Acceptance: the migration test; a version-conflict test; the customer shape
test extended to assert the note is absent; the note visible after reload.

### m13.3 A size as a table, and a size priced in one action

Once a size is committed in the filter, `/owner` shows a compact row per tire
instead of a card: name, supplier price, stock, your price (editable inline),
offered (a toggle). Save is per row, or one Save for the rows changed. Two
per-size actions above the table: **Offer everything in stock at markup**
(writes an enabled offer at the current markup price for every active
in-stock tire of the size that has no offer yet; never overwrites a price Ken
set) and **Clear this size** (disables every offer for the size, prices kept).
Filters become composable (in stock AND not yet chosen) and the list gains a
sort (supplier price, stock, name).

Why: 281 saves for one size, and 545 sizes in the walk file, is not a job
anyone finishes; the markup rule exists because of that, and this is the
screen catching up with it.

Bulk actions are backend routes of their own, transactional, and refused
mid-refresh the way the snapshot import is. Each names its count in the
response ("Offered 203 tires at $52.03 to $184.10") so the screen can say
what happened.

Acceptance: a test that the bulk offer skips priced rows and disabled rows;
a test that clear keeps prices; the owner-inventory audit gains a table check
with `EXPECTED_CHECKS` moved in the same commit; at 375 px the table shows at
least eight rows per screen (against one card per screen today), measured
the way the figures below were.

### m13.4 Small, alongside

- `listForOwner()` keys the catalog by id in a `Map` and filters by status in
  SQL instead of reading every request; invisible at today's volume, cheap
  now. (Held out of m12 by the PROJECT MANAGER for file overlap.)
- Stock and last-seen on the request card (#105): the data is on the
  supplier row; the owner endpoint just does not carry it. Protects the only
  human gate in the flow.
- A 15-second poll on `/status` while the document is visible, customer half
  of #104; the owner half only if Ken asks.
- The native 910-entry size `<select>` inside the Import-from-browser section
  becomes the same type-to-find input the filter uses.

### m13.5 Only when the deep pass lands

A generated column on the supplier name with an index, as a migration, for
the inventory search. Measured below: 10 ms per keystroke at the post-import
count and 34 ms at 25,000 rows, both fine; beyond that it is not, and the
deep pass (2,681 unread pages) is where it stops being fine.

### m13.6 The inventory summary once, not on every page

Recorded on the PROJECT MANAGER's ruling of 2026-09-06, measured by LEAD
FULL STACK under Slow 3G (,
PR #180): every page of  carries the same
, and the summary is most of the response.

| part of one inventory response | raw |
| --- | --- |
| the 24 tire cards asked for | 10 KB |
| , the 910 supported sizes | 11 KB |
| , 511 rows | 72 KB |
| whole response | 98 KB; about 3 KB brotli on a synthetic database, which is a floor, since uniform invented coverage rows compress better than real ones |

Resent on every filter change and every page turn: moving from page 1 to
page 2 of a size re-downloads 83 KB of metadata that did not change to
fetch 10 KB of cards. The same shape as the customer catalog's whole-world
response, in the owner's endpoint; the fix is the same kind, a transfer
question and not a query one. It grows with every size the walk adds (235
sizes remain, and the deep pass is post-launch), and the real wire figure
today is above the 3 KB floor by an amount nobody has measured.

Shape of the fix, for the lanes that own it (LEAD BACKEND DEV and the UI
lane): fetch the summary once, on open and after a save or a job, and let
the list pages travel alone; the coverage list only needs the committed
size's row. Not built during launch week: Ken's measured experience is
fine, and it is an API shape change plus a UI change.

What that measurement also settled, so this milestone is read correctly:
nothing on Ken's side is slow today. Cold  to the password field
is 3.7 s on production (111 KB, four requests, all bundle and brand image,
no data); sign-in to the first tire card is estimated at 1 to 1.5 s;
committing  with its 281 tires reaches the first card in 2.7 s
locally under the same throttle;  with five requests is
1.0 s and 5 KB. m13.1 to m13.3 are about the shape of Ken's work, the
scrolling, the 281 saves and the missing search, not about waiting. The
customer-side pass of the same day is in PR #179 (t61), cited rather than
restated here.

## Out of scope

Pricing logic, tax, disposal, TPMS and valve lines (#94, deferred by the
user); the owner adjusting a quote before sending (t35); accounts of any
kind; a customer record beyond the note and the history line; the seed
writing `'full'` coverage for sizes the snapshot marks complete (a backend
semantics change the PROJECT MANAGER recorded and did not take during the
import week; the wording fix went ahead of it).

## The measurements

Taken 2026-09-06 against a throwaway local server, read-only, nothing on
production. Every number below is from the script's JSON output, not from
reading a screen.

### Method

`backend/dev.mjs` on port 4291 with `KMT_OWNER_DB` pointed at a scratch
file, so the database seeded itself from the tracked snapshot
(`src/data/scraped-tires.json`, 1,083 tires over four sizes, scraped
2026-09-06T02:28Z, every size complete); one TEST request posted into that
scratch database so `/owner/quotes` had a card; Playwright Chromium at
375 × 812, device scale 2; checkout at main `d5c6084`; server stopped and
the port confirmed closed afterwards. The script drove `/owner` as it opens,
typed `215/60R16` into the size filter, then opened `/owner/quotes`, and
read `getBoundingClientRect()` and `scrollHeight` from the DOM. The
screenshots are not tracked (`.forge/shots/` is ignored by design); they
live in the analyst session's scratchpad and are regenerated by the method
above in under a minute.

### `/owner` as it opens (1,083 tires, four sizes)

| measure | value |
| --- | --- |
| page height | 21,378 px |
| top of the filters | 1,672 px |
| top of the first tire card | 2,048 px (2.5 screens at 812 px) |
| results heading | "1083 matching tires" |

### `/owner` with `215/60R16` committed

| measure | value |
| --- | --- |
| results heading | "281 matching tires" |
| pagination | "Page 1 of 12" (24 per page) |
| cards on page 1 | 24 |
| card heights | 780 to 873 px, mean 791 px |
| top of the first card | 2,071 px |
| page 1 height | 21,540 px, 27 screens at 812 px |
| Save buttons on page 1 | 24 |
| saves to curate the size by hand | 281 |

### `/owner/quotes` with one draft

| measure | value |
| --- | --- |
| input elements on the screen | 0 |
| tabs | Open 1 · Needs you 1 · With customer 0 · To fit 0 · Closed 0 |
| card fields | vehicle, tire line with quantity, location, preferred date, contact, draft total, status, three actions |
| request id or age on the card | none |

### The two query paths at the post-import row count

Measured the same day on a scratch database cloned from the tracked snapshot
to each row count (rows are copies of the 1,083 real tires with new ids,
spread over other supported sizes; bytes per tire and the query shapes are
representative, the size distribution is not). Five runs each after a warm
call, Node 24.14, `node:sqlite`.

| supplier rows | `catalog()` | catalog JSON raw / gzip | owner list, search | owner list, by size | `summary()` |
| --- | --- | --- | --- | --- | --- |
| 1,083 (before the import) | 4 ms | 193 KB / 26 KB | 2 ms | 0.4 ms | 0.1 ms |
| 6,169 (after the import) | 22 ms | 1.07 MB / 130 KB | 10 ms | 0.4 ms | 0.5 ms |
| 25,000 (a deep pass, rough) | 88 ms | 4.3 MB / 406 KB | 34 ms | 0.5 ms | 2.3 ms |

On the wire the same day: `GET https://kensmobiletire.com/api/catalog`
answered 200 in 0.13 s with `content-encoding: br` and 35,677 bytes for
1,083 tires; the platform's edge compresses even though `server.mjs` does
not. Neither path is bound by SQLite at any of these counts. The customer's
cost is transfer per visit to `/` (about 200 KB after the import, `no-store`),
which is a caching or sizes-first question and not m13's; the owner's search
is m13.5, and only after the deep pass.

## What this document does not decide

Whether the customer catalog is cached or fetched per size (the customer
lane); whether the seed should honour the snapshot's own `complete` flag
(backend, recorded by the PROJECT MANAGER); the wording of anything Ken
reads, which is the lead's. Anything here that turns out to be wrong should
be re-measured the same way and this file corrected, not argued from memory.
