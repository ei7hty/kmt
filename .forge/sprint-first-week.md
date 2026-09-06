# Ken's first week: the sprint after launch

Written by the DEV-PRODUCT MANAGER (`local_c91d84bb`) on 2026-09-06 at
`origin/main` `c399b2a`, on the OWNER AGENT's brief (`local_44d1e1f9`, who
rules; this document plans) and with the CUSTOMER SUCCESS MANAGER
(`local_a76ad1cd`), whose measurements it cites rather than restates. The
PROJECT MANAGER (`local_5b6d8402`) owns how, who and when once the OWNER
AGENT has ruled; the repo agent owns the gate and every merge. Every number
below names where it was measured; where a number is pending it says so.

## The goal, in one sentence

By the end of Ken's first week live, a customer's call is answered from one
search, Ken remembers what he told them last time, every message the system
promised actually arrives in an inbox, and the first true number about the
business exists.

## What starts nothing: Gate 3, in the user's hands

Nothing below starts on production before Gate 3 of `sprint-live.md` closes,
and the team cannot close it. Measured on production at the time of writing
(`curl -sI https://kensmobiletire.com/`): `x-kmt-release: 4265010`,
`x-kmt-service-area: off`, HSTS and CSP present; `https://kmt.fly.dev/` and
`https://www.kensmobiletire.com/` both answer 200 rather than 301, so
`KMT_CANONICAL_HOST` is not set; `KMT_ALLOWED_HOSTS` is not set (the
runbook's preflight says so). What remains is four things the user does with
their own hands, each already written as a command with its proof and its
rollback in `docs/operations.md`:

1. Step 1, `KMT_ALLOWED_HOSTS` with all four names; proof: `/api/health` 200
   on every name right after.
2. Step 2, `KMT_CANONICAL_HOST=kensmobiletire.com`; proof: `www`, `order` and
   `kmt.fly.dev` answer 301 to the apex and the owner cookie survives.
3. `KMT_SERVICE_AREA` back on; proof: `x-kmt-service-area: on` (decision of
   2026-09-06: enforcing at launch, the switch is a named cutover step).
4. The restore drill, with `.forge/restore-integrity-check.mjs` proving the
   data came back, recorded in `HANDOFF.md`.

Then the live test on the apex (t56) with the user on the owner side. SPF and
DKIM are done: `resend._domainkey`, `rsend` and `send` resolve and the domain
is verified for Resend (OWNER AGENT, measured tonight); off the gate.

## Constraints the plan is built under

- **No new sessions.** Every item is owned by an existing session, which
  delegates to its own subagents; the session holds the claim and the report.
- **Merge rate is a deploy input.** Eleven merges in one hour cancelled seven
  queued deploys tonight, and a cancelled deploy is forgotten. Rule for the
  sprint: the repo agent merges one code PR at a time and watches its deploy
  to green before the next; docs-only PRs batch and no longer redeploy
  (#103). Three code merges an hour is the ceiling, not the target.
- **The owner approval gate is untouchable.** Search, notes, bulk pricing
  and the report change how Ken sees; none changes what may be sent without
  him.
- **Measure before claiming.** Every "how many" below is a number with a
  source, or is marked pending.

## The candidates, ranked

Rank is value to Ken in his first week divided by cost, with risk to the
gate as the tie-breaker. Each entry: what, why, the measurement, the cost.

### 1. Real email, t38, on Resend over SMTP: secrets only, no code

**What.** Turn on the five messages the system already writes. The mailer on
`main` is a generic SMTP adapter (`backend/mail.mjs`: `KMT_MAIL_SMTP_HOST`,
`_PORT`, `_USER`, `_PASSWORD`, `KMT_MAIL_FROM`, `KMT_OWNER_EMAIL`,
`KMT_OWNER_NAME`), and Resend accepts SMTP at `smtp.resend.com` with the user
`resend` and the API key as the password. So t38 is one `flyctl secrets set`
by the user carrying all seven values (one restart), a from-address on the
verified domain such as `quotes@kensmobiletire.com`, the user's own address
as owner and as the customer on one TEST request, and the outbox showing
`sent`. No pull request.

**Why.** It is the product's promise and the cheapest item on this list.
Until it is on, a customer who submits and closes the tab is waiting on a
callback that never comes, which is the experience the product exists to
replace (decision of 2026-09-06 on the fifth message type). #97 (the iOS
seven-day key) is the OWNER AGENT's and waits on this.

**Measurement.** `backend/api.mjs` writes outbox rows at 290, 291, 309, 415
and 419 for the five events; the adapter reads the seven settings at
`mail.mjs:53-70`; the only warning path (`mail.mjs:80-82`) compares the
from-domain with the SMTP user's domain and `resend` has none, so it stays
quiet. Pending, and the funnel report's first rule: nobody has yet seen a
real `quote-sent` row on production; the TEST request proves it.

**Cost.** The user: fifteen minutes and one restart. The team: the QA TESTER
reads the two inboxes (the user's, both sides) and the outbox status, and
records the exchange in `HANDOFF.md` as Gate 4.

**Sequence.** Right after Gate 3, before anything with a pull request.

### 2. Owner request lookup, m13.1

**What.** `GET /api/owner/requests?q=` matched server-side against name,
email, normalised phone, vehicle and request-id prefix; one search box above
the tabs on `/owner/quotes`; counts unchanged by `q`. Exactly as
`m13-owner-day-to-day.md` specifies.

**Why.** The first phone call. A customer reading the first characters of
their status link cannot be matched to a card today except by scrolling.

**Measurement.** `/owner/quotes` has zero input elements and the owner API
takes one parameter, the status view (m13 doc, measured 2026-09-06 at
`d5c6084`; re-measurement at current main pending from the CSM). Owner list
search at the post-import count: 10 ms; at 25,000 rows: 34 ms (same doc).

**Cost.** One backend PR (LEAD BACKEND DEV: the parameter, one test per
matched field and one for the empty match) and one UI PR (LEAD UI ENGINEER
or the junior: the box; the id and age are already on the card since t59).
Two merges. Risk to the gate: none; it reads.

### 3. Stock and last-seen on the request card, #105 (m13.4)

**What.** The supplier's current stock and `lastSeen` for the requested tire
on Ken's card, with "supplier shows 0 in stock" as a warning line before
Approve & Send.

**Why.** It protects the only human gate in the flow: Ken should never
approve a tire the supplier no longer has.

**Measurement.** The data is already on the supplier row; the owner endpoint
does not carry it (m13 doc). Cost is the endpoint carrying two fields and
the card rendering them.

**Cost.** Rides in m13.1's two PRs (same endpoint, same card). No extra
merge.

### 4. A note on a request, and who this customer is, m13.2

**What.** A nullable `owner_note` column through `migrate()` with an
old-schema test (the migration contract), saved through `moveTo()` so two
owner windows 409; a textarea with its own Save on the card; one history
line, "N earlier requests from this email"; the note never in the customer
shape.

**Why.** The second phone call: Ken remembers what he told someone.

**Measurement.** Nothing links two requests from the same person; the only
free text Ken can attach is a cancel reason through a browser prompt (m13
doc). The email is stored but never grouped.

**Cost.** One migration PR (DB ADMIN, storage only, first) and one PR for
the save path and the card (LEAD BACKEND DEV and the UI lane). Two merges.
It touches `backend/quotes.mjs`, the most contended file; it goes after
m13.1 and before t35's PR, which touches the same file (below).

### 5. The funnel report, phase one, as specified in `.forge/funnel-report.md`

**What.** A read-only, owner-session-only report over rows that already
exist: time from request to quote and from quote to payment (median and
slowest decile, from the outbox's per-event timestamps), the exception rate
with the breakdown by reason, conversion by status, requests per day. Proven
against a fixture, never reading a personal column.

**Why.** It is the first true number about the business, and the first
question is whether the product keeps its promise of speed.

**Measurement.** The spec's own correction: `quotes.updated_at` is
overwritten on every transition (`quotes.mjs:669`), so the outbox is the only
event log. Its first rule is a precondition that item 1 satisfies: real
`quote-sent` rows must be seen on production before building. Cost of
waiting on the deferred refusal count is accepted by the OWNER AGENT and not
reopened here.

**Cost.** One backend PR (LEAD BACKEND DEV) with a fixture test; one small
owner-screen panel (the UI lane). Two merges. Sequenced after item 1 has
produced real rows.

### 6. A size priced in one action: the bulk offer of m13.3, without the table

**What.** Two per-size actions on `/owner`, "Offer everything in stock at
markup" and "Clear this size", as transactional backend routes that name
their counts, refused mid-refresh like the snapshot import; the existing
cards stay for this sprint.

**Why.** Curating one size is 281 saves across roughly 320 screens (m13 doc,
`215/60R16`, 791 px mean card height at 375). The action is what Ken needs;
the table is how the screen catches up with it.

**Measurement.** As above; and the reason it is not higher: the customer
catalog already composes every active supplier row at the markup rate, so a
per-tire offer is an override, not a gate (`src/markup.js`). Ken's customers
see prices today whether or not he curates.

**Cost.** One backend PR (DB ADMIN or LEAD BACKEND DEV: two routes, the
skip-priced and keep-prices tests) and one small UI PR (two buttons above
the list and the count line). Two merges.

### 7. The status page refreshes itself, customer half of #104

**What.** A 15-second poll on `/status` while the document is visible.

**Why.** A customer waiting on their phone sees "sent" arrive without
reloading; the tester found the page never updates on its own (charter
line B).

**Measurement.** Pending from the CSM's re-measurement; the finding is the
tester's, on production, 2026-09-06.

**Cost.** One small UI PR (the junior). One merge. The owner half only if
Ken asks.

### 8. Inquiries, t65, to completion

**What.** The route, the form under Services, the owner "Inquiries" list and
the sixth message type, on the storage that is already on `main`
(`backend/inquiries.mjs`). PR #271 is open from the TERRA agent.

**Why.** Ken's other work; the user asked for it. It is not what the first
phone call is about.

**Measurement.** `backend/inquiries.mjs` is imported by nothing but its own
test (funnel-report spec), so today the feature is a table that is never
created in production. #271's state at merge time decides whether it is a
finish or a start.

**Cost.** If #271 is green and reviewed, one merge plus the owner list and
the message type, two more; otherwise it is the whole feature and it moves
to the cuts.

## What this sprint cuts, and why

- **m13.3's per-size table.** The largest change to what Ken sees, for a
  job he does not have to do this week (prices already flow at markup). The
  bulk action above gives him the one-action pricing; the table follows in
  the next sprint, on the measurements already taken.
- **t35, the owner adjusting a quote before sending.** In progress from a
  GitHub-only agent (#224); it edits `backend/quotes.mjs`, the same file as
  m13.2, and pricing is deferred by the user. It is not a commitment of this
  sprint: its PR merges when it is green and reviewed, after m13.2's
  migration has landed, and not before. If it is not ready by the end of the
  week, it waits.
- **t66, socials and testimonials.** No `site-content.json` exists and Ken
  has supplied no handles or quotes; a section with no content has no value.
  It starts the day the content arrives, as one small PR.
- **The refusal count and phases two and three of the funnel.** The OWNER
  AGENT's rulings stand: the refusal band rides with the next legitimate
  edit of `submit()`, post-cutover; visitor counting is held.
- **m13.5 and m13.6.** The inventory index waits for the deep pass; the
  summary-once change is a transfer improvement Ken does not feel today
  (3.7 s cold to the password field on production, m13 doc).
- **The deep pass and the walk.** Background, on the pacing change and the
  user's word; not sprint work.
- **#94 and #97.** The OWNER AGENT's; not reopened.

## Owners, without new sessions

| item | session that owns the claim and the report |
| --- | --- |
| Gate 3 steps, t38 secrets, the TEST request | the user; the QA TESTER reads and records |
| m13.1 backend, m13.2 save path, the funnel report backend | LEAD BACKEND DEV |
| m13.2 migration, the bulk-offer routes, second reads on `quotes.mjs` | DB ADMIN |
| m13.1 box, #105 on the card, m13.2 card, the bulk-offer buttons, the report panel | LEAD UI ENGINEER, delegating small pieces to the junior |
| #104 poll | JUNIOR FRONT END DEV |
| audits for search and the bulk action, `EXPECTED_CHECKS` | QA ENGINEER |
| the re-measurement of m13 at current main; the acceptance walk of each item as a person, at 375, before it is called done | CUSTOMER SUCCESS MANAGER |
| every merge, one at a time, watched to green | the repo agent |

## Sequence and gates

1. Gate 3 (the user). 2. t38 (the user), proven by the TEST exchange:
Gate 4. 3. m13.1 with #105, two merges. 4. m13.2, migration first. 5. The
funnel report, once real rows exist. 6. The bulk offer. 7. #104's poll.
8. t65 if #271 is ready. Done means: the CSM has walked each item as a person
on a phone against production and written the line in `HANDOFF.md`, and
Ken has used search and the note on a real request.

## What this document does not decide

Whether t35 ships this week (the OWNER AGENT, on its PR's state). The
wording Ken reads (the lead, per t62's rule). Whether the walk resumes
(the user). Anything here that is wrong should be re-measured the same way
and this file corrected, not argued from memory.
