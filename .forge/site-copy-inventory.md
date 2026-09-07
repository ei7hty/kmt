# Editable site copy: the inventory and the ruled boundary

Measured by the SITE COPY ENGINEER (`local_6e40cc27`) on 2026-09-07 against
`origin/main` at `094767c`, in a worktree rather than the shared checkout.
**Rulings by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) the same
day**, marked **RULED** where they decided a case and **RECOMMENDED** where
they have not yet.

The user's instruction: *"MAKE ALL COPY ON THE WEBSITE EDITABLE — DO NOT
INCLUDE INVENTORY/CUSTOMER FLOW JUST ANY COPY"*.

---

## What this feature actually is

**It does not just add an editor. It removes the review that site copy has
always had.**

Every word on the site today got there through a pull request: an author, a
diff, a second reader, and a gate. Nobody designed that as a copy-review
process — **it exists because there has been no other way to change a string.**
The moment Ken can edit live, that chain is gone: no reviewer, no diff, no gate
run, no artifact of what changed or why.

So the spec's job is not "add a text box." It is **to say what replaces the
review it removes.**

### The precise version, because the obvious one is false

**It is not true that every word a customer reads went through a PR.** Four
owner-authored fields already reach customers with no reviewer, and they
already carry the guard shape this feature needs:

| field | where | guard today |
| --- | --- | --- |
| quote line descriptions | `cleanQuoteAdjustment`, `quotes.mjs:258-261` | required, ≤200 chars, ≤25 lines |
| the customer note | `quotes.mjs:271-275` | optional, ≤1000 chars |
| the decline reason | `cleanReason`, `quotes.mjs:243-250` | optional, ≤500 chars |
| pricing-catalogue line labels | `inventory.mjs`, `setPricingLines` | required, ≤200 chars, capped array |

`lineItems` and `note` are both in `CUSTOMER_QUOTE_FIELDS`; the reason renders
on `/status`. All four reach a real reader.

**Two consequences. The second is the one to build on.**

**The guard pattern is not ours to invent.** It is the house idiom, already
proven load-bearing — a new field mirrored `cleanReason` this week and was
verified by deleting the guard and watching four tests go red. A copy guard
that mirrors it inherits a reviewed shape instead of proposing a new one.

**And the accurate framing is narrower than "all copy was reviewed", and cuts
better:**

> **This feature moves unreviewed owner text from *one customer who already
> asked* — private, per-request — to *every visitor and every searcher*, public
> and standing.**

A bad quote note reaches one person who can text Ken back. A bad `<title>`
reaches everyone who searches and keeps reaching them after it is fixed. That
framing also gives the guards something to be sized against: the question stops
being *should there be a rule* and becomes *this field already has a
500-character rule for one reader — what does it need for fifty thousand?*

---

## The boundary coincides with the gate, which makes it a constraint

**RULED, and it is why this section stands on its own.**

The three browser audits navigate by visible button text:

```
button:has-text("Continue to tires")      12 in dead-end-audit.mjs
                                           3 in request-flow-check.mjs
                                           2 in audit-ui.mjs
"Request my quote"                         2 in request-flow-check.mjs
```

**Every string the gate depends on is customer-flow copy — the side the user
excluded.** The line drawn by product instinct coincides exactly with the line
the gate needs held stable.

**That converts the boundary from a preference into a constraint**, and
constraints survive re-litigation in a way preferences do not. Anyone later
arguing that a wizard label is "just copy, surely we can let Ken edit it" is
not proposing a scope change — they are proposing to make the gate unable to
navigate the flow it exists to prove.

---

## Which copy is safe to hand over unguarded

**The discriminator is not how "marketing" a string feels. It is whether a
constraint in the code can contradict it, times how far a bad edit reaches,
times whether it can be taken back.**

### The constraints copy can contradict, measured

| constraint | where | copy that would contradict it |
| --- | --- | --- |
| `MIN_LEAD_DAYS = 7` | `backend/quotes.mjs:25` | *same day*, *24/7*, *emergency*, *right away* |
| radius 100 mi, review band 25 mi, base 02148 | `service-area.mjs:40-42` | *anywhere in Boston*, *all of New England* |
| payment is not taken at request time | the flow, and `CustomerRequest.jsx:442` | anything about when money moves |
| markup rate is `isPlaceholder` | `src/markup.js` | *lowest price*, *no hidden fees* |
| R26 — no marketing use of a customer address | `requirements.md` | any newsletter or offers wording |

### Three tiers

**Green — safe beyond non-empty and a length bound.** Taste, not commitments;
reverts on the next page load. Section eyebrows, the footer brand line, the
`Inquiry.jsx` and `NotFound.jsx` prose.

**Amber — editable, behind the claim guard below.** Where a sentence becomes a
promise the software will refuse to keep: the hero lede, all three
service-strip claims, the hero visual label (`REAL MOBILE SERVICE / BOSTON` is
a coverage claim against a 100-mile radius).

**Red — not editable.** Durable, cached beyond our reach, or carrying an
obligation. See the exclusions below.

**The one-line test:** *if this string were wrong for a week, who would see it,
and could we take it back?*

---

## What is excluded, and why

### The `index.html` head — RULED out of scope

`<title>`, meta description, `og:*`, JSON-LD.

**This is the one tier where a bad edit is durable.** Everywhere else a mistake
is visible on the page and fixed in a minute; a wrong `<title>` propagates into
a search index and link previews and outlives the correction by days. **Editing
is only safe where it is reversible, and this is the one place it is not.**

Two further reasons, both structural. It is **tier B** — baked into `dist/` at
build time — so reaching it needs server-side HTML rewriting, a new mechanism
on a one-machine deployment whose health check Fly restarts on: real cost,
buying the least reversible tier. And the head is the **acquisition surface**,
where the owner's positioning ruling is expressed (*a funnel for tire sales and
schedulable work; no emergency vocabulary*), with the reasoning already
recorded in a comment directly above the tag: job and place first, brand last,
and no speed term because `MIN_LEAD_DAYS` puts a seven-day floor under every
booking.

**This is a deliberate narrowing of "all copy" and the OWNER AGENT is flagging
it to the user as one.** If overruled it becomes a second phase with
server-side rendering.

### Four more, all RULED excluded

**1. The hero CTA and the three nav labels.** A button that is the only route
into the wizard *is* the wizard's entrance. **And its accidental protection is
being removed this week**: `data-testid` in the audits is `0` today, and #375
replaces text locators with testids — after which a broken CTA label breaks
nothing the gate can see.

*Applying that same rule where it was not spelled out:* `More than tires? Tell
me` (`CustomerRequest.jsx:437`) is the **only** in-app route into `/inquiry`
(measured — the only other reference is the route definition at
`App.jsx:103`), so it is that flow's entrance and is excluded on the same
grounds. Recorded as an inference from the ruling, open to correction.

**2. `No payment now. Ken reviews your request before you pay.`** Excluded not
for where it sits but for what it is: **a commitment about when money changes
hands, which the product enforces.**

**3. `Privacy.jsx`, in full.** **A legal disclosure is not marketing copy.** An
owner-editable one with no reviewer is a different risk class from a headline.
It stays under PR review.

**4. Strings that are business facts with a code counterpart.** The footer's
`Mobile tire service. Malden, MA.` and the *"about N miles from Malden"* a
refused customer reads are both downstream of `DEFAULT_BASE_ZIP = '02148'`.
**Editable display over fixed behaviour is a defect generator, not a feature** —
it manufactures the drift class that produced the README line, corrected the
same hour this was written, claiming the business was in Everett.

### Two RECOMMENDED out, not yet ruled

- **Email templates** (`backend/mail-templates.mjs`). Customer-facing and
  governed by the voice rule, but each interpolates request data, so an edit can
  break an invoice; #293 is open on them.
- **Owner-screen copy** (`/owner`, `/owner/quotes`, `/owner/outbox`) and the
  `alt`/`aria-label` strings. Not "the website" in the sense the user meant.

---

## What version one actually covers

**About 24 strings.** Stated plainly because the instruction said *all copy*
and the rulings above are a real narrowing — the number belongs in front of
whoever decides whether the machinery is worth it.

| surface | strings | tier |
| --- | --- | --- |
| Hero — eyebrow, `Mobile Tire` / `Service`, two lede lines, visual label | 6 | amber |
| Service strip — three title/body pairs | 6 | amber |
| Order-section heading — `SHOP KMT`, `Order tires online`, the lede | 3 | green |
| Footer brand line | 1 | green |
| `Inquiry.jsx` prose | 5 | green |
| `NotFound.jsx` prose | 3 | green |

It is still the whole marketing surface: everything a visitor reads before
deciding to start, which is the part Ken has opinions about and the part no PR
should be needed for.

---

## The replacement for review

### 1. Reversibility, first

Keep the previous value and offer one-tap revert. Nearly free in the `metadata`
JSON (`{ current, previous, updatedAt }`), and **it is what makes every other
rule optional rather than load-bearing — a mistake you can undo in one tap is
not a mistake that needs preventing.**

### 2. The claim guard — warn, explain, require acknowledgement; never block

**RULED: build it, and it is not paternalism.** It does not protect Ken from
bad taste. **It stops the site making a promise the booking form will refuse.**
`MIN_LEAD_DAYS = 7` is a hard floor: a customer who reads *same day*, decides
to buy, and then hits a seven-day wall **has been misled by our software, not
by Ken's judgement.** That is a correctness constraint wearing a copy costume.

The evidence is that the composite-immediacy failure **already happened —
through agents, under review, with a gate** — and still took two sessions a
full night to converge on. The one person who will never have a second reader
should not meet it with no rail at all.

**A word list cannot tell "quick quote" (true) from "same-day service" (false),
so it must not try.** Show Ken the conflict — *the booking form enforces a
seven-day minimum; this text promises sooner* — and let him proceed if he means
it. He owns the business. **What he must not be able to do is promise it
without knowing the form will refuse it.**

**A block gets resented and routed around; a reason gets read.**

### 3. Length bounds and non-empty on structural fields

Mirroring `cleanReason` rather than inventing an idiom. A heading, a lede and
the strip titles cannot be blank.

### 4. The voice rule beside the field, not in a document

Ken is one man: the copy says "I", never "we". Three customer emails already
went out saying "we".

### 5. Preview before save

### 6. Prove each guard can fail before trusting it to pass

Delete it and watch the test go red. This repository has two recorded cases of
a guard that passed on input it should have rejected.

---

## The storage, which costs no schema change

`backend/inventory.mjs:62`:

```sql
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

`getMeta`/`setMeta` JSON-encode the value. Keys today: `markup`, `pricing`,
`pricingLines`, `seeded`, `job`.

**A `siteCopy` key needs no `ALTER`, no `migrate()`, no CHECK change** — which
matters because `NOTES.md` records that a schema change is the thing that
passes every test and both CI jobs and then fails on production's first write.
This avoids the class rather than mitigating it.

**Delivery precedent exists:** `/api/catalog` is public (`api.mjs:47`) and
already serves an owner-set setting to the customer page — `disposalFee`, from
the `pricing` key (`api.mjs:156`). Copy wants its own endpoint rather than
riding `/api/catalog`, which is per-size and `no-store`.

---

## What stops a bad edit today: measured, and it is nothing

**No audit asserts any marketing copy.** Zero matches across every
`.forge/*.mjs` for `hero`, `eyebrow`, `service-strip`, `site-footer`, `COME TO
YOU`, `PRICE UP FRONT`, `Order tires online`.

**A positive control was run first**, because a grep returning nothing agrees
with whatever you already believed: the same grep finds the flow locators in
the same files (12, 3 and 2 hits), so it reaches them and works. The single
`Roadside` hit is `request-flow-check.mjs:70`, the wizard's location-type
button — a control, not the hero lede.

**Partial cover that remains:** `responsive-check.mjs` measures horizontal
overflow on 10 screens at 375px and 1280px, so an unbreakable long token trips
it. It would not catch an emptied hero, a 40-word heading that wraps politely,
or a sentence that is simply false.

---

## How this was measured, and what it cannot see

A deliberately crude extractor pulls JSX text nodes, text-bearing props
(`placeholder`, `alt`, `aria-label`, `title`, `label`) and sentence-shaped
literals. It over-reports on purpose and was filtered by hand, because a silent
miss is the failure this repository keeps recording.

**Validated before its numbers were used:** against `CustomerRequest.jsx` it
returned every string already read by hand off the render block, plus two
comment blocks as false positives — the over-report working.

**What it cannot see, said now rather than discovered later:** copy composed at
runtime from parts, copy in CSS `::before` content, and any string reaching a
customer through a path not read. **The counts here are a floor, not a total.**
