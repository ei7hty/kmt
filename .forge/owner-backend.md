# Owner inventory backend

## Current scope

The owner curates supplier inventory before any customer catalog integration.
`/owner` is the inventory workspace. The existing browser-local quote demo is
preserved at `/owner/quotes`. Customer tire selection and pricing are unchanged.

The new backend and owner component are separate from the existing scraper CLI.
No changes are needed in `scripts/`, `src/data/scraped-tires.json`, `package.json`,
or `README.md` to run this slice.

## Run locally

Requires Node 24.14 or later (built-in `node:sqlite`) and the existing installed
project dependencies. From the repository/worktree root:

```powershell
node backend/dev.mjs
```

Open http://127.0.0.1:4180/owner . This single command starts the API and Vite on
one origin. Ordinary `npm run dev` starts only the old frontend; the owner screen
then explains that its backend is not connected. `KMT_OWNER_PORT` overrides 4180;
`KMT_OWNER_DB` overrides the database file. Existing Playwright Chromium must be
installed to run live supplier refreshes.

The database defaults to `backend/data/owner.sqlite`, ignored by Git. Copy/back
up that folder with the server stopped. Closing the browser does not lose offers;
restarting the server does not reimport or overwrite existing data. This worktree
uses a dependency junction to the already-installed main checkout; a separate
clone should install the dependencies normally.

## Data contract

- `supplier`: every parsed supplier row, original source metadata, last-seen time,
  and whether it was present in the most recent complete refresh for its size.
- `offers`: owner-selected status, KMT price in integer cents, private notes,
  version and update timestamp, linked by supplier ID. Prices are never inferred
  from supplier prices. A positive price is required to enable an offer.
- `coverage`: limited snapshot versus full refresh, last successful fetch, latest
  failure and attempt timestamp, by size. Missing coverage means never fetched.
- `metadata`: one-time seed marker and latest refresh job/progress. Running jobs
  are marked interrupted on restart; they are not automatically restarted.

The existing JSON snapshot seeds a new database once (24 tires across four sizes).
It is explicitly labelled limited coverage. Supported refresh sizes currently
come from the existing KMT catalog (290 sizes), not from the supplier results or
owner selections. If customer catalog integration replaces that source later,
extract the supported-size list first so missing supplier stock cannot shrink it.

## Owner API

- `GET /api/owner/inventory?search=&size=&filter=all&page=1`: 24 rows per page,
  counts, all supported sizes, coverage and refresh status. Filters: all, offered,
  unselected, available. Unknown stock is not counted as confirmed availability.
- `PUT /api/owner/offers/:id`: `{priceCents, enabled, notes, version}`. Conflicting
  versions return 409 so another window cannot silently overwrite the owner.
- `POST /api/owner/refresh`: `{sizes: ["215/60R16"]}`. Starts one background job;
  concurrent jobs return 409. The UI can send one size or every KMT size.
- `POST /api/owner/refresh/cancel`: `{}`. Stops after the current page; incomplete
  sizes are not applied. The UI polls the inventory endpoint for progress.
- `GET /api/owner/markup`, `PUT /api/owner/markup`: `{rate}`. The default markup,
  stored in `metadata`. Rates below 1 (quoting under supplier cost) or above 10
  (a typo repricing everything) are rejected. Also returned on the inventory
  response as `summary.markup`, so the screen needs no second request.

## Markup versus owner prices

Owner prices are still never inferred from supplier prices: `offers.price_cents`
wins wherever it is set, and nothing here writes to it. Markup only decides what
a tire nobody has priced costs a customer, because there are 290 supported sizes
and pricing each one by hand does not finish. `isPlaceholder` stays true until a
rate is saved, so the customer catalog can mark those prices provisional rather
than presenting a default as a decision that was made.

The default rate and the rule's shape come from `src/markup.js`, imported rather
than restated so the backend and the customer catalog cannot disagree about what
an unconfigured tire costs. Resolution order lives in that module's
`quotedPrice`: an owner price wins, otherwise markup proposes, and a tire the
owner has disabled leaves the customer catalog entirely.

## Supplier refresh behavior

Uses the existing Giga browser fetcher and parser, without modifying their files.
Reads all reported pages, with a 1.5-second minimum pause between page requests;
there is no cheapest-eight filter. A complete size is validated and applied in a
single transaction. Rows not listed anymore are retained as inactive, preserving
owner offers and prices. Previously completed sizes remain saved if a later size
fails. Blocks, unexpected pages, missing prices, repeated pages, empty results and
invalid data stop the job, preserve the failed size and show a reason. Empty
results are conservatively treated as uncertain, never as permission to wipe
inventory. A changing supplier listing is not an atomic inventory feed; stock
and price are last-seen values, not guaranteed purchase terms.

This exposes all fields the existing parser extracts: name, size, supplier price,
list price, availability, stock count, category, segment, description/specs, SKU,
and product link, plus the raw imported fields. It does not claim to extract every
field Giga might show on individual product pages, nor prefetch all 290 sizes.

## Deployment boundary

This is a local backend slice, not a deployable public admin system. It binds to
loopback, rejects unexpected hosts and cross-origin API requests, and keeps DB
files out of Vite's served files. There is no owner login yet. The existing static
Vercel deployment cannot run this persistent SQLite/browser process. Before remote
owner use: add authentication/authorization, choose persistent hosting/database,
and run scraping in a worker appropriate for that environment. Do not expose this
local server or deploy the changed frontend alone as a working owner backend.

## Verification

```powershell
node --test backend/owner.test.mjs
node node_modules/eslint/bin/eslint.js src
node node_modules/vite/bin/vite.js build
# With the owner server running on 4180:
node .forge/owner-inventory-audit.mjs
# The legacy audit reads AUDIT_BASE and otherwise defaults to port 4179. Point it
# at the owner server, or it silently audits whatever else is on 4179 -- it fails
# at the Quote requests step, which reads like a regression and is not one.
$env:AUDIT_BASE="http://127.0.0.1:4180"; node .forge/dead-end-audit.mjs
```

Backend tests cover persistence, protected offer pricing, incomplete refreshes,
all-page traversal, cancellation, restart status, optimistic concurrency, input
validation and origin checks. Browser verification covers save/reload, filters,
owner/quote navigation, customer-home rendering, errors and 375/1280px overflow.
The legacy dead-end audit now follows the visible Quote requests link from the
owner inventory screen, preserving coverage of the existing quote/payment demo.

Live verification: the owner refresh button fetched 70 supplier tires across all
7 listing pages for 185/55R15 on 2026-09-05. This data lives in the local database;
the tracked seed snapshot remains unchanged.
