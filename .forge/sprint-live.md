# Final sprint: KMT live on Ken's own domain (m12)

Written by the KMT lead (KMT-F DEV-PRODUCT MANAGER) on 2026-09-06 at main
`dd0888d`, on the user's instruction: "plan final sprint to live, prepare the
app for mating with domain, assign tasks through the temp lead and project
manager." This file is the what and the why. The PROJECT MANAGER turns it into
briefs and owns how, who and when within the assignments below; the REPO
AGENT owns the gate, the workflow and every merge. Product calls stay with
the lead and the user. Session ids are in `roles/README.md`; a title is never
an address.

## The goal, in one sentence

A customer in Ken's service area opens Ken's own domain on a phone, asks for
tires that are really in stock, gets a draft quote, Ken approves it from his
phone, the customer pays and both of them are told, and nothing about that
exchange leaks, breaks or goes unwatched.

## Definition of done for the sprint

1. **Data.** Every size the supplier lists shows real supplier tires with
   stock and price on the live site (page-one coverage; `--complete` is not
   required). Sizes the supplier does not carry still route to owner review
   through the `giga-` guard.
2. **Safe for real customers.** A shared status link exposes no contact
   details; public endpoints are rate-limited; owner login is throttled and
   logout invalidates the cookie; responses carry security headers; the
   container does not run as root and cannot bake in `secrets/`; production
   copy is production copy; a privacy notice exists and is linked; the
   service area is enforced at submit.
3. **The domain.** The site answers at the client's domain over HTTPS with a
   valid certificate; `kmt.fly.dev` redirects to it; the owner cookie works
   there; the verify job and the post-deploy check run against it; something
   watches it and tells the user when it is down; the backup and restore
   path is written down and has been exercised once.
4. **Email** (m10's t37 and t38, staffed and sequenced last): the customer is
   told when the quote is sent and when payment is recorded, Ken is told
   when a request arrives, from a sending domain with SPF, DKIM and DMARC.
   The site may go live on the domain before this stage if the user chooses;
   the cutover does not wait on email.

The owner approval gate is untouched by everything below. No task in this
sprint may weaken it, and any task that finds it in the way stops and asks.

## Stages and gates

Each stage has a gate the PROJECT MANAGER reports against. A stage does not
start on production until the previous gate is green, but branches for later
stages may be cut and reviewed early when their files are free.

### Stage 1, data (in motion)

| task | what | why | who |
| --- | --- | --- | --- |
| t42 | The walk reads page one of every size the supplier lists, with #81 (empty versus block) fixed before the 19-24 and 12-14 inch bands, under the five approved rules. | Empties cost three times a hit; without #81 the walk does not finish. | DB ADMIN (`local_31eab57d`), on the PM's line; inside the user's "optimise the rest of your walks". |
| t43 | Stage-1 import of the breadth file without `--complete`, then read-only verification: `/api/catalog` row count, a sample of five sizes across bands showing supplier tires, no supplier fields in the response, the deployed-site check green. | Puts stock data on every size, which is the user's first priority. | The user runs the command (owner password stays in their hands); DB ADMIN prepares it and the expected counts; QA ENGINEER verifies read-only once reopened, otherwise DB ADMIN. |

Gate 1: catalog rows and per-band samples match the walk file; deployed-site
check green; no supplier field in `/api/catalog`.

The deep pass (2681 unread pages, four to seven hours supervised) is stage 1b
and starts only on the user's word; it is not a condition of any gate.

### Stage 2, safe for real customers

| task | what | why | who |
| --- | --- | --- | --- |
| t44 | Customer-facing request shape without `customerName`, `customerEmail`, `customerPhone` or `locationNotes` for `get()` and `listForCustomer()`; `listForOwner` keeps the full row; one test per shape; the status screen still renders. (#65) | R23: contact details never go to another customer, and status links are meant to be shared. | LEAD BACKEND DEV |
| t45 | Rate limiting on submit, pay and cancel (per IP and per key), owner login throttling, logout invalidating the session (server-side session id or a rotating secret), address and body-size validation on the public endpoints; tests for the limits and for the gate audits staying under them. (#63, #66, #98) | An open relay the day email sends; a brute-forceable owner login. | LEAD BACKEND DEV |
| t46 | Security headers on every response (`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`, a CSP that the bundle and the audits pass, HSTS only when the request is HTTPS), plus an env-driven canonical host: when `KMT_CANONICAL_HOST` is set, any other host is answered with a 301 to it, and the `/api/health` path is exempt so Fly's check never redirects. (#67, and the app half of #102) | The domain cutover needs one switch that moves everyone to the new name and nothing else; headers are cheap before customers arrive and expensive after. | LEAD BACKEND DEV; DEVSCOPS/AUDITOR reads the PR |
| t47 | Owner cookie `SameSite=Lax` and a `/owner/quotes?request=<id>` deep link that opens the request's card. (#89) | Email links to the owner must land on the request; Strict sends him to sign-in every time. | LEAD BACKEND DEV (cookie, with a test that Lax is set and Strict is gone); LEAD UI ENGINEER (deep link) |
| t48 | Service area at submit: an allow-list of ZIP codes or a radius from the base, read from configuration, refused with a clear message that offers the phone number; date must be today or later; ZIP must be five digits. (#95, #70) | A customer 200 miles away can complete the flow today. | LEAD BACKEND DEV (validation and tests) and LEAD UI ENGINEER (the message and the tel link); waits on the user for the area |
| t49 | Production copy: page title "Ken's Mobile Tire", the stale owner-screen strings, the formatted phone on the owner card, a sign-out control on the owner screens, brand-red contrast and the footer control at 375, unknown paths rendering a not-found panel instead of the home page. (#72, #96, #85, #76) | The client's name in the tab; the owner can leave a shared device; AA contrast on a phone. | LEAD UI ENGINEER |
| t50 | A `/privacy` page and a one-line link under the email field and in the footer: what is collected, why, how long it is kept (R27: nothing is deleted, stated as policy), who sees it (Ken; the supplier never), and how to ask for deletion (Ken's phone and email). (#100) | Personal data is being collected now; a notice is cheap this week and hard to retrofit. | LEAD UI ENGINEER builds; the lead drafts the text; the user or Ken approves it before merge |
| t51 | Container runs as a non-root user with Chromium still able to launch under Xvfb; `.dockerignore` excludes `secrets/`, `.worktrees/`, `data/` and the walk output. (#87, #68) | A root process beside the customer database; a local deploy that would bake in the password. | DEV OPS/INFRASTRUCTURE; DEVSCOPS/AUDITOR reads the PR |

Gate 2: every task above merged and deployed green; DEVSCOPS/AUDITOR has
sent one security read covering t44 to t47 and t51 with nothing open; the
three flow audits and the deployed-site check green on the merged
combination; the live TEST request from the v1 push still answers on
`/status` (nothing regressed for existing customers).

### Stage 3, the domain

| task | what | why | who |
| --- | --- | --- | --- |
| t52 | The domain cutover runbook in `docs/operations.md`: the DNS records (A and AAAA to the app's IPs from `flyctl ips list`, or CNAME for a subdomain), `flyctl certs add`, `flyctl certs check`, the `KMT_ALLOWED_HOSTS` secret carrying both names, the `KMT_CANONICAL_HOST` flip, the order of those steps, how to tell each one worked, and the rollback (unset `KMT_CANONICAL_HOST`; `kmt.fly.dev` keeps serving). Includes the same for the sending subdomain (SPF, DKIM, DMARC) so stage 4 does not wait on DNS. (#102) | The cutover is four commands and two DNS records in the right order; written down, it is an afternoon; improvised, it is an outage. | DEV OPS/INFRASTRUCTURE writes it; the user executes every `flyctl` and registrar step with their own hands; no agent holds the token |
| t53 | The workflow reads the public URL from one repository variable (default `https://kmt.fly.dev`) for the wait loop and the verify job; the deployed-site check gains three checks: the canonical host answers 200 over HTTPS, `kmt.fly.dev` answers 301 to it once the flip is on, `/api/health` answers 200 on both; docs-only merges skip the deploy job (#103); a scheduled workflow every ten minutes reads `/api/health` on the public URL and fails loudly, which emails the repository owner (#101). | The gate must prove the domain, not the old name; docs merges stop redeploying; something pages someone. | KMT-F REPO AGENT (workflow); QA ENGINEER (the check script and its `EXPECTED_CHECKS`), or DEV OPS if QA is not reopened |
| t54 | The operations runbook: what Fly snapshots already do and their retention, a monthly off-Fly copy of `owner.sqlite` and where it goes, the restore procedure exercised once against a throwaway machine or a local server and its result recorded, secret rotation for the owner password and the session secret, the incident steps (site down, machine unhealthy, database corrupt, supplier blocked). (#99, #80) | Backups that have never been restored are a hope, not a plan. | DEV OPS/INFRASTRUCTURE writes; the user runs the restore drill |
| t56 | The cutover itself and the live test on the domain: the user runs t52's steps; QA ENGINEER drives the customer side on an emulated phone against the domain (submit, status, pay, cold link by id) with a request marked TEST; the user drives the owner side; DEVSCOPS/AUDITOR does one read-only pre-cutover read of the domain (TLS, headers, redirect, the `/api/requests/:id` shape, owner API refusing without a session) and one after. | The site is live when the whole exchange has happened once on the real name. | The user, QA ENGINEER, DEVSCOPS/AUDITOR; the PM runs the checklist |

Gate 3: the verify job green against the domain; the three new deployed-site
checks green; the live test recorded step by step in `HANDOFF.md`; the
auditor's post-cutover read clean; the restore drill recorded.

### Stage 4, email (m10: t37, t38)

Unchanged in substance from `roadmap.md` and `state.json`: one module, one
seam, an outbox table, the provider behind it; the customer is emailed when
the quote is sent and when payment is recorded, Ken when a request arrives;
no customer email before Ken has sent the quote. Preconditions are t45 and
t47, both in stage 2, and the sending-domain records from t52. Staffing is
the user's decision: the roster names LEAD FULL STACK, which is under the
cost stand-down; the alternative is LEAD BACKEND DEV for the seam and LEAD
UI ENGINEER for the templates. The provider account and its key are the
user's and never pass through an agent.

Gate 4: two real inboxes receive the three messages from a TEST request on
the domain; the outbox shows each as sent; a bounce is recorded, not lost.

### Stage 5, gate coverage (runs alongside, QA ENGINEER)

| task | what | why | who |
| --- | --- | --- | --- |
| t55 | #79 (wait for the chip, four lines), #113 (an audit step that picks quantity 2 and checks the set price and the draft total), #78 (cancel through an in-page confirm so the audit can exercise it; counts bumped where they move). | The gate is the only thing standing between a merge and a customer; it must not flake and must cover the largest line on every quote. | QA ENGINEER, once the user has reopened it inside the repository. #79 waits on the user's word "flake". |

## The assignment table, by agent name

| agent | sequence, one brief at a time | does not touch |
| --- | --- | --- |
| KMT-O LIVE PROJECT MANAGER | Turns this file into briefs in the order above; controls file overlap (below); collects reports; sends stage-gate status to the lead and the auditor; writes task status into `state.json` with the repo agent. | Product substance; merges. |
| KMT-F REPO AGENT | Every merge as second reader; t53; `state.json` and `roles/README.md` upkeep with the PM; branch and worktree hygiene; the `EXPECTED_CHECKS` discipline on every audit change. | Application code. |
| LEAD BACKEND DEV | #124 (in flight) → t44 → t45 → t47 cookie half → t46 → t48 validation → stage 4 seam if the user assigns it. | `.github/`, `Dockerfile`, `fly.toml`, `src/` beyond what a task names. |
| LEAD UI ENGINEER | #126 (in flight) → t49 → t47 deep link → t50 → t48 message → stage 4 templates if assigned. | Rules, routes' state, `backend/`, audits' counts without the repo agent. |
| DEV OPS/INFRASTRUCTURE | #123 (in flight, with the health-check condition: deploy green, machine healthy after, rollback named in the PR) → t51 → t52 → t54 → t53's check definitions with QA. | `.github/workflows/` (proposes, the repo agent applies); any `flyctl` write; `backend/` beyond `server.mjs` mounts already agreed. |
| QA ENGINEER | Once reopened in the repo: t55 → t53's check script → t43 verification → t56 customer side. | Scraper and import code; production requests outside t56. |
| DEVSCOPS/AUDITOR | Security reads by message on #123, #124, t44, t45, t46, t47, t51, t52; the pre- and post-cutover reads in t56. | Claims, merges, implementation, instruction. |
| DB ADMIN (`local_31eab57d`) | t42 → t43 preparation → stage 1b on the user's word → `docs/supplier-refresh.md` updated for the domain. | Anything outside the scraper and import lane. |
| LEAD FULL STACK | Stood down under the cost rule; takes stage 4 only if the user lifts it in its own session. | Everything until then. |
| HARNESS AGENT, orchestrator | Observe only. | Everything. |

## File overlap the PM must sequence

- `backend/server.mjs`: DEV OPS (#123) first, then LEAD BACKEND DEV (t46).
- `backend/api.mjs`, `backend/auth.mjs`, `backend/requests.mjs`: LEAD BACKEND
  DEV only; one PR at a time.
- `src/routes/Confirmation.jsx`: #126 before t49.
- `src/routes/QuoteRequests.jsx`: t49 (phone, sign-out) before t47's deep link.
- `.forge/deployed-site-check.mjs`: t53 only, with its `EXPECTED_CHECKS` moved
  in the same commit.
- `fly.toml`, `Dockerfile`, `.dockerignore`: DEV OPS only; #123 before t51.
- `.github/workflows/`: REPO AGENT only.

## What only the user can supply, and when it blocks

| input | blocks | recommendation |
| --- | --- | --- |
| The domain name, and whether the app lives on a subdomain (for example `quote.<domain>`) or replaces the marketing site at the root. | t46's default, t52, t53's variable, t56 | A subdomain, linked from the existing marketing site: lowest risk, nothing on the root changes, and the marketing pages Ken already has stay up. |
| Registrar access and the `flyctl` steps, run by the user. | t56 | The runbook (t52) names each step; the user runs them in order and pastes each command's output to the PM. |
| Ken's service area: a list of towns or ZIP codes, or a radius in miles from the base. | t48 | A ZIP list is explicit and easy to change; a radius needs a geocoder the app does not have. |
| Approval of the privacy notice text the lead drafts. | t50's merge | One read by the user or Ken. |
| The email provider and its account, and the sending subdomain. Or "no email at launch". | Stage 4 | A transactional provider with a free tier and DKIM per domain; the key is set as a Fly secret by the user. |
| Who builds stage 4 if LEAD FULL STACK stays stood down. | Stage 4 | LEAD BACKEND DEV for the seam, LEAD UI ENGINEER for the templates. |
| "flake" for #79; reopening QA ENGINEER inside the repository. | t55 | Both are one action each. |
| "import" when the walk has read page one of every size; "deep pass" when wanted. | Gate 1; stage 1b | Import once at page-one completion; run the deep pass when the user has an evening to supervise it. |

## Out of scope for this sprint, deferred after launch

Pricing logic, tax, disposal, TPMS and valve lines (#94), the owner adjusting
a quote before sending (t35), real payments, a second machine, screens that
refresh without a reload (#104), supplier stock on the owner card (#105),
the iOS seven-day status key (#97), Tailwind's dead dependency (#90), the
lint rule set (#64, unless the repo agent takes it inside t53), the
`/api/catalog` cache (#84, backend lane, after t46 if time allows).

## Rules for the sprint

- One task per brief; claim first; `origin/main` merged in before asking; the
  repo agent merges as second reader; nobody merges their own PR, the lead
  included.
- Merge is deploy. Every PR that touches `fly.toml`, `Dockerfile`, the
  workflow or `server.mjs` names its rollback in the PR body.
- Credentials never pass through an agent: the owner password, the Fly
  token, DNS, the certificate, the email key. The user runs those steps.
- No production request is created except in t43's verification and t56's
  live test, each marked TEST in the vehicle field.
- Docs-only changes are batched into one PR per stage unless a brief needs
  one now.
- Report what actually happened, including what did not work. A count read
  from a screen is a claim; a count read from the script's output is a fact.
