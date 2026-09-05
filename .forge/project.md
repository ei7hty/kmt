# KMT Tire Quoting

> **Working alongside other agents?** Read `.forge/AGENTS.md` first. Several
> agents share this repository and cannot message each other, so the protocol
> for claiming work, staying out of each other's commits, and verifying changes
> lives there.


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

---

## Phase 2 -- UI refinement

Phase 1 shipped: 16/16 tasks done, deployed to Vercel, and audited. That deployment
is treated as this project's production environment going forward.

### What this phase is

Phase 1 delivered the *shape* of the product but the polish landed unevenly: the
customer flow at `/` is strongly branded (dark ground, red accents, KMT logo, bold
condensed headings, a three-step wizard with a visual tire-size selector) while
`/owner` -- the screen that has to sell the whole concept to the shop owner, since
it's the part that actually saves him time -- uses default/unstyled Tailwind gray
and blue. `/status` and `/confirmation` sit in between: functional, but not
obviously part of the same product as `/`.

Phase 2 is a **visual refinement pass only**. No new functionality, no real
backend, no real payments, no supplier integrations. Same stack: React 19, Vite,
Tailwind 4, no new dependencies unless clearly justified. Mobile-first, since the
client reviews on a phone.

### Design reference

The client supplied two mockups from the production KMT marketing site (not this
prototype, and not owner-screen mockups -- no owner mockup exists):

- **`mock (1).png` -- homepage**: full-bleed dark hero with a photo of the wrapped
  KMT box truck; small red uppercase eyebrow "WE COME TO YOU" above a huge
  condensed uppercase headline ("MOBILE TIRE" in white, "SERVICE" in red); two
  stacked CTAs (solid red primary with a small subtitle, dark outlined secondary);
  a row of three icon+label trust items; a bordered "ORDER TIRES ONLINE" strip with
  red line icons and a red CTA; a "WHAT WE DO" eyebrow over "OUR SERVICES" heading
  with five dark image cards (bold uppercase title, small gray body text); a bottom
  stats bar with big red numbers over small uppercase gray captions.
- **`mock (2).png` -- tire results/checkout page**: a numbered three-step progress
  bar ("1 CHOOSE TIRES, 2 REVIEW ORDER, 3 CHECKOUT") with the active step a filled
  red circle and completed track red; a dark summary strip showing the selected
  tire size with a red "Change Size" link; a left filter sidebar with red
  checkboxes and a red range slider; a center column of dark tire result cards
  (product image, title, spec line, green "In Stock" text, per-tire price in white,
  set-of-four price large in red, solid red "SELECT TIRE" button); a right-hand
  "ORDER SUMMARY" panel with line items, a large "ESTIMATED TOTAL," a full-width
  red "REVIEW ORDER" button, and three icon+text reassurance blocks; a four-item
  trust bar at the bottom.
- **`mock (1).jfif`**: same visual language reference as above (client-provided,
  same production site).

Key takeaway confirmed by the client: **green is already used in production as a
secondary semantic accent alongside brand red** (e.g. "In Stock" text, "FREE" line
items) -- it is not a departure from brand to keep using green for success/paid
states in this prototype, and amber (already used in Phase 1's exception styling)
is the right distinct color for "needs attention" so it's never confused with a
primary action (red) or a success state (green).

### Scope split

- **`/owner`**: full redesign. No owner mockup exists, so the plan is to build it
  as branded cards using the same visual language as `/` and the mockups -- near-
  black page ground, dark card panels with subtle thin borders, small red uppercase
  eyebrow labels above bold condensed uppercase headings, red reserved for primary
  actions and key figures (not decoration), small gray secondary text. This is not
  an invented dashboard layout, just the existing request/quote list restyled to
  match the brand.
- **`/status`**: lighter pass. Reuses whatever nav/typography/button/card
  components come out of the `/owner` and `/` work. One explicit reuse (not a new
  feature): the numbered stepper pattern from the customer order flow / mock (2)
  should be reused on `/status` to show the customer's request position in the
  draft -> approved -> paid lifecycle, since the customer already sees that pattern
  during ordering.
- **`/confirmation`**: lighter pass, same reuse-only approach as `/status`.

### Explicitly out of scope for Phase 2

- Any new functionality, screen, or route.
- A real backend, real payment processor, or real supplier/pricing integration.
- New dependencies (icon libraries, UI kits, animation libraries, additional CSS
  frameworks) unless a specific package is proposed with a justification that
  outweighs the minimal-dependencies constraint.
- Changing any business rule, validation, or state transition introduced in Phase 1
  (e.g. what makes a quote an "exception," what "Approve & Send" does, the fake
  payment behavior). If a clean visual fix seems to require a behavior change,
  that's flagged for a decision, not made silently.
- Deployment permanence. The existing Vercel URL is production for this project;
  Phase 2 may ship to a new deployment URL and no task effort goes into making URLs
  stable across phases.
</content>
