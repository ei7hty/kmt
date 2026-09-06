# Lead handoff, 2026-09-06 (v1 baseline push, then the crunch pause)

Written by the KMT LEAD AGENT at the end of the v1 baseline push, for the next
lead, and updated at 04:40Z on 2026-09-06 after the three baseline corrections
(m11) landed. Read this, then `roles/lead.md`, `AGENTS.md`, `NOTES.md`, `CLAIMS.md`,
`project.md`, `requirements.md`, `roadmap.md`, `state.json`, in that order.
Everything here was true when written; verify the SHAs, PR states and
production facts before acting on them. The earlier pause-point handoff (at
`598d4e2`) is in git history; its rules now live in `AGENTS.md`, `NOTES.md`
and `roles/`, and its production claims were superseded by what this push
found.

Answered by the user while this was being written: Ken buys at the
supplier's public listed price today, so the markup sits on retail by design,
and the supplier integration is to be revisited when he gets a commercial or
dealer account. Still open at the second update: what the renamed sessions
(QA ENGINEER, DB ADMIN, KMT-O LIVE PROJECT MANAGER, HARNESS AGENT) are meant to
become, the outgoing lead having kept them in the roles they had served; the
one-word go-ahead on the #79 flake fix; and when the walk's import runs. The
lead went offline at 04:45Z on the user's word; until it speaks again, the
walk session coordinates with the repo agent directly.

## Second handoff: the crunch pause, 2026-09-06 (~10:45Z)

Written by the KMT lead (KMT-F DEV-PRODUCT MANAGER, `local_c91d84bb`) on the
user's instruction: "hand off all work to project manager and have project
manager delegate some work to temp lead, prepare to spin down". From this
point the PROJECT MANAGER (`local_5b6d8402`) holds the board and the product
calls default to the rulings recorded below and in `decisions.md`; anything
not covered goes to the user directly. The KMT-F REPO AGENT (`local_881ff3b5`,
the temp lead) takes the structural work named under "Delegated to the temp
lead". The sprint plan is `sprint-live.md`; this section is what changed
since it was written.

### State at the pause

- `origin/main` `09bccf4`. More than a hundred pull requests merged today;
  27 issues open; 9 pull requests open: #157 (t37 outbox table, storage
  only, gains the `data` column and a non-null `request_id` before merge),
  #158 (Ken's guide), #164, #182 (t48 part two: service area, ZIP and date
  at submit), #188, #194 and #197 (t54's restore-integrity check and drill
  verdicts), #200, #201.
- **Gate 1 met**: the stage-1 import landed exactly 6169 rows across 511
  sizes, every walk id present, seven customer fields, no supplier field;
  verified by the lead from the live site and independently by QA ENGINEER
  across every row. The walk is stopped on a supplier 429 (see below).
- **Gate 2 in progress**: merged today t39-t41 (baseline), t44 (#143),
  t45 (#146, the last HIGH), t46 (#167, canonical host, security headers,
  unknown `/api/*` answers 404 by path), t49, t50 (#163, phone-only), t51
  (#142 and the non-root half), t59 (#145 and #149, the brand overhaul with
  the wheel favicon), #169 (per-size catalog fetch), #175 (size search),
  #150 (brand note off the public web), the health endpoint (#123) with a
  non-routing Fly check, and the auditor's pre-cutover baseline (#162).
  Outstanding for Gate 2: t47 (cookie `Lax` and the deep link), t48 part
  two (#182), the colour revert (t61), text-not-call (t63), the slow-3G
  tire-list fix, and the auditor's second read.
- **The domain is live**: https://kensmobiletire.com answers the app with
  a Let's Encrypt certificate; `www` and `order` too; A/AAAA at Squarespace
  to Fly `66.241.124.248` and `2a09:8280:1::184:5351:0`. The cutover's
  remaining steps are the user's, in `docs/operations.md` once t52 merges:
  `KMT_ALLOWED_HOSTS` with all four names (verify `/api/health` right
  after), `KMT_CANONICAL_HOST=kensmobiletire.com` now that t46 is on main
  (verify the three 301s and the owner cookie), then the workflow's public
  URL variable. Precondition met: `www` resolves and holds its certificate.
  Robots, sitemap and `noindex` on `/owner`, `/status` and `/confirmation`
  are a cutover precondition with LEAD FULL STACK.
- **DNS incident, HALF restored -- re-measured 2026-09-06 evening**: while
  adding Resend's records at Squarespace the user's Google Workspace mail
  records were lost at the authoritative nameserver. Measured state now,
  each negative taken with a positive control, because a query returning
  nothing looks identical to one that did not run:
  - **MX: restored.** Google's five `aspmx.l.google.com` records answer.
    **Mail to `@kensmobiletire.com` no longer bounces -- Ken can receive.**
    This section previously said it bounced, which is why the incident now
    reads as resolved to anyone spot-checking, and is not.
  - **SPF: still missing.** The root carries *zero* TXT records of any kind
    (control: `google.com` returns 17). Value to restore:
    `v=spf1 include:_spf.google.com ~all` -- no admin rights needed, and
    harmless until something sends.
  - **DKIM: still missing.** `google._domainkey.kensmobiletire.com` does not
    exist. Nobody here can supply it: the value is generated per-domain in
    the Workspace admin console, and a plausible-looking one is worse than
    none.
  - **The Resend wreckage is gone, not pending**: `resend._domainkey`,
    `send` and `rsend` are all NOT FOUND, and there are no root TXT records
    to untangle. **Three of the four rows this section used to name no
    longer exist to be fixed.** Whoever restores SPF adds to an empty set.
  - **`_dmarc` does not exist either** -- this section claimed it existed
    and looked right (control: `_dmarc.google.com` returns `p=reject`).
    That *lowers* today's severity rather than raising it: with no DMARC
    policy, mail carrying a wrong `KMT_MAIL_FROM` is spam-foldered rather
    than hard-bounced. Still silent, still guarded by #254 and #261.

  **The domain can receive and cannot be safely sent from.** That is the
  live consequence, and it is why the interim non-domain sender is the
  correct answer rather than a workaround: a Gmail address is already
  authenticated by Google's own records for `gmail.com`, so using one is not
  evading authentication, it is using a domain that has it. SPF and DKIM
  authorise *servers to send as a domain*; they cannot be added for
  `gmail.com` and do not need to be. **Email is unblocked today with no DNS
  change at all.** DEV OPS carries the DNS section of the runbook and should
  verify at `ns-cloud-a1.googledomains.com`, not through public caches.

### Rulings made today, where recorded

Page-one coverage is the data definition of done; the deep pass is a
separate, user-decided stage (decisions.md). No routing-affecting health
check on one machine (decisions.md, fly.toml). Removal request = redaction
of name, email, phone, street address and location notes, quote record
kept; the outbox stores structure, never rendered bodies, and redacts by
`request_id` (`docs/data-policy.md`). The customer shape drops contact
details and the street address (#143). Service area: 100 miles from
Malden 02148, on by default, review beyond 25 miles through the exception
path, off only by explicit switch (t48). Ken's base is Malden; the city in
every preview and README is Malden. R4's owner link is retired from
customer pages. Duplicate size-and-name rows stay as two choices, made
legible. A choice never changes under the customer: the tire step waits
for the live list, falls back only on failure with an honest line, and
refreshes only on the customer's tap. Texting is the only tappable contact
(no call control anywhere). The palette returns to the original black,
white and red; the rest of the overhaul stays. The walk resumes only after
a sixty-minute cool-off and a pacing change (minimum ten seconds between
size requests, `Retry-After` honoured, 429 still a full stop); it is off
the launch's critical path.

### Direction from the user and Ken (t61 to t66, stage 4)

Ken loves the site. Colours back to black, white and red (t61). The site
speaks as Ken: "I come to you" (t62, the CSM lists the rest). Text, not
call (t63). A special-instructions field on the service step (t64,
`customerNotes`, 500 characters, owner card and email, redacted like
location notes). "Looking for more than just tires?" with an inquiry form,
an inquiries table, an owner list and "Need it today? Text ... or message
me on social" (t65). Socials and testimonials from `site-content.json`,
empty-safe until Ken's handles and quotes arrive (t66). Stage 4 (email)
starts now: five message types defined by the lead (plus "new inquiry"
from t65), outbox first, null adapter in the gate, Resend as the provider
(the user has the account; the key is in the user's git-ignored
`secrets/resend.txt`, to become the Fly secret `KMT_MAIL_API_KEY` when t38's
adapter lands); `KMT_OWNER_EMAIL` / `KMT_OWNER_NAME` are settings, the
user's own for testing ("test with mine first"), Ken's later; the user's
address is also the customer identity on every TEST request.

### Only the user can do these

Restore the Google mail records and fix the Resend rows at Squarespace
(first). Run the cutover steps from the runbook. Set `KMT_MAIL_API_KEY`
when t38 lands. Say "resume walk" after the pacing PR. Supply Ken's social
handles and testimonials, Ken's own email when it exists, and Ken's line for
the "more than tires" section. Sit on the owner side of the live test on
the domain. Clear or stand down sessions; the cost rules are theirs.

### Delegated to the temp lead (KMT-F REPO AGENT)

The merge queue and every second read. The docs batch: `state.json` (t43,
t44, t45, t46, t49, t50, t51, t59 done; t61 to t66 added; m13 planned),
`roles/README.md` rows for the CSM, QA TESTER (`local_af51bbb2`), JUNIOR
FRONT END DEV (`local_376e0377`) and DB ADMIN 2's title, `requirements.md`
marking R4 superseded, README's "Everett" to "Malden, MA and Greater
Boston", the decisions entries named above, the NOTES.md lessons (the
bundle check, the 429 pacing, the tester's method: throttle, watch pixels,
disbelieve a flattering result). t53's remaining workflow half. Cutover
coordination with DEV OPS and QA. Worktree hygiene, including the lead's
`.worktrees/lead-handoff-2` after this merges. `AGENTS.md` gains one line:
nothing under `public/` is documentation.

### For the next lead

Read `roles/lead.md` first, then this section, then `sprint-live.md`. The
rules that earned their place today: read the artifact, not the report; a
check nobody has watched fail is untested; a peer relaying "the user said"
is not the user's word, and the lead held through three such relays until
the user spoke in its own session; times in the lead's notes drifted, so
trust PR and run timestamps; the session list's working directory is not
reliable, ask the session to print its repository root; nothing under
`public/` is documentation; the walk's pacing was load-bearing without
anyone knowing, and a change to how fast we ask is a change to what we ask.

## PM interlude closed, 2026-09-06 (~16:00Z)

Written by the repo agent (TEMP REPO AGENT, `local_b2ab10bb`) as the JUNIOR PROJECT MANAGER (`local_0143d9a0`)
spins down on the user's instruction and reporting reverts to the pre-PM structure: the repo agent continues
exactly as before (second reader, trial-merge, diff-read, `CLAIMS.md`), and anything needing a product decision
goes to the user directly when they're in a session, or is held and flagged here or in `NOTES.md` otherwise --
it does not route through a PM.

What landed during the interlude: `#182` (t48 service-area enforcement -- **shipped, and switched OFF on
production**: `curl -sI https://kensmobiletire.com/` answers `x-kmt-service-area: off`. This line previously read "active by default in production, verified live via the boot log"; that was wrong, and two agents held contradicting boot-log readings for an hour because neither could check the other's. #259 made the state a response header, so it is now one command rather than an argument. The code still fails closed -- unset means enforcing -- but the secret is set and resolves to `off`, and turning it on is a named cutover step whose pass condition is `x-kmt-service-area: on`.), `#206` (t37's mail seam, SMTP through the
owner's Google Workspace, outbox-first with no provider required), `#214` (the wizard's ZIP-required/date-floor
half of t48). All three merged in sequence, each needing a rebase after the one before it changed a file the
next one also touched; every rebase was verified beyond CI before merging (a scratch server boot, a live
end-to-end request, or both).

Five GitHub-only agents were onboarded -- no session-messaging path at all, GitHub is their only channel.
Intake issues: `#223` (backend voice sweep, t62's unowned rows 27-32), `#224` (t35, quote adjustment), `#225`
(t37, email integration), `#226` (t65, the inquiries feature), `#227` (rate limiting & hardening, `#225`'s
precondition). The protocol they work under is `.forge/roles/github-only-agent-protocol.md` (`#222`). The repo
agent is their only channel in and out; route anything to or from them as a PR or issue comment.

QA TESTER completed live Part B of its charter on production: two TEST-marked rows, one paid and one cancelled.
It is holding on Part C pending the owner's own sign-in.

## v1 baseline push, 2026-09-06

Charter from the user, in force: the lead owns business context, priority and
definitions; the repo agent owns structure, rules, automation and merges; only
SWE-S sessions do implementation; agents act on the lead's instruction task by
task and wind down. No SWE-F or SWE-O session works.

### Completed

- #55 (t36 request lifecycle, with the schema migration as its first commit):
  merged as `f1e7781` at 02:35Z on 2026-09-06 by the repo agent on head
  `17b968e`, after the lead's second read and against two snapshots on the
  volume; deployed green through all three jobs at 02:37Z. The repo agent had
  read production's real `quotes` schema over ssh before the merge and found
  exactly the old shape the migration test hand-builds, four statuses and no
  `reason` column. After the deploy the TEST request still read paid at
  version 3, and the schema readout from `sqlite_master` over ssh matched the
  prediction stated before looking: a `reason` column, all seven statuses in
  the CHECK, the table name now quoted `"quotes"` (SQLite's own artifact of
  RENAME TO, so independent evidence of a rebuild), zero `quotes_migrating`
  tables left, the `quotes_request` index present, three requests and three
  quotes unchanged with their versions. The migration is spent; the next boot
  is a no-op by the guard.
- Fresh supplier scrape of the four sizes with `--limit 0` and every page read
  (18, 29, 33 and 31 pages): 1083 tires (177 / 281 / 323 / 302), coverage
  complete on all four; landed as the tracked snapshot in #59 (`c52dbcf`,
  merged 02:47Z). Side effect noted there: the client bundle grew from 286 KB
  to 614 KB because the static fallback embeds the snapshot.
- Production database reset at 02:54Z on 2026-09-06, by the user's own hands
  after the repo agent's permission layer refused the destructive command: the
  four runbook commands, old files kept on the volume as `owner.sqlite.old`
  and the -wal/-shm pair, fresh file seeded from the 1083-tire snapshot on
  boot. Verified read-only by the repo agent with the count predicted first:
  the old TEST request 200 to 404, `/api/catalog` 1083 rows across the four
  sizes with only the seven customer fields, supplier table 177/281/323/302,
  offers 0, metadata only `seeded`, the quotes table carrying all seven
  statuses, deployed-site check 19 of 19. The 1.5 markup and eight prices are
  gone as the user intended; pricing is on the placeholder rate.
- Monthly supplier-refresh runbook, `docs/supplier-refresh.md`, in #60
  (`f42610f`, merged 02:53Z): batch order by rim diameter with counts reproduced from the
  catalog (439 sizes at 15 to 18 inch, 92 at 12 to 14, 379 at 19 to 24), the
  per-batch checklist (coverage complete, dry-run, `--complete` import, confirm
  on /owner), the stop rule on a supplier challenge, and honest time bounds.
- Live end-to-end test on f42610f, 03:00 to 03:12Z: customer submit, owner
  Approve & Send, customer pay, cold link by id, owner Mark done, customer sees
  done; every step rendered and the server recorded them as versions 1 to 4 of
  one request. Nothing failed. Details under "Verified live".
- Fixes made because they blocked the workflow: none were needed.
- Role knowledge stacks under `.forge/roles/`, asked for by the user so
  successors start where these agents ended: `repo-agent.md` (#83, `12cc746`,
  merged by the lead as second reader), `swe-owner-screen-lane.md` (#82),
  `swe-scraper-lane.md` (pending, written between walk chunks), and the lead's
  own `lead.md` in this update.

### Verified live

Request `d6dab88175459eea653db6f3817e5756` on `f42610f`, 2026-09-06 03:00 to
03:10Z. Customer side by SWE-S AGENT 2 (emulated phone, 375 wide, driving the
page's own handlers because the browser pane rendered hidden); owner side by
the user on their own device.

| step | device / context | result |
| --- | --- | --- |
| submit: 205/65R15, Waterfall Quattro $42.04, vehicle "TEST v1 baseline 2026-09-06", name and email, location, date today | phone | request created, draft $92.03; acknowledgement "Ken reviews it before anything is charged"; /status at step 1, chip DRAFT, cancel action; no overflow |
| owner sees it beside their own hand-test draft, contact shown, Approve & Send | user's device | chip SENT in place; server: status sent, version 2 |
| customer reloads, pays | phone | chip SENT then PAY $92.03; /confirmation "Payment confirmed", amount $92.03; server: paid, version 3 |
| cold link by id, key deliberately cleared | third context | chip PAID, "Payment received. Your service is confirmed." |
| owner confirms paid, Mark done | user's device | server: status done, version 4, 03:11:33Z |
| customer sees done | phone | chip DONE, "Fitted. Thanks for choosing KMT."; all four stepper steps complete |

Read-only alongside: `/api/catalog` 1083 rows; `/api/owner/inventory` 401
without a session; no horizontal overflow on / and /status at 375.

### Known broken or incomplete

- **Supplier data ships in the public bundle** (scrutiny finding 1, verified
  live by the lead on 2026-09-06: the deployed JS carries 1083 SKUs, 1085
  supplier list prices, 1088 supplier URLs and the markup rate, so KMT's
  margin on every tire is computable by anyone). Cause: `src/data/catalog.js`
  imports `scraped-tires.json` for the static fallback. This breaks R16 and
  grew with #59. Fix is the same change as "snapshot out of the client bundle":
  the fallback keeps seeds plus generated rows, the snapshot seeds the backend
  only, plus a build check that fails if `dist` contains `listPrice` or `sku:`.
  Decision recorded: the user said fix it; assigned to SWE-S AGENT 2 as the
  first of three tasks (t39 in `state.json`); the gate check is the repo
  agent's. Delivered: #110 `bdc399a` (t39) and #114 `59c28ce` (the gate
  step, after the check was shown to fail on a leaking build); the deployed
  asset measured 250,887 bytes with zero `sku:`, `listPrice:`, `scrapedAt:`
  or `stock:` markers, and the leak stayed closed across the three merges
  since, with the check running on each.
- **Invented tires are orderable on the live site** (finding 2): 906 of 910
  sizes show generated placeholders, and the six seed tires sit beside real
  ones; a customer can be quoted, approved and charged for a tire that does
  not exist. The cheap guard is one rule in `src/pricing.js`: a tire whose id
  does not start with `giga-` becomes an exception reason, so the owner's
  approval gate catches it. The full fix is the all-sizes walk. Decision
  recorded: the user said add the guard; assigned as t40, after the leak fix.
  Delivered: #111 `afcb481` (t40); the audits' clean path now resolves a real
  supplier tire from `/api/catalog` instead of a seed by name, and
  `src/pricing.js` is server-side only, so this change never moved the
  public bundle.
- **Public POSTs have no rate limit** (finding 3): fine today, an open relay
  the day t37 sends email. Adopted as a constraint on t37's brief: per-IP and
  per-key throttling on submit, pay and cancel, and no customer email until
  the owner has sent the quote.
- The scrutiny agent's full report (20 findings) is filed as issues #61 to
  #80, one per finding, each marked verified by the repo agent or relayed
  unchecked. Verified: 1 (the leak; #61), 4 (backend lint has zero rules), 5,
  7, 9, 16. Nothing is assigned from them without the user's decision.
- The scrutiny agent's second pass (relayed to the repo agent for the issue
  list, #84 to #107, with corrections commented on #61, #72, #79, #80) adds,
  checked: the "no compression, 850 KB" finding was wrong, Fly's proxy serves
  brotli and a phone downloads about 213 KB before the first price, though
  `/api/catalog` is `no-store` and refetched every visit (#84, downgraded);
  AA contrast failures on brand red under
  white text and the muted greys at 375; `KMT_SESSION_HOURS` unvalidated
  (a non-number silently locks the owner out); Chromium running as root in
  the container; no Fly health check; and `SameSite=Strict` on the owner
  cookie, which will send the owner to sign-in from every t37 email link
  (`Lax` plus a request deep link on /owner/quotes must precede t37). And
  unplanned: **quantity** (every job is two or four tires and the flow quotes
  one, so every real quote is under-quoted until the owner decides), tax and
  invoice lines before the email, service area, sign-out, iOS clearing the
  status key after seven days, backups and retention, a privacy notice,
  monitoring, the client's own domain, every merge redeploying production,
  screens that never refresh, and whether "supplier price" is retail or
  dealer cost. Quantity is delivered: the form asks 1, 2 or 4, default four
  (t41, #112 `df196ce`, deployed green at 04:36Z); the tire line multiplies,
  the mobile-service fee stays one line, and four of a non-supplier tire
  still multiplies (intersection test). The audits do not yet exercise the
  picker; that gap is #113. The supplier price is the public retail listing, which
  is what Ken pays today (user, 2026-09-06); the markup is on retail by
  design until he has a commercial or dealer account.
- `state.json` had t34 as todo after #53 merged it; corrected in the first
  update. m11 (t39 to t41) is closed as done in the second, all three live.
  m10 stays planned: t35, t37 and t38 remain.
- The owner-inventory audit is real but ungated (no workflow runs it).
- `git worktree remove` on this machine fails once with permission denied and
  succeeds on retry; seen three times, harmless, worth a NOTES.md line.
- A future quote status means another table rebuild through `migrate()`: the
  status list is still a database CHECK, widened, not removed.

### Direction from the user after the migration landed

Pricing logic, including installation, shipping and taxes, is deferred to a
later issue; the 1.5 rate and the eight owner prices found in production were
exploration, and t35 (the owner adjusting a quote) is out of the current
push. What matters next: a production database with real supplier stock on
every size the customer can select (today 4 of 910), and a documented monthly
supplier refresh, with supplier prices imported and the markup rate applied
automatically as now. After that, the m10 plan resumes.

### Recommended next step

- Done: the snapshot is out of the client bundle (t39, #110) and the check
  job fails on supplier markers in `dist/` (#114).
- The all-sizes walk, under way in SWE-S AGENT 1's lane, writing to
  `C:/Users/anune/kmt-walk/supplier-walk.json` outside the repository and
  reaching production only through `import-tires` run by the user (the guard
  from #51 refuses `--complete` for any size not fully read, so single-page
  sizes import as partial coverage automatically). Pilot of 27 sizes at 15
  inch: 18 complete, 9 "blocked or unexpected page" interleaved with successes
  (probably empty listings, retest pending), 1114 tires, 5.4 s per page across
  two independent measurements. Of the 18, 12 needed one or two pages, so a
  single page per size is often the whole inventory. Plan: breadth-first pass
  over the remaining 879 sizes at one page each (about 80 minutes), then deep
  batches for the common sizes. Imports were held until the live test ended.
  The monthly runbook is `docs/supplier-refresh.md` (#60). Status at 04:40Z:
  11 of 36 chunks written, 2241 tires across 156 sizes, 61 of them complete;
  chunk 12 ended on a browser crash ("Target page, context or browser has
  been closed"), not a supplier block, and the walk session is restructuring
  for speed at the user's own direction. The import is still one command, run
  by the user, after the walk.
- Still not started: `/api/catalog` moves from `no-store` to a public
  five-minute max-age, decided 2026-09-06, backend lane.
- Then t37 email, which needs the user's provider account and a verified
  sending domain, with the rate-limit and SameSite constraints above. t35
  waits for the pricing decision.

### What the production database actually held before the reset

The previous handoff said "no owner price is set in production; every price
is the placeholder markup". Both halves were wrong, found by the repo agent
reading the database over ssh on 2026-09-06: 8 offers, all priced and enabled
(set 19:07 to 22:23 on 2026-09-05; one carried a plainly exploratory note), a
markup rate of 1.5 marked as deliberately set at 22:23 the same day, and three
requests: two fabricated by the flow audits before #42 made the post-deploy run
read-only, and the t33 TEST request. The lead stopped the reset and asked the
user whether the rate and prices were real; the answer and what was done are
recorded under "Completed". Lesson: a handoff statement about production data
is a claim to verify over ssh, not a summary to carry forward.

### The database reset, and how to tell it happened

Three facts the repo agent established by reading the code, which the obvious
plan gets wrong:

- **The seed is silent.** `Inventory.importSnapshot` logs nothing; the boot log
  shows only "listening" and "Database: /data/owner.sqlite". Do not look for a
  seed line.
- **Merging a new `src/data/scraped-tires.json` does not change the live
  catalog.** Seeding runs once, guarded by the `seeded` flag already set in
  production. A deploy carrying a new snapshot imports nothing; that is correct
  behaviour, not a failed import, and it is why the reset must follow the
  scrape PR, not precede it.
- **The decisive check is the old TEST request answering 404.** Before the
  reset `GET /api/requests/f80ada133275b41c327b6c35fb5555a4` returns 200; after
  a real reset it returns 404. A catalog count is evidence only once the
  deployed snapshot's tire count differs from the old 118 and the expected
  number was stated before the reset.

Note for the next lead: an agent's own permission layer refused the first
destructive `mv` over ssh (the auto-mode classifier), independently of the
user's instruction and the lead's authorisation. The correct response, which
the repo agent gave, is no retry and no reshaping; the user either approves the
action in that session or runs the commands themselves. flyctl on Windows prints
"Error: The handle is invalid" after each ssh command; that is a console quirk,
not a failure.

Runbook, as executed on 2026-09-06: the read-only lines by the repo agent with
the user's authenticated CLI at `C:/Users/anune/.fly/bin/flyctl.exe` (not on
PATH), the destructive lines by the user after the agent's permission layer
refused them; one simple remote command per call so nothing needs nested
quoting. Everything destructive is a rename;
the `.old` files stay on the volume beside the user's snapshot
(`vs_O717p6ZzqQnFz9BZ1z45bXR` on `vol_42k8dgjpg8jo3j34`).

```
flyctl volumes snapshots list vol_42k8dgjpg8jo3j34
flyctl ssh console -a kmt -C "ls -la /data"
flyctl ssh console -a kmt -C "mv /data/owner.sqlite /data/owner.sqlite.old"
flyctl ssh console -a kmt -C "mv /data/owner.sqlite-wal /data/owner.sqlite-wal.old"   # if ls showed it
flyctl ssh console -a kmt -C "mv /data/owner.sqlite-shm /data/owner.sqlite-shm.old"   # if ls showed it
flyctl ssh console -a kmt -C "ls -la /data"
flyctl machine restart d89459da9703e8 -a kmt
flyctl logs -a kmt --no-tail
curl -s -o /dev/null -w "%{http_code}\n" https://kmt.fly.dev/api/requests/f80ada133275b41c327b6c35fb5555a4   # expect 404
```

Then, read-only: `/api/catalog` row count equals the deployed snapshot's tire
count (stated in advance), distinct sizes equal the snapshot's `sizes`, no row
carries a supplier, cost or markup field, and the deployed-site check passes.

Merge is deploy; a deploy carrying a migration runs it on first boot; rolling
back a commit restores code, not data.
