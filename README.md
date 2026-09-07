# KMT Tire Quoting

Automated draft quotes for Ken's Mobile Tire (KMT), a mobile tire service in
Malden, MA and Greater Boston. A customer picks a tire size and a tire,
describes the vehicle and where it is parked, and gets a draft quote on the
spot. The owner reviews the draft, sends or declines it, the customer pays,
and the owner marks the job fitted. Behind that, a separate owner workspace
lets the owner build KMT's tire offering from a supplier's live listings and
set his own prices.

Live at **https://kensmobiletire.com** (Ken's own domain, on Fly.io; `kmt.fly.dev`
and the older Vercel URL still answer and will redirect there).

> Several agents work on this repository at once and cannot message each
> other. If you are one of them, read [`.forge/AGENTS.md`](.forge/AGENTS.md)
> before touching anything.

## What is real and what is a demo

| Area | Today |
| --- | --- |
| Customer flow (`/`, `/status`, `/confirmation`) | Real. Requests and draft quotes are stored by the backend and drafted server-side by the pricing rules. `/status` lists this device's requests by its per-browser key, or opens one by id from a link. Payment is still a fake step that always succeeds, recorded by the backend. |
| Quote review (`/owner/quotes`) | Real. Reads the same requests from the API, grouped into Open, Needs you, With customer, To fit and Closed views; approving, declining, cancelling and marking done write back. Needs the owner sign-in when hosted. |
| Owner inventory (`/owner`) | Real. SQLite database, supplier refresh from giga-tires.com, per-tire owner prices, a default markup rule. Password-protected when hosted. |
| Tire catalog the customer sees | Real when the backend answers: the owner's enabled tires at his price or the markup price, composed into the static catalog (seed tires, the scraped snapshot, generated coverage for every other plausible size). The static catalog alone when it does not. The markup rate is still a placeholder, not the owner's number. |
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

Frontend only, on Vite's default port. Sizes and tires browse from the static
catalog, but submitting a request fails with the shop's phone number, and
`/owner` and `/owner/quotes` say their backend is not connected.

```bash
node backend/dev.mjs
```

Frontend and owner API together at http://127.0.0.1:4180. This is the one to
use for anything involving `/owner`. It runs Vite in middleware mode behind the
API so both share one origin, binds to loopback only, and needs no password.
`KMT_OWNER_PORT` overrides the port and `KMT_OWNER_DB` the database path
(default `backend/data/owner.sqlite`, ignored by Git). The database is seeded
once from `src/data/scraped-tires.json`; restarting never reimports over saved
offers. The same file holds every request, draft quote and payment.

## Screens

| Route | Who | What |
| --- | --- | --- |
| `/` | Customer | Landing page and a three-step order wizard: pick a tire size (width, ratio, diameter), pick a tire and describe the vehicle, then give the service location and preferred date. Submitting sends the request to the backend, which drafts the quote and answers with it. |
| `/status` | Customer | The requests made from this device, found by its per-browser key, each with its position in Requested, Owner review, Pay & confirm, Fitted. `?request=<id>` opens that one request from any device. Sent or approved quotes have a Pay button; unpaid live requests can be cancelled. |
| `/confirmation?request=…` | Customer | The paid end state. |
| `/owner` | Owner | The inventory workspace: supplier tires by size, refresh from the supplier, choose what KMT offers, set a price per tire, set the default markup. Requires the owner backend. |
| `/owner/quotes` | Owner | Submitted quotes grouped by `?view=`: Open, Needs you, With customer, To fit and Closed. Drafts can be adjusted, sent, declined or cancelled; paid requests can be marked done. Quotes needing attention are flagged as exceptions in amber. Reads the API; needs the owner sign-in when hosted. |

Routing is a `pathname` switch in `src/App.jsx` over the screens in
`src/routes/`; there is no router library.
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
row, the owner's offer for each (price in integer cents, enabled, notes),
per-size coverage, and every customer request with its draft quote, the
owner's decision and its payment state. Owner prices are never inferred from
supplier prices.

| Endpoint | Does |
| --- | --- |
| `GET /api/owner/inventory?search=&size=&filter=&page=` | 24 rows per page plus counts, supported sizes, coverage, refresh status and the markup rule. |
| `PUT /api/owner/offers/:id` | Save `{priceCents, enabled, notes, version}`. A stale `version` gets 409. |
| `GET` / `PUT /api/owner/markup` | Read or set the default markup `{rate}`. Rates below 1 or above 10 are rejected. |
| `POST /api/owner/refresh` | Start a background supplier refresh for `{sizes}`. One job at a time. |
| `POST /api/owner/refresh/cancel` | Stop after the current page. Incomplete sizes are not applied. |
| `POST /api/owner/import-snapshot` | Apply a scraped snapshot `{snapshot, complete, dryRun}` to the live database. What `scripts/import-tires.mjs` calls. Refused while a refresh is running. |
| `GET /api/owner/requests?view=` | One owner quote view plus counts for every view. Views are `open` (default), `attention`, `awaiting`, `paid` and `closed`. |
| `POST /api/owner/quotes/:id/approve`, `.../reject`, `.../done`, `.../cancel` | The owner's quote transition, with `{version}` and optional `{reason}` where the action asks for one; a stale version gets 409. |
| `POST /api/owner/login`, `POST /api/owner/logout`, `GET /api/owner/session` | Hosted server only. |

Four routes are public, because a customer never signs in; they are named in
an allow-list in `backend/api.mjs` and everything else under `/api/` is
refused without a session:

| Endpoint | Does |
| --- | --- |
| `GET /api/catalog` | What a customer may be shown: offered tires at KMT's price, never the supplier's. |
| `POST /api/requests` | Submit a request with this browser's customer key; the server drafts the quote and answers with it. |
| `GET /api/requests?customer=<key>`, `GET /api/requests/:id` | This device's requests, or one request by its unguessable id. |
| `POST /api/requests/:id/pay`, `.../cancel` | The customer's public quote actions: fake payment for a sent quote, or cancellation before any money has moved. |

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
either both Google client variables or a valid `KMT_OWNER_PASSWORD`. Owner
authentication guards the API, not the pages: the customer flow and its public
routes need no sign-in, and `/owner` and `/owner/quotes` show the available
sign-in controls when their API answers 401.

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

Product-page enrichment is opt-in and always bounded. It keeps image URLs and
product metadata in the private supplier payload; the customer API continues
to project only its existing allow-listed fields.

```bash
# One known product URL, without crawling its size
npm run scrape-tires -- --product-url https://www.giga-tires.com/tires/.../tirecode/... --enrich-limit 1

# Enrich the rows found for one size
npm run scrape-tires -- 215/60R16 --enrich-products --enrich-limit 8

# A deliberately small batch, with explicit pacing
npm run scrape-tires -- 215/60R16 225/50R17 --enrich-products \
  --enrich-limit 12 --concurrency 2 --product-delay 2000
```

`--enrich-limit` accepts 1–50 and `--concurrency` accepts 1–4. A direct product
URL replaces that product in the snapshot while preserving every other tire,
including other tires of the same size. No image is downloaded or hotlinked by
this command.

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

Running this across all 910 selector sizes rather than a handful is a
monthly process, not a single command -- see
[`docs/supplier-refresh.md`](docs/supplier-refresh.md) for the batch order,
time expectations and the checks to run before each batch ships.

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
KMT_OWNER_PASSWORD='...' npm run import-tires -- --to https://kensmobiletire.com
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
cheapest few per size, so tires the file does not mention stay listed.
`--complete` marks tires missing from the file as no longer listed, as a
refresh would, with their offers kept. The scraper records per size whether it
read everything (`--limit 0`, every page), and both the CLI and the server
refuse `--complete` for any size the file does not record as read in full,
naming the size; a snapshot from before that record existed counts as
partial. The result shows on `/owner` like any refresh.

```bash
npm run import-tires -- --help
```

## Verification

Nothing is done until these pass. CI runs the first three on every push to
`main` and on every pull request.

```bash
node --test backend/*.test.mjs
```

```bash
npx eslint .
```

```bash
npm run build
```

The browser audits need a running app. They all read `AUDIT_BASE`, and each
falls back to a **different** default port, so always set it explicitly, and
check what is actually listening there before believing a result either way.
Run them against `backend/server.mjs`, the hosted shape CI uses: build, start
it with a throwaway `KMT_OWNER_DB` and a `KMT_OWNER_PASSWORD`, and pass that
password to each audit so it can sign in at the owner step. A local
`backend/dev.mjs` works too and never asks for one.

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

The `/owner` workspace: save, reload, filters and navigation. Reads
`AUDIT_BASE` like the others, falling back to `node backend/dev.mjs` on port
4180, and signs in with `KMT_OWNER_PASSWORD` when the server asks.

Run the dead-end audit against the live URL before calling a deploy good. This
project has already shipped a build that passed every local check and 404'd in
production on a missing SPA fallback.

## Deployment

Pushing to `main` runs `.github/workflows/fly-deploy.yml`: tests, lint and
build first, with the three flow audits against a throwaway database; deploy to
Fly only if they pass; then `.forge/deployed-site-check.mjs`, a read-only check
of the live site that never posts or signs in, because the flow audits
would leave fabricated, paid requests in the owner's list. Nothing deploys from
any other branch or from a pull request.

The `Dockerfile` is host-agnostic: a Node 24 image with Chromium and Xvfb
(supplier refreshes need a headful browser even on a server), listening on
`$PORT`, with the database on a volume at `/data`. `fly.toml` is the Fly half:
one machine, kept running, 1 GB of memory for the browser. Do not run more than
one machine; a Fly volume attaches to one, and a second machine would get a
second, empty database.

Environment for the hosted server:

| Variable | |
| --- | --- |
| `KMT_OWNER_PASSWORD` | Optional only when both Google client variables are configured; otherwise required and at least 12 characters. Keep it during the cutover. After this support is deployed, complete another successful production Google login before removing the password secret as a separate operation. |
| `KMT_GOOGLE_CLIENT_ID`, `KMT_GOOGLE_CLIENT_SECRET` | Together enable Google owner sign-in; one without the other refuses to boot. With both set, the hosted server can run Google-only and the owner screen hides password controls when no password is configured. |
| `KMT_SESSION_SECRET` | Recommended. Otherwise sessions are signed with a per-boot secret and every restart signs the owner out. |
| `KMT_OWNER_DB` | SQLite path. Point it at the volume. |
| `PORT`, `KMT_BIND` | Default `8080` and `0.0.0.0`. |
| `KMT_ALLOWED_HOSTS` | Comma-separated hostnames to accept. Unset accepts any. |
| `KMT_SESSION_HOURS` | Session lifetime, default 12. |
| `KMT_MAIL_SMTP_HOST` | Where mail is sent through: the owner's Google Workspace, `smtp-relay.gmail.com` (default when any SMTP setting is present) or `smtp.gmail.com`. With no SMTP setting at all the server sends nothing and records every message in the outbox as `queued` (R25). |
| `KMT_MAIL_SMTP_PORT` | Default `587` (STARTTLS); `465` is implicit TLS. |
| `KMT_MAIL_SMTP_USER`, `KMT_MAIL_SMTP_PASSWORD` | Together or not at all: the mailbox and its App Password, or the relay credential. Unset for an IP-allow-listed relay. The password is set by the owner as a Fly secret and read by nothing else. |
| `KMT_MAIL_FROM` | Required with any SMTP setting: a mailbox that authenticates on the sending server (for Gmail, the `KMT_MAIL_SMTP_USER` mailbox). Until the domain has SPF and DKIM, a domain address sent through another provider fails authentication silently, filed as spam while the outbox says sent. |
| `KMT_OWNER_EMAIL` | Required with any SMTP setting: where the owner's copy goes and what customers reply to. |
| `KMT_PUBLIC_ORIGIN` | The origin links in emails point at. Unset, `https://` plus `KMT_CANONICAL_HOST`. |

First-time Fly setup, `fly launch` pitfalls and the Docker commands are in
[`.forge/owner-backend.md`](.forge/owner-backend.md). Whether supplier
refreshes work from a datacenter IP is unproven; if they come back blocked, run
the scraper from a home connection and treat the host as serving-only.

## Layout

| Path | Job |
| --- | --- |
| `src/App.jsx`, `src/App.css` | The route switch and the shared styles. `src/RequestFlow.css` styles the vehicle and service-location steps. |
| `src/routes/` | One file per screen: the customer flow, `/status`, `/confirmation` and the owner's quote list. |
| `src/components/RequestDetails.jsx` | Vehicle entry and service-location sections of the order wizard. |
| `src/owner/OwnerInventory.jsx` | The `/owner` inventory workspace, including the hosted sign-in gate. |
| `src/store.js` | The API client for requests, quotes and payment. The only thing it keeps in the browser is the per-device customer key. |
| `src/pricing.js` | Draft quote and exception rules. |
| `src/markup.js` | Supplier price to KMT price: owner override, markup rule, disabled tires. |
| `src/data/catalog.js` | Assembles the catalog from seeds, the scraped snapshot and generated coverage. |
| `src/data/fitment.js` | The width, ratio and diameter ranges the size selector offers. |
| `src/data/scraped-tires.json` | The tracked supplier snapshot. Written by the scraper, read by the catalog and used to seed a new owner database. |
| `backend/inventory.mjs` | SQLite schema, offers, markup, coverage, snapshot import. |
| `backend/quotes.mjs` | Requests, draft quotes, the owner's decisions and payment, in the same database. |
| `backend/refresh.mjs` | The background supplier refresh job. |
| `backend/api.mjs` | The owner HTTP API. |
| `backend/auth.mjs` | Password gate and signed session cookie for the hosted server. |
| `backend/dev.mjs`, `backend/server.mjs` | Local and hosted entry points. |
| `backend/*.test.mjs` | Backend tests, run with `node --test backend/*.test.mjs`. |
| `scripts/scrape-tires.mjs` | Snapshot CLI: arguments, the run loop, the diff. |
| `scripts/import-tires.mjs` | Pushes a snapshot into a running owner server, local or hosted. |
| `scripts/giga-tires.mjs` | Parsing and normalising one supplier listing page. Pure, so it can be tested on saved HTML. |
| `scripts/browser-fetch.mjs` | Fetching pages through a real browser. |
| `scripts/worktree.mjs` | Adds and removes agent worktrees under `.worktrees/`, linking the shared `node_modules` and unlinking it before removal. |
| `.forge/` | Project record: requirements, roadmap, decisions, task state, the owner-backend design, the audit scripts, and the protocol for agents sharing this repo. |
| `docs/supplier-refresh.md` | The monthly runbook for scraping all 910 selector sizes in batches and getting a batch into production. |
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
the owner's curated inventory reaching the customer. Phase 4 is under way and
its first milestone (m9) has shipped: requests and quotes live in the backend,
so the owner reviews from any device and the customer pays from their own. For
what is current, read [`state.json`](.forge/state.json) rather than this
paragraph -- a milestone status restated here is one more copy to go stale.
