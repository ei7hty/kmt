# Staggered fitments: different tires front and rear, one car, one visit

Written 2026-09-13 by the OWNER AGENT (`local_44d1e1f9`) after Ken asked for
a cart and then narrowed it himself.

**Ken, 2026-09-13, in order:** *"we should have a cart feature for if someone
needs different tires installed on the [car]"*, then, asked whether that meant
staggered fitments or two cars in one visit: **"staggered fitments, different
sizes front and rear"**.

That narrowing is the most important line in this document. It is **one car,
one visit, one service address, one date, one customer**. Nothing here needs a
second vehicle, a second appointment, or a second contact. If someone later
reads "cart" and builds a shopping basket across vehicles, they have built
something Ken did not ask for and the scheduling model does not support.

## Why the flow cannot do this today

`formData` carries one `tireSize`, one `tireSelection`, one `quantity`, and
the whole path down to the invoice line is built on that being singular:

| where | what assumes one tire |
| --- | --- |
| `src/routes/CustomerRequest.jsx` | the size step picks a single size; the tire step a single id |
| `src/pricing.js` | `calculateDraftQuote` resolves one `tire`, builds one tire line |
| `backend/quotes.mjs` | `REQUIRED` includes `tireSelection`; `LIMITS.tireSelection`; the catalogue check |
| `src/routes/QuoteRequests.jsx` | the owner sees one "Tire:" row |
| `backend/mail.mjs` | the email names one tire |

A customer with a 245/35R19 front and a 275/35R19 rear cannot order at all
today. They pick one size and either order the wrong tires or leave.

## What this is NOT going to need

Measured before scoping, because both would have changed the estimate a lot:

- **No database migration.** `requests` stores `payload TEXT` (a JSON blob),
  not typed columns -- `backend/quotes.mjs:500`. A request can grow a field
  without touching the schema. This was the part most likely to be risky and
  it is not there.
- **No new concept of a "line".** Quotes already carry a `lineItems` array,
  and `computeQuoteTotals` already only sums what it is handed. Today exactly
  one of those lines can be a tire. The work is to let there be more than one,
  not to invent the idea.

## The shape

One new optional field on the request payload:

```js
tires: [
  { position: 'front', size: '245/35R19', tireSelection: 'giga-...', quantity: 2 },
  { position: 'rear',  size: '275/35R19', tireSelection: 'giga-...', quantity: 2 },
]
```

**`calculateDraftQuote` must read this array and nothing else.** When a
request has no `tires` array -- every request in the database today, and every
request from a browser running yesterday's bundle -- the engine builds a
one-element array from the legacy `tireSize`/`tireSelection`/`quantity`
fields and prices that.

This is the whole safety design, and it is worth being explicit about why it
is not the other obvious choice. The tempting shape is "keep pricing the
legacy fields, and add the array alongside". That leaves two code paths, and
the failure mode of the one that gets forgotten is a **staggered request
priced as though it were four of the front tire**. That is a wrong number on
a real invoice, it looks exactly like a working order, and nobody finds it
until Ken is out of pocket or a customer is overcharged. One path cannot have
that bug.

Every exception reason in `calculateDraftQuote` that inspects "the tire"
(out of stock, off-road, not supplier-listed) must run **per entry**, and the
request is an exception if any entry raises one. An off-road rear with a
road-going front is still an off-road job.

## The fee decision, which is a money question and therefore mine to make

`catalogueLineItems` prices an owner-authored fee through
`scopedAmountCents(entry, tire)`: a SKU override beats a size override beats
the site-wide amount. With two tires in one request, "the tire" stops having
an answer. `saveCatalogueLines` really does persist `amountOverrides` for
both sizes and SKUs (`backend/inventory.mjs:575`), so this is a live
mechanism, not a hypothetical one.

**The ruling, and the reasoning, so it can be overruled on the reasoning:**

1. **`basis: 'perTire'` fees split into one line per tire entry**, each scoped
   to its own tire and its own quantity. Disposal of a 275 costs what
   disposing of a 275 costs. A single merged line cannot express two different
   unit prices, so merging would either overcharge one half or undercharge the
   other.
2. **`basis: 'perJob'` fees are charged once, at the site-wide
   `amountCents`**, ignoring size and SKU overrides, whenever the request has
   more than one distinct tire. A per-visit fee scoped to "the tire" is
   meaningless when there are two, and the alternative -- scope it to the
   first entry -- would make the price of the visit depend on which tire the
   customer happened to choose first. A price that moves with the order of
   clicks is indefensible to a customer who asks about it.

**This changes nothing for any request that exists today.** A single-tire
request has exactly one distinct tire, so rule 2 never fires and rule 1
produces the one line it always produced. That is a property to assert in a
test, not a claim to take on trust.

## Staging, and the one ordering rule that is not negotiable

**A customer must never be able to submit a request the pricing engine cannot
price.** The dangerous intermediate state is a browser that can build a
two-tire request reaching a server that reads only the first. Everything
below is ordered to make that state impossible rather than unlikely.

| stage | what | lane |
| --- | --- | --- |
| A | `calculateDraftQuote` prices a list; legacy fields become a one-element list. No UI, nothing can submit an array yet. | backend / pricing |
| B | `backend/quotes.mjs` accepts, validates and stores the array. Still no UI. | backend |
| C | Owner screen, email and status page show N tires. | owner / mail |
| D | The customer picker: front and rear. Only now can a staggered request exist. | front end |

A and B are invisible to everyone and independently safe: they change no
behaviour for a request that has no array, and nothing can produce one. C
before D so that the first staggered request Ken ever receives is one his own
screen can already display -- not one that renders as a single tire and
quietly loses the rear.

D must not merge before C. If the schedule pushes, the right lever is to
build D behind a flag that stays off, never to ship D and "watch for
problems": the problem is a wrong price on a real customer's quote.

## What is still open

- **The picker's shape is a design question, not a spec one.** Whether the
  customer says "same all round / different front and rear" up front, or adds
  a rear after choosing a front, is Fable's to propose and Ken's to approve.
  Nothing above constrains it.
- **Quantities.** 2 + 2 is the ordinary staggered case, but nothing here
  requires it and the per-entry `quantity` allows 1 + 2 or any other split.
  Whether the picker offers that freedom is part of D's design.
