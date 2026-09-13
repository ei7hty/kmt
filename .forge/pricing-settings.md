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

## Shipping — resolved: charged to the customer, undisclosed, tracked separately

**The user's ruling: the customer is charged for shipping and never sees it as
a line, and it stays a separate figure internally rather than being folded into
the markup.** See "The formula" below — an earlier version of this section ruled
the opposite and is marked superseded there rather than deleted.

So it is **not** a quote setting and does not belong in this document's table.
It belongs in `src/markup.js`, which exists precisely to be "the boundary
between what the supplier charges and what KMT charges."

**That module was built for this.** Its own header lists the rules it expects
to grow — a rate per category, tiers by cost, a minimum margin, a floor that
never quotes below cost — and says: *"Each of those becomes another field
here and another step in `retailPrice`. Adding one should not require
touching a caller."* Shipping is one more of those, and the first to arrive.

### The formula, and the one decision inside it

```
retailPrice = (supplierPrice × rate) + shippingPerTire
```

**Shipping stays OUTSIDE the multiplier.** Goods are marked up; freight is
added at cost. The owner's ruling, 2026-09-12, in his words: *"shipping
shouldnt be baked in because it is an outbound customer cost"*, and *"customer
is charged for shipping although we dont disclose it — we just want it to be
separate for sake of things."*

Three properties, and the formula above is the only one that has all three:

- **The customer pays it.** It is added to the per-tire price, so the money is
  collected. Nothing here is absorbed by KMT.
- **The customer never sees it.** It is not a line, not a field, and not
  separable from the price by anyone reading the public API — `CATALOG_FIELDS`
  in `.forge/audit-ui.mjs` is a positive allow-list and shipping is not on it,
  which `backend/catalog-boundary.test.mjs` asserts on every row.
- **Ken sees it separately.** It stays its own setting and its own term rather
  than being folded into `rate`, so he can change what freight costs without
  restating what his margin is. `minMarginPerTire` / `maxMarginPerTire` keep it
  outside the clamp for the same reason: freight is not goods margin, and a
  floor that counted it would stop protecting anything the day a shipping
  figure was set.

> **SUPERSEDED, kept so nobody re-argues it from scratch.** This section
> previously ruled the opposite — `(supplierPrice + shippingPerTire) × rate`,
> marking up landed cost on the grounds that otherwise *"Ken earns nothing on
> the money he fronted to get the tire to Malden."* `src/markup.js` never
> implemented it; the code has always passed freight through at cost.
>
> On 2026-09-12 that stale paragraph was read as a live decision — it was in
> bold, and it said "the user's ruling" — and a change was routed to a lane to
> make the code match it. It was cancelled before anything landed, on the
> owner's correction. **The code was right and this document was wrong**, which
> is the more dangerous direction: a confident document outranks unfamiliar
> code in a reader's head. A written ruling records what was decided once. If
> it is load-bearing, ask before acting on it.
>
> The superseded ruling also claimed a side benefit — an absolute amount inside
> the multiplier lifts cheap tires proportionally more, answering `markup.js`'s
> own complaint that a flat rate *"adds $12 to a $34 tire and $60 to a $170
> one, which is backwards."* That complaint is real and still unaddressed by
> shipping. It is answered instead by the margin floor and ceiling, which fix
> the same skew without moving freight.

**WHICH FORMULA IS LIVE, CHECKED IN ONE LINE.** Do not settle this from prose
again — this document lost the argument to the code and would have done so
faster if it had pointed here. `backend/owner.test.mjs` asserts:

```js
// supplierPrice x rate + shipping: freight is an internal cost passed
// through after the goods margin is calculated.
assert.equal(quotedPrice({ supplierPrice: 50, offer: null, settings: db.getMarkup() }).price, 83, '(50 x 1.5) + 8')
```

83 is `(50 × 1.5) + 8`, against a stored markup of rate 1.5 and $8 shipping.
Landed cost would be 87. That test has been green on `main` throughout, so the
standing formula has always been the tested one, and a change to the other
would turn it red immediately.

It was one of **four** independent places that already agreed with the code
while this paragraph disagreed: the engine in `src/markup.js`, that test, the
owner form's own label in `src/owner/OwnerInventory.jsx` (*"SUPPLIER PRICE ×
MARKUP, THEN + SHIPPING"*), and the bulk price tool in
`src/owner/inventory-grid.js`. Four implementations against one prose
paragraph, and the paragraph won for half an hour because it was bold and
attributed. Reading it more carefully would not have helped; going to the
source did.

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


## Per-tire shipping: Ken's number, and an override for the outliers

**2026-09-07, on the user's instruction: `$25.75` per tire, adjustable in the
owner portal for all tires and individually.**

### The flat figure is Ken's now, and it closes a live loss

**`$25.75` replaces the `0` default.** Until he sets it, `retailPrice` computes
`(supplierPrice + 0) x rate` while he pays `supplierPrice + freight` -- **about
$140-175 of margin per four-tire job.** Setting it is one save on the existing
markup form, which has sent `shippingPerTire` since #299.

**It sits inside the range the scraper lane measured** -- four tires to 02149
came back between `$94.00` and `$119.56`, so `$23.50` to `$29.89` per tire.
**That is a sanity check and nothing more: it is his number, from what he
actually pays, and the measurement was one supplier's cart to one ZIP.**

**`shippingPerTireIsPlaceholder` becomes false legitimately** for the first
time, which is what #313 made possible.

### Why a per-tire override is the right second half

**The scraper lane established there is no per-tire shipping number to scrape**
-- destination-gated, `$0.00` to `$119.56` across SKUs at the same quantity and
ZIP, and non-linear in quantity. **A single flat rate is therefore permanently
the shape**, and it is wrong in exactly the cases that measurement found:

**One tire ships free. Another costs `$119.56`.** A flat `$25.75` adds Ken's
freight to a tire that has none, and under-recovers on the expensive one.

**So the override is for outliers Ken meets by hand**, which is the
justification the seam has had since the scraper question was answered. It is
not a step toward automation; **there is nothing to automate.**

### The seam already exists and nothing writes to it

`retailPrice(supplierPrice, tire = {}, settings)` **already reads
`tire.shippingPerTire` and falls back to the flat setting.** Nothing in `src/`
or `backend/` writes that field today.

**So the pricing maths needs no change at all.** The work is storage, an API
that carries it, and a control on the owner screen.

### Storage, and the one decision inside it

**`offers` has no shipping column** -- `id, price_cents, enabled, notes,
version, updated_at`. **So this is a schema change**, and in this project that
means **`migrate()` and a migration test**, without exception: a schema change
that only fails in production is a failure mode this database has already had.

**`shipping_cents INTEGER`, nullable.** Integer cents, matching
`price_cents` beside it.

**`NULL` means "use the flat rate". It does not mean zero, and zero does not
mean unset.** `$0.00` is a real, meaningful value here -- **it is the
free-shipping tire the scraper actually found** -- and conflating absence with
zero is precisely the bug #313 fixed one level up. **The same distinction, at
the row level, before it is written rather than after.**

### The owner screen

**A shipping field on each tire's row, beside the price**, empty by default,
with the flat rate visible as the fallback it will use.

**Clearing it returns the tire to the flat rate.** That is the only way back,
and it must not be confusable with typing `0`.

**And the flat rate keeps its own control**, unchanged, where it is today.

### What must not change

**The owner's own price still wins outright.** If Ken has priced a tire, that
price is the price and shipping is not added to it. **Markup proposes, the
owner disposes** -- unchanged, and the per-tire override lives entirely on the
proposing side.

**No number reaches a customer unless Ken put it there or it is visibly marked
as not his.** A per-tire override is his by construction. **The flat rate
becomes his the moment he saves `$25.75`.**
