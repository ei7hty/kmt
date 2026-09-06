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
its own `isPlaceholder` until Ken sets it. **Dummy value now**, per the
user's instruction, and visibly ours until replaced.

**The per-tire seam is already in the signature.**
`retailPrice(supplierPrice, tire = {}, settings)` takes a `tire` argument
that **nothing currently reads**. When the scraper supplies real per-tire
shipping, it is read from there and the flat setting becomes the fallback for
tires that have none. **No caller changes, exactly as the module intended.**

**The owner's own price still wins outright.** If Ken has priced a tire, that
price is the price — shipping does not get added to it. Markup proposes, the
owner disposes, unchanged.

### The scraper, planned honestly

`scripts/giga-tires.mjs` captures `source: { sku, stock, listPrice, segment,
url }`. **No shipping field.** Adding one means a new key in the snapshot
shape, which flows through `import-tires.mjs` and the supplier table the same
way the others do.

**But the first task is not "pull shipping" — it is "find out whether
shipping is a per-tire number at all."** Supplier shipping is commonly
**order-level and destination-dependent**: a cart total, free over a
threshold, varying by how many tires ship together and where they go. If that
is what giga-tires publishes, then a per-tire field is the wrong shape and
the honest answer is a configured average rather than a scraped figure.

**So the scraper task is scoped as a question first.** Read what the site
actually shows for shipping on a listing and in a cart, and report the shape.
**The flat setting stands either way** — that is why it is being built first,
and it is what makes this safe to ship before the answer exists.

This is the same discipline the walk used: *page-one coverage is the data
definition of done, and the deep pass is a separate decision with its cost
attached.*

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
