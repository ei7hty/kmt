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

---

# Phase 4 -- The owner reviews real requests from any device

Phase 3 finished (m8, 28/28 tasks): the customer is quoted from the owner's
real inventory, deployed and proven on the live site. The last thing standing
between this and a product two people can use is that requests and quotes
still live in the customer's browser (`src/store.js`, `localStorage`). On the
deployed site the owner cannot see a request unless he is holding the phone it
was made on. Phase 4 (**m9**) moves that state into the backend that already
holds the inventory. It was open question 2 in the phase 3 plan and the owner
has answered it.

## Why this sequence inside m9

**t29 (the backend owns requests and quotes) goes first and is the largest
task**, because everything else is a client of it. It includes drafting the
quote server-side: the server composes the same catalog the customer was shown
(`catalogFromLiveRows` over `inventory.catalog()`) and runs the existing
`calculateDraftQuote` over it, so the rules do not change and there is still
only one pricing implementation. It also settles how a customer gets back to
their own request without an account (an unguessable id and a per-browser key),
which is a contract the frontend must not have to guess at.

**t30 (owner endpoints) is separate from t29** for the same reason t26 was
separate from t27: the owner side has its own access rule (session-gated when
hosted, open locally) and its own tests, and a bug in either side should be
provable in isolation.

**t31 (the frontend switches over) is one task, not four**, because the four
routes share one store module and swapping it under them is a single change
that either works everywhere or nowhere. It is also where R21 is enforced:
the `localStorage` store goes, the per-browser key stays, and a failed submit
becomes a visible state with a phone number rather than a local quote.

**t32 (verification against the real server) has to follow t31 and precede
deployment**, and it is a task rather than a chore because it changes the
project's contract. Once submit needs the backend, the gate's `vite preview`
can no longer complete the flow. The audits move to running against
`backend/server.mjs` with a temporary database and sign in at the owner step,
locally and in CI. The counts will change and are re-recorded.

**t33 (deploy and prove it between two devices) is last**, as deployment has
been in every phase, and this time the proof is the point of the phase: a
request made on one phone, reviewed on another device, paid on the first.

## Now

- **m9 -- The owner reviews real requests from any device.** t29 -> t30 -> t31
  -> t32 -> t33.

## Then, in the same phase

- **m10 -- The quote is a real exchange between two people.** t34 -> t35 ->
  t36 -> t37 -> t38. Decided on 2026-09-05 when the client's representative
  answered the three open questions with "build it": this is a service for a
  client, not a prototype for reaction.

### Why this sequence inside m10

**t34 (contact details) goes first** because nothing else in the milestone can
work without a name and an email address on the request, and because it is
embarrassing today: a customer submits, the owner approves, and if the
customer never comes back to `/status` nobody can reach them. It touches the form t31 just rewrote,
which is why it waits for m9 to finish rather than running alongside.

**t35 (the owner adjusts the quote) comes before notifications**, because the
email the customer receives *is* the quote, itemised, and the numbers in it
have to be the numbers the owner meant. Approve & Send changes meaning here: it sends
the adjusted quote, not the drafted one, and the draft is kept for the record.

**t36 (lifecycle) comes before notifications too**, because a request that can
end is what makes an owner list usable once real requests arrive, and the
receipt after payment is the last email the customer gets.

**t37 (email) is where the first real external integration lands.** It was
planned as text messages; the client redirected it to email on 2026-09-05 while
preparing for live service, and the shape is unchanged: one module, one seam,
an outbox.
It is deliberately behind a one-module seam with an outbox fallback, so every
other task and every test can run without a provider account, and the account
itself is the client's to open.

**t38 (deploy and prove it with real emails to two inboxes)** is last for the
reason it always is.

## Later

- Real payment processing (phase 5, first item). Stripe Checkout or Square,
  whichever the client already has an account with.
- Refunds, which arrive with real payments and not before. Until they do, a
  paid request's only exit is `done`: nothing in the app can undo a payment, so
  nothing in the app pretends to. A customer who paid and then needs out of it
  is a phone call, and the owner closes the request when it is settled.
- Scheduling: a confirmed time, not just a preferred date.
- Photo of the tire or the sidewall on the request, for cases where the
  customer is not sure of the size.

# Phase 5 -- Live on the client's own domain

One milestone, m12, planned by the lead on 2026-09-06 on the user's
instruction to plan the final sprint to live. The plan, the four gates, the
assignment table by agent name and the inputs only the user can supply are in
[`sprint-live.md`](sprint-live.md); `state.json` carries t42 to t56.

## Why this sequence

**Data first (t42, t43)**, because the user's stated priority is stock data on
every size and the walk is already running. Page-one coverage is the
definition of done; the deep pass is a separate decision with a cost.

**Safe before public (t44 to t51)**, because the domain is the moment real
customers arrive, and a shared status link that hands out a phone number, an
unthrottled owner login or a container running as root are cheaper to fix
the week before than the week after.

**The domain (t52, t53, t54, t56)** as four commands and two DNS records in a
written order, run by the user, with the gate proving the new name and a
schedule watching it.

**Email last (t37, t38)**, as m10 always had it: it needs the sending domain's
records from t52, the rate limits from t45 and the cookie change from t47,
and a provider account that is the client's to open. The cutover does not
wait on it.

## Later

Unchanged from phase 4's list: real payments, refunds, scheduling, photos.
After them, the items deferred from this sprint in `sprint-live.md`.
