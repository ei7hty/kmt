# Customer data policy

What KMT keeps, why, and what a customer's removal request actually does to
the database. Written 2026-09-06 by the DB ADMIN session at main `3e5f9c5`.
Verify this against `backend/quotes.mjs` before relying on it -- the policy
is decided by the lead under the user's standing direction (with the user
holding veto), but the mechanism described here is read off the code, not
assumed. Companion to `docs/operations.md` (DEV OPS): that document is the
how -- backups, restore, rotation, incidents; this one is the what and why --
retention, removal, what a reset destroys, what a migration must preserve.
Neither repeats the other's ground.

**This document is not only internal.** The privacy notice (t50) points at
it, so what is written here is the thing that makes that page's promises
true. If a customer reads "you can ask to have your details removed" and
this document describes something narrower, the gap belongs on this page in
plain words, not left silent between the two.

## What is kept, and why

Requests and quotes are business records: what a customer asked for, what
they were quoted, what they were charged, and when. They are **not deleted**,
automatically or by request, and there is no in-app delete. The reason is
the ledger, not inertia -- "a set of four tires was quoted at $X, approved,
and paid" has to stay true and checkable for as long as the business might
need to answer for it (a dispute, a warranty question, the books). Nothing
here treats indefinite retention as a default nobody chose; it is the
record a paid transaction requires.

This is a statement about `requests` and `quotes` specifically. It says
nothing about logs, backups, or anything DEV OPS's document covers; ask
there for how long an infrastructure copy of a redacted row might still
exist.

## What a removal request does: redaction, not deletion

A customer's removal request is honoured by **redacting the contact
fields** -- name, email, phone -- while the quote record stays intact:
its line items, total, status, version, and timestamps are untouched. The
ledger stays true; the way to reach that customer does not.

**Open question, not yet resolved: does "contact fields" include the
service address (`location`)?** The field list this section currently
implements is name, email, phone -- `locationNotes` is grouped with them
because it can carry personal detail incidentally (a gate code, a
description of the customer's car), but the address line itself
(`location`: street, city, state) is not currently redacted. That is worth
naming here rather than deciding by omission: a street address, usually a
home, is the strongest identifier in the row -- stronger than the notes
field beside it that *did* make the list. The business record that has to
survive is what was sold and for how much, not necessarily where the truck
went; if the address is needed as a business record at all, the ZIP (stored
separately from the free-text address) may be the right coarser form to
keep. This is a policy call, not an implementation one, and is with the
lead for a ruling. **Until it is resolved, do not describe removal to a
customer as covering their address.**

## What redaction does not touch, and why

- **`quotes.status`, `.version`, `.total`, `.lineItems`, both timestamps.**
  A removal request is about how to reach the customer, not about what was
  sold. Rewriting any of these would make the ledger this policy exists to
  protect unreliable.
- **`requests.customer_key`.** This is an opaque per-browser token, not
  contact information -- it is what lets that browser find its own request
  again at `/status`. Redacting contact fields and revoking a device's
  access to its own history are two different asks; a removal request is
  the first one, not the second, and conflating them would take away
  something nobody asked to lose.
- **A row that was never given these fields** (any request submitted before
  contact fields existed, pre-#53). Redacting an already-absent field is
  the same write as redacting a present one -- there is no special case,
  and the existing truthiness guard in `QuoteRequests.jsx` and `Status.jsx`
  already renders both the same way.

## The mechanism, for whoever implements it

Not a schema change, and not `migrate()`'s concern. The contact fields live
inside `requests.payload`, a JSON blob in a column that already exists --
redaction is `UPDATE requests SET payload=?, updated_at=? WHERE id=?` with
the parsed JSON's `customerName`/`customerEmail`/`customerPhone` overwritten
to a redacted marker (not deleted from the object entirely, so a reader
can tell "this was redacted" apart from "this was never collected").
Belongs as a method on `Quotes`, next to `shapeRow` which is the one place
a stored row becomes an API shape. It should be **idempotent**: redacting
an already-redacted row is a no-op, not an error, since "was this one
already handled" should not need its own bookkeeping.

## What a migration must preserve

Any future schema change to `requests` or `quotes` (see
`.forge/owner-backend.md`'s migration contract) copies rows forward by
named column. That copy must never reintroduce a redacted field from
anywhere else -- there is nowhere else, since redaction rewrites the
`payload` column in place rather than moving data aside, but a migration
that ever adds a "recover original value" path would defeat this policy
outright, and should be refused on sight if proposed.

## What a full reset destroys

A database reset (as run on 2026-09-06, see `.forge/HANDOFF.md`) is not
part of how removal requests are fulfilled -- it is a distinct, deliberate
operational act that erases every request and quote, redacted or not, along
with the business record this policy exists to keep. A reset is DEV OPS's
procedure to run and the user's to authorise; it is named here only so the
two are never confused: redaction answers "forget this customer's contact
details," a reset answers "start the database over," and a pending removal
request is not a reason to reach for the second when the first is what was
asked.
