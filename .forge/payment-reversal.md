# Reversing a payment recorded in error (#328)

Written by DB ADMIN (`local_adccdadc`) on 2026-09-07 at main `33dc038`, at the
OWNER AGENT's instruction: design first, in a document, before any schema.
**Ruled by the OWNER AGENT the same night: reverse `paid → sent`. No new
status, no migration.** The question below is recorded as it was asked and
answered, including the option this document leaned toward and did not get
ruled -- the reasoning that overturned it is worth keeping, not just the
verdict.

## What the gap actually is, read off the code rather than assumed

`backend/quotes.mjs`'s `pay()` already documents this as a known, filed gap,
in its own comment:

> Unlike cancel, there is no reversal here at all, not even the owner's:
> `CANCELLABLE` excludes `paid`, and `paid` moves only to `done`. A mistaken
> or induced payment is not "text Ken and he sorts it out" the way a
> cancellation is -- it needs a manual database edit. That gap is real and
> is filed as its own issue rather than fixed in this change.

`finish()` says the same from the other side: *"Only from `paid`, and it is
the only way out of `paid`... nothing here can undo that -- see the
roadmap."* `.forge/roadmap.md` lists "real payments, refunds" together,
under **Later**.

**That pairing is the first thing worth being honest about.** `pay()` is
still, in its own words, *"the fake step that always succeeds."* There is no
payment processor, no charge, no money that actually moved through a
gateway. So "reversing a payment" cannot mean processing a refund -- there
is nothing to refund. **What #328 is actually asking for is a way to correct
a `paid` status that was recorded in error**, the same way `cancel()` lets
the owner correct a request that should not proceed. The real-payments-and-
refunds project in `roadmap.md`'s "Later" is a different, larger thing this
does not need to wait for or solve.

## The question that decides everything else

**Is a reversed payment the same customer-facing fact as a cancellation, or
a different one?**

Today, `cancelled` renders on `/status` as:

```jsx
{quote.status === 'cancelled' && <div className="status-outcome">
  <p className="status-note status-note-bad">
    This request was cancelled.{quote.reason ? ` ${quote.reason}` : ''} You have not been charged.
```

**"You have not been charged" would be false for a reversed payment.** The
customer *was* charged (by this system's own record, whatever the mistake
was) and the charge was then taken back. Reusing `cancelled` as-is would
have the app tell a customer something false about their own transaction on
the one screen that exists to tell them the truth about it. That is not a
styling gap to patch after the fact -- it is the same class of thing
`isPlaceholder` exists to prevent on the pricing side: a status whose
customer-facing meaning no longer matches what actually happened.

So the real options are:

**Option A -- a new status, e.g. `refunded`.** Distinct copy on `/status`
("Your payment was reversed. You have not been charged further.", or
whatever OWNER AGENT rules the sentence should say), distinct from both
"never charged" (`cancelled`) and "charged, job done" (`paid`/`done`).
**Needs a migration**: `QUOTE_STATUSES`'s `CHECK` constraint cannot be
altered in place (the t36 lesson this database has already paid for once),
so this is `migrate()` plus a migration test, following
`.forge/owner-backend.md`'s existing contract exactly -- the same shape as
every earlier status widening, no new pattern to invent.

**Option B -- reuse `cancelled`, with conditional copy.** No migration:
`cancelled` already exists, already renders on `/status`, already carries a
free-text `reason`. The `/status` copy would need a branch (something like:
if the reason indicates a reversal, say so instead of "you have not been
charged") -- which means the `reason` field silently becomes a control
value the UI switches on, rather than free text for the owner. That is a
smell worth naming plainly: it works, but it means "cancelled" stops being
one fact and becomes two facts wearing the same status, told apart by
sniffing a sentence a human typed. `QUOTE_VIEWS.closed` already includes
`cancelled`, so the owner's own list would show a reversed payment
identically to a job that was never charged at all -- which may or may not
be what the owner actually wants to see when scanning "closed."

**Option C -- something else** (a `disputed`/`voided` status with its own
lifecycle, if a reversal should itself be reversible, or need its own
follow-up state). Not designed here because nothing so far suggests it is
needed -- flagged only so the choice is stated as A vs. B vs. "no, actually,
C" rather than assumed binary.

**My lean was Option A, and the ruling was Option D -- a fourth option
neither A, B nor C named, and it is the right one.** Recording why, because
the argument is sharper than anything above and the reasoning is worth
keeping as much as the verdict.

## The ruling: reverse `paid → sent`. Neither A nor B.

**Option A's `refunded` has the same defect it was chosen to fix, pointed
the other way.** `pay()` never moves real money -- so telling a customer
their payment was *refunded* is exactly as false as telling them they were
*never charged*. Both sentences describe a financial event that did not
happen, in either direction, because there is no real payment underneath
either one yet. Naming a new status does not avoid the lie the way it
looked like it would; it relocates it.

**And `cancelled` is wrong for a second, separate reason beyond its
copy:** the request is not cancelled. It is still live, and still awaiting
payment. Neither existing option, and no plausible new one shaped like
them, describes that correctly.

**`sent` already means exactly that.** `QUOTE_STATUSES` is `draft, sent,
approved, rejected, paid, done, cancelled` -- and a quote whose payment was
recorded in error has, factually, not been paid. That is what `sent`
already asserts. No status is stretched to cover a second meaning; the
existing one was simply the correct one, sitting one transition away.

**No `CHECK` widening, no `migrate()`, no migration test.** The migration
cost this document priced as real for Option A is avoided entirely, not
paid at a discount.

**History is not lost, because the status was never where it lived.**
`moveTo` already records the version and, since #349 merged, the actor
(`decided_by`, `COALESCE`'d so a later transition cannot overwrite an
earlier one's). The status column is the current fact; the sequence of
transitions is the history. A row that went `sent → paid → sent` says
exactly that, with who reversed it and when, the same as any other
transition this database already records.

**The decisive argument is already sitting in `quotes.mjs`'s own comment**,
on `cancelByCustomer`:

> One consequence found in review, accepted with its bound stated rather
> than left undiscovered: someone holding the shared link can call `pay()`
> on a sent quote specifically to block the customer's own cancel (this
> method refuses once `paid`) and trigger a false "payment received" email.

**That is the induced case #328 exists for, and it names the actual harm
precisely: an induced payment does not just record a false charge, it takes
away the customer's ability to cancel**, because `cancelByCustomer` refuses
once `paid` (`CANCELLABLE` excludes it). **A new terminal status does not
restore that.** `refunded` or `reversed` would leave the customer exactly as
stuck as the attack left them, with a tidier label on the state that stuck
them there. **Reversing to `sent` gives the cancel button back**, which is
the actual capability the induced-payment attack takes away. The fix has to
restore something the customer can do, not just describe what happened to
them more accurately.

## What the customer sees

**They see the quote awaiting payment again, which is true.** No "you have
been refunded" -- nothing happened to refund. Copy is about the record being
corrected, not about money moving: something to the effect that the payment
record was corrected and the quote is open again. **MARKETING owns the
actual sentence** (`t62-voice.md`: Ken's first person, no apology, the next
move in the sentence, not a passive description of a state) -- the state
this copy has to describe is settled here; the words are theirs.

## The "not yet," written down so it does not get reused by accident

**When real payments land (`roadmap.md`'s Later item), a genuine refund is
a different fact from this bookkeeping correction, and it earns its own
status then.** Money actually returning to a customer is not the same event
as correcting a status that was never backed by a real charge. **`sent` is
the right reversal target only while `pay()` remains fake.** The first
person who implements real payment processing should not reach for `sent`
to represent an actual refund on the strength of this precedent -- that
would be exactly the "one status, two meanings" defect this document spent
its whole first half trying to avoid, arriving by the road this ruling took
to avoid it the first time.

## What does NOT change, now that the target status is settled

**This is an owner action, full stop.** No customer or link-holder can
trigger it -- unlike `pay()` and the customer's own `cancel`, which #316
deliberately dropped the `customerKey` check from. Reversal is a different
class of action (undoing a financial fact, not calling off an unpaid job)
and does not inherit that relaxation. It should be built the way `decide`,
`finish` and `cancel` are: through `moveTo`, with `audience: 'owner'`,
gated by the same owner session every other `/api/owner/*` route requires.

**A reason should probably be mandatory, not optional**, still unruled and
worth a decision alongside implementation rather than left to whoever
builds it. `cancel()`'s reason is optional because most cancellations are
mundane. A reversal is unusual enough on a system where `pay()` "always
succeeds" that a paper trail is worth requiring rather than inviting
silence.

**It carries `decided_by` for free, and this is no longer conditional on
anything landing.** TECHNICAL ARCHITECT's `quote-decided-by` (#290's schema
half) is merged (PR #349, `quotes.mjs:864-869`, verified directly rather
than taken on the PR description): `moveTo` already writes
`actor ?? SHARED_PASSWORD_ACTOR` to `decided_by` on any owner-audience
transition, `COALESCE`'d so it is never overwritten once set. A `reverse()`
built as an ordinary `moveTo({ to: 'sent', from: ['paid'], audience: 'owner', ... })`
call gets this with no second actor column and no coordination cost beyond
building on top of the mechanism that already exists.

**Payment being "the fake step that always succeeds" is itself worth a
second look**, but is out of scope for this document and this issue. If
`pay()` is ever taught to require a real confirmation step, "induced or
mistaken payment" becomes a smaller and different problem than it is today.
Not blocking on that -- it may never happen, and #328 is worth fixing on
its own terms regardless.

## The empirical question: has this ever actually happened?

**Asked and I could not get a clean answer, and I'm saying so rather than
implying I checked and it was fine.** There is no marker for "this `paid`
row was later found to be a mistake" because the feature that would create
one does not exist yet -- any real incident so far would have been handled
exactly the way `pay()`'s comment says, a manual database edit, which
leaves no trace distinguishable from an ordinary row once done. The
honestly answerable questions are narrower:

- **How many quotes are `paid` right now** (money "changed hands" by this
  system's record and the job isn't marked done yet) -- this is the set a
  reversal feature would apply to today, if one were needed immediately.
- **Do any `cancelled` rows carry a `reason` that reads like a payment
  mistake** (mentions of "refund," "twice," "duplicate," "wrong charge") --
  the closest thing to a trace a manual workaround might have left, since
  the honest tool for "this was paid by mistake" today is `cancel()`
  misused for lack of anything better, if anyone reached for it that way.

I don't have Fly access to run either query. Read-only, for whoever does
(the pattern in `.forge/HANDOFF.md`, confirmed working with `sqlite3
-readonly` rather than the `node:sqlite` one-liner, per OWNER AGENT's
correction tonight):

```
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT status, count(*) FROM quotes GROUP BY status;\""
```

```
flyctl ssh console -a kmt -C "sqlite3 -readonly /data/owner.sqlite \"SELECT id, reason FROM quotes WHERE status='cancelled' AND reason IS NOT NULL;\""
```

**Neither of these can prove a mistaken payment never happened** -- only
that if one did and was handled the honest way available at the time, it
might show up in the second query, and if it was handled by a raw edit it
will show up nowhere. That limit is the reason this document never leaned
on "it has never happened" as part of the case for any option: the data
cannot actually tell us that, and building as if it had would be the same
mistake as trusting `DEFAULT_MARKUP_SETTINGS.isPlaceholder` because nobody
had gotten around to checking. The OWNER AGENT has offered to run both
queries directly (read-only, no credential needed); their results, when
they land, belong in `.forge/HANDOFF.md` or a follow-up note here, not a
silent edit to this section.

## What this document is not

Not a schema. Not a route. Not JSX. **The ruling settles the schema
question as "there isn't one":** no `CHECK` widening, no `migrate()`, no
migration test -- `sent` already exists. What's left to build is a
`reverse(id, version, reason)` method on `Quotes` beside `finish()` and
`cancel()` (`moveTo({ to: 'sent', from: ['paid'], audience: 'owner', ... })`),
a route under `/api/owner/`, and `/status` copy for a customer whose quote
just returned to `sent` from `paid` -- distinguishable, if it matters later,
from a quote that has simply never been paid yet, though nothing so far
suggests the customer needs to be able to tell those apart. No code changes
in this PR -- the point of asking first was to not write any of it twice.
