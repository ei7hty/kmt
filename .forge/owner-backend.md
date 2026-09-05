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
- `POST /api/owner/import-snapshot`: `{snapshot, complete, dryRun}`, where
  `snapshot` is the file `scripts/scrape-tires.mjs` writes. Applies every size in
  one transaction through the same `writeSize` a refresh uses, so offers are
  untouched and nothing is deleted. `complete: false` (the default) upserts and
  retires nothing, labelled `snapshot` coverage; `complete: true` retires rows the
  file omits, labelled `full`. `dryRun` answers with per-size counts (new,
  changed, unchanged, retired) and writes nothing. 409 while a refresh runs.
  `scripts/import-tires.mjs` is the client.
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

## Running it hosted

There are two entry points. `backend/dev.mjs` is the local one -- Vite in
middleware mode, loopback bind, no password, because whoever reaches it is
already at the keyboard. `backend/server.mjs` is the hosted one: it serves the
built `dist/` and the API from one origin, binds a real interface, and refuses
to start without a password.

One origin is deliberate. The API's same-origin check keeps working as written,
so there is no CORS surface and no token to hand a separate frontend. It also
means the static Vercel deployment becomes redundant once this is up -- the
container serves the customer flow too.

### Configuration

Everything comes from the environment, so the same image runs anywhere:

| variable | |
| --- | --- |
| `KMT_OWNER_PASSWORD` | **Required.** At least 12 characters. The server exits without it rather than starting open. |
| `KMT_SESSION_SECRET` | Recommended. Without it a random secret is generated per boot, which signs everyone out on every restart. |
| `KMT_OWNER_DB` | SQLite path. Point it at a mounted volume; the default lives inside the container and dies with it. |
| `PORT` | Defaults to 8080. Most hosts set this for you. |
| `KMT_BIND` | Defaults to `0.0.0.0`. |
| `KMT_ALLOWED_HOSTS` | Comma-separated hostnames to accept. Unset accepts any, which is fine behind a host terminating its own TLS. |
| `KMT_SESSION_HOURS` | Session lifetime, default 12. |

### Deploying

The `Dockerfile` is plain and host-agnostic: an image listening on `$PORT` with
its database on a volume at `/data`. Nothing in it is specific to a provider.

```bash
docker build -t kmt .
docker run -p 8080:8080 -v kmt-data:/data \
  -e KMT_OWNER_PASSWORD=... -e KMT_SESSION_SECRET=... kmt
```

#### Fly, specifically

**Run these from a checkout that is on `main`.** `fly launch` reads the working
directory, not the repository: run it where `Dockerfile` and `fly.toml` are not
checked out and it scaffolds its own. It did exactly that here -- generated a
`FROM pierrezemb/gostatic` Dockerfile (a static file server: no Node, no SQLite,
no Chromium) and a fly.toml with `min_machines_running = 0`, which is the
opposite of what this app is for. Deploying that ships raw files and no backend,
and it looks like a successful deploy.

If those generated files exist, delete them before deploying; the committed ones
are the real config.


`fly.toml` is committed and tuned for this app. Volume first, secrets second,
deploy last -- a deploy without the volume looks fine until the next one wipes
the database.

```bash
fly launch --no-deploy              # claim the app name, keep the committed fly.toml
fly volumes create kmt_data --region ewr --size 1
fly secrets set KMT_OWNER_PASSWORD='...' KMT_SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

Three settings in `fly.toml` are load-bearing and explained in its comments:
`auto_stop_machines = false` and `min_machines_running = 1` (a suspended machine
cannot hold a refresh job), `memory = "1gb"` (Chromium, not the server, sets the
floor), and the standing warning never to run more than one machine -- a Fly
volume attaches to one machine, so a second gets a second empty database and the
two diverge silently.

After the first deploy, set `KMT_ALLOWED_HOSTS` to the app's hostname if you
want the Host check enforced:

```bash
fly secrets set KMT_ALLOWED_HOSTS=kmt.fly.dev
```

Any container host takes it from there: Fly (`fly launch`, add a volume mounted
at `/data`), Render (Docker service plus a persistent disk), Railway, or Docker
on a VPS. The only requirements are a persistent volume and a process that stays
running -- serverless platforms satisfy neither, which is why Vercel cannot host
this half.

### Resolved: the five-minute trial stop

For part of 2026-09-05 the Fly org was treated as a trial and machines were
force stopped after exactly 5m0s of uptime, logging:

```
Trial machine stopping. To run for longer than 5m0s,
add a credit card by visiting https://fly.io/trial.
```

It was never a configuration fault -- `fly.toml` sets `auto_stop_machines =
false` with `min_machines_running = 1`, and the machine reported `autostop:
false` while being stopped anyway. Fly was overriding both for billing. The
limit also kept firing for a while after a card was added, which is why this was
written down as an open problem rather than a solved one.

It is gone. Measured at 20:14Z: the machine had been up 7m36s, past the cap it
used to die at, with no `Trial machine` line anywhere in 33 minutes of logs
where it had previously appeared every five.

Kept as history because the symptom is confusing on its own: a machine that
stops despite `auto_stop_machines = false` looks like a broken deploy config,
and the cause is in the billing account rather than this repo. If it ever
returns, that is where to look. Check with:

```bash
fly logs -a kmt --no-tail | grep "Trial machine"
```

Uptime is the better test, though: `fly status -a kmt` showing more than five
minutes since the last update settles it either way.

### What the password does and does not cover

It guards the data that is actually on the server: supplier costs, offers and
prices. It does not cover `/owner/quotes`, and deliberately so -- that screen
reads `localStorage` in the browser and never contacts this server, so a server
password would protect nothing there while locking the owner out of a screen
that works everywhere. The sign-in gate keeps its nav link reachable.

One shared password, because there is one owner. It is not an account system:
no users, no registration, no reset. If more than one person ever needs their
own login, replace it rather than growing it.

### Importing from the owner's browser

Server-side refresh is the normal route and was tested working from Fly (see
below). This is the fallback for the day it stops being: it runs on the owner's
own connection and needs no server access to the supplier at all.

A page on kmt.fly.dev cannot fetch giga-tires: cross-origin requests come back
as an empty 202 with no `Access-Control-Allow-Origin`. Verified, not assumed.
The one place the fetch is permitted is a giga-tires page itself, where it is
same-origin -- so a bookmarklet runs there, walks every page of the listing with
the same 1.5s pause the server uses, and POSTs each page's HTML to
`POST /api/owner/import`.

- The parser stays on the server. Extracting rows in the browser would be a
  smaller payload and a second implementation of the thing most likely to break
  when the supplier changes their markup.
- Pages accumulate in memory and only reach the database once the size is
  complete, via the same `refreshSize` a server refresh uses. A half-read size
  never replaces a whole one, and a listing that changes page count mid-import
  is discarded rather than mixed.
- Auth is a bearer token from `POST /api/owner/import-token`, not the session
  cookie: that cookie is `SameSite=Strict` and deliberately does not travel
  cross-site. The import token lasts two hours and authorises nothing else.
- CORS is granted to the two giga-tires origins for that one endpoint. Every
  other route stays same-origin only.

`src/owner/bookmarklet.js` is the readable source; `buildBookmarklet` in
OwnerInventory holds the minified copy that becomes the `javascript:` URL. Edit
the readable one first.

### Importing a scrape run somewhere else

The third route to the supplier, beside the server refresh and the bookmarklet:
run `scripts/scrape-tires.mjs` on any machine with a screen and a home
connection, then `scripts/import-tires.mjs` pushes the resulting file to
`POST /api/owner/import-snapshot` on whichever server should have it. Locally
that is `backend/dev.mjs` with no password; hosted, the CLI signs in with
`KMT_OWNER_PASSWORD` from its environment, exactly as the owner screen does,
and sends the session cookie. It sends no `Origin` header, so the API's
same-origin check is not in play, and it needs no CORS grant.

Why a separate step rather than a `--push` flag on the scraper: the snapshot is
meant to be read before it goes anywhere, and the import's dry run is where the
reading happens against what the server already holds. The seed-once
`importSnapshot` is unchanged; this is `applySnapshot`, which shares its
validation and writes whether or not the database was seeded.

### Supplier refreshes on the host

Refreshes run on the server, triggered by hand from `/owner`. Nothing is
scheduled: no cron, no refresh on boot.

The image carries Chromium and Xvfb because refreshes drive a **headful**
browser -- giga-tires' WAF refuses headless outright, and that does not stop
being true on a server. Xvfb supplies the display a headful browser needs on a
machine with no screen. `KMT_CHROMIUM_PATH` and `KMT_CHROMIUM_NO_SANDBOX` point
Playwright at the system Chromium and drop the sandbox, which is required when
running as root in a container; both are unset locally and change nothing there.

**Tested from the datacenter on 2026-09-05 and it works.** Run on the Fly
machine in `ewr`, the headful-under-Xvfb fetcher returned a full listing page --
801KB, ten product cards, price data present. The concern was that the WAF
weighs IP reputation as well as browser fingerprint and would refuse a cloud
range; on this evidence it does not. Server-side refresh is the normal route,
not a hopeful one.

Reproduce it with:

```bash
fly ssh console -a kmt -C "sh -c 'xvfb-run -a node /tmp/probe.mjs'"
```

That is one observation, not a guarantee: IP reputation can change, and a WAF
that accepts you today can challenge you tomorrow. If refreshes start coming
back blocked, the fallback is the browser import above, which runs on the
owner's own connection and needs no server access to the supplier at all. Do not
respond by adding stealth plugins or residential proxies -- that is evading the
supplier's bot detection rather than being a well-behaved client.

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
