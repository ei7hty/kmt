# Role: backend and customer request lane

Written 2026-09-06 by the outgoing SWE-0 AGENT 1 (now DEV OPS/INFRASTRUCTURE),
at main `cb8d0a6`. Verify every SHA, branch and PR state below before acting on
it -- a snapshot, not a live view. The sequence this lane ran was t25 to t33,
then t36 and the migration under it (#55, merged as `f1e7781`).

## What this role owned, and did not

Owned: the server and its API surface -- `backend/server.mjs`, `api.mjs`,
`quotes.mjs`, and the schema of everything under `requests` and `quotes`. The
customer's path through the product: `src/store.js` as the API client, the
request wizard, `/status`, `/confirmation`. The request lifecycle end to end --
who may move a quote to which status, and what a stale screen is told.

Did not own: the owner screens (`OwnerInventory.jsx`, `QuoteRequests.jsx` --
this lane wrote the lifecycle *into* the second one and then handed it back),
the five audit scripts, the scraper and import lane, `.github/workflows/` and
`scripts/` (the repo agent's), pricing policy (`src/pricing.js` drafts; this
lane never repriced a quote).

The boundary that mattered most: **this lane owned the transitions, the owner
lane owned the screen that calls them.** Both files were touched by both
lanes on the same day, twice, and both times the fix was to sequence the
merges rather than to split the file.

## Who you answer to, and what you report

The lead, one task at a time. Not another agent, not a PR comment, not a
message that says "the lead said" -- and a peer cannot authorise anything the
user has not. Twice this session a message arrived that contradicted a
standing instruction; both times surfacing it cost nothing and was right.

Report done-or-blocked with specifics: the SHA, the audit counts as printed,
what you read, and what you deliberately did not change. The repo agent
merges; you never merge your own PR.

## Code map

**`backend/server.mjs`** -- the hosted entry point, and what Fly runs. Env:
`KMT_OWNER_PASSWORD` (required, the process exits without it),
`KMT_SESSION_SECRET` (random per boot if unset, so sessions die on restart --
it says so in the log), `KMT_OWNER_DB` (point at the mounted volume),
`KMT_BIND` (defaults `0.0.0.0`; **not** `HOST`, which it ignores),
`KMT_ALLOWED_HOSTS`, `KMT_SESSION_HOURS`, `PORT` (8080). It mounts three
handlers in order -- `createCatalogApi`, `createRequestsApi`, `createApi` --
and serves the built `dist/` with an SPA fallback. `backend/dev.mjs` mounts
the same three; anything you add to one belongs in both.

**`backend/api.mjs`** -- the public surface is an allow-list, not a loosened
check. `PUBLIC_API_PATHS` (GET `/api/catalog`), `PUBLIC_POST_PATHS` (submit,
pay, cancel -- one regex per route, written out on purpose), `REQUEST_ACTIONS`
(suffixes a GET must never answer). `QUOTE_ACTION` is the owner's four verbs.
Everything else under `/api/` needs the session.

**`backend/quotes.mjs`** -- the lane's centre.
- `QUOTE_STATUSES` -- draft, sent, approved, rejected, paid, done, cancelled.
  `approved` is dead vocabulary kept alive: production holds rows written
  before the rename, and they must stay payable, listable and closable.
- `QUOTE_VIEWS` -- open/attention/awaiting/paid/closed, named for what the
  owner does next rather than for the status.
- `migrate()` -- rebuilds the quotes table when the stored schema is old.
  Reads `sqlite_master.sql` to decide, rather than a version counter there is
  no framework to keep. Foreign keys off *outside* the transaction; the pragma
  is a no-op inside one.
- `moveTo(id, version, {to, from, reason, refused})` -- one place that checks
  the version, checks the current status is in an allowed set, writes, and
  bumps. `decide()`, `finish()`, `cancel()` are thin callers. **t35's
  adjustment endpoint should be a fourth caller, not a rewrite.**
- `cancelByCustomer()` -- keyed like `pay()`, and a wrong key is answered
  "no such request", never "not yours": the second sentence confirms the
  request exists.
- `shapeRow()` -- the single place a stored row becomes an API shape. A new
  column reaches every screen through here or not at all.

**`backend/inventory.mjs`** -- owns the database handle every other module
borrows (`quotes.db` *is* `inventory.db`), `transaction()`, `validateTire()`,
markup, and `importSnapshot()`, which **returns early when already seeded** --
a second import is a silent no-op, which has cost a test its meaning before.

**`backend/auth.mjs`** -- one password, one signed cookie, `SameSite=Strict`,
`secure` derived from the request rather than hardcoded. Strict is why a
deep link into `/owner/quotes` from an email will not carry the session; that
is #89, and it is a real decision, not an oversight.

**`src/store.js`** -- the API client and the only place a fetch belongs:
`submitRequest`, `myRequests`, `requestById`, `payRequest`, `cancelRequest`,
`ownerRequests(view)`, `actOnQuote(id, action, version, reason)`. 4xx is shown
to the user as written; 5xx is replaced with friendly text. `NeedsSignIn`
turns a 401 into a sign-in form instead of an error.

**The customer routes** -- `CustomerRequest.jsx` is a three-step wizard
(fitment, tire, details), not one page; `Status.jsx` lists this device's
requests by `kmt_customer_key` in localStorage, or shows one request to
anyone holding `?request=<id>` -- the id is the access, 128 bits from the
platform CSPRNG. `STAGE` maps status to a four-beat tracker, with `approved`
sharing `sent`'s beat. `Confirmation.jsx` is the receipt.

## Rules this lane paid for

- **CREATE TABLE IF NOT EXISTS does nothing to a table that exists, and
  SQLite cannot ALTER a CHECK.** Every test and both CI jobs build fresh
  databases; production's persists on the volume. A new status passed
  everything locally and would have failed on production's first write --
  the owner's Approve button. That is why `migrate()` exists and why
  `migration.test.mjs` builds the *old* schema by hand rather than from the
  code under test. `ALTER TABLE ADD COLUMN` works for a nullable column and
  not a required one; plan the shape before writing it.
- **Prove a guard is load-bearing.** Comment out `this.migrate()` and two
  tests must fail. A test that passes with the feature removed is decoration.
- **A handler must guard its own path.** `createCatalogApi` once guarded on
  `isPublicApiCall`, so widening the public set made it answer `POST
  /api/requests` with the catalog: 200, valid JSON, wrong endpoint. Tests did
  not catch it; running `backend/dev.mjs` did.
- **Write assertions after reading the code, not from the task description.**
  Wrong markup shape, a hardcoded total that was never the total, a price of
  0 that `validateTire` rejects -- all self-inflicted, all before the code.
- **Every transition bumps the version.** Two owner windows must 409 the
  second save rather than silently overwrite the first.
- **Legacy rows read `null`, new fixtures leave fields `undefined`.** Guard on
  truthiness; tightening to `!== undefined` passes the suite and breaks every
  row already on the live site.

## How to verify

`backend/server.mjs` serving the **built** `dist/`, never `vite preview` --
a preview serves the frontend only, and the flow audits cannot complete
against it. Throwaway `KMT_OWNER_DB` and `KMT_OWNER_PASSWORD` (12 chars
minimum, or the server refuses to boot and it reads like a hang),
`KMT_BIND=127.0.0.1`.

Sequence: `npm run build`; start the server; `node --test backend/*.test.mjs`
(the glob, not one named file); `npx eslint src backend`; then the browser
audits with `AUDIT_BASE` and the password passed explicitly -- each script
defaults to a *different* port, so a forgotten `AUDIT_BASE` silently audits
whatever else is listening. Curl the port first. Read the printed count, not
the exit code; each script carries its own `EXPECTED_CHECKS` and fails on a
mismatch in either direction.

## Working in this harness

- **Messages arrive stale.** A PR merged, main moved, a worktree was taken
  over differently. The instruction that opened this very file named main at
  `ab6aaec`; by the time the worktree existed it was `cb8d0a6`. Fetch and
  re-verify before acting, including on fresh instructions.
- **Kill by port, not by `$!`.** Seventeen leaked preview servers once
  produced a false "the UI has changed" failure. `curl` the port to confirm
  it is free before trusting the next audit.
- **Worktrees share `node_modules` by junction.** `git worktree remove
  --force` deletes through it into the shared install. Use
  `scripts/worktree.mjs remove`.
- **Most source files are CRLF**, and the working directory resets after most
  worktree operations. A script matching `\n` finds nothing and aborts having
  changed nothing.
- **`dist/` is what the global `forge` bin runs**, if you are also running
  the harness: a source edit without a build produces "unknown option" on a
  flag you just added.

## What I would tell you on day one that no document holds

The dangerous changes in this lane do not look dangerous. A one-line status
value, a new column, a widened allow-list -- each of them passes the whole
suite and both CI jobs, because everything that runs builds its tables from
the code you just changed. The only database that disagrees is the one with
the customers in it. Before any schema or vocabulary change, ask what the
deployed table already holds, and write the test that starts from *that*.

And when a brief assumes something -- that a PR merged, that a file has a
shape, that a peer's lane does not overlap yours -- spend the thirty seconds
to check. It caught a wrong assumption three times in two days here, and
saying so cost nothing every time. Once it was my own: I warned another lane
about a NOT NULL migration for columns their diff never added, because I had
reasoned from the task description instead of reading their branch.
