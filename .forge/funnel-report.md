# The funnel report (phase one): what we can already answer, and from where

Written 2026-09-06 by the MARKETING AGENT (`local_d80272eb`) for the backend
lane, which owns `backend/` and will build this. **Approved by the product
owner (OWNER AGENT) as the whole of what is to be built now**; the PROJECT
MANAGER owns staffing and sequencing. Growth wrote the spec and is not
building it.

**The problem this answers:** nothing records how the business is doing. There
is no denominator anywhere — not for visits, not for conversion, not for how
long a customer waits. Phase one is deliberately the part that needs **no new
collection of any kind**: a read-only report over rows that already exist.

## Correction to the proposal this came from, before anything is built on it

The message that won approval said time-to-approve and time-to-pay were
recoverable from `created_at` and `updated_at`. **That was wrong, and a spec
written from it would not have been implementable.**

`quotes.updated_at` is **overwritten on every transition**
(`backend/quotes.mjs:669`, `SET status=?, ..., updated_at=?`). For a quote that
went `draft` → `sent` → `paid`, it holds only the time of the *last* change.
The moment of approval is gone from that row.

**The durable event log is the outbox**, and it is better than `updated_at`
would have been. `backend/api.mjs` records a row per lifecycle event, each with
its own `created_at`, and later transitions never touch earlier rows:

| event | written at | `backend/api.mjs` |
| --- | --- | --- |
| `request-received`, `request-arrived` | submit | 289-290 |
| `quote-sent` | the owner approves (status becomes `sent`) | 410 |
| `payment-recorded` | payment recorded | 308 |

Three things that make this safe to build on, each checked rather than assumed:

- **The mailer is constructed unconditionally** in `backend/server.mjs:132` and
  falls back to a `NullAdapter` when no provider is configured — "the mailer
  decides whether anything is actually sent". So outbox rows exist on the
  hosted server whether or not mail is going out. There is no configuration in
  which the report silently has no data.
- **Redaction preserves the row.** A removal request `UPDATE`s the personal
  columns by `request_id`; it does not `DELETE`. `created_at` survives, so
  timing data is intact for customers who asked to be removed — **and the
  report must never read the redactable columns anyway** (see the rule below).
- **The row is per event, not per state**, so nothing overwrites a timestamp.

## The four questions, in the order the product owner wants them

### 1. How long a customer waits — the product's actual promise

`request-received`.`created_at` → `quote-sent`.`created_at`, per request, and
`quote-sent` → `payment-recorded`.

This is the number to put in front of Ken first. The whole pitch is "a fast
quote instead of waiting on a callback", and nobody has ever measured whether
that is true. Report the **median and the slowest decile**, not the mean: one
forgotten request skews a mean and hides the ordinary case, and the slow tail
is the part a customer actually experiences as being let down.

### 2. How often the exception rule fires — a product-integrity question

`quotes.payload` carries `exception` (boolean) and `exceptionReasons` (array),
set by `src/pricing.js:68-69`. Report **the rate, and the breakdown by
reason**.

The breakdown is the point, and it is worth more than the rate alone. The
product owner's framing: if the rule fires on nearly everything, **Ken's
approval stops being a judgement and becomes a rubber stamp**, and the approval
gate is the one thing in this system nothing may weaken. But "80% are
exceptions" is not actionable on its own — "80% are *Truck, pickup, van and SUV
requests require owner review*" says which rule to look at. That is the
difference between a defect report and a number.

There are five reasons in `pricing.js`; report all five even at zero, because
a reason that never fires is also a finding.

### 3. Conversion

Of requests submitted: how many reach `sent`, how many reach `paid`, how many
are `rejected`, how many are `cancelled`. From `quotes.status` plus the outbox
events above.

### 4. Volume

Requests per day from `requests.created_at`. Mostly a denominator for the
three above; on its own it is the least interesting number here.

## Rules for whoever builds it

- **Read-only.** No new columns, no new writes, no migration, no dependency.
- **Never read the personal columns.** This report needs `created_at`, `status`,
  `type`, and the two exception fields. It has no business touching names,
  emails, phone numbers, addresses or location notes, and it must not become
  the thing that quietly re-exposes them. Aggregate output only; no row that
  identifies one customer.
- **If it is exposed over HTTP it sits behind the owner session.** This is
  business data. `/api/` is deny-by-default with a four-route allow-list in
  `backend/api.mjs`; do not widen it.
- **Say what the data cannot cover.** The outbox events arrive with t37, so
  requests older than the mail seam have no event rows and their timing is
  unrecoverable — `updated_at` is destructive, as above. `quote-sent` fires on
  `sent`; legacy rows carrying the older `approved` status have no such event.
  A report that silently drops those rows will read as a volume dip that never
  happened.

## What phase one cannot answer, and is not pretending to

**Everything above the submit button.** How many people reach `/`, how many
start the wizard, which step they abandon — none of that is recorded anywhere,
and no query over existing rows will produce it. Phase one measures the funnel
from the first request onward; the top of it stays dark.

## Deferred, approved in principle: the refusal count

**A request from outside the service area is refused before anything is
stored** — the `isServiceable` check at `backend/quotes.mjs:440-441`, under the
comment at 434-439 that says so in as many words, and ahead of `newId()` and
any insert. So demand outside the radius leaves no trace, and the
25-advertised / 100-enforced decision **cannot be evaluated after the fact**.

The product owner has approved this **in principle and not yet**, with
constraints that are not negotiable:

- A row is **`(day, distance band, count)` and nothing else.**
- **Never the ZIP.** A band is coarser and answers the same business question.
  Wanting the ZIP "just for resolution" is the moment to stop and go back to
  the product owner.
- No timestamp finer than a day. No per-person record, no payload, no fragment
  of what was asked for.

**Not now, because** it edits `submit()` — the most sensitive path in the
application — during a live launch with gates 2 and 3 open, and
`backend/quotes.mjs` is contended. It should ride with whoever next has a
legitimate reason to be in that file, post-cutover.

**The cost of waiting is real and was accepted knowingly: this data cannot be
recovered retroactively.** Every day without it is a day of refusals
permanently invisible. It is acceptable only because volume is near zero; **if
traffic picks up before the cutover finishes, raise it with the product owner
again, because the arithmetic changes.**

One thing that makes it cheap when it happens: **`area.miles` is already
computed at the point of refusal.** The band is a rounding of a number that
already exists. That is the difference between a small change and a design.

## Standing rules for any later phase, so they are not relitigated

These bind phases two and three (visitor and wizard-step counting), which are
**held**, not approved.

- **If any visitor counting ever ships, `/privacy` gains a line in the same
  pull request.** A rule, not a judgement call. Aggregate counts may not
  legally require disclosure, but that notice's entire value is that it is
  complete: a customer who later finds we count something it did not mention
  has learned the notice is a partial list, and then it is worth nothing.
- **No cookie, no third party, ever.** Aggregate, identity-free, server-side,
  or it does not happen.
- **A naive counter on production would be measuring us.** We deploy many times
  a day and `deployed-site-check` hits the live site on every deploy; bots
  crawl `/` freely. At current volume a visit count would be **mostly CI**, and
  a number that is largely our own robots, quoted to Ken as demand, is not a
  weak measurement — it is a false one that would inform a real decision about
  his business.
- So: exclude known audit traffic, **and then prove the exclusion works by
  running the audits and watching the counter not move.** This repository's own
  rule — prove a check can fail before trusting that it can pass — applies to
  instruments as much as to tests. **A counter nobody has watched *not* count
  is unproven in the direction that matters.**
