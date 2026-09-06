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

A customer's removal request is honoured by **redacting name, email,
phone, the service address (`location`), and the access notes
(`locationNotes`)** -- while the quote record stays intact: its line
items, total, status, version, and timestamps are untouched. The ledger
stays true; the way to reach that customer, and where they were found,
does not.

The address is in scope deliberately, not by the same omission that
almost left it out: a street address, usually a home, is the strongest
identifier in the row, and leaving it in place after "removing" a
customer's details would make the promise thinner than it sounds. What
stays instead is `serviceZip` -- service-area evidence without the
doorstep -- plus the vehicle, the tire, the quantity, and the quote's own
lines, total, status, versions and dates. The vehicle stays on purpose:
"a set of four for a 2019 F-150 at $X" is what was sold, weakly
identifying on its own, and the detail Ken needs if the same customer
calls back. This wording matches the privacy notice (t50) exactly --
"your name, contact details and address" -- so the public promise and
this policy say the same thing, in the same words.

## What redaction does not touch, and why

- **`requests.serviceZip`, `.vehicleInfo`, `.tireSelection`, `.quantity`,
  and `quotes.status`, `.version`, `.total`, `.lineItems`, both
  timestamps.** A removal request is about how to reach the customer and
  where they were found, not about what was sold. Rewriting any of these
  would make the ledger this policy exists to protect unreliable -- see
  "What is kept, and why" above for what that ledger is for.
- **`requests.customer_key`.** This is an opaque per-browser token, not
  contact information. **Redacting contact information and revoking device
  access are two different asks, and only one was made.** That key is what
  lets the customer's own device still see its history at `/status`; the
  instinct on a removal request is to scrub everything that looks like an
  identifier, and someone will eventually propose clearing this one too as
  a tidiness improvement. It stays, because clearing it would take away
  something nobody asked to lose.
- **A row that was never given these fields** (any request submitted before
  contact fields existed, pre-#53). Redacting an already-absent field is
  the same write as redacting a present one -- there is no special case,
  and the existing truthiness guard in `QuoteRequests.jsx` and `Status.jsx`
  already renders both the same way.

## The mechanism, for whoever implements it

Not a schema change, and not `migrate()`'s concern. The redacted fields
live inside `requests.payload`, a JSON blob in a column that already
exists -- redaction is `UPDATE requests SET payload=?, updated_at=? WHERE
id=?` with the parsed JSON's `customerName`/`customerEmail`/
`customerPhone`/`location`/`locationNotes` overwritten to a redacted
marker (not deleted from the object entirely, so a reader can tell "this
was redacted" apart from "this was never collected"). Belongs as a method
on `Quotes`, next to `shapeRow` which is the one place a stored row
becomes an API shape.

It should be **idempotent: redacting an already-redacted row is a no-op,
not an error.** Without that, "has this request already been handled"
would need its own tracking separate from the row itself; the answer
should be readable off the row by re-running the same operation, not kept
in a second place that can drift from what the row actually says.

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

## Inquiries (t65): a second personal-data table, redacted by its own id

`inquiries` (`backend/inquiries.mjs`) holds the short "more than tires" form:
name, a phone or email, what they need, the vehicle if it matters. It is not
a request's sibling -- no `request_id`, nothing else in the database points
at it -- so it carries its own copy of this policy rather than inheriting
the requests/quotes one above.

**Personal:** `name` and `contact` identify a specific person, the same
claim `requests`' name/email/phone make. **Not personal, and untouched by a
removal request:** `vehicle_info` and `message`, for the same reason
`requests.vehicleInfo` survives redaction there -- they are what the
inquiry is *about*, not how to reach the person who sent it, and Ken needs
both if the same person calls back. `INQUIRY_PERSONAL_FIELDS`, exported
from `inquiries.mjs`, names the first two so an implementation reads the
list from one place rather than re-deciding it.

**The mechanism, for whoever implements it** (not written yet -- neither
`requests` nor `outbox`'s redaction is implemented in code today either;
see above): `UPDATE inquiries SET name=?, contact=?, updated_at=? WHERE
id=?`, the redacted marker overwriting real columns rather than a JSON
key, since this table was given typed columns instead of a `payload` blob
from the start (see `inquiries.mjs`'s header for why). Idempotent for the
same reason the requests mechanism must be: redacting an already-redacted
row should be a no-op read straight off the row, not a state tracked
anywhere else.

**No status, no category.** An inquiry has no workflow column and no
CHECK-constrained taxonomy, the same decision and the same reasoning as
outbox's unconstrained `type` in #157: whether an inquiry needs a
new/contacted/closed workflow, or a category of "more than tires" work, is
`POST /api/inquiries` and the owner screen's question to answer once they
exist, not a guess to constrain today. If either is added later, it is a
schema change made when the vocabulary is real, the same as any other
widening under `.forge/owner-backend.md`'s migration contract -- and since
`inquiries` needs no `migrate()` of its own (a brand-new table has no prior
rows in any deployed shape to reconcile), that future change would be the
first time this table needs one.
