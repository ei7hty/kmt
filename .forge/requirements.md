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

## Phase 4 open questions

For the owner, not guessed at in the tasks:

1. **Should the owner be able to change the drafted total before approving?**
   Today he can only approve or reject the number the rules produced. That is
   fine for a demo and probably wrong for a business where "Ken prices the job
   in his head" is the current process. Not built here; it changes what
   "approve" means.
2. **How long are requests kept, and does the owner need to close or archive
   them?** Phase 4 keeps everything forever and shows everything. A list that
   only grows will need a "done" state before long.
3. **Notifications.** With requests on the server, telling the owner a request
   arrived and telling the customer a quote is ready are the obvious next step
   and the first real integration (SMS or email). Which channel, and whether the
   owner wants one at all, is his call.
