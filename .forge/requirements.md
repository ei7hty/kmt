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

---

## Phase 2 -- UI refinement requirements

Phase 2 changes appearance and consistency only. R1-R7 above and their behavior are
unchanged and still apply; Phase 2 adds presentation requirements on top of them.

_R8._ `/owner` uses the same visual system as `/` (dark ground, card-based panels
with subtle borders, red accent reserved for primary actions/key figures, condensed
uppercase headings with small red uppercase eyebrow labels, small gray secondary
text) instead of default/unstyled Tailwind gray-and-blue utility styling. This
applies at both phone and desktop widths.

_R9._ On `/owner`, the distinction between a normal approvable draft quote and one
flagged as an **exception** (R3) remains visually obvious after restyling, using a
color other than the brand red or brand green for the exception state (amber, per
the design reference in project.md) so it cannot be confused with a primary action
or a success/paid state.

_R10._ `/status` and `/confirmation` are restyled to reuse the components/classes
introduced for `/owner` and `/` (nav, typography, buttons, cards) so that no screen
in the app looks like it belongs to a different product, without introducing new
layouts beyond what's needed for that consistency.

_R11._ `/status` shows the customer's request position in the draft -> approved ->
paid lifecycle using the same numbered stepper component/pattern already used in
the customer order flow on `/`, rather than inventing a new progress indicator.

_R12._ Success/paid and error/rejected states across `/owner`, `/status`, and
`/confirmation` keep using green for success and a clearly distinct warning color
for exceptions/attention-needed, consistent with existing production-site use of
green as a secondary semantic accent alongside brand red (see project.md design
reference) -- i.e. the redesign does not force every accent into brand red.

_R13._ No functional behavior, state, route, or business rule introduced in Phase 1
(R1-R7) changes as a result of this restyling. Any place where a clean visual fix
seems to require a behavior change is flagged for a decision rather than
implemented silently.

## Phase 2 non-functional

- **No new dependencies** (icon libraries, UI kits, animation libraries, CSS
  frameworks beyond the existing Tailwind 4 + hand-written CSS mix) unless a
  specific package is proposed with a justification that outweighs the
  minimal-dependencies constraint from Phase 1.
- **Mobile-first verification**: every restyled screen is checked at a phone-sized
  viewport first (the client reviews on a phone), then at desktop width, matching
  how `/` was originally verified (see `.forge/shots/phone-*` and
  `.forge/shots/desktop-*` for the Phase 1 pattern to follow).
- **Deployment URL is not a deliverable**: the existing Vercel deployment is
  treated as this project's production environment; Phase 2 may ship to a new
  deployment URL and no task effort is spent making URLs stable across phases.

## Phase 2 open questions

_Nothing blocking planning at this time._ The client confirmed: no owner-screen
mockup exists (both supplied mockups are customer-facing production pages, used as
visual-language reference only); green-for-success/amber-for-attention alongside
brand red is confirmed correct and matches the live production site; `/owner` gets
a full redesign while `/status` and `/confirmation` get a lighter reuse-only pass,
with the customer-flow stepper explicitly reused on `/status`; deployment
permanence is explicitly not a goal for this phase.
</content>
