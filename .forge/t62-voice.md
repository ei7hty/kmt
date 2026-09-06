# t62 — the voice: every sentence, its approved form, and the lead's marks

Written 2026-09-06 by the OWNER PORTAL ANALYST (`local_a76ad1cd`) at the
PROJECT MANAGER's instruction, so the approved list lives on a branch and
not in a message. Extracted at origin/main `09bccf4` from every string
literal and JSX text in `src/`, `backend/` (not tests) and `index.html`,
then a second pass over rendered multi-line sentences; verified against
the files named. The lead approved the list and added five marks, applied
below. JUNIOR FRONT END DEV sweeps from this file; the rule and the method
are in `roles/owner-portal-analyst.md`.

## The rule, in four lines

First person where a person could truthfully say it. No pronoun where the
speaker is a loading state, the browser, a server error or a lookup
table. The privacy page stays in the third person (a statement of
obligations, not a conversation). Every "call us" becomes "text me" (t63,
customer-facing controls only; the owner card's `tel:` link stays). The
business name "Ken's Mobile Tire" is untouched everywhere.

## Scope

In: the 32 sentences below, all in `src/` and `backend/`. Out: t65's line
("Flat repairs, roadside help and anything else that keeps you moving.
Tell me what you need.") is approved but belongs to the section under
"Looking for more than just tires?", which is not on main; it lands with
that section, not with this sweep. Out: the five email sketches in part F
are the voice for t37's templates and touch nothing in `src/`. Out: the
owner screens, which speak to Ken and carry no "we"; `docs/owner-guide.md`,
which addresses Ken as "you"; every sentence with no pronoun that needs no
voice decision ("You have not been charged." stays).

## A. Marketing copy — `src/routes/CustomerRequest.jsx`

| # | line | now | approved |
| --- | --- | --- | --- |
| 1 | 424 | WE COME TO YOU (hero eyebrow) | I COME TO YOU |
| 2 | 425 | WE COME TO YOU · Home, work or roadside (service strip) | I COME TO YOU · Home, work or roadside |
| 3 | 430 | STEP 03 / WE COME TO YOU (step-3 kicker) | STEP 03 / I COME TO YOU |
| 4 | 426 | Find the right fit for your vehicle and we'll handle the rest. | Find the right fit for your vehicle and I'll handle the rest. |
| 5 | 430 | Let's bring the shop to you. | keep as is |
| 6 | 424 | Tires. Repairs. Roadside assistance. Fast, reliable & always on the move. | keep as is (no pronoun) |

## B. The size step — `src/routes/CustomerRequest.jsx`

| # | line | now | approved |
| --- | --- | --- | --- |
| 7 | 428 | We don't have a size {size} to choose here. | {size} isn't a size I list here. |
| 8 | 428 | No sizes match "{search}". | keep as is (no pronoun) |
| 9 | 429 | We don't stock {size} for online ordering. | I don't sell {size} online yet. |
| 10 | 429 | We can still source it. | I can still get it. |
| 11 | 429 | Call us and we'll sort it out, or pick a different size. | Text me and I'll sort it out, or pick a different size. |
| 12 | 429 | Showing our standard list; today's stock and prices are confirmed when Ken reviews your request. | Showing my standard list; today's stock and prices are confirmed when I review your request. |
| 13 | 429 | Choose from tires in size {size}, then tell us what you drive. | Choose from tires in size {size}, then tell me what you drive. |
| 14 | 69 | We are still checking today's prices for {size}. One moment. | Still checking today's prices for {size}. One moment. |

## C. Vehicle, location, contact — `src/components/RequestDetails.jsx` and the ZIP step

| # | file:line | now | approved |
| --- | --- | --- | --- |
| 15 | RequestDetails.jsx:7 | Unsure? Tell us what you know. | Unsure? Tell me what you know. |
| 16 | RequestDetails.jsx:29 | We'll meet you there. | I'll meet you there. |
| 17 | RequestDetails.jsx:31 | Include direction of travel and a landmark so we can find you. | Include direction of travel and a landmark so I can find you. |
| 18 | RequestDetails.jsx:34 | Where do we send your quote? | Where do I send your quote? |
| 19 | CustomerRequest.jsx:428 | Where will we service you? (ZIP step label) | Where do you need me? |
| 20 | CustomerRequest.jsx:430 | Tell us where to find your vehicle and when you'd prefer service. | Tell me where to find your vehicle and when you'd prefer service. |
| 21 | CustomerRequest.jsx:337 | Tell us what vehicle the tires are going on (validation) | Tell me what vehicle the tires are going on |

## D. Errors and status

| # | file:line | now | approved |
| --- | --- | --- | --- |
| 22 | CustomerRequest.jsx:440 | Your details are still here. Try again, or call the shop and we will take it down for you. | Your details are still here. Try again, or text me and I'll take it down for you. |
| 23 | store.js:57 | We could not reach the shop. Check your connection and try again. | Couldn't reach the shop. Check your connection and try again. |
| 24 | store.js:64 | We could not reach the shop. Please try again in a moment. | The shop's site isn't answering right now. Please try again in a moment. |
| 25 | Confirmation.jsx:104 | We could not find that request | That request wasn't found |
| 26 | Privacy.jsx:22 | What we collect | What Ken's Mobile Tire collects — the lead's mark: the rest of the page stays in the third person as it is |

## E. Backend messages that reach a customer

| # | file:line | now | approved |
| --- | --- | --- | --- |
| 27 | quotes.mjs:294 | That tire is not one we currently offer. Choose another. | That tire isn't one I offer right now. Choose another. |
| 28 | quotes.mjs:565 | This request has been paid for. Get in touch and we will sort it out. | This request has been paid for. Text me and I'll sort it out. |
| 29 | api.mjs:261 | That email address has been used for too many requests today. Call us instead. | That email address has been used for too many requests today. Text me instead. |
| 30 | service-area.mjs:151 | We do not recognise that ZIP code. | That ZIP code isn't one I recognize. — the lead's mark: US spelling |
| 31 | service-area.mjs:157 | That address is about {N} miles from us, outside the {M} mile area we serve. | That's about {N} miles from Malden, outside the {M} miles I cover. Text me at (617) 410-8319 if you'd like to ask anyway. — the lead's mark: the text invitation stays |
| 32 | service-area.mjs:163 | About {N} miles from base, beyond the {M} mile review distance. (owner-facing exception reason) | About {N} miles from Malden, beyond the {M} mile review distance. |

Line numbers are as of `09bccf4`; match on the text, not the number.
Rows 30 to 32 are `backend/`, LEAD BACKEND DEV's lane by the lanes table;
if the sweep is `src/` only, hand those three across rather than editing
them from the UI lane. The `tel:` link on the owner card
(`QuoteRequests.jsx`) is not in this list and stays.

## F. The five emails (t37): the voice, not code in `src/`

From name "Ken's Mobile Tire"; every body first person and signed "Ken";
the text number in every customer message; "we" nowhere; the business name
only in the From line and the footer. The receipt's money lines stay in
plain itemised form. Sketches, with the lead's mark applied to the first
("usually the same day" cut):

- Customer, request received: "Got your request for 4 × [tire] on your
  [vehicle]. I'll look it over and send you a quote. Track it here:
  [link]. — Ken"
- Ken, new request (to Ken; second person, no "we"): "New request:
  [vehicle], 4 × [tire], [town], [date]. Open it: [link]."
- Customer, quote sent: "Here's your quote for the [vehicle]: [lines] …
  Total $[X]. Pay here: [link]. Questions? Text me at (617) 410-8319. —
  Ken"
- Customer, payment received: "Payment received, thank you. I'll be at
  [location] on [date]. Your receipt: [lines, total]. Text me if anything
  changes. — Ken"
- Customer, declined, **when Ken wrote a reason**: "I can't take this one
  on: [reason]. You haven't been charged. Text me at (617) 410-8319 if
  you'd like to talk it through. — Ken"
- Customer, declined, **when he left it blank**: "I can't take this one on.
  You haven't been charged. Text me at (617) 410-8319 if you'd like to talk
  it through. — Ken"

  Two sketches, not one, because the reason is genuinely optional and this
  list previously implied it was not. `backend/quotes.mjs:217` is explicit --
  *"Optional means optional: nothing is a valid reason, and stores as no
  reason"* -- and the owner's own prompt invites it: *"Leave blank to say
  nothing."* So a template built from the single sketch sends **"I can't take
  this one on: . You haven't been charged."** to somebody who has just
  learned they are not getting their tires. The colon and the reason appear
  together or neither appears.

  The screen already gets this right and the email must match it:
  `src/routes/QuoteRequests.jsx:230` renders
  `` {CLOSED_NOTE[quote.status]}{quote.reason ? ` ${quote.reason}` : ''} ``.

  **Never synthesise the missing half.** A reason Ken did not write is a
  sentence he has to defend when the customer texts him about it, and the
  ruling in `decisions.md` that created this message type says so: the
  reason is carried only when he actually wrote one, never inferred and
  never generated. Declining without explanation is a thing a person is
  allowed to do; inventing his explanation is not.

## Checking the sweep

The junior's own enumeration found 19 sentences with a pronoun plus the
hero line; this list has 32. The difference is rows a grep cannot see:
sentences assembled from two literals across lines (9, 10, 11, 13), the
backend rows (27 to 32), and rows whose line also contains an excluded
word. Diff the two lists; any sentence on one side and not the other is
either a miss or a new string since `09bccf4`, and both are worth a line
in the PR.
