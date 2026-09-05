# KMT Tire Quoting

Automated draft quotes for Ken's Mobile Tire (KMT), a mobile tire service in
the Everett, MA area. A customer picks a tire size and a tire, describes the
vehicle and where it is parked, and gets a draft quote on the spot. The owner
reviews the draft, approves or rejects it, and the customer pays. Behind that,
a separate owner workspace lets the owner build KMT's tire offering from a
supplier's live listings and set his own prices.

Live at **https://kmt.fly.dev** (the older Vercel URL redirects there).

> Several agents work on this repository at once and cannot message each
> other. If you are one of them, read [`.forge/AGENTS.md`](.forge/AGENTS.md)
> before touching anything.

## What is real and what is a demo

| Area | Today |
| --- | --- |
| Customer flow (`/`, `/status`, `/confirmation`) | Working demo. Requests, draft quotes and payments live in the browser's `localStorage`; payment always succeeds. |
| Quote review (`/owner/quotes`) | Same browser-local demo state, seen from the owner's side. |
| Owner inventory (`/owner`) | Real. SQLite database, supplier refresh from giga-tires.com, per-tire owner prices, a default markup rule. Password-protected when hosted. |
| Tire catalog the customer sees | Assembled from three sources: six seed tires, the scraped supplier snapshot, and generated coverage for every other plausible size. Prices come from a placeholder markup over supplier cost. The owner's real inventory does **not** reach the customer yet; that is the next phase. |
| Hosting | Real. One container on Fly.io serving the built frontend and the owner API from a single origin, deployed from CI. |

## Getting started

Node **24 or later** is required. The owner backend uses `node:sqlite`, which
does not exist in earlier versions.

```bash
npm install
```

Two ways to run it locally:

```bash
npm run dev
```

Frontend only, on Vite's default port. `/owner` will say its backend is not
connected.

```bash
node backend/dev.mjs
```

Frontend and owner API together at http://127.0.0.1:4180. This is the one to
use for anything involving `/owner`. It runs Vite in middleware mode behind the
API so both share one origin, binds to loopback only, and needs no password.
`KMT_OWNER_PORT` overrides the port and `KMT_OWNER_DB` the database path
(default `backend/data/owner.sqlite`, ignored by Git). The database is seeded
once from `src/data/scraped-tires.json`; restarting never reimports over saved
offers.

## Screens

| Route | Who | What |
| --- | --- | --- |
| `/` | Customer | Landing page and a three-step order wizard: pick a tire size (width, ratio, diameter), pick a tire and describe the vehicle, then give the service location and preferred date. Submitting saves the request and drafts a quote immediately. |
| `/status` | Customer | Every request with its position in Requested, Owner review, Pay & confirm. An approved quote has a Pay button. |
| `/confirmation?quoteId=…` | Customer | The paid end state. |
| `/owner` | Owner | The inventory workspace: supplier tires by size, refresh from the supplier, choose what KMT offers, set a price per tire, set the default markup. Requires the owner backend. |
| `/owner/quotes` | Owner | The drafted quotes, each with Approve & Send and Reject. Quotes needing attention are flagged as exceptions in amber. Reads `localStorage`, so it works without the backend. |

Routing is a `pathname` switch in `src/App.jsx`; there is no router library.
Every screen has a visible way forward, and `.forge/dead-end-audit.mjs` proves
it.

## How a quote is priced

`src/pricing.js` drafts a quote from a request: the tire's price plus a flat
mobile installation fee. It marks the quote an **exception** for owner review
when the tire is out of stock, when the tire is an off-road category, or when
the vehicle reads as a truck, pickup, van or SUV. Exceptions still get a quote;
they are just not auto-sendable.

The tire's price comes from `src/data/catalog.js`, which assembles the catalog
from three sources in order of how real they are:

1. **Seed tires.** Six hand-written rows, kept verbatim because the audit
   scripts select them by name.
2. **Scraped tires.** Real rows from `src/data/scraped-tires.json`, priced
   through `src/markup.js`. Real rows displace generated ones for the sizes
   they cover.
3. **Generated tires.** A few invented models per size for every plausible
   fitment in `src/data/fitment.js`, so a completed size selection always
   lands on tires.

`src/markup.js` is the boundary between what the supplier charges and what KMT
charges. An owner price for a specific tire wins outright; otherwise a markup
rate proposes a price; a tire the owner has disabled leaves the customer
catalog. The shipped rate is a placeholder, flagged as such, and is not the
owner's number. The backend imports the same module so the two cannot disagree.

## The owner backend

`backend/` is a small Node server over SQLite. It stores every parsed supplier
row, the owner's offer for each (price in integer cents, enabled, notes), and
per-size coverage. Owner prices are never inferred from supplier prices.

| Endpoint | Does |
| --- | --- |
| `GET /api/owner/inventory?search=&size=&filter=&page=` | 24 rows per page plus counts, supported sizes, coverage, refresh status and the markup rule. |
| `PUT /api/owner/offers/:id` | Save `{priceCents, enabled, notes, version}`. A stale `version` gets 409. |
| `GET` / `PUT /api/owner/markup` | Read or set the default markup `{rate}`. Rates below 1 or above 10 are rejected. |
| `POST /api/owner/refresh` | Start a background supplier refresh for `{sizes}`. One job at a time. |
| `POST /api/owner/refresh/cancel` | Stop after the current page. Incomplete sizes are not applied. |
| `POST /api/owner/import-snapshot` | Apply a scraped snapshot `{snapshot, complete, dryRun}` to the live database. What `scripts/import-tires.mjs` calls. Refused while a refresh is running. |
| `POST /api/owner/login`, `POST /api/owner/logout`, `GET /api/owner/session` | Hosted server only. |

A refresh drives a **visible** Chromium window through Playwright, reads every
listing page for a size with a pause between pages, and applies a complete size
in one transaction. Anything unexpected (a challenge page, a missing price, a
repeated page, an empty result) stops the job and keeps the previous inventory.
Tires that disappear from the supplier stay in the database as inactive with
their owner offers intact. Nothing is scheduled: refreshes are started by hand
from `/owner`.

There are two entry points. `backend/dev.mjs` is local development, described
above. `backend/server.mjs` is the hosted one: it serves the built `dist/` and
the API, binds a real interface, and refuses to start without
`KMT_OWNER_PASSWORD`. The password guards the API, not the pages: the customer
flow is public and `/owner/quotes` never contacts the server.

The full design, data contract and refresh rules are in
[`.forge/owner-backend.md`](.forge/owner-backend.md).

## Updating the tire catalog snapshot

`scripts/scrape-tires.mjs` pulls real tires from giga-tires.com into a
reviewable JSON snapshot at `src/data/scraped-tires.json`. The owner backend
uses the same fetcher and parser for its live refreshes, but this CLI is what
updates the tracked snapshot that seeds a new database and feeds the customer
catalog.

```bash
npm run scrape-tires -- 215/60R16 225/50R17 --limit 6
```

```bash
npm run scrape-tires -- 215/60R16 --dry-run
```

```bash
npm run scrape-tires -- --help
```

It is a person-in-the-loop tool, not a scheduled job. It writes a snapshot and
prints a diff (added, removed, repriced, back in or out of stock); it never
touches `src/data/catalog.js`. A dry run prints the report and writes nothing.
A run over one size updates that size and leaves the rest of the snapshot
alone. Pass `--replace` to drop sizes the run did not cover.

### Why it opens a browser window

giga-tires.com sits behind AWS WAF. A plain HTTP request gets a challenge page
and a *headless* browser is refused outright, so the scraper drives an ordinary
visible browser instead and reads pages the way a person would. There is no
stealth plugin, no spoofed user agent and no token replay: if the site decides
to turn this away, it should be able to.

What keeps that reasonable is staying small and honest: one window, one page
at a time, a pause between requests, and only the `/tires/` paths their
robots.txt allows. It is not built to run unattended or at volume. If KMT ends
up wanting this regularly, the right move is to ask giga-tires for a dealer
feed rather than to scrape harder.

Rows come out in the shape `src/data/catalog.js` uses (`id`, `name`, `size`,
`price`, `inStock`, `category`, `description`) plus a `source` block holding
the SKU, stock count, list price and product URL, so any row can be traced back
to the page it came from.

### Pushing a scrape into a running server

The snapshot seeds a new database once and is otherwise never read again, so
on its own a local scrape never reaches a server that is already up. This does:
scrape on the machine with the screen and the home connection, then push the
file to whichever server should have it.

```bash
npm run scrape-tires -- 215/60R16 --limit 0 --pages 10
```

```bash
npm run import-tires -- --dry-run
```

```bash
npm run import-tires
```

```bash
KMT_OWNER_PASSWORD='...' npm run import-tires -- --to https://kmt.fly.dev
```

The local server (`node backend/dev.mjs` on port 4180) is the default target
and needs no password. The hosted one takes the owner password from the
environment, signs in the way the owner screen does, and never stores it.
`--sizes 215/60R16,225/50R17` sends only those sizes; a path argument imports
a snapshot kept somewhere other than `src/data/scraped-tires.json`.

An import writes through the same door a supplier refresh uses: owner prices,
choices and notes are untouched, and nothing is ever deleted. A dry run reports
new, changed and unchanged tires per size and writes nothing. By default a
size is treated as a **partial** view, because the scraper keeps only the
cheapest few per size, so tires the file does not mention stay listed. Pass
`--complete` only for a scrape run with `--limit 0` over every page: then
tires missing from the file are marked no longer listed, as a refresh would,
with their offers kept. The result shows on `/owner` like any refresh.

```bash
npm run import-tires -- --help
```

## Verification

Nothing is done until these pass. CI runs the first three on every push to
`main` and on every pull request.

```bash
node --test backend/owner.test.mjs
```

```bash
npx eslint src backend
```

```bash
npm run build
```

The browser audits need a running app. They all read `AUDIT_BASE`, and each
falls back to a **different** default port, so always set it explicitly, and
check what is actually listening there before believing a result either way.

```bash
AUDIT_BASE=http://localhost:4173 node .forge/dead-end-audit.mjs
```

The full click path at phone and desktop widths, including the exception
branch.

```bash
AUDIT_BASE=http://localhost:4173 node .forge/responsive-check.mjs
```

No horizontal overflow on any screen at 375px and 1280px.

```bash
AUDIT_BASE=http://localhost:4173 node .forge/request-flow-check.mjs
```

Vehicle and service-location entry, validation, back navigation, and the
submitted data reaching the owner.

```bash
node .forge/owner-inventory-audit.mjs
```

The `/owner` workspace: save, reload, filters and navigation. Expects
`node backend/dev.mjs` on port 4180.

Run the dead-end audit against the live URL before calling a deploy good. This
project has already shipped a build that passed every local check and 404'd in
production on a missing SPA fallback.

## Deployment

Pushing to `main` runs `.github/workflows/fly-deploy.yml`: tests, lint and
build first; deploy to Fly only if they pass; then the three browser audits
against https://kmt.fly.dev. Nothing deploys from any other branch or from a
pull request.

The `Dockerfile` is host-agnostic: a Node 24 image with Chromium and Xvfb
(supplier refreshes need a headful browser even on a server), listening on
`$PORT`, with the database on a volume at `/data`. `fly.toml` is the Fly half:
one machine, kept running, 1 GB of memory for the browser. Do not run more than
one machine; a Fly volume attaches to one, and a second machine would get a
second, empty database.

Environment for the hosted server:

| Variable | |
| --- | --- |
| `KMT_OWNER_PASSWORD` | **Required.** The server exits without it. |
| `KMT_SESSION_SECRET` | Recommended. Otherwise sessions are signed with a per-boot secret and every restart signs the owner out. |
| `KMT_OWNER_DB` | SQLite path. Point it at the volume. |
| `PORT`, `KMT_BIND` | Default `8080` and `0.0.0.0`. |
| `KMT_ALLOWED_HOSTS` | Comma-separated hostnames to accept. Unset accepts any. |
| `KMT_SESSION_HOURS` | Session lifetime, default 12. |

First-time Fly setup, `fly launch` pitfalls and the Docker commands are in
[`.forge/owner-backend.md`](.forge/owner-backend.md). Whether supplier
refreshes work from a datacenter IP is unproven; if they come back blocked, run
the scraper from a home connection and treat the host as serving-only.

## Layout

| Path | Job |
| --- | --- |
| `src/App.jsx`, `src/App.css` | The customer flow and the quote screens, all routes in one file. `src/RequestFlow.css` styles the vehicle and service-location steps. |
| `src/components/RequestDetails.jsx` | Vehicle entry and service-location sections of the order wizard. |
| `src/owner/OwnerInventory.jsx` | The `/owner` inventory workspace, including the hosted sign-in gate. |
| `src/store.js` | The `localStorage` store for requests and quotes. |
| `src/pricing.js` | Draft quote and exception rules. |
| `src/markup.js` | Supplier price to KMT price: owner override, markup rule, disabled tires. |
| `src/data/catalog.js` | Assembles the catalog from seeds, the scraped snapshot and generated coverage. |
| `src/data/fitment.js` | The width, ratio and diameter ranges the size selector offers. |
| `src/data/scraped-tires.json` | The tracked supplier snapshot. Written by the scraper, read by the catalog and used to seed a new owner database. |
| `backend/inventory.mjs` | SQLite schema, offers, markup, coverage, snapshot import. |
| `backend/refresh.mjs` | The background supplier refresh job. |
| `backend/api.mjs` | The owner HTTP API. |
| `backend/auth.mjs` | Password gate and signed session cookie for the hosted server. |
| `backend/dev.mjs`, `backend/server.mjs` | Local and hosted entry points. |
| `backend/owner.test.mjs` | Backend tests, run with `node --test`. |
| `scripts/scrape-tires.mjs` | Snapshot CLI: arguments, the run loop, the diff. |
| `scripts/import-tires.mjs` | Pushes a snapshot into a running owner server, local or hosted. |
| `scripts/giga-tires.mjs` | Parsing and normalising one supplier listing page. Pure, so it can be tested on saved HTML. |
| `scripts/browser-fetch.mjs` | Fetching pages through a real browser. |
| `.forge/` | Project record: requirements, roadmap, decisions, task state, the owner-backend design, the audit scripts, and the protocol for agents sharing this repo. |
| `Dockerfile`, `fly.toml`, `.github/workflows/fly-deploy.yml` | Container image, Fly config, CI. |
| `vercel.json` | Redirects the old Vercel deployment to Fly. |

## Product record

The reasoning behind the product lives in `.forge/`, which the planning tool
(forge) and people both maintain:

- [`project.md`](.forge/project.md): what this is, who it is for, the phase
  scopes, and what is faked versus real.
- [`requirements.md`](.forge/requirements.md): testable requirements per phase.
- [`roadmap.md`](.forge/roadmap.md): milestones and why they are in that order.
- [`decisions.md`](.forge/decisions.md): architecture decisions, append-only.
- [`owner-backend.md`](.forge/owner-backend.md): the inventory backend, its
  data contract, and how to host it.
- [`state.json`](.forge/state.json): task status.

Phases 1 to 3 are done: the clickable prototype, the visual refinement, and
the owner's curated inventory reaching the customer. Phase 4, moving requests
and quotes out of the browser into the backend so the owner reviews from any
device, is planned in `.forge/` as milestone m9 and not yet started.
