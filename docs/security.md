# Security review of a pull request

What the security reviewer checks on a pull request that touches `backend/`,
auth, `.github/workflows/`, `Dockerfile`, `fly.toml`, `.dockerignore`, or
anything that stores, returns or sends customer data. Written 2026-09-06 by the
DEVSCOPS/AUDITOR session (the outside reviewer) so the read is repeatable by
the inside security agent that comes later. Verify each mechanism named here
against the code on `main` before relying on it; this page describes the
system as it stood at `cb8d0a6` and names the open issues as they were then.

The reviewer reads and reports. It does not merge, fix, claim or instruct, and
during the isolation its findings go by message to the temp lead, never as
pull-request comments. A finding is: where (file and line), what a caller can
do, the evidence (the command and its output), a severity, a suggested fix,
and whether it should block the merge. Say what was not checked.

## Before the diff

1. `git fetch`; `gh pr diff <n>`; note the head SHA and read the diff, not the
   body. If the PR touches a file others edit, trial-merge:
   `git merge-tree --write-tree origin/main <branch>` and diff the result.
2. Confirm the gate ran on that head SHA and read each audit's own count line
   in the log. "No checks reported" is no gate.
3. Name the trust boundary the change sits on. There are four: the public
   customer (no credential), the signed-in owner (session cookie), the import
   bookmarklet (bearer token, one route), and CI/deploy (`FLY_API_TOKEN`).
   Every question below is "does this change move something across one of
   those lines?"

## `backend/api.mjs` and `backend/server.mjs`: the boundaries

- Everything under `/api/` is refused without a session unless named in the
  allow-list: `PUBLIC_API_PATHS`, `PUBLIC_REQUEST_PREFIX` (GET only, minus
  `REQUEST_ACTIONS`), and `PUBLIC_POST_PATHS` (submit, pay, cancel). A new
  route is private by default; a route made public must be added there and
  covered by the test "the public rule opens the customer paths and nothing
  else" in `backend/quotes.test.mjs`. Reject a PR that loosens the check
  instead of naming the route.
- Owner routes live inside `createApi` only, behind the same-origin check that
  reads `x-forwarded-proto`. CORS headers exist for one route,
  `/api/owner/import`, and only for the two giga-tires origins. Any CORS
  header appearing elsewhere is a finding.
- Bodies: JSON content-type required; 32 KB default, 4 MB for a supplier
  page, 8 MB for a snapshot. Errors are `InputError` with a status; a handler
  that lets one escape returns 500 with a stack trace (the auth routes do,
  #69). Nothing logs a request body.
- `serveStatic` resolves under `dist/` and falls back to `index.html`.
  Hashed assets are immutable; `index.html` is `no-cache`. No security
  headers are sent yet (#67); a PR adding them must keep the owner screen's
  `javascript:` bookmarklet link working.
- `KMT_ALLOWED_HOSTS` gates the Host header when set; `KMT_BIND` the
  interface. The local `dev.mjs` binds loopback and has no password by design;
  a change that makes `dev.mjs` reachable off-host is a finding.

## `backend/auth.mjs`: the two credentials

- The owner password is required at boot, at least twelve characters,
  compared in constant time, and never logged. The session is an HMAC-signed
  purpose-and-expiry string in an `HttpOnly` cookie, `Secure` behind TLS,
  `SameSite=Strict` today (`Lax` is planned in #89; a change must still keep
  cross-site POST from carrying the cookie). Logout clears the cookie only; a
  copied cookie lives out its TTL (#66). `KMT_SESSION_HOURS` is unvalidated;
  a non-number locks the owner out silently (#86). Login has no throttling
  (#66).
- The import token is issued only to a signed-in owner, carries a different
  purpose string, lasts two hours, and unlocks `/api/owner/import` and nothing
  else. The test "import tokens cannot be swapped for session tokens" is the
  contract; a change to `issue` or `verify` that lets one purpose pass as
  another is a blocking finding.
- Credentials come from the environment. A PR that reads a password, token or
  key from a file in the repository, from the frontend, or from a PR body is
  refused on sight. `secrets/` on the maintainer's machine is gitignored and
  must stay so; `.dockerignore` does not yet exclude it (#68).

## `backend/quotes.mjs` and the routes: customer data

- Collected: vehicle text, tire id, quantity (1, 2 or 4), location with
  optional ZIP and access notes, preferred date, name, email, optional phone
  stored E.164. Lengths are bounded and the required fields enforced in
  `cleanRequest`; date and ZIP are not validated (#70). A new field needs a
  limit, a type check and a test in the same PR.
- Access is a 128-bit request id or the per-browser key. A wrong key answers
  404 exactly as a missing id does; nothing lists requests without one. A new
  customer endpoint must keep both properties and be tested for the 404 shape.
- `shapeRow` spreads the whole request payload, so the public by-id GET
  returns the customer's name, email and phone to anyone holding the link
  (#65). The owner's list may see everything; a customer must never receive
  another customer's row, and nothing the owner writes about inventory
  (`offers.notes`) reaches a customer. The cancellation `reason` is
  customer-visible by design.
- The built bundle is public. `.forge/bundle-leak-check.mjs` runs in the gate
  after the build and fails on `sku:`, `listPrice:` or `scrapedAt:` in
  `dist/`; the deployed-site check asserts `/api/catalog` rows carry exactly
  the seven customer fields. A PR that imports data into `src/` gets a grep
  of its build for supplier, cost, markup and personal fields, whatever the
  gate says.
- Any schema change needs `migrate()` and a test that starts from the old
  schema (`backend/migration.test.mjs` is the pattern). Merge is deploy, and
  the migration runs on production's first boot; the volume snapshot comes
  first and is the user's to take.
- Public POSTs have no rate limit (#63). Until they do, any PR that makes a
  public POST send email, spend money or write more than one row is a
  blocking finding.

## `.github/workflows/fly-deploy.yml`

- Deploy runs only on a push to `main`; pull requests get the check job and
  nothing that holds `FLY_API_TOKEN`. The flyctl action is pinned to a commit;
  bumping it is a deliberate change with a reason in the comment. Concurrency
  is per ref.
- The check job: backend tests, `eslint src backend` (zero rules on `.mjs`
  today, #64), build, `bundle-leak-check`, Playwright, then the three flow
  audits against `backend/server.mjs` with a temporary database, a throwaway
  password, `KMT_BIND=127.0.0.1` and `AUDIT_BASE` set explicitly. The verify
  job runs only the read-only deployed-site check.
- Refuse: a secret reaching the check job; any step that points the flow
  audits at `https://kmt.fly.dev` (they submit, approve and pay); an
  unpinned third-party action; a removed or renamed gate step without its
  `EXPECTED_CHECKS` accounted for.

## `Dockerfile`, `fly.toml`, `.dockerignore`

- The container runs as root and launches Chromium with `--no-sandbox` to
  render third-party supplier pages beside `/data/owner.sqlite` (#87). Dev
  dependencies are installed on purpose (Playwright is used at runtime);
  `NODE_ENV` is set after the build. Read what `COPY . .` would include given
  `.dockerignore` as changed.
- `fly.toml` runs one machine on one volume by design; a second machine means
  a second, diverging database. `min_machines_running = 1`; there is no
  health check (#88). `[env]` is committed, so anything secret goes through
  `fly secrets`, never there.
- A PR adding an environment variable documents it in the `server.mjs`
  header and `.forge/owner-backend.md`, says whether it is a secret, and
  validates it the way the password is validated.

## `scripts/` and the supplier path

- `browser-fetch.mjs` and `refresh.mjs` render another site's HTML in a real
  browser; `import.mjs` accepts pages from the owner's browser under the
  bearer token with bounded sessions (60 pages, 8 sessions, 15 minutes). The
  parser stays on the server. A PR that moves parsing into the browser, adds
  stealth or user-agent spoofing, shortens the 1.5-second pause, or widens
  the import origins is a policy change and is reported as one.

## Dependencies

- No new dependency without the justification `AGENTS.md` asks for. Run
  `npm audit`; check `package-lock.json` changes match `package.json`. The
  application fetches nothing at runtime except the supplier and Fly.

## Check, do not only read

- Locally: `node --test backend/*.test.mjs`, `npx eslint src backend`,
  `npm run build`, `node .forge/bundle-leak-check.mjs`, `npm audit`.
- The four audits against a throwaway `backend/server.mjs`: build, start it on
  a port no audit defaults to with a temp `KMT_OWNER_DB`, a twelve-character
  password and `KMT_BIND=127.0.0.1`, export `AUDIT_BASE` and
  `KMT_OWNER_PASSWORD`, run the scripts one after another, stop the server by
  port, delete the database files by literal path.
- For an auth or API change, drive the throwaway server with `curl`: wrong
  password 401; no cookie 401 on every owner route; a tampered cookie 401; an
  import token on a session route 401; a cross-origin POST 403; a non-JSON
  body 415; a body over the limit 413; a public route with a wrong customer
  key 404.
- Against production, read-only only: GET and HEAD, and
  `.forge/deployed-site-check.mjs`. Measure with the request a browser makes
  (a GET with `Accept-Encoding`); a HEAD carries no `content-encoding`.

## Open security issues to hold in view

#63 and #98 rate limiting; #64 backend lint; #65 contact fields by link; #66
login throttling and revocation; #67 headers; #68 `.dockerignore`; #69 auth
500; #70 date and ZIP; #86 session hours; #87 root and `--no-sandbox`; #88
health check; #89 `SameSite`; #96 sign-out; #80 and #99 backups and
retention; #100 privacy notice. A PR that closes one should reference it and
add the test that would have caught it.
