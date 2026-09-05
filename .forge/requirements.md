# Requirements

<!-- Maintained by forge and by you. Edit freely: the agent reads this before it plans. -->

Each requirement is testable: it says what must be true, not how to build it.

## Functional

_R1._ A customer, starting at `/`, can submit a tire request: vehicle info, a tire
choice picked from a hardcoded catalog, and location/date placeholders. No login
required.

_R2._ On submission, the system immediately produces a draft quote by running
faked/simplified pricing rules over the hardcoded catalog. No manual pricing step
blocks this.

_R3._ An owner, at `/owner`, can see drafted quotes and for each one either:
- **Approve & Send** in one tap, or
- see it flagged as an **exception** requiring attention instead of being
  auto-sendable (the trigger for "exception" may be scripted/faked, but the state
  must be visibly distinct from a normal approvable quote).

_R4._ There is an obvious, tappable way to navigate between the customer flow (`/`)
and the owner flow (`/owner`) so both can be demoed from one session on one device.

_R5._ After the owner approves a quote, the customer can view the approved quote
and complete a fake payment step that always succeeds (no real processor).

_R6._ The flow has a clear end state after payment ("confirmed and paid"). No
scheduling, dispatch, or fulfillment screens follow it.

_R7._ The app is deployed to a public URL reachable from an arbitrary phone browser
(no VPN, no localhost, no login wall).

## Non-functional

- **Responsive**: primary target is a phone-sized viewport; layout must also remain
  usable and correct at desktop widths. No functionality is desktop-only.
- **No dead ends**: every screen in the one happy path has a visible next action;
  the demo never leaves the tapper stuck with no way forward.
- **Data need not persist** across reloads/sessions unless the lack of persistence
  makes a step in the demo read as broken (e.g. owner approving something the
  customer submitted in the same sitting should still connect, if the demo depends
  on that connection being visible).
- **Minimal dependencies**: stack is React + Vite + Tailwind; avoid adding libraries
  unless they clearly pay for themselves, since Copilot is doing much of the
  implementation and a smaller surface is easier for it (and for review) to reason
  about.
- **No real integrations**: no real payment processor, no real messaging/email
  provider, no real pricing data source. All of these are simulated in-app.

## Open questions

_Nothing blocking planning at this time._ Everything needed to define the Phase 1
prototype has an answer above. Product/scope questions that will matter for a real
Phase 2 (real pricing entry tool, real payments, accounts, scheduling) are
deliberately deferred and listed as "eventual real answer" in project.md rather
than as open questions here, since they don't change what gets built in this phase.
