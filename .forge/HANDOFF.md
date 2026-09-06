# Lead handoff, 2026-09-06 (v1 baseline push)

Written by the KMT LEAD AGENT at the end of the v1 baseline push, for the next
lead. Read this, then `roles/lead.md`, `AGENTS.md`, `NOTES.md`, `CLAIMS.md`,
`project.md`, `requirements.md`, `roadmap.md`, `state.json`, in that order.
Everything here was true when written; verify the SHAs, PR states and
production facts before acting on them. The earlier pause-point handoff (at
`598d4e2`) is in git history; its rules now live in `AGENTS.md`, `NOTES.md`
and `roles/`, and its production claims were superseded by what this push
found.

Answered by the user while this was being written: Ken buys at the
supplier's public listed price today, so the markup sits on retail by design,
and the supplier integration is to be revisited when he gets a commercial or
dealer account. Still open: what the renamed sessions (QA ENGINEER, DB ADMIN,
KMT-O PROJECT MANAGER) are meant to become; the outgoing lead kept them in the
roles they had served.

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
  agent's.
- **Invented tires are orderable on the live site** (finding 2): 906 of 910
  sizes show generated placeholders, and the six seed tires sit beside real
  ones; a customer can be quoted, approved and charged for a tire that does
  not exist. The cheap guard is one rule in `src/pricing.js`: a tire whose id
  does not start with `giga-` becomes an exception reason, so the owner's
  approval gate catches it. The full fix is the all-sizes walk. Decision
  recorded: the user said add the guard; assigned as t40, after the leak fix.
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
  dealer cost. Quantity is decided: the form asks, default four (t41,
  assigned third). The supplier price is the public retail listing, which
  is what Ken pays today (user, 2026-09-06); the markup is on retail by
  design until he has a commercial or dealer account.
- `state.json` had t34 as todo after #53 merged it; corrected in this update.
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

- **First, before any all-sizes scrape: take the snapshot out of the client
  bundle.** `src/data/catalog.js` imports `scraped-tires.json`, so the static
  fallback ships every scraped row to the browser; #59's 1083 tires took the
  bundle from 286 KB to 614 KB, and 910 sizes would be tens of megabytes. The
  snapshot should seed the backend only; the fallback keeps the seed tires plus
  generated coverage, and the live catalog comes from `/api/catalog` as now.
  Frontend task, SWE-S AGENT 2's lane, with the audits' by-name seeds unchanged.
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
  The monthly runbook is `docs/supplier-refresh.md` (#60).
- After t39 lands: the bundle check is wired into the check job by the repo
  agent, asserting on `dist/` only for what the fix removed, never before the
  fix (main contains `listPrice` 1085 times until then, so a check first
  would block its own fix); and `/api/catalog` moves from `no-store` to a
  public five-minute max-age, decided 2026-09-06, backend lane, not started.
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
