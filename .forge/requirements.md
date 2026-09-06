# Requirements

<!-- Maintained by forge and by you. Edit freely: the agent reads this before it plans.
Keep this file under 10000 characters: that is all a forge phase sees. Earlier phases'
full text lives in requirements-history.md; only the current phase is here in full. -->

Each requirement is testable: it says what must be true, not how to build it.

## Standing requirements from phases 1 to 3 (summary; full text in requirements-history.md)

All of these still apply.

- _R1._ A customer at `/` can submit a tire request (vehicle, tire from the catalog, location, date) with no login.
- _R2._ Submission immediately produces a draft quote from the pricing rules; no manual step blocks it.
- _R3._ The owner sees drafted quotes and can Approve & Send in one tap, or sees them flagged as an exception, visibly distinct.
- _R4._ There is an obvious, tappable way between the customer flow and the owner flow.
- _R5._ After approval the customer can view the quote and complete a fake payment that always succeeds.
- _R6._ The flow ends clearly at "confirmed and paid"; no scheduling or dispatch follows.
- _R7._ The app is deployed at a public URL reachable from any phone browser.
- _R8._ `/owner` uses the same visual system as `/`: dark ground, cards, red for primary actions, condensed uppercase headings.
- _R9._ The exception state on the owner screen stays visually distinct, in amber, never red or green.
- _R10._ `/status` and `/confirmation` reuse the shared components; no screen looks like a different product.
- _R11._ `/status` shows the request's position with the same numbered stepper as the order flow.
- _R12._ Green means success or paid, amber means attention, across every screen.
- _R13._ Restyling changed no behaviour, state, route or rule.
- _R14._ With the owner backend reachable, the customer catalog reflects the owner's choices: enabled tires only, at his price or the markup price.
- _R15._ With the backend unreachable the customer flow keeps working from the static catalog (browsing; see R22 for submit).
- _R16._ The customer is sent only name, size, price, in-stock, category and description per tire; never SKU, list price, stock, notes or unoffered tires.

Non-functional rules that still apply: mobile-first, no dead ends, minimal dependencies,
no new dependency without a justification, verification by running the checks in
`.forge/AGENTS.md` rather than reading the diff.

---


## Phase 4 -- The owner reviews real requests from any device

Corrections to the phase 3 section, so nobody plans against them: the
production site runs the owner backend (R15's "cannot run it" is no longer
true, though the fallback it asks for still exists and is still verified), and
open questions 1 and 3 are settled -- the backend is deployed customer-reachable,
and a size with nothing curated shows generated coverage, which is today's
behaviour. Question 4 was settled by #24: a delisted tire is out of stock and
the existing rule routes it to owner review. This phase answers question 2.

R1-R16 stand. Nothing about the exception rules, the catalog, or what a customer
is asked changes here; only where requests and quotes live and who can see them.

_R17._ A request submitted from any browser at `/` is stored by the backend, and
its draft quote is produced by the backend from the same catalog the customer was
shown, using `calculateDraftQuote` unchanged. The customer sees the same draft,
total and exception state they see today.

_R18._ The owner, at `/owner/quotes` on any device, sees every request with its
draft quote and can Approve & Send or Reject, exactly as today, and the result
is visible to the customer on `/status` from their own device without either
side reloading more than once. When hosted, `/owner/quotes` sits behind the same
owner sign-in as `/owner`; locally it needs no password.

_R19._ A customer can return to `/status` on the device they submitted from,
without logging in, and see their own requests and nobody else's. A link that
carries a request's id opens that one request on any device. There is no way to
list requests without holding either the device's key or a request's id, and ids
are not guessable.

_R20._ Payment stays a fake step that always succeeds, but its result is
recorded by the backend, so `/confirmation` and the owner's screen both show
"paid" from any device.

_R21._ Requests and quotes are never stored in the browser. The only thing kept
in `localStorage` is the per-browser customer key. If the backend cannot be
reached when a customer submits, the customer sees a clear failure with the
shop's phone number and a way to retry; the app does not fall back to drafting a
quote locally that no owner will ever see.

_R22._ The catalog fallback from phase 3 (R15) still exists and is still
verified: a customer can browse sizes and tires with the backend down, and only
the submit step needs it.

## Phase 4 non-functional

- **Same database, same server.** Requests and quotes live in the existing
  SQLite file next to inventory, served by the existing `backend/dev.mjs` and
  `backend/server.mjs`. No new process, no new dependency; ids come from
  `node:crypto`.
- **Verification runs against the real server.** A `vite preview` cannot
  complete the customer flow once submit needs the backend, so the browser
  audits, locally and in the CI gate, run against `backend/server.mjs` serving
  the built frontend with a temporary database and a known owner password, and
  they sign in at the owner step. The audit counts are re-baselined in this
  phase and the new numbers recorded in `.forge/AGENTS.md`.
- **Behaviour before and after must match on every screen the customer sees.**
  The dead-end audit, request-flow check and responsive check must pass against
  the real server before and after each task in this phase.
- **No personal data beyond what the form asks for**, and nothing the owner
  writes about a request is sent to a customer.

## Phase 4, second milestone (m10) -- the quote is a real exchange

The three questions above were answered on 2026-09-05 by the client's
representative: build all three. m10 follows m9; it depends on requests living
in the backend.

_R23._ A request carries the customer's name and email address (both required)
and a mobile number (optional, for the owner to call), collected at the
service-details step, validated on the server (email syntactically, phone as
a US number stored normalised), shown to the owner with the request, and never
returned to any other customer.

_R24._ Before sending, the owner can change the tire unit price, change the
service fee, add or remove a line (with a description and amount) and write a
note to the customer. Approve & Send sends the adjusted quote; the original
draft is kept alongside it. The customer sees the sent total and the note.

_R25._ Four emails, each sent by the server when the event happens: to the
customer when their request is received (what they asked for, and that the
shop will reply); to the owner when a request arrives (the request, with a
link to review it); to the customer when the quote is sent (the quote itself,
itemised like an invoice, the owner's note, and the link to view and pay); and
to the customer when payment is recorded (a receipt). Emails go through a real
provider configured by environment; with no provider configured, the server
records each message in an outbox the owner screen shows, so the flow is
verifiable without an account, and the quote email can be read before a real
one is ever sent.

_R26._ Every email is about that one request and nothing else. The form says,
in one line, that the address is used to send the quote. No marketing use, no
list, no unsubscribe machinery needed because nothing recurs.

_R27._ A request has an end: after payment the owner marks the job done, or
rejects or cancels at any earlier point. The owner list shows open requests
first and by default, with a filter for needs-attention, awaiting-customer,
paid and closed. Nothing is deleted.

_R28._ Every state change above is visible to the other side from their own
device, and the stepper on `/status` reflects the new states.

## m10 non-functional

- **No email SDK.** The provider's REST API is called with `fetch` and a
  credential from the environment; the provider is one small module that can be
  swapped. Provider, sending address and the owner's address are configuration,
  never code.
- **Secrets stay out of the repository** and out of the frontend. The owner's
  address and the provider credential live only in the server environment.
- **Deliverability is configuration the client owns**: a sending domain with
  SPF and DKIM set at the provider. Until that is done, mail goes to spam or
  nowhere, and no code change fixes it.
- **Verification against the real server**, as in t32. Notification tests use
  the outbox, not the provider.
