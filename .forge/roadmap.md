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

---

# Phase 2 — UI refinement

One milestone, because this is a single outcome rather than a sequence of
capabilities. Nothing here adds behaviour; every task changes how the product
looks and then proves it did not change what it does.

## Now

- **m7 — App looks like one product across every screen.** The order inside
  this milestone matters more than usual, because a styling pass done in the
  wrong sequence gets redone.

  **t17 extracts the shared classes first**, and everything else depends on it.
  Phase 1 produced a branded customer flow and three screens leaning on
  Tailwind defaults with dark-theme overrides bolted on. Restyling those
  screens one at a time would invent three slightly different versions of the
  same card, button and heading — the exact inconsistency this phase exists to
  remove. Pulling the vocabulary out once means the later tasks are applying a
  system rather than each making up their own.

  **t18 redesigns /owner**, and t19–t21 hang off it. This is the only screen
  getting a genuine redesign rather than a reuse pass: it is what has to sell
  the concept to the shop owner, since it is the part that saves him time, and
  it currently looks like a different application. t20 (/status, plus the
  numbered stepper the customer already knows from the tire-results mockup) and
  t21 (/confirmation) come after because they reuse what t18 settles.

  **t19 is separated from t18 on purpose.** Restyling the owner screen is
  exactly when the exception state stops being visually distinct — the risk is
  that a consistent dark card treatment flattens "needs attention" into looking
  like every other row. R9 is a requirement, not a detail, so it gets its own
  check rather than being assumed.

  **t22 and t23 are the verification pair**, reusing the scripts Phase 1 left
  behind rather than new ones: `responsive-check.mjs` for overflow at phone and
  desktop widths, `dead-end-audit.mjs` to prove no behaviour regressed. A
  styling pass is precisely the kind of change that silently breaks a click
  path, and R13 says behaviour must not change, so the audit is the evidence.

  **t24 deploys and checks on a real phone**, last, for the same reason it was
  last in Phase 1: the flow passing locally and failing in production is a
  thing that has already happened once on this project.

---

# Phase 3 — Real inventory reaches the customer

Phase 2 finished (24/24 tasks). Since then, work landed on this repository
outside any forge-tracked milestone: a real owner backend (`backend/`, SQLite
via `node:sqlite`) that lets the owner curate supplier inventory scraped from
giga-tires.com, set his own price per tire, and fall back to a markup rule
(`src/markup.js`) for anything he hasn't priced yet. It is documented in
`.forge/owner-backend.md`, which is explicit that it was scoped to stop short
of the customer: *"Customer tire selection and pricing are unchanged... Wiring
the snapshot into the live catalog is a separate, deliberate step."*

That gap is what Phase 3 (**m8**) closes. Today, `/owner` lets the owner curate
a real inventory that has no effect on what a customer sees or is quoted: the
customer flow at `/` and the pricing engine in `src/pricing.js` still run
entirely over the fully-generated static catalog
(`src/data/catalog.js`'s `buildCatalog()` with no arguments), and requests/
quotes still live in `localStorage`, disconnected from the SQLite backend.
Closing that gap is a single, nameable outcome and the most valuable thing to
do next: everything the owner does on `/owner` today is otherwise invisible
to the product it's meant to serve.

## Why this sequence inside m8

**t25 (split `App.jsx`) goes first**, ahead of any functional change, because
every other task in this milestone edits the customer route's tire-loading
code, and `.forge/AGENTS.md` already flags `App.jsx` as a 23KB single file
that has burned whole agent sessions just being read. Splitting it first,
while the change is still behavior-only, is cheap to verify (build, lint, both
audits, same counts as before) and makes every later diff in this milestone
smaller and safer to review. Doing it after t27 would mean re-verifying a
functional change and a structural one tangled together.

**t26 (customer-safe catalog endpoint) comes before t27 (wire it up)**
because the endpoint's contract -- what shape it returns, what it omits, how
it resolves owner-price-vs-markup -- needs to be right and tested in isolation
(via `backend/owner.test.mjs`) before the frontend depends on it. Getting the
backend and frontend right at the same time, in the same task, means a bug
could be in either side and there is no isolated test proving which.

**t27 depends on both** and is where fallback behavior matters as much as the
happy path: the static Vercel deployment cannot run the SQLite/browser backend
(see the deployment boundary in `.forge/owner-backend.md`), so the public demo
must keep working exactly as today when no backend is reachable. That's a
decision already recorded (see decisions.md) rather than left to be discovered
during implementation.

**t28 (deploy and verify) is last**, as it was in m6 and m7 for the same
reason each time: a flow that passes locally and fails in production is a
thing that has already happened once on this project (missing SPA rewrite,
Phase 1). It also has to verify two different environments -- the deployed
fallback path, and the live-backend path locally -- because the deployed
environment cannot demonstrate the live-backend path itself.

## Now

- **m8 — Customer quotes are priced from the owner's real inventory, not the
  static demo catalog.** t25 → t26 → t27 → t28, as above.

## Open questions for the owner (not guessed at in tasks above)

These change the *scope* of later work in ways only Ken can decide, so they
are written down here rather than turned into tasks:

1. **Does the owner backend get deployed anywhere the customer can reach, or
   does the live/curated-inventory experience stay a local-only demo for now?**
   `.forge/owner-backend.md` is explicit that the current backend binds to
   loopback, has no auth, and the static Vercel deployment can't run a
   persistent SQLite + browser process. m8 makes the *wiring* work either way
   (fallback keeps the public URL working with no backend), but deciding to
   actually host the backend somewhere reachable is a real infrastructure and
   cost decision -- hosting, a persistent DB, and where the Playwright-driven
   supplier refresh runs -- that shouldn't be assumed.
2. **Should the request/quote data (currently `localStorage`, per the Phase 1
   decision) move into the same real backend/database as inventory, or stay
   separate for now?** Once inventory is real, having quotes still live only
   in the customer's browser is an increasingly odd asymmetry, but merging them
   is a bigger step (a real backend for demo state, matching real inventory)
   that Phase 1's decision log explicitly deferred. Worth revisiting once m8
   ships and the owner has used the wired-up flow, not before.
3. **What should happen when the owner has curated zero tires for a size (or
   for everything)?** Before m8, every size always has generated fallback
   tires, so this never happens. After m8, a size where the owner has offered
   nothing could show as empty to a customer. Whether that should show "call
   us" (like the existing no-stock-for-online-ordering path) or silently fall
   back to the generated catalog for that size is a product call about how
   "real" the demo should look versus how populated it should look, not
   something to decide inside a task.
4. **Does the exception engine (`src/pricing.js`) need to know about real
   supplier data at all in this phase** -- e.g. should a tire the supplier has
   marked inactive/no-longer-listed trigger an exception the way "out of
   stock" already does -- or is that explicitly out of scope until the owner
   asks for it? Left alone in m8: `calculateDraftQuote` keeps reading
   `inStock`/`category` off whatever catalog array it's given, generated or
   real, and no new exception rule is added speculatively.
</content>
