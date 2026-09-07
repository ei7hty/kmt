# Competitor: My Tire Guys' town-page pattern, and whether "no town pages" survives it

Written 2026-09-06 by the SEO STRATEGIST (`local_1375b7e1`) on the user's direct
instruction (via the OWNER AGENT): analyse `mytireguys.com` — a mobile-tyre
competitor in Everett, the town bordering Malden — and rule on whether the OWNER
AGENT's hour-old "no page-per-town" ruling survives contact with it.

Method: read-only fetch of their Everett, Revere and home pages, and a
`site:mytireguys.com` listing, on 2026-09-06; the KMT product claims below are
verified against the repo, not assumed. This is a findings-and-verdict document;
it prescribes no copy (MARKETING's) and no machinery (ANALYST's).

## What My Tire Guys actually does

- **A page per town, many of them.** Everett, Revere, Winchester, Melrose,
  North Reading, and more (`site:` surfaces at least these; the set spans their
  Greater-Boston area). Same business as Ken's: mobile, "we come to you", new
  tyres fitted at home/work. Needham-based, "family owned and operated since
  2009."
- **The pages are mostly boilerplate.** Measured across the Everett and Revere
  pages: **60–80% identical templated body**, with the town name swapped in and
  one or two thin local lines ("Winter tires are a big thing in Revere and New
  England"; "tire shop in Everett Ma ... at any location in and around Everett").
  This is the textbook near-duplicate location-page pattern Google names as a
  low-value "doorway" set.
- **Their titles are the pattern KMT is weakest on.** "Tires Revere MA | Tire
  Shop Revere | Mobile Tire Shop"; "Tire Shop Everett Ma" as the H1. **Job +
  town + descriptor, in the title, for every town.** KMT's `<title>` is the bare
  brand name (see `seo-demand.md`). That gap is real and independent of page
  structure.
- **Trust is a "5-star Google-rated" badge + a testimonials page.** No visible
  review count or rating breakdown in the page HTML — which points to their real
  ranking engine being off-site (below).
- **No schema surfaced** in the fetch (LocalBusiness / areaServed / review
  markup not detected — inconclusive, not confirmed absent).
- **What they do NOT promise:** no hours, no response-time, no "same day", **no
  24/7 or emergency language.** They have an "Appointment Policy" page. So they
  are a *planned* mobile-replacement business too — not an emergency one. This
  matters for the verdict.

## Question 1 — do they rank *because* of the town pages, or despite them?

The evidence points to **despite**, or at most partly because, and the causation
cannot be read off "the pages exist and they rank":

- **Age and off-site signals are the likelier engine.** A 2009 domain, a Google
  Business Profile carrying the "5-star Google-rated" reviews, and years of local
  links do most of the work for "mobile tire [town]" and map-pack results. None
  of that is the town pages.
- **The pages are thin enough to be a liability, not an asset.** 60–80%
  duplication across near-identical location pages is precisely what Google's
  doorway-page guidance devalues. A strong site can rank *around* thin pages; the
  pages being present is not evidence they are what's ranking.
- **But one mechanism is genuinely theirs and genuinely works:** the **town name
  in the `<title>` and H1**, matching "tire shop everett ma" / "mobile tire
  revere" queries exactly. That is a real on-page signal, and a single page
  cannot hold 56 town names without becoming keyword spam. This is the one part
  of their structure that does something a single page can't replicate.

## Question 2 — does it transfer to a one-owner business?

**It transfers worse to Ken than it works for them**, on two counts:

- **The distinctions would be even more invented.** My Tire Guys has
  "technicians" (plural) and may run more than one van, so a per-town page can at
  least gesture at different coverage. **Ken is one man and one van.** A Malden
  page and a Medford page would be the *same person, van, prices, and coverage* —
  the OWNER AGENT's original reasoning is not weakened by the competitor, it is
  confirmed by watching the competitor already struggle to fill these pages with
  anything real.
- **The lead-time floor removes the intent town pages would chase.** Verified:
  `backend/quotes.mjs:25` sets `MIN_LEAD_DAYS = 7`, enforced at `:61-62`. The
  urgent "mobile tire [town] now" searcher a town page would catch **cannot book
  for a week.** For Ken the town-page traffic is disproportionately the traffic
  he must refuse.

## Verdict: the ruling survives — with one honest concession

**The no-town-pages ruling stands.** For a one-owner van, per-town pages would be
thinner than the competitor's already-thin ones, would risk the doorway-page
devaluation rather than earn ranking, and would chase urgent intent the seven-day
floor makes unservable. Building them would be inventing distinctions the business
does not have — exactly the OWNER AGENT's original argument, now supported by the
evidence rather than refuted by it.

**The concession, stated plainly so it is not buried:** the ruling does give up
one real signal — the town-name-in-title match for "[town] mobile tire" queries
across many towns. That signal is worth something and a single `/` cannot carry
it for 56 towns. So "do nothing about towns" would leave value on the table. The
resolution is **not** town pages; it is that the higher-leverage moves for a
one-owner business sit off the page-structure question entirely:

1. **The title, first and free.** My Tire Guys beats KMT on the single most
   important on-page signal today only because KMT's title is the bare brand
   name. Closing that (MARKETING's wording) recovers most of the "job + place"
   ground without a single new page.
2. **A Google Business Profile is where this fight is actually won.** Local
   "near me" and map-pack ranking for both businesses runs on GBP + reviews, not
   page count — and a GBP is **owner-level and fully available to Ken** (one real
   location, Malden). This is the highest-leverage competitive move on the board
   and it is outside every lane's files: it routes to the OWNER AGENT / the user
   as an off-site action, not to MARKETING or ANALYST.
3. **The enriched single `/`** (the OWNER AGENT's ruling #2) can carry the
   truthful towns list from `seo-demand.md`, capturing the town names honestly on
   one page without the doorway pattern.

## What a one-owner operation can say that a multi-van one cannot

Not copy — the true claims available to Ken and structurally unavailable to them:

- **"You deal with Ken — the owner quotes you and the owner shows up."** My Tire
  Guys sells anonymous "technicians"; they cannot say one named person answers
  and arrives. This is the differentiator the OWNER AGENT already identified
  ("a real quote back from Ken, not a call centre"), and the competitor's own
  plural-technician framing is the proof it is exclusive to Ken.
- **Pricing transparency.** My Tire Guys shows no prices. Ken now has real
  numbers (markup, mobile fee, disposal, 6.25% tax). Whether/how to show them is
  MARKETING's + the OWNER AGENT's call; that the competitor shows none is the
  opening.
- **Honest "planned, not emergency" positioning.** Both are planned businesses,
  but only Ken's site currently has the chance to *say so* clearly and set the
  right expectation — turning the seven-day floor from a hidden disappointment
  into an upfront "book me ahead, I come to you" promise.

## Constraints reaffirmed (the competitor's behaviour reopens none of them)

No chasing 24/7/emergency intent (they don't either, and Ken's lead-time floor
forbids it); `/status`, `/confirmation`, `/owner` stay out of the index; no speed
number in visible copy until the funnel report has real volume; R26; Ken's voice
in the body, third person in labels.

## Routing

- **OWNER AGENT / user (off-site, product):** the Google Business Profile +
  reviews recommendation — the real local-ranking engine, owner-level, the single
  biggest competitive lever, and not in any repo lane.
- **MARKETING (words):** the title gap (already in `seo-demand.md`); the towns
  list and the one-owner/pricing/planned claims as *available true material*, not
  prescribed wording.
- **SEO ANALYST (machinery):** if `/` gains indexable town content, confirm the
  single-page structure and canonical still hold; no machinery change proposed
  here.
