# Roadmap

<!-- Maintained by forge and by you. Edit freely: the agent reads this before it plans. -->

Milestones in order. The structured version lives in state.json; this file is
for the reasoning behind the sequence -- why this before that.

## Sequencing logic

The order follows the flow itself (customer request -> draft quote -> owner
review -> customer payment -> confirmation), because that's also the order of
dependency: nothing downstream can be built, or even sensibly demoed, before
the thing upstream of it exists.

Two things are pulled forward ahead of "build features," on purpose:

1. **Deployment (m1) goes first, not last.** The project doc treats a live
   public URL as part of the definition of done, not a follow-up step. Standing
   up hosting after everything is built risks discovering a deployment problem
   (routing, build config, env quirks) at the worst possible time -- right before
   the client demo. Deploying an empty skeleton first retires that risk cheaply
   and gives every later milestone a place to land continuously.
2. **The shared-state mechanism (localStorage-backed store, see decisions.md)
   is introduced early, in m2-m3**, because the demo's core trick -- the owner
   seeing what the customer just submitted, in the same sitting -- depends on
   it. Building the customer form and the owner screen without agreeing on how
   they talk to each other first would mean redoing one side or the other.

## Now

- **m1 -- Skeleton app is live at a public URL.** Scaffold, two-route shell,
  deploy. Nothing else can be verified end-to-end until this exists, and
  deployment is deliberately proven early (see above) rather than saved for
  the end.

## Next

- **m2 -- Customer can submit a tire request.** Hardcoded catalog first (it's
  consumed by both the form and the pricing engine later), then the form,
  then wiring submission into the shared store.
- **m3 -- Submitted request gets an instant draft quote.** The pricing engine
  is built and tested as a pure function in isolation before it's wired into
  the submit flow, so pricing-rule bugs are caught without needing to click
  through the UI each time.
- **m4 -- Owner can approve or see exceptions.** Depends on m3 because there's
  nothing to review until quotes are drafting themselves. The exception state
  is visibly distinct from day one rather than retrofitted, since R3 requires
  that distinction to be demonstrable.
- **m5 -- Customer can view the approved quote and pay.** Depends on the
  owner's approval actually changing state in m4; payment is intentionally the
  last feature added because it's the simplest (always succeeds, no real
  validation) and has nothing behind it.

## Later

- **m6 -- Happy path is demo-ready end to end.** Once every screen exists,
  this milestone is entirely about polish and verification: a clear end
  state, a responsive pass across phone and desktop widths, a no-dead-end
  audit of the whole path (including the exception branch), and a final
  deploy + on-device check. This is last because polishing a screen before
  its neighbors exist is wasted effort -- the responsive and dead-end audits
  are cheapest done once, against the finished flow.
