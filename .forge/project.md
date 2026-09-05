# KMT Tire Quoting

<!-- Maintained by forge and by you. Edit freely: the agent reads this before it plans. -->

## What this is

Automated draft quotes for Ken's Mobile Tire, reviewed by the owner before they go out.

**Phase 1 is a clickable prototype, not a production system.** Its only job is to let
the client tap through the intended experience end-to-end and react to it. Nothing in
it needs to be real, accurate, or connected to a live system yet -- see "Faked vs.
real" below.

## Who it is for

- **The client / owner (Ken)**: needs to see and feel the whole flow -- customer
  request, auto-drafted quote, his one-click review, customer payment -- before
  committing to building it for real. Today this is entirely manual: customer calls
  or texts, Ken prices the job in his head or on paper, quotes verbally, and collects
  payment in person or over the phone.
- **The end customer**: requests a quote and, in this prototype, experiences getting
  a fast, professional-looking quote back and paying online instead of waiting on a
  callback.

## The MVP

A tappable demo covering one path start to finish, with dummy data throughout, in a
single deployed app with two entry points:

- **`/` (root)** -- the customer flow.
- **`/owner`** -- the owner review screen.
- An obvious link/nav between the two so the client can hop back and forth and see
  both sides of the flow in one sitting, on one phone, from one URL.

Flow:

1. Customer submits a tire request (vehicle info, tire choice from a hardcoded
   catalog, location/date placeholders).
2. System auto-drafts a quote immediately using the dummy catalog -- no manual
   pricing step.
3. Owner sees a review screen: the drafted quote, a one-click **Approve & Send**,
   and an **Exceptions** state that flags quotes needing attention (e.g. something
   the fake pricing logic can't confidently price) instead of auto-sending them.
4. Customer receives/views the approved quote and pays (fake payment, always
   succeeds).
5. Flow ends at "customer confirms and paid." No scheduling, dispatch, or
   fulfillment.

The MVP is done when:

- A person can tap through steps 1-4 without hitting a dead end, using believable
  but fake data, in a way that clearly demonstrates the *shape* of the real product
  to the client.
- It works well on a phone screen first, and still looks correct on desktop.
- **It is deployed to a public URL the client can open on their own phone.**
  Deployment is part of "done," not a follow-up step.

## Faked vs. real (read before assuming anything works)

| Area | Phase 1 status | Eventual real answer |
|---|---|---|
| Tire pricing/catalog | Hardcoded dummy catalog | Manual entry by the owner (a real pricing source, swappable in later); prototype's data layer should be structured so this swap doesn't require a rewrite |
| Quote auto-draft logic | Faked/simplified rules over the dummy catalog | Real pricing + business rules |
| Owner approval flow | Visible and clickable (Approve & Send, Exceptions) but the "exception" trigger is faked/scripted | Real rules for what needs a human look |
| Payment | Fake payment step, always succeeds, no real processor | Real payment processor integration |
| Notifications (quote sent, receipt, etc.) | Cosmetic only if shown at all | Real email/SMS delivery |
| Appointments/scheduling/dispatch | **Out of scope entirely** -- flow ends at payment | Future phase |
| Authentication/accounts | Not required for the prototype (both routes are open, no login) | TBD later |
| Data persistence | Not required to survive reloads unless needed for the demo to read naturally | Real database |
| Hosting | Real -- must be a live public URL (Vercel/Netlify/similar) | Same, just a production tier/environment later |

## Explicitly not in scope

- Real payment processing.
- Real tire pricing/inventory data or supplier integration.
- Appointment scheduling, dispatch, or any post-payment fulfillment step.
- Manual pricing-entry tooling for the owner (that's the eventual real answer for
  pricing, but building the entry tool is not part of this prototype).
- Multi-role auth, accounts, or persistence guarantees.
- Native app or wrapped-webview packaging.
- Handling more than the one happy-path flow polished enough to demo; edge cases
  can be stubbed or skipped rather than fully built.

## Constraints

- **Platform**: mobile-first responsive web app; must also look correct on desktop.
  Not native, not a wrapped webview -- the client taps through it in a phone browser.
- **Stack**: React + Vite + Tailwind, minimal dependencies. Chosen because GitHub
  Copilot will be doing much of the implementation, and this stack is common enough
  that Copilot's suggestions stay reliable; no concrete reason to deviate.
- **Deployment**: must be hosted on a public URL (Vercel, Netlify, or similar) that
  the client can open on their own phone. This is part of the definition of done for
  Phase 1, not a later step.
- Budget/deadline: not specified yet.
