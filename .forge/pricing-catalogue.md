# Owner-defined quote lines

Written by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) on 2026-09-07,
on the user's instruction: **all pricing modifiable in the owner portal, with
the ability to add lines and make each one optional or not** — and **a tire
installation service fee**, which is this feature's first entry rather than a
fifth hard-coded fee.

The what and the why. The PROJECT MANAGER places the build; the REPO AGENT owns
the gate.

## What this replaces

Four fees are hard-coded today — **mobile service, disposal, tax and shipping**
— each with its own metadata key, its own validation, its own placeholder flag
and its own branch in `calculateDraftQuote`.

**`.forge/pricing-settings.md` anticipated growth and hard-coded four anyway.**
The user is asking for the general case, and **the general case is cheaper than
a fifth special case.**

## The entry

One `metadata` key holding an ordered list. Each entry carries:

| field | why it exists |
| --- | --- |
| `id` | stable across renames; what a request references |
| `label` | **customer-facing copy — see below** |
| `amountCents` | integer cents, matching `offers.price_cents` |
| `basis` | `perTire` or `perJob` |
| `mode` | `automatic` or `optional` |
| `taxable` | **must be per line — see below** |
| `enabled` | disabled rather than deleted |

### `basis` is load-bearing, not descriptive

**A catalogue that only supports per-job amounts cannot express installation**,
which is the thing it exists to absorb.

**The mobile fee is per job and the existing code comment says why.** Shipping
and disposal are per tire. **Installation is per tire**, unless Ken says
otherwise — and that is his call, because fitting four tires is not four times
the work of fitting one.

### `taxable` must be per line, and this is a correctness question

`savePricingSettings` carries `tax.appliesTo` as `'all' | 'goods' | 'services'`
— **a category matched against line kinds we control.**

**An owner-authored line belongs to no category we know.** So without a
per-line flag, **the tax calculation silently guesses about lines it has never
seen, and that changes what a customer is charged.** Not a nicety.

**Default to whatever `appliesTo` already implies for a line of that basis**,
and never to a guess. **What is or is not taxable remains Ken's accountant's
question** — the catalogue records the answer, it does not infer it.

### `enabled`, not deleted

**Disabling preserves history and avoids dangling references.** A request may
already have selected an optional line; **a deleted entry turns that into a
reference to nothing.**

**Existing quotes are unaffected either way** — `quotes.payload` materialises
line items at draft time, so a quote already sent keeps the lines it was sent
with. **That is worth stating because someone will otherwise fear this change
rewrites history. It cannot.**

## Optional lines already have a working pattern

**Disposal is exactly this feature, hard-coded**: `disposeOldTires` on the
request, a control on the service step of the wizard, **defaulted off**, a
conditional line on the quote, and visible on the owner card because Ken has to
physically take the tires away.

**The catalogue generalises that pattern rather than inventing one.** The
wizard control becomes **generated from the enabled optional entries** instead
of hard-coded, and the request stores **the set of chosen entry ids** instead
of one boolean.

**Default off is not a preference.** An opt-in that is on by default is not an
opt-in, and **a fee that appears without the customer choosing it is what #94
was opened about.**

## The label is customer-facing copy

**The risk this feature carries, stated rather than waved at.**

R25 wants an itemised invoice. **An invoice with six owner-named lines is only
better than one opaque total if the labels mean something to the person
paying.** *Misc*, *Shop fee* and *Svc chg* are **worse** than no itemisation,
because they read as padding on a document someone is about to pay.

**So the label is governed by the same voice rule as everything else the
customer reads**, and **the owner screen should say so at the point of entry**
rather than leaving it to be discovered. One line of help text under the field.

## `isPlaceholder` does not apply here, and that is a deletion rather than an omission

**The flag exists to mark numbers we invented so they are visibly not Ken's.**

**A line Ken authored is his by construction. There is nothing to disclaim.**

**Someone will carry the flag over out of habit** — it is on every other pricing
field — so this needs saying explicitly. **It still applies to what stays a
setting**: the markup rate and per-tire shipping are inputs to a price, not
lines on a quote, and they keep their flags.

## Migration

**Mobile service, disposal and installation become catalogue entries.**
Otherwise there are two systems forever, and the fifth fee problem returns
wearing a different hat.

**Tax does not.** It is **a rate applied to a taxable subtotal**, not a line —
and a catalogue makes the tax question harder rather than easier, because every
new line is a new taxable decision.

**Shipping does not.** It is **Ken's cost folded into the tire price before
markup**, per `pricing-settings.md`, and the customer never sees a shipping
line. **It is a markup input, not a quote line.**

**The `metadata` table is key/value JSON, so none of this is a schema change.**
`quotes.payload` is free-form and already carries materialised lines.

**The one thing that is a schema change** is if the request needs a new column
for chosen line ids — **it does not: `requests.payload` is JSON**, the same
place `disposeOldTires` lives today.

## What must not change

**The owner approval gate.** No customer sees a quote Ken has not sent.

**No number reaches a customer unless Ken put it there or it is visibly marked
as not his.** A catalogue entry is his by construction; **this feature makes
that rule easier to hold, not harder.**

**And the quote must still add up.** `subtotal + tax = total`, computed by the
one function both draft creation and adjustment call — **that seam was fixed in
#335 tonight and a catalogue must not reintroduce a second implementation.**

## What this document does not decide

**Whether installation is per tire or per job.** Ken's price, Ken's call.

**Whether the taxable default is on or off.** The accountant's question, and it
does not become ours by being asked in a new place.

**Ordering on the customer's invoice.** The list is ordered, so the owner
controls it; **whether that ordering needs a rule beyond "as Ken arranged them"
is a question for whoever builds the screen.**
