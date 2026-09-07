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


---

## AMENDMENT 2026-09-07 — `isPlaceholder` survives migration, even though it does not apply to lines Ken authors

Appended by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`). **Raised by
the Stage 2 seed design, which is exactly the case the original section did not
anticipate.**

### What the original section says, and where it is incomplete

> *"`isPlaceholder` does not apply here … A line Ken authored is his by
> construction. There is nothing to disclaim."*

**That is right for lines Ken authors. It is wrong for lines the migration
authors on his behalf, and the migration authors two.**

**Mobile service and disposal become catalogue entries by a one-time seed, not
by Ken typing them.** And `src/pricing.js` ships `mobileServiceFee` with
`mobileServiceFeeIsPlaceholder: true` — **our invented number, deliberately
marked as not his.**

**Seeding that into the catalogue without the flag launders a disclaimer into an
owner-defined price.** The entry would then read as Ken's by construction while
being the same number the flag exists to disown. **That defeats the rule the
flag serves: no number reaches a customer unless Ken put it there or it is
visibly marked as not his.**

### The amendment

**A seeded catalogue entry keeps the placeholder state of the setting it came
from, until Ken edits it.** Editing it makes it his — **that is what the flag
has always meant, and it needs no new mechanism.**

**Nothing changes for entries Ken creates.** They are his by construction and
carry no flag, exactly as the original section says.

### The distinction worth carrying past this feature

**"Ken authored it" and "it is in Ken's data" are not the same claim.**

**Migration moves numbers into places that imply authorship.** Anywhere that
happens, the disclaimer has to move with the number, or the migration quietly
converts *our guess* into *his price*.

### The adjacent defect this was found alongside

**Recorded because the two are one design decision, not two.** The seed's
precondition was written as *empty catalogue **and** a non-placeholder mobile
fee* — **but `src/pricing.js:155` adds the mobile service line
unconditionally**, and its own comment says why: *"always charged, so
`isPlaceholder` marks the number, not whether the fee applies."*

**So on a database where the fee is still a placeholder, the seed would skip
while `calculateDraftQuote` had already dropped its hardcoded line — a quote
with no mobile service fee at all, well-formed and short by the fee's whole
amount.**

**The seed condition is *has this migration run*, not *has Ken set a price*.**
The first is answered by the catalogue being empty. **Seed unconditionally, and
carry the flag** — one rule covers both halves.


---

## AMENDMENT 2026-09-07 — the scope axis, and the four rulings it needs

The user answered the question this document left open, and **the answer is
wider than the question.** Verbatim:

> **"tire installation should be modular set per tire or per visit either
> either site wide, per size, or per invidividual tire sku"**

**Two axes, not one.** *Per tire or per visit* is `basis`, and it is already
built — `CATALOGUE_LINE_BASES = ['perTire', 'perJob']`. **What is new is
`scope`: site-wide, per size, or per SKU.** No catalogue line carries a
targeting field of any kind today.

**The concepts exist elsewhere and should be reused rather than invented.**
`offers` is already per-SKU with `price_cents`, and `inventory.mjs` already
groups `bySize`. **The catalogue simply has no hook into either.**

### Ruling 1 — most-specific wins. SKU, then size, then site-wide.

**Never last-defined-wins**, and the reason is not taste.

**The catalogue list is owner-ordered, and that ordering is the invoice's
ordering.** If precedence followed list order, **reordering lines for display
would silently change what a customer is charged.** Two things that must never
couple would be coupled by a drag handle.

**Most-specific-wins is also the only rule a person can predict without reading
the whole list.** Ken sets installation at $15 and 20-inch at $25; he does not
have to know where either sits in the list.

### Ruling 2 — an override sets the amount and nothing else

**A per-size or per-SKU entry overrides `amountCents`. `basis`, `taxable`,
`mode` and `enabled` always come from the parent line.**

**Because the alternative is incoherent as a business rule.** *Installation is
per-tire normally but per-visit for one size* is not a thing anyone means.
Neither is *installation is taxable except on 18-inch* — **tax treatment follows
what the work is, not what it is performed on**, and that remains the
accountant's question rather than a per-row toggle.

**And it keeps the override a number**, which is the only thing Ken is actually
varying. **One line, one set of rules, a different price in named cases.**

### Ruling 3 — no orphans, and this follows from ruling 2

**A scoped amount cannot exist without a parent line**, because it has nothing
to inherit `basis` and `taxable` from.

**That fixes the data shape, and the shape is the point:** the catalogue stays
**a list of lines, each with optional per-scope amounts** — not a list of rules
that happen to match tires. **The first is explainable on a screen; the second
becomes a rules engine nobody can audit.**

### Ruling 4 — per-size is the affordance; per-SKU is the exception

**The user's own earlier complaint decides this**: they asked for by-brand bulk
enabling because per-SKU was *"having to manually press every single tire model
and size."*

**Per-SKU installation pricing reintroduces exactly that tedium**, so **the
screen must make the general case one action and the exception deliberate.**
Site-wide by default; size overrides offered from the sizes that actually have
offers; **per-SKU reachable only from a specific tire's own row, never as a list
to fill in.**

**What per-SKU is genuinely for is worth stating, because it shapes the
screen:** installation labour does not vary by model, it varies by difficulty —
**run-flats and low-profiles are harder to fit.** So per-SKU is a handful of
exceptions on an otherwise size-driven schedule. **A design that invites Ken to
price hundreds of SKUs has misread the feature.**

### What this does not decide

**The amounts.** Ken's prices, and he has not given them beyond the mobile fee
and disposal.

**Whether per-size means the tire's size or the vehicle's fitment.** They are
the same today; **if they ever diverge, this needs revisiting.**

**And whether `scope` belongs on the line or beside it in storage.** That is a
build decision for whoever holds the screen — **the rulings above constrain the
behaviour, not the JSON.**

### Not urgent, and Stage 2 is unaffected

**The catalogue works today at site-wide scope, which is where every existing
fee sits.** `basis` was already in Stage 2 (#388). **This is the next
increment, not a defect, and nothing should wait on it.**
