# Ken's first week: the sprint after launch

Written by the DEV-PRODUCT MANAGER (`local_c91d84bb`) with the CUSTOMER
SUCCESS MANAGER (`local_a76ad1cd`) on 2026-09-06 at `origin/main` `37ddc1f`,
on the OWNER AGENT's brief (`local_44d1e1f9`, who rules; this document plans).
The PROJECT MANAGER (`local_5b6d8402`) owns how, who and when once the OWNER
AGENT has ruled; the repo agent owns the gate and every merge. Every number
names where it was measured. The CSM's measurements are from its re-run on
`c399b2a` today (throwaway server on port 4293, scratch database from the
tracked snapshot, two TEST drafts, one rejected through the UI; screenshots
`needs-you-card-375.png` and `customer-declined-375.png` in its session, from
`owner-shots.mjs`, `after-extra.mjs` and `declined-walk.mjs`).

## The goal, in one sentence

By the end of Ken's first week live, a customer's call is answered from one
search, Ken remembers what he told them last time, a customer who is turned
down or kept waiting is told so kindly and given the way back, every message
the system promised actually arrives, and the first true number about the
business exists.

## What starts nothing: Gate 3, in the user's hands

Nothing below starts on production before Gate 3 of `sprint-live.md` closes,
and the team cannot close it. Measured on production at the time of writing:
`x-kmt-release: 4265010`, `x-kmt-service-area: off`; `https://kmt.fly.dev/`
and `https://www.kensmobiletire.com/` answer 200, not 301, so
`KMT_CANONICAL_HOST` is not set; `KMT_ALLOWED_HOSTS` is not set; the restore
drill has never been run. Gate 2 closed with t47 (the owner cookie is `Lax`).
The four steps are the user's, each written as a command with its proof and
its rollback in `docs/operations.md`:

1. `KMT_ALLOWED_HOSTS` with all four names; proof: `/api/health` 200 on each.
2. `KMT_CANONICAL_HOST=kensmobiletire.com`; proof: `www`, `order` and
   `kmt.fly.dev` answer 301 to the apex and the owner cookie survives.
3. Service-area enforcement back on; proof: `x-kmt-service-area: on`.
4. The restore drill, with `.forge/restore-integrity-check.mjs` proving the
   data came back, recorded in `HANDOFF.md`.

Then the live test on the apex (t56). The PROJECT MANAGER wants #238 (AA
contrast and tap targets at 375) and #244 (the release-header assertion)
merged before the live test, so the cutover is verified by the stronger gate;
that sequencing is the PM's and this plan agrees with it.

**Email DNS is not a Gate 3 item until a sender is chosen**, and the sender
is an open decision of the user's. Measured tonight, positive control on
every query: Resend is verified (`resend._domainkey` TXT live, `v=spf1` on
the `send` subdomain, the `send` and `rsend` CNAMEs resolving). Google
Workspace is not: the root carries `google-site-verification` and no `v=spf1`
at all, and `google._domainkey` is absent; the root MX records for Google
exist again. A domain is verified for a specific sender, never "for
sending".

## Constraints the plan is built under

- **No new sessions.** Every item is owned by an existing session, which
  delegates to its own subagents; the session holds the claim and the report.
- **Merge rate is a deploy input.** Eleven merges in one hour cancelled seven
  queued deploys tonight, and a cancelled deploy is forgotten, with production
  an hour behind while every check was green. Rule: the repo agent merges one
  code PR at a time and watches its deploy to green before the next; docs-only
  PRs batch and no longer redeploy (#103). Three code merges an hour is the
  ceiling, not the target.
- **The owner approval gate is untouchable.** Nothing here changes what may
  be sent without Ken; the sweeper option below nudges and tells, and never
  decides.
- **Measure before claiming.** Every "how many" below has a source.

## The candidates, ranked

Rank is value to Ken and the customer in the first week divided by cost,
with risk to the gate as the tie-breaker. The CSM ranked by what each does
for a person; the lead added cost and gate risk; where they differed the
reason is stated.

### 1. Real email, t38, sized on the provider decision the user owes

**What.** Turn on the messages the system already writes. The mailer on
`main` is a generic SMTP adapter (`backend/mail.mjs:53-70`: host, port, user,
password, from, owner email, owner name; the outbox-only null adapter when
none is set). `backend/api.mjs` writes the outbox row for every event
(290, 291, 309, 415, 419), so the rows exist whether or not mail goes out.

**Two branches, different blockers, the user chooses:**

- **Resend**: ready today. Resend accepts SMTP at `smtp.resend.com`, user
  `resend`, the API key as the password (the user holds it in the ignored
  `secrets/resend.txt`). One `flyctl secrets set` with the seven values (one
  restart), a from-address on the verified domain such as
  `quotes@kensmobiletire.com`, the user's own address as owner and as the
  customer on one TEST request, the outbox reading `sent`. No pull request.
  The adapter's one warning path (`mail.mjs:80-82`) compares the from-domain
  with the SMTP user's domain; `resend` has none, so it stays quiet.
- **Google Workspace**: the same secrets pointed at `smtp.gmail.com` with an
  App Password on a Workspace mailbox, or the relay; but deliverability
  needs the root `v=spf1 include:_spf.google.com ~all` and `google._domainkey`
  restored, and the user has said they do not hold the domain admin those
  need. Until they exist, a domain address sent through Google is filed as
  spam while the outbox says sent (the adapter's own boot warning says so).

**Why first.** It is the product's promise: a customer who submits and
closes the tab is otherwise waiting on a callback that never comes. #97 waits
on it, and it produces the real `quote-sent` rows the funnel report's first
rule requires. The planner's recommendation, not a ruling: Resend, because
it is verified today and the seam hides the choice; the user decides.

**Cost.** Resend: the user's fifteen minutes and one restart; the QA TESTER
reads both inboxes and the outbox and records Gate 4 in `HANDOFF.md`.
Workspace: unknown until the admin access exists; if that branch is chosen,
this item drops below items 2 to 4 and the plan is amended, not assumed.

### 2. Owner request lookup, m13.1, with the decision card's weight

**What.** `GET /api/owner/requests?q=` matched server-side against name,
email, normalised phone, vehicle and request-id prefix; one search box above
the tabs; counts unchanged by `q` (per `m13-owner-day-to-day.md`). In the
same UI PR: the inline quote editor t35 added to every draft card collapses
behind one "Adjust quote" control, and the owner nav that now wraps to three
rows at 375 is made one.

**Why.** The first phone call, and the decision screen regressing after t35.

**Measurement (CSM, `c399b2a`).** `/owner/quotes` still has 0 inputs outside
the cards. The first "Needs you" card is 1,001 px tall at 375 (1.2 screens),
Approve & Send sits 1,260 px from the top, seven inputs per card, the editor
open on every draft whether or not Ken wants to edit; the nav is five
controls on three rows. Owner search at the post-import count is 10 ms
(m13 doc). #105 has landed: the card shows "447 in stock · seen 17 hours
ago".

**Cost.** One backend PR (LEAD BACKEND DEV: the parameter, one test per
matched field and the empty match) and one UI PR (LEAD UI ENGINEER: the
box, the collapsed editor, the nav). Two merges. Gate risk: none.

### 3. The declined path, and what a waiting customer is told

**What, part A (the declined path).** A reason box and a confirm on Reject,
reusing the Cancel component that already has both; the reject route carries
the reason; the `/status` chip reads "Declined", not "REJECTED"; the declined
state carries the text number; "submit a new request" appears only when Ken
gave a reason that says what to change.

**What, part B (waiting expectations, copy only).** In the received email
and on the waiting state of `/status`, in Ken's voice: "I answer most
requests within a few hours on working days. If you need it today, text me
at (617) 410-8319." The lines are the lead's per t62; the acknowledgement
still promises no time, it states a norm and gives the way back at hour zero.

**Why.** The two moments a customer with a flat is most alone. Today Reject
is one tap with no confirm and no reason box, so a mis-tap declines a
customer and mails them, and the decision's own ruling ("the reason only
when Ken wrote one") is "never" because there is nowhere to write it. The
email is kind; the page is cold; nothing on the waiting state gives a way
back.

**Measurement (CSM, walked as a person).** Reject: one tap, no confirmation,
no reason field; the outbox row carries `reason: null`; the reject route
passes only the version. Customer page: "REJECTED", "This quote was
declined. Please submit a new request.", no text number, no reason. The
declined email reads well (`mail-templates.mjs`). The waiting state: "This
quote is awaiting owner review." with no text number, and nothing happens at
any later hour (no reminder to Ken, no second message, no scheduler in the
app; the only cron is GitHub's health monitor).

**Cost.** One UI PR (the junior, LEAD UI first reader: the reason box and
confirm, the chip, the two states' copy) and one small backend PR (the
reject route takes the reason; the template carries it only when present).
Two merges. Gate risk: none; declining stays Ken's tap, now a confirmed one.

### 4. A note on a request, and who this customer is, m13.2

**What.** A nullable `owner_note` column through `migrate()` with an
old-schema test; saved through `moveTo()` so two windows 409; a textarea on
the card; the line "N earlier requests from this email"; never in the
customer shape.

**Why.** The second phone call.

**Measurement (m13 doc, unchanged at `c399b2a`).** Nothing links two
requests from the same person; the email is stored but never grouped.

**Cost.** The migration PR (DB ADMIN, storage only, first) and the save path
and card (LEAD BACKEND DEV and the UI lane). Two merges, in
`backend/quotes.mjs`, so sequenced alone.

### 5. The funnel report, phase one, which is also Ken's time-to-answer

**What.** As specified in `.forge/funnel-report.md`: read-only, owner
session only, fixture-proven, never a personal column: request to quote and
quote to payment (median and slowest decile from the outbox's per-event
rows), the exception rate by reason, conversion by status, requests per day.
The first figure is the owner-visible "time to answer" the CSM asked for.

**Why.** The first true number about the business, and the number that
decides whether item 7 is needed.

**Measurement.** `quotes.updated_at` is overwritten on every transition
(`quotes.mjs:669`), so the outbox is the only event log; its rows must be
seen for real on production before building, which item 1 provides.

**Cost.** One backend PR with a fixture test (LEAD BACKEND DEV) and one
owner-screen panel (the UI lane). Two merges, after item 1 has produced real
rows.

### 6. A size priced in one action: the per-size bulk offer, without the table

**What.** "Offer everything in stock at markup" and "Clear this size" per
committed size, as transactional routes that name their counts, refused
mid-refresh like the import; the cards stay this sprint.

**Why.** 281 saves and 320 screens for one size is not a job anyone
finishes.

**Measurement (CSM, `c399b2a`).** Per size: 12 pages, 24 Save buttons a
page, 281 saves, unchanged. A by-brand bulk enable has landed
(`PUT /api/owner/offers/by-brand/`, `inventory.setBrandEnabled`), so the
per-size action is the same shape with a different filter, cheaper than
first costed. The reason it is not higher: the customer catalog composes
every active supplier row at the markup rate already, so a per-tire offer
is an override, not a gate (`src/markup.js`).

**Cost.** One backend PR (DB ADMIN or LEAD BACKEND DEV: two routes beside
the by-brand one, the skip-priced and keep-prices tests) and one small UI
PR. Two merges.

### 7. The request nobody touches for six hours: the sweeper, on the OWNER AGENT's ruling

**What.** A sweep inside the server every fifteen minutes (the machine is
always on and the refresher already runs background jobs): a draft older
than N hours with no reminder yet sends Ken one "still waiting" message; a
draft older than M hours sends the customer one honest message in Ken's
voice, "I haven't got to your request yet; I'm probably on a job. If you
need this today, text me at (617) 410-8319." Each is an outbox row of a new
type, so it sends once; nothing is decided on Ken's behalf. The CSM's
proposal is N = 2 and M = 4; quiet hours are a setting.

**Why.** Every flow assumes Ken acts. Under a car, in the rain, the phone in
his pocket, the customer sees "Owner review" indefinitely and nothing
escalates.

**Measurement.** Nothing happens at any hour today (item 3's measurement).
What is not known is how long Ken takes: there are no real requests yet,
and item 5 answers it after week one.

**Cost.** One backend PR (the sweep, two message types, idempotency and
quiet-hours tests) and two templates. Two merges. The CSM recommends
building it only if week one's numbers show Ken's answers often pass M; the
lead's view is that the customer message costs the same either way and the
roadside case does not wait for a report. Ranked here so the OWNER AGENT
rules on it explicitly rather than by omission.

### 8. Small, if the week has room

The customer half of #104, a 15-second poll on `/status` while visible
(one UI PR, the junior). t65's inquiries to completion, only if #271 is
green and reviewed after Gate 3 (the PM holds it there deliberately: a new
table, endpoint and route are the wrong thing to add before a cutover).

## What this sprint cuts, and why

- **m13.3's per-size table.** The largest change to what Ken sees, for a
  job he does not have to do this week; the bulk action gives him one-action
  pricing; the table follows next sprint on the measurements already taken.
- **t66, socials and testimonials.** No `site-content.json` and no content
  from Ken; a section with nothing in it has no value. One small PR the day
  the content arrives.
- **The refusal count and phases two and three of the funnel.** The OWNER
  AGENT's rulings stand.
- **m13.5 and m13.6.** The inventory index waits for the deep pass; the
  summary-once change is a transfer improvement Ken does not feel today
  (3.7 s cold to the password field, m13 doc).
- **The walk and the deep pass.** Background, on the pacing change and the
  user's word.
- **#94 and #97.** Settled by the OWNER AGENT and left open; not sprint
  work. t35 shipped today and is not a sprint item; its effect on the card
  is item 2's concern.

## Owners, without new sessions

| item | session that owns the claim and the report |
| --- | --- |
| Gate 3 steps, the provider choice, t38's secrets, the TEST request | the user; the QA TESTER reads and records |
| m13.1 backend, the reject reason route, m13.2 save path, the funnel report backend, the sweeper | LEAD BACKEND DEV |
| m13.2 migration, the per-size bulk routes, second reads on `quotes.mjs` | DB ADMIN |
| the search box and collapsed editor, m13.2 card, the bulk buttons, the report panel | LEAD UI ENGINEER, delegating to the junior |
| the declined and waiting states, #104's poll | JUNIOR FRONT END DEV, LEAD UI first reader |
| audits for search, reject-with-reason and the bulk action; `EXPECTED_CHECKS` | QA ENGINEER |
| the acceptance walk of each item as a person at 375 before it is called done; the week-one numbers | CUSTOMER SUCCESS MANAGER |
| every merge, one at a time, watched to green | the repo agent |

## Sequence and gates

1. Gate 3 (the user), with #238 and #244 merged before the live test.
2. The provider decision, then t38 (the user), proven by the TEST exchange:
Gate 4. 3. Item 2, two merges. 4. Item 3, two merges. 5. Item 4, migration
first. 6. Item 5, once real rows exist. 7. Item 6. 8. Item 7 on the ruling.
9. Item 8 if the week has room. Done means: the CSM has walked each item as
a person on a phone against production and written the line in
`HANDOFF.md`, and Ken has used search and the note on a real request.

## What this document does not decide

The sender (the user). Whether the sweeper is built this week and its
thresholds (the OWNER AGENT). The exact lines Ken's customers read (the
lead, per t62; drafts above). Whether the walk resumes (the user). Anything
here that is wrong should be re-measured the same way and this file
corrected, not argued from memory.
