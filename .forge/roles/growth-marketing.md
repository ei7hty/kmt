# Role: growth and marketing (the acquisition surface)

Written 2026-09-06 by the first GROWTH/MARKETING agent (`local_d80272eb`,
since retitled **MARKETING AGENT** — the session id is the address, a sidebar
title never is) at main `a284618`, after the lane's first task rather than
before it — the
PROJECT MANAGER's instruction, and a good one: the boundaries below are the
ones that actually came up, not the ones that sounded plausible from a
reading. Everything here that is a **state** claim (SHAs, PR numbers, what is
live) is a measurement with a date on it and should be re-measured before you
act on it. Everything that is **intent** — why a number is what it is, why a
field is absent — keeps, and is the part only the author has.

Read `.forge/AGENTS.md` first, then `.forge/roles/README.md` for the roster,
then this. The PROJECT MANAGER instructs; the repo agent merges; you never
merge your own PR; claim a row in `.forge/CLAIMS.md` committed alone and
pushed before you start, released when you finish, **straight to `main`,
never through a pull request**.

## What this lane owns

**The acquisition surface: what a stranger finds, and what they see in the
first ten seconds.** Set by the PROJECT MANAGER on 2026-09-06.

- `index.html`'s **marketing head**: `<title>`, `<meta name="description">`,
  the structured data block, and the OG and Twitter tags.
- `public/robots.txt` and `public/sitemap.xml`.
- `public/brand/` and `docs/brand.md`.
- The **landing copy** in `src/routes/CustomerRequest.jsx` — the hero and the
  trust strip.

## A second agent is now in this surface: SEO ANALYST

**Open at the time of writing, and not for this lane to settle.** The SEO
ANALYST (`local_f596e88c`, onboarded 2026-09-06 at `79495d4`) has no charter
either, and flagged the overlap to the PROJECT MANAGER rather than assuming a
split — the same way this lane did. Its own guess, offered as a guess: SEO
takes **technical** SEO — crawlability and indexing correctness, canonical and
redirect behaviour verified against the live domain, sitemap accuracy as
routes change, page-speed factors, search-console-style measurement — while
this lane keeps **brand, copy and on-page content**.

That split is plausible and it is not agreed. It cuts straight through
`robots.txt`, `sitemap.xml` and the structured data, all listed as owned
below. **Until the PROJECT MANAGER rules, treat every row in this file that
touches those three as shared, and say in your claim row which side of the
line you are on.** Two agents editing the head from opposite ends is precisely
the collision `.forge/AGENTS.md` was written after.

## What this lane does not own, and the two boundaries that bite

**Copy is yours; structure and CSS are not.** The landing copy lives in a
file that belongs to the UI lane. Changing a string is this lane's work.
Anything needing markup or styling beyond a string gets a claim row that says
so and a pairing with whoever holds the file — not a quiet edit because the UI
lane happened to be thin that day.

**The head is split, and `lead-ui-engineer-lane.md` has not been updated to
say so.** That file, written earlier the same day, lists "`index.html`'s head"
as UI-owned. It is not wrong so much as older than this lane. The working
split, and the one to confirm with the PROJECT MANAGER rather than assume:

| in the head | lane |
| --- | --- |
| `<title>`, `<meta name="description">`, JSON-LD, `og:*`, `twitter:*` | growth |
| viewport, `theme-color`, icon links, the manifest link | UI |

If those two files ever contradict each other in a way that matters, the
roster and the PROJECT MANAGER settle it. Do not resolve it by editing the
other lane's file.

Never edited from this lane: `backend/`, `src/store.js`, `src/pricing.js`,
routes, state, `.github/`. The five audit scripts under `.forge/` are QA
ENGINEER's — see "the audit coupling" below, which is the one place this lane
legitimately reaches into them.

## The rule that shapes everything here: R26

`.forge/requirements.md` R26 — *"Every email is about that one request and
nothing else… No marketing use, no list, no unsubscribe machinery needed
because nothing recurs."*

**Customer email addresses collected at intake (R23) are transactional-only.**
No list, no campaign, no nurture sequence, no retargeting, no "check back with
us" mail. Confirmed as binding by the PROJECT MANAGER on 2026-09-06, and
`/privacy` plus `docs/data-policy.md` make it a public promise to real people.
Reversing it is the product owner's and the user's call, made explicitly in
`requirements.md` — never something this lane builds toward quietly because a
growth tactic would be easier with a list.

A promise quietly grown out of is worse than one never made.

## The standing rule on fabricated evidence

**No invented reviews, testimonials, ratings, or customer counts. Ever.** Not
as placeholders, not as examples, not "to show the layout", not in a mockup
that might get copied. Ruled 2026-09-06 by the product owner as a standing
rule, not a one-off decision.

`aggregateRating` and `review` are therefore absent from the structured data
and stay absent until real customer reviews exist. This is not only a search
penalty question: a rating is a stranger's judgement about whether to trust
Ken with their car, and inventing one misrepresents a real person to exactly
the customer who is deciding. The route to having them is asking after a paid
job — t66's territory, and a conversation with Ken about what he is
comfortable asking for.

Same principle, weaker stakes: hours, price range and `sameAs` are absent
because nobody has supplied them. Absent beats guessed. They are on the
user's list.

## The service radius, and why two numbers disagree on purpose

The structured data advertises **25 miles**; the server refuses past **100**.
Ruled 2026-09-06 by the product owner: **25 stands, and the two must not be
wired together.**

They answer different questions. The 100 in `KMT_SERVICE_RADIUS_MILES` is a
straight-line floor on how far the owner may be *asked* to go, deliberately
set under road distance so a refusal errs toward letting someone through —
`backend/service-area.mjs`'s own header says so. `areaServed` answers where
Ken should turn up when somebody searches, which is his market, and **his
scarce resource is hours, not leads**: a lead from 80 miles costs him a read
and a decline on a day he is already on a roadside, and costs that customer a
rejection they would rather not have been invited into.

A listing that says 25 while enforcement allows 100 is the review band doing
its job, not drift. The full reasoning is in `docs/brand.md`, deliberately, so
that the next person to notice the gap finds the reason before they "fix" it.

## The brand assets, measured

`docs/brand.md` said every file in `public/brand/` carries the seller's
watermark. True — and it had been read as the watermark being *visible*, which
it is not. Measured against the flat ground of each file that ships:
**1.02:1** in `og-1200x630.jpg`, **1.03:1** in `kens-dark-1200.webp`, nothing
detectable in `kens-dark-600.webp`, against the **3:1** at which WCAG 1.4.11
treats a graphical object as perceptible at all.

**The swap to licensed art is still owed, on licensing grounds.** These are
unlicensed previews whatever they look like. "You cannot see it" is a good
answer to the wrong question.

Method, if you ever need to redo it: mask out the artwork (a big `MaxFilter`
window rejects anything near a bright edge — without it you measure the logo's
own white strokes and get nonsense, which is what the first pass did), measure
the peak deviation from the local ground, and **stamp a watermark at known
strengths onto a copy to prove the measurement rises with it before trusting a
low reading.** A stamp at 1.61:1 is plainly visible in a 600px link preview;
the shipped files are not.

Only **8 of the 14** files in `public/brand/` are referenced by anything
(measured 2026-09-06 — recount, the intended uses are real). The other six
ship publicly for uses that do not exist yet. Whether they stay is the owner's
call, not a cleanup to do quietly.

## What already exists, so it is not re-proposed as new

Live at `https://kensmobiletire.com` (Fly; `www`, `order` and `kmt.fly.dev`
answer, canonical host and security headers from t46). OG and Twitter tags,
favicons, apple-touch-icon, manifest, `theme-color`. `robots.txt` indexes `/`
only and disallows `/owner`, `/status`, `/confirmation`, `/api/`;
`sitemap.xml` lists `/` and `/privacy`. `AutoRepair` JSON-LD and the meta
description shipped in #250. Landing copy is written and on-brand.

## Analytics: the answer is "not yet", and the shape is decided

There is **no analytics or tracking of any kind** in this repository, which
means there is no denominator: nothing records how many people reach `/`, how
many start the wizard, how many finish.

When it happens it is **server-side counts off data the backend already
stores** — no dependency, no third party, no privacy-notice change of the kind
a tracker forces. The PROJECT MANAGER's framing is the one to keep: *we do not
buy a denominator with someone else's privacy.* It is a product call, and it
goes to the product owner.

## The audit coupling

The two head tags are invisible on the page and visible only to a crawler,
which is exactly why they carry checks: nothing a person clicks would reveal
that either had gone missing. They live in `.forge/deployed-site-check.mjs`
(**QA ENGINEER's file**) beside the `og:image` assertion, and they run
post-deploy against production, not in the pre-merge gate.

So: **a head change that adds or removes a check moves `EXPECTED_CHECKS` in
that file, and the constant must move in the same commit** — the run fails on
a mismatch in either direction, by design. Coordinate before touching it; that
file is claimed often.

`.forge/head-check-control.mjs` is the fail-direction proof for those checks,
kept rerunnable. **It is not part of the gate and is counted in no baseline.**
It boots the real `backend/server.mjs` over a built `dist/`, serves
deliberately broken copies of `index.html`, and reads back what the real
script prints. Two of its own cases were wrong before they were right — one
harness misconfiguration, and one break case that silently rewrote `og:url`
instead of the JSON-LD's `url` and so proved nothing. A control that is itself
broken is the failure it exists to catch, one level down.

## Practical notes for the next holder

- **Every value in the structured data must trace to a fact the business has
  stated.** The phone is `+1-617-410-8319`; the `(617) 555-0100` in the
  codebase is a form placeholder and a test fixture. There is no street
  address because there is no storefront — inventing one sends customers to a
  driveway. The `areaServed` centroid comes from `backend/zip-centroids.json`
  so the geo agrees with the code.
- **Do not put provenance in a shipped HTML comment.** Everything in the head
  goes to the public web. This repo has already published its own asset
  provenance once, at `/brand/SOURCES.md`. Sources belong in `docs/`.
- Run the audits against `backend/server.mjs` serving the built `dist/`, a
  **fresh server and temp database per audit**: `NOTES.md` records ~14 submits
  per run against a cap of 30, so one server across three runs trips the
  limiter and reads like a regression.
- `.forge/owner-inventory-audit.mjs` needs `backend/dev.mjs`, and fails with
  `WebSocket closed without opened` when another session holds Vite's HMR port
  **24678**. That is an environment collision, not your change. Do not kill
  another session's server; say it did not run.
