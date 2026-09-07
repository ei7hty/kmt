# SEO demand — what people search, and whether the surface answers it

Written 2026-09-06 by the SEO STRATEGIST (`local_1375b7e1`), the demand seat,
at the PROJECT MANAGER's (`local_5b6d8402`) instruction. This seat owns no
files: this is a **findings document**, not an edit to any lane's surface.
Every gap below is stated as a **presence/absence fact** about the current
build, for MARKETING (the words) or SEO ANALYST (the machinery) to act on —
never as prescribed copy or markup, which are theirs.

Method: search-intent research (Sept 2026) on how people in the Malden / Greater
Boston market look for a mobile-tyre job, read against the current visible
surface at `index.html` (`<title>`, `<meta name="description">`, the OG tags,
the `AutoRepair` JSON-LD) and `public/sitemap.xml`. **No GA4 history exists**
(property is hours old), so nothing here rests on past-traffic analysis; this is
intent research, not analytics.

## The one finding the PM and OWNER AGENT asked for first

**The promise is speed — measured tonight at 11m52s and 18m00s to answer two
real customers — and nothing a searcher sees states it.**

- `<title>` = `Ken's Mobile Tire`. It contains no job term, no place, and no
  speed term. A brand name unknown to a searcher, in the slot that decides the
  click.
- `<meta name="description">` = "Mobile tire service in Malden, MA and Greater
  Boston. New tires fitted at your home, work or roadside." Present: the job,
  the place, "come to you". **Absent: any speed term.**
- `og:title` = `Ken's Mobile Tire` (brand only); `og:description` omits speed.
- The `AutoRepair` JSON-LD `description` repeats the meta description — same
  content, so the same absence of speed.

## What people actually type (demand vocabulary)

Grouped by the intent behind the query, highest-volume first. These are the
words; whether and where to use them is MARKETING's / ANALYST's call.

| intent | representative queries |
| --- | --- |
| emergency roadside | "flat tire help near me", "roadside flat tire help", "emergency tire change service", "24/7 mobile tire" |
| mobile replacement | "mobile tire repair near me", "mobile tire change near me", "tire shop that comes to you", "mobile tire installation" |
| speed / convenience | "same day tire replacement", "tire change at my house", "someone to come change my tire" |
| local / brand | town name + "mobile tire" ("mobile tire Malden"); brand names are searched only by people who already know them |

Location intent is overwhelmingly "near me" or a town name, not a brand.

## Presence/absence: do the words people type appear on the visible surface?

Fact table. "Surface" = title, meta/OG description, and JSON-LD content — all
MARKETING's. Absence is a fact, not an instruction to add anything.

| term people type | in `<title>`? | in description / OG / JSON-LD? |
| --- | --- | --- |
| "mobile tire" (the job) | no (brand only) | yes |
| place ("Malden" / town) | no | yes |
| "comes to you" / "at your home" | no | yes ("home, work or roadside") |
| speed ("same day" / "fast" / "today") | no | **no** |
| "flat" / "flat tire" | no | no |
| "roadside" | no | yes (in "home, work or roadside") |
| "near me" | n/a (not a literal to place) | n/a |

## Three demand facts that are positioning questions — routed to the OWNER AGENT

These are demand observations, not copy. The call on each is the OWNER AGENT's.

1. **The largest query volume is emergency/24-7 roadside intent, which Ken does
   not serve — and the product enforces this, so it is structural, not a
   preference.** `backend/quotes.mjs:25` sets `MIN_LEAD_DAYS = 7`, enforced in
   `cleanDate` at `backend/quotes.mjs:61-62`: a preferred date less than seven
   calendar days out is refused with "I need at least a week's notice -- the
   earliest I can come is {date}." Presence/absence fact: **the entire top of
   the demand curve — "flat tire help near me", "emergency", and even "same
   day tire replacement" — is unservable by construction.** A searcher with a
   flat today cannot book sooner than next week, and learns it only after
   filling in the form. So chasing that volume does not draw a wrong-fit slice;
   it draws a guaranteed bounce and a bad experience that costs Ken. The intent
   Ken *does* serve — **planned** new-tyre replacement at the customer's
   location, booked ahead, with a real quote from the owner — is what the
   surface can honestly speak to. Which intent the copy targets is a
   positioning decision; that "same day" is off the table is a fact.

2. **Only `/` and `/privacy` are indexable** (correct and settled — I am not
   reopening the `/status`, `/confirmation`, `/owner` exclusions; `/status`'s
   query string is a customer credential). Demand fact: competitors in this
   market rank through many town- and service-specific pages, while KMT has a
   single indexable page to carry every query above. Whether the site's one
   indexable page should carry more of this vocabulary in its content is a
   product+SEO decision, not a copy edit.

3. **Speed is measured at n=2.** Demand fact: "same day" / "fast" are terms
   people search and the surface omits. Whether any speed claim can be stated
   truthfully in a public snippet without becoming a guarantee Ken must hit
   every time is a product call — a soft, true framing may be safe where a hard
   number is a promise.

   **The two-speed trap (copy-safety fact for MARKETING).** There are two
   different speeds and they must not be collapsed. The **quote** is fast — Ken
   answered the two real customers in 11m52s and 18m00s. The **appointment** is
   slow by design — `MIN_LEAD_DAYS = 7` (`backend/quotes.mjs:25`), a hard floor.
   So an unqualified "fast" in visible copy is actively dangerous: a buyer reads
   "fast" as "soon", then hits the seven-day wall *after* deciding to buy — the
   same refusal-generating mismatch as emergency intent, moved into the copy and
   landing on a customer who is further down the funnel. The safe true statement
   is about the **answer** ("a real quote back from Ken quickly"), never the
   **appointment**. Ruling recorded by the OWNER AGENT 2026-09-06 after this was
   found: position at planned replacement, booked ahead, at your location, with
   a quick quote — the quick thing is the answer, never the visit.

## The reachable slice — who is actually servable, and what they type

Finding #1 establishes that the top of the demand curve is unservable by
construction (the seven-day floor). This answers the question that finding
raises: **then what *is* reachable, and does the surface contain its words?**

**These are two different people, not one searcher at two urgencies.** Someone
with a flat on the hard shoulder and someone who has noticed their tread is low
and would rather not lose a Saturday in a waiting room are not the same person
dialled up or down. The seven-day floor is what makes this a **hard boundary,
not a spectrum** — the urgent person is refused by the product, the planned
person is exactly who it is for. So the reachable slice is not "the low-urgency
end of flat-tyre demand"; it is a distinct intent with its own vocabulary.

**The reachable-slice vocabulary** (the planned buyer: knows they need ~4 new
tyres, wants them fitted at home or work, will book ahead):

| sub-intent | representative queries |
| --- | --- |
| at-home installation | "new tires installed at home", "mobile tire installation [town]", "someone to come put tires on my car", "tires installed at my house" |
| buy + fit together | "buy tires and have them installed", "tires delivered and installed", "mobile tire mounting" |
| avoid the shop | "tire shop that comes to you", "new tires without going to a shop", "tire fitting at home" |
| seasonal / planned swap | "winter tire changeover at home", "seasonal tire swap mobile", "mobile tire change [town]" |
| considered / spec-led | "[size] tires installed near me", "buy [brand] tires mobile install" |

Note the verb split that separates the two people: the urgent curve types
**repair / change / help / flat / emergency / same-day**; the planned slice
types **install / installed / installation / buy / fitted / delivered**. The
word "installed" is close to a clean discriminator between servable and
unservable intent.

**Presence/absence against the current surface:**

- `<title>` = brand only — **none** of the reachable-slice vocabulary.
- Meta description / OG / JSON-LD = "New tires fitted at your home, work or
  roadside." This is the **one place the surface already speaks to the planned
  slice** — "new tires fitted at your home/work" is squarely this intent. But
  it omits the actual verbs people type: **"install/installation" appears
  nowhere**, nor "buy tires", nor any seasonal or spec-led term.

So the reachable slice is barely addressed and the highest-intent word for it
("installed"/"installation") is absent from every surface. **What to write with
this vocabulary is MARKETING's; that it is absent is the finding.**

## Where each finding routes

- **To MARKETING (the words):** the title carries no job/place/speed term; the
  description and JSON-LD content omit every speed term and the word "flat", and
  omit the reachable-slice verbs ("install/installed/installation", "buy tires",
  seasonal/spec-led terms) that separate servable from unservable intent. These
  are facts about their surface; the wording is theirs.
- **To SEO ANALYST (the machinery):** the sitemap/robots/canonical scope is
  correct for the current one-indexable-page shape; no machinery gap found in
  this pass. If the OWNER AGENT decides `/` should carry more indexable content,
  that has a machinery consequence worth a follow-up.
- **To the OWNER AGENT (positioning):** the three questions above.

## The towns Ken really serves — derived, not guessed

At the OWNER AGENT's instruction (ruling #2: enrich `/` with a truthful towns
list, no page-per-town), derived from the **same centroid table and haversine
the production server uses** (`backend/service-area.mjs`, `distanceMiles` over
`backend/zip-centroids.json`), base ZIP `02148`, module defaults. Town → its
principal ZIP is a known fact; the **distance is computed**, so a mis-keyed ZIP
would show a wrong distance. Spot-checked against reality: Cambridge 5.1 mi,
Salem 11.9, Lowell 18.5, Worcester 39.7, Providence 45.8 — all correct.

**The band structure the code actually enforces (this reconciles the 25-vs-100
question the SEO ANALYST charter flags):**

- **≤ 25 mi — covered, no review** (`KMT_SERVICE_REVIEW_MILES`, default 25).
  This is "the places he really goes," and it is **exactly the JSON-LD
  `areaServed`** (`geoRadius` 40234 m = 25.0 mi). The marketed area and the
  silent-accept band are the same number — already correct, no machinery gap.
- **25–100 mi — accepted but flagged for the owner** ("by arrangement").
- **> 100 mi — refused** (`KMT_SERVICE_RADIUS_MILES`, default 100).

So the towns list for the enriched `/` is the **≤ 25 mi band**, not the 100-mile
refuse boundary. The OWNER AGENT's phrase was "the constraint that accepts or
refuses" (100 mi); the honest "places he really goes" is the review band (25
mi). Flagging the difference rather than taking 100 at face value.

**Covered (≤ 25 mi), nearest first** — a derived list, not a copy selection
(which towns to actually name is MARKETING's; naming all of them would stuff
keywords, a demand fact, not a decision I make):

Malden, Everett, Melrose, Medford, Chelsea, Revere, Charlestown, Saugus,
Stoneham, Somerville, Winchester, Arlington, Cambridge, Boston, Wakefield,
East Boston, Winthrop, Woburn, Lynn, Belmont, Nahant, Lynnfield, Watertown,
Reading, Brookline, Swampscott, Newton, Peabody, Burlington, Lexington,
Waltham, North Reading, Wilmington, Danvers, Marblehead, Salem, Milton,
Quincy, Beverly, Wellesley, Dedham, Needham, Braintree, Andover, Weymouth,
Randolph, Natick, Canton, Norwood, Lowell, Lawrence, Framingham, Ipswich,
Gloucester, Brockton (24.3 mi, the far edge of the band).

**By arrangement (25–100 mi):** Haverhill (25.4), Marlborough (25.5), Salem NH
(26.1), Nashua NH (29.6), Derry NH (33.9), Worcester (39.7), Plymouth (43.7),
Manchester NH (43.9), Providence RI (45.8).

**One precision caveat (second-check honesty):** the distance is measured to a
town's ZIP *centroid*. A geographically large town whose center sits near 25 mi
(Lowell 18.5, Lawrence 19.9, Framingham 21, Brockton 24.3) has edge ZIPs that
cross into the flagged band — the server measures the customer's actual ZIP, so
a town on the "covered" list is not a promise every address in it clears 25 mi.
This is a truthful-copy constraint for MARKETING, not an error in the list. The
sample above is ~65 towns chosen to bracket the 25-mile line; it is
representative of the band, not the exhaustive set of ZIPs within it.
