# Ken's first week: the sprint after launch

Written by the DEV-PRODUCT MANAGER (`local_c91d84bb`) with the CUSTOMER
SUCCESS MANAGER (`local_a76ad1cd`) on 2026-09-06, and **ruled on by the OWNER
AGENT (`local_44d1e1f9`): approved with the amendments carried below.** The
PROJECT MANAGER (`local_5b6d8402`) owns how, who and when from here; the repo
agent owns the gate and every merge. Every number names where it was
measured. The CSM's figures are from its re-run on `c399b2a` (method: PR #213;
the m13 measurements: PR #148; throwaway server on port 4293, scratch database
from the tracked snapshot, two TEST drafts, one rejected through the UI, every
number from the scripts' JSON; screenshots `needs-you-card-375.png` and
`customer-declined-375.png` in its session).

## The goal, in one sentence

By the end of Ken's first week live, a customer who is turned down or kept
waiting is told so kindly and can reach Ken with one tap, a mis-tap cannot
decline anyone, Ken's decision screen is a glance again, a customer's call is
answered from one search, every message the system promised arrives, and the
first true number about the business exists.

## Two lists, not one

Nothing here weakens the owner approval gate: every item leaves Approve &
Send as the only way a quote reaches a customer. Gate 3 is planned around,
not through.

### User-gated, not sprint work

The team cannot do any of these. Each is a command with its proof and its
rollback in `docs/operations.md`, except the first, which is a decision.

1. **The sending provider.** Not settled. Measured tonight with a positive
   control on every query: Resend is verified (`resend._domainkey`, a 218
   character TXT; `v=spf1` on the `send` subdomain; the `send` and `rsend`
   CNAMEs resolving). Google Workspace is not: the root carries only a
   `google-site-verification` TXT and no `v=spf1`; `google._domainkey` is
   absent; the Google MX set is present. `docs/operations.md:1004` records
   "Google Workspace is the only sender. Resend was cancelled on
   2026-09-06", and the user has since told the OWNER AGENT to use Resend;
   neither instruction can be dated against the other, and the user has been
   asked. A domain is verified for a specific sender, never "for sending".
   **Standing hazard until the decision:** `docs/operations.md:1040-1049`
   tells the operator to delete the `rsend` CNAME and hunt an apex TXT, and
   those are the records that make Resend work today. Nobody executes any
   DNS row until the provider is decided and that table is corrected.
2. **t38, turning email on**, sized by the decision. The mailer on `main` is
   a generic SMTP adapter (`backend/mail.mjs:53-70`) and the outbox row is
   written for every event whether or not mail goes out (`backend/api.mjs`
   290, 291, 309, 415, 419). Resend branch: `smtp.resend.com`, user `resend`,
   the API key as password (in the user's ignored `secrets/resend.txt`), a
   from-address on the verified domain, the user's own address as owner and
   as the TEST customer; one `flyctl secrets set`, one restart, no pull
   request; the adapter's only warning path (`mail.mjs:80-82`) stays quiet
   because `resend` has no domain. Workspace branch: the same secrets at
   `smtp.gmail.com` with an App Password, but deliverability needs the root
   `v=spf1 include:_spf.google.com ~all` and `google._domainkey`, which need
   domain admin the user has said they do not hold. Proof either way: the
   TEST exchange in two inboxes and the outbox reading `sent`, recorded as
   Gate 4.
3. `KMT_ALLOWED_HOSTS` with all four names; proof: `/api/health` 200 on each.
4. `KMT_CANONICAL_HOST=kensmobiletire.com`; proof: `www`, `order` and
   `kmt.fly.dev` 301 to the apex and the owner cookie survives. Measured now:
   both answer 200, so it is not set; `x-kmt-release: 4265010`.
5. Service-area enforcement back on; proof: `x-kmt-service-area: on`
   (measured now: `off`).
6. The restore drill, with `.forge/restore-integrity-check.mjs` proving the
   data came back, recorded in `HANDOFF.md`. Never run.

Gate 2 closed with t47 (the owner cookie is `Lax`). The PROJECT MANAGER wants
#238 (AA contrast and tap targets at 375) and #244 (the release-header
assertion) merged before the live test; this plan agrees.

### Team work, ranked by harm to a person (the OWNER AGENT's order)

**1. The email HTML anchors.** `htmlOf` in `mail-templates.mjs` renders every
body as escaped text inside a `<pre>` and produces zero `<a>` tags, so the
status link and "Text me at (617) 410-8319" are bare text in all five
emails, tappable only if a client guesses, and `sms:` never. The fix is two
anchors in the HTML part, the status URL as `<a href>` and "Text me" as
`<a href="sms:+16174108319">` using the same value `src/contact.js` exports
as `TEXT_HREF`; the plain-text parts stay as they are. Why first: a person
with a flat at hour six reloads once and then looks for a number to call,
and t63 replaced calling with a text they cannot tap from the email. Certain
harm, every customer, every message, two lines of fix. One backend PR with a
template test asserting the two hrefs. (CSM, confirmed by the PM.)

**2. Reject gets a confirmation and a reason box.** Today Reject is one tap,
no confirm, no reason field; the reject route passes only the version and
the outbox row carries `reason: null`, so the decline email's reason branch
is unreachable and a mis-tap declines a real customer and mails them, which
cannot be unsent. Cancel's `asks: true` component already has both; reuse
it. The route takes the reason; the template carries it only when present.
The cheapest item on the board and the only one where a slip is
unrecoverable. One UI PR and one small backend PR.

**3. Declined-path copy.** "Declined", not "REJECTED", on the chip; the text
link on the declined state (Status.jsx line 152 renders none; `TEXT_HREF`
and `TEXT_LABEL` are already imported by the screen and rendered only in the
no-requests panel at line 104); the reason shown when present; "submit a new
request" only when Ken's reason says what to change. Measured (CSM, walked
as a person): the customer's page today reads "REJECTED", "This quote was
declined. Please submit a new request.", a New Request button, no number, no
reason; the email itself is kind and carries the way back. One UI PR, the
junior with LEAD UI reading; the lines are the lead's per t62 and are
drafted in item 4.

**4. Waiting expectations, and the decision screen's weight, as one
problem.** Copy only, both sides, in Ken's voice, promising no time and
giving the way back at hour zero: in the received email and on the waiting
state of `/status` (line 147, which today reads "This quote is awaiting
owner review." with no text link): "I answer most requests within a few
hours on working days. If you need it today, text me at (617) 410-8319."
With it, because it is the same screen getting harder to operate correctly:
t35's inline editor collapses behind one "Adjust quote" control (most quotes
need no adjustment, so an always-open editor inverts the default), and the
owner nav that wraps to three rows at 375 becomes one. Measured (CSM): the
first "Needs you" card is 1,001 px tall (1.2 screens), Approve & Send sits
1,260 px from the top, seven inputs per card, five nav controls on three
rows. One UI PR for the copy on both states and the collapsed editor; the
email line rides with item 1's template PR.

**5. Phase A of the issue sweep.** Close what is already done, one comment
per issue naming the artifact, verified at the moment of closing. Measured
tonight by two planners independently ranking finished work: #105 (supplier
stock and last-seen on the card, `QuoteRequests.jsx:264-278`) and t35 (the
`QuoteEditor`) are on `main` with their issues open. The repo agent, from
the issue list against `main`.

**6. m13.1, owner request lookup.** `GET /api/owner/requests?q=` matched
server-side against name, email, normalised phone, vehicle and request-id
prefix; one search box above the tabs; counts unchanged by `q`; as
`m13-owner-day-to-day.md` specifies. Measured (CSM, `c399b2a`): `/owner/
quotes` still has 0 inputs outside the cards; owner search at the
post-import count is 10 ms (m13 doc). Volume-dependent: re-ranked after week
one, and to the top if Ken is fielding calls he cannot match. Two merges
(backend with a test per field and the empty match; the box).

**7. m13.2, a note on a request, and who this customer is.** A nullable
`owner_note` column through `migrate()` with an old-schema test, saved
through `moveTo()` so two windows 409, a textarea on the card, "N earlier
requests from this email", never in the customer shape. Measured: nothing
links two requests from the same person; the only free text on a request is
the cancel reason. Migration first (DB ADMIN), then the save path and card;
sequenced alone in `backend/quotes.mjs`.

**8. The funnel report, phase one, which is also Ken's time-to-answer.** As
`.forge/funnel-report.md` specifies (#263, #266): read-only, owner session
only, fixture-proven, no personal column; request to quote and quote to
payment as median and slowest decile from the outbox's per-event rows, the
exception rate by reason, conversion by status, requests per day. The owner
visible time-to-answer the CSM asked for and this report are one
measurement, built once. `quotes.updated_at` is overwritten on every
transition (`quotes.mjs:669`), so the outbox is the only event log, and its
rows must be seen for real on production before building; t38 provides them.
Name the four numbers now (submitted, decided, paid, median time to answer)
and read them at day 7. Two merges, after real rows exist.

**9. m13.3's bulk offer, without the table.** "Offer everything in stock at
markup" and "Clear this size" per committed size as transactional routes
naming their counts, refused mid-refresh like the import; the cards stay.
Measured (CSM): 12 pages, 24 Save buttons a page, 281 saves per size,
unchanged; a by-brand bulk enable has landed (`PUT /api/owner/offers/
by-brand/`, `inventory.setBrandEnabled`), so per-size is the same shape with
a different filter. Not higher because the customer catalog already
composes every active supplier row at the markup rate (`src/markup.js`), so
an offer is an override, not a gate. Two merges.

**10. #104, the customer half.** A 15-second poll on `/status` while the
document is visible; 0 polling anywhere today. One small UI PR.

**11. t65, inquiries to completion**, only if #271 is green and reviewed, and
only after Gate 3: a new table, endpoint and route do not land in a cutover
window. `backend/inquiries.mjs` is imported by nothing but its own test
today, so the feature is a table never created in production.

### The sweeper, ruled

For a request nobody touches for hours (measured: nothing happens at any
hour today; no reminder to Ken, no message to the customer, no scheduler in
the app; the only cron is GitHub's health monitor): the nudge to Ken (a
15-minute sweep in the server, one "still waiting" outbox row of a new type
at N hours, sent once) is approved in principle after week one, and is to be
described as partial, because email reaches a pocket only if his mail
notifies and no SMS path to Ken exists. The customer-side message at M hours
is held and returns to the OWNER AGENT for a fresh ruling with week-one
data, not automatic entry, because it can be worse than silence and promises
a responsiveness not yet known to be keepable. The number that decides it,
named so it is not re-argued from taste: build the customer message when
week-one data shows Ken's median answer time exceeds M; if his median is well
under M, it is a message that arrives to tell people about a problem they do
not have. Item 8's figure is what decides both. And the waiting copy of item
4 ("if you need it today, text me") is inert until item 1's anchors land,
which is one more reason the anchors go first: the roadside case is answered
at hour zero by a tap that works, not by a timer.

## What this sprint cuts, and why

- **m13.3's per-size table.** The largest change to what Ken sees for a job
  he does not have to do this week; the bulk action gives him one-action
  pricing; the table follows on the measurements already taken.
- **t66, socials and testimonials.** No `site-content.json` and no content
  from Ken; one small PR the day the content arrives.
- **The refusal count and phases two and three of the funnel.** The OWNER
  AGENT's rulings stand.
- **m13.5 and m13.6.** The inventory index waits for the deep pass; the
  summary-once change is a transfer improvement Ken does not feel today
  (3.7 s cold to the password field, m13 doc).
- **The walk and the deep pass.** Background, on the pacing change and the
  user's word.
- **#94 and #97.** Settled by the OWNER AGENT and left open; not sprint work.
- **Done, not candidates:** t35 (the quote editor) and #105 (stock on the
  card), both on `main`, closed by item 5.

## Constraints the plan is built under

- **No new sessions.** Every item is owned by an existing session, which
  delegates to its own subagents; the session holds the claim and the report.
- **Merge rate is a deploy input.** Eleven merges in one hour cancelled seven
  queued deploys tonight, and a cancelled deploy is forgotten, with production
  an hour behind while every check was green. The repo agent merges one code
  PR at a time and watches its deploy to green before the next; docs-only PRs
  batch and no longer redeploy (#103). Three code merges an hour is the
  ceiling, not the target.
- **The owner approval gate is untouchable.**
- **Measure before claiming.** Every "how many" above has a source.

## Owners, without new sessions (a proposal for the PROJECT MANAGER's sequencing)

| item | session that owns the claim and the report |
| --- | --- |
| the provider decision, t38's secrets, the four cutover steps | the user; the QA TESTER reads both inboxes and the outbox and records Gate 4 |
| 1 the email anchors, 2's reject route, 7's save path, 8's backend | LEAD BACKEND DEV |
| 2's confirm and reason box, 3, 4's copy and collapsed editor, 10 | JUNIOR FRONT END DEV with LEAD UI ENGINEER as first reader; LEAD UI takes 6's box and 9's buttons |
| 7's migration, 9's routes, second reads on `quotes.mjs` | DB ADMIN |
| 5 the issue sweep; every merge, one at a time, watched to green | the repo agent |
| audits for reject-with-reason, search and the bulk action; `EXPECTED_CHECKS` | QA ENGINEER |
| the acceptance walk of each item as a person at 375 before it is called done; the week-one numbers; two verifications before week one: that the duplicate size-and-name ruling landed (175 of 5,976 pairs), and whether the QA TESTER's Parts B and C actually ran, since the PM's record says Part B ran on production and the CSM's says it did not | CUSTOMER SUCCESS MANAGER |

## Definition of done

The CSM has walked each item as a person on a phone against production and
written the line in `HANDOFF.md`, and Ken has used search and the note on a
real request. Not "the audits pass": two of today's worst findings survived
every test and were caught by someone reading the output.

**Which items are walked at 375 before "done"** (the method is
`.forge/roles/owner-portal-analyst.md`, PR #213, under a minute per screen):
t38 (two real inboxes, every link in every email tapped on a phone, the
`sms:` one included); item 1 (the same tap, on the declined email
specifically); item 2 (Ken's screen at 375: the confirm appears, the reason
box appears, the reason reaches the outbox row and the customer's page);
items 3 and 4 (the customer's `/status` in the waiting and declined states,
the text link present and tappable; the Needs-you card's height, Approve's
offset from the top and the nav rows re-measured with the driver); item 6 (a
request found by name, by phone and by reference); item 7 (the note saved
and shown after reload; the history line); item 9 (the count in the response
matches the rows on the screen; a priced row untouched). Read instead of
walked: item 8 (the four numbers), item 5 (the closing comments), the
sweeper (nothing built this week).

**The resourcing condition.** The acceptance walk and the week-one read are
the CSM's, and they need a session holding that role awake; the CSM's own
session was spun down before tonight's brief woke it. If no session holds
the role, the definition of done silently degrades to "the audits pass",
which is what tonight's worst findings survived. So: the OWNER AGENT has put
the session question to the user; until it is answered, the QA TESTER
(`local_af51bbb2`) walks by the same method and the CSM reads the week-one
numbers when it is next awake. Whoever walks, writes the line in
`HANDOFF.md`; an item without the line is not done.

## What this document does not decide

The sender (the user). The sweeper's thresholds and the customer-side
message (the OWNER AGENT, with week-one data). The exact lines Ken's
customers read (the lead, per t62; drafts above). Whether the walk resumes
(the user). Anything here that is wrong should be re-measured the same way
and this file corrected, not argued from memory.
