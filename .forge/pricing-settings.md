# Pricing settings: shipping, tax, disposal and the mobile fee

Written by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) on 2026-09-06
at main `71cd81a`, on the user's instruction. This is the what and the why.
The PROJECT MANAGER turns it into briefs; the REPO AGENT owns the gate.

**This unblocks #94.** That issue asked for tax, disposal, TPMS and valve
lines and was ruled on earlier today: *no line ships with a number we
invented, no tax line until Ken's accountant answers, and one question to
Ken decides it.* The user has now answered the shape question — **build the
structure with flat rates that Ken can change, and let a scraper supply real
numbers later** — which is a different and better answer than either
inventing numbers or waiting.

## The goal, in one sentence

Every number on a quote comes from a setting Ken can change, and until he
changes one it is visibly ours rather than his.

## The finding that makes this cheap

**None of it needs a migration.** Three facts, each read from the code:

- **`backend/inventory.mjs:55`** — `CREATE TABLE IF NOT EXISTS metadata (key
  TEXT PRIMARY KEY, value TEXT NOT NULL)`, with `getMeta`/`setMeta` storing
  JSON. **The markup rate already lives here**, and nothing else is required
  to add more settings.
- **`quotes.payload` is free-form JSON.** New line items and a new
  `subtotal` field cost nothing at the schema level. The CHECK constraint on
  that table is on `status`, not on the payload.
- **`isPlaceholder` already exists and already means this.**
  `getMarkup()` returns `{ rate, isPlaceholder: true, updatedAt: null }`
  until the owner saves one. That is exactly the semantics the user asked
  for — a flat rate now, a real number later — and reusing it means the
  owner screen's existing "this is not Ken's number" treatment applies
  without inventing a second convention.

**So the work is a settings object, a pricing function that reads it, an
owner screen to edit it, and one new field on the quote. Not a schema
project.**

## The settings, and what each one is

One `metadata` key, `pricing`, holding a JSON object. Every field carries its
own `isPlaceholder` — because Ken will set the mobile fee long before he has
an answer on tax, and a single flag for the whole object would lie about the
rest.

| setting | shape | default | notes |
| --- | --- | --- | --- |
| `mobileServiceFee` | amount, per visit | today's `49.99`, `isPlaceholder: true` | Already charged; today it is a constant in `src/pricing.js:3`. This change moves it, it does not introduce it. **Per visit, not per tire** — that is settled and the current code comment says why. |
| `disposalFee` | amount, per tire | `null`, off | **Opt-in by the customer.** See below. |
| ~~`shipping`~~ | — | — | **Not here.** Resolved by the user: it is Ken's cost, so it belongs in the markup settings, not the quote. See "Shipping" below. |
| `tax` | `{ rate, appliesTo }` | `null`, off | **Ships disabled. Not a placeholder — absent.** See below. |

**Amounts are integer cents in storage**, the way `offers.priceCents`
already is, and formatted at the edges. The existing quote maths uses floats
with a `roundCurrency` helper; a tax rate multiplied across several lines is
where that starts to drift, and cents is the cheap fix while the code is
being touched anyway.

## Tax is not a line item, and it is the one real shape change

Everything else is another entry in `lineItems`. **Tax is a rate applied to a
taxable subtotal**, and the quote today has `total` and no `subtotal`
(confirmed: no occurrence of `subtotal` anywhere in `src/` or `backend/`).

So the quote gains:

```
lineItems: [ ... ]     unchanged shape
subtotal                sum of the lines
tax: { rate, amount }   present only when tax is configured
total                   subtotal + tax
```

**Tax ships disabled and that is deliberate, not a placeholder.** The earlier
ruling stands and the user's instruction does not overturn it: a wrong tax
line is materially worse than an absent one, because an absent line is a
number Ken can correct and a wrong one is a number a customer already paid
that Ken then has to defend. **`isPlaceholder` is right for a fee we guessed;
it is wrong for a tax rate, because there is no such thing as a provisional
tax rate on a document someone pays against.**

`appliesTo` exists because which lines are taxable is a real question — a
tire is tangible goods and a mobile installation is a service, and they are
not necessarily treated the same. **That question is for Ken's accountant.**
The field is there so the answer can be recorded when it arrives; it is not
there for us to guess at.

## Disposal is opt-in, so it is a request field and not only a setting

The other three are things Ken charges. **Disposal is something the customer
chooses**, which means it cannot live in settings alone:

- a control on the service step of the wizard, defaulted **off**
- `disposeOldTires: boolean` on the request — `requests.payload` is JSON, so
  no migration, and it belongs in the customer-facing shape rather than the
  personal-data set
- a conditional line in the quote, `quantity` matching the tire quantity
- visible on the owner card, because Ken has to actually take the tires away

**Default off, and the label says what it costs.** An opt-in that is on by
default is not an opt-in, and a fee that appears without the customer having
chosen it is the thing #94 was opened about.

## Shipping — resolved: Ken's cost, inside the tire price

**The user's ruling: shipping is what Ken pays, folded into the tire cost
along with markup. The customer never sees a shipping line.**

So it is **not** a quote setting and does not belong in this document's table.
It belongs in `src/markup.js`, which exists precisely to be "the boundary
between what the supplier charges and what KMT charges."

**That module was built for this.** Its own header lists the rules it expects
to grow — a rate per category, tiers by cost, a minimum margin, a floor that
never quotes below cost — and says: *"Each of those becomes another field
here and another step in `retailPrice`. Adding one should not require
touching a caller."* Shipping is one more of those, and the first to arrive.

### The formula, and the one decision inside it

Today `retailPrice` is `supplierPrice × rate`. It becomes:

```
retailPrice = (supplierPrice + shippingPerTire) × rate
```

**Shipping goes inside the multiplier, not outside it** — the markup applies
to landed cost, because landed cost is what the tire actually cost Ken to
have in his hand. Marking up goods and passing shipping through at cost is
the other option and it is the wrong one here: it would mean Ken earns
nothing on the money he fronted to get the tire to Malden.

**A useful side effect worth noting.** `markup.js` already criticises its own
flat multiplier — *"adds $12 to a $34 tire and $60 to a $170 one, which is
backwards."* A per-tire shipping cost is an **absolute** amount added before
the multiplier, so it pushes cheap tires up proportionally more than
expensive ones. That is a small step toward the tiering the module says it
wants, arriving as a side effect rather than a redesign.

### Where it lives, and the seam that already exists

`shippingPerTire` becomes a field in the markup settings beside `rate`,
owner-editable through the existing `GET`/`PUT /api/owner/markup`, carrying
its own `isPlaceholder` until Ken sets it. **The default is `0`, not a guessed
dollar figure** -- nothing charged a separate shipping amount before this
existed, so an invented number would move live prices on a guess while zero
preserves them until Ken supplies a real one.

**The per-tire seam is already in the signature.**
`retailPrice(supplierPrice, tire = {}, settings)` takes a `tire` argument
that **nothing currently reads**, and the flat setting is the fallback for
tires that have none. **No caller changes, exactly as the module intended.**

**What that seam is for has changed — see the ruling below.** It was written
for a scraper that would supply per-tire shipping. **No such number exists.**
The seam stays because Ken will meet outliers by hand: at one destination and
one quantity, giga-tires ships one tire **free** and another for **$119.56**,
and a single flat figure adds his shipping cost to a tire that ships free.

**The owner's own price still wins outright.** If Ken has priced a tire, that
price is the price — shipping does not get added to it. Markup proposes, the
owner disposes, unchanged.

### The scraper: asked, answered, and closed

**This section originally planned a scraper task and scoped it as a question
first**: *"the first task is not 'pull shipping' -- it is 'find out whether
shipping is a per-tire number at all.'"* **The scraper lane ran that question
on 2026-09-06 and the answer is no.** What follows replaces the plan.

**Measured on giga-tires.com, by hand, no scraper run and no import:**

- **No shipping figure exists until a destination ZIP is entered.** Every card
  reads "Shipping -- Enter zip code". It is not a catalog attribute.
- **At the same quantity (4) and the same ZIP (02149), shipping across SKUs
  was $0.00, $94.00, $97.16, $101.36, $109.32, $116.44 and $119.56.** One tire
  ships free while another costs $119.56. **No per-tire multiplier can
  represent that.**
- **It is not linear in quantity either, which rules out "flat rate x N" as a
  model of the supplier**: the same tire at the same ZIP is **$32.86 for one
  and $116.44 for four**, against the $131.44 a flat per-tire rate predicts.
  Cheaper per unit at volume -- ordinary freight economics, not a constant.
- **The site says so itself**: *"For orders over quantity 10 of one tire,
  please call us so we can provide a more accurate shipping cost."* Their own
  system stops auto-quoting past a threshold.
- **Total is exactly (per-tire price x quantity) + shipping**, confirmed by
  arithmetic on several rows. **Shipping is never folded into the per-tire
  price**, so it cannot be backed out of one either. That also confirms a
  quiet assumption in `retailPrice`: the supplier's listed price *is* the bare
  goods cost, which is what treating `supplierPrice` as landed-cost-minus-
  shipping depends on. Nobody had checked it before.

**Ruling: `scripts/giga-tires.mjs`'s `source` block gains no shipping key.**
There is nothing stable to capture. **A scraped "shipping per tire" would
assert a precision, and a linearity, that the supplier's own pricing does not
have.**

**So the flat owner-configured setting is the permanent shape, not a
stopgap.** This document previously framed it as a placeholder awaiting the
scraper. **That framing was mine and it was wrong**, and the correction
matters because a setting described as temporary does not get the care a
permanent one does.

### The four-tire basis, which the numbers force

**A single per-tire flat rate cannot be right at both quantities.** It is
arithmetically impossible against the curve above:

- set from a one-tire experience (~$32.86), **a four-tire job overcharges by
  about $15**
- set from a four-tire experience (~$29.11), **a single-tire job undercharges
  by a few dollars**

**Ruling: Ken sets the figure on a four-tire basis, and the owner screen says
so in the field's help text.**

**Most jobs are four tires, so the common case should be the accurate one.**
And when a flat rate has to be wrong somewhere, **it should be wrong in the
direction that costs Ken a little rather than the direction that overcharges a
customer.** An overcharge is a conversation with somebody who trusted the
number, and this business runs on that trust.

## What ships inert, and why that matters

**Only the mobile fee has a live number on day one**, and it is the one
already being charged. Disposal, shipping and tax all ship off. **The
feature's value is that Ken can turn each one on with his own number**, not
that we shipped four new charges.

That is the difference between this and the version of #94 I refused: the
structure is ours to build, the numbers are his to supply, and until he
supplies one the customer is not charged for it.

## Sequencing against the approved sprint

`sprint-first-week.md` is ruled and this is new scope, so it does **not**
displace anything without the PROJECT MANAGER re-ranking. Two notes for that
decision:

- **It is smaller than it looks** — no migration, one settings key, one new
  quote field — so it may cost less than items already ranked below it.
- **It touches `src/pricing.js` and `backend/quotes.mjs`**, and m13.2's
  migration and t35's editor both touch the second. **Sequence against those
  or accept a rebase**, per #262's region rule.

**Nothing here starts before Gate 3**, which now has one item left.

## The rule that survives this document

**No number reaches a customer unless Ken put it there or it is visibly
marked as not his.** That is what `isPlaceholder` is for, it is why the
markup rate has carried it since it shipped, and it is the reason this can be
built now rather than waiting for four answers Ken does not have yet.
