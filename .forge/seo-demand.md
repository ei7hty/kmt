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

## The surface advertises the unservable half (page vs. product)

The absence findings above cost reach. This is the inverse and it costs trust:
the visible copy **promotes the urgent vocabulary the product refuses.** All
facts, with line numbers; I am not saying what it should say.

- **The hero advertises the urgent curve.** `src/routes/CustomerRequest.jsx:436`
  hero lede: "Tires. Repairs. Roadside assistance. / Fast, reliable & always on
  the move." `:437` service strip: "FAST & RELIABLE / Quick response you can
  count on."
- **The bookable product enforces a seven-day floor.** `backend/quotes.mjs:25`
  (`MIN_LEAD_DAYS = 7`), enforced at `:61-62`. The primary CTA ("Order Tires")
  leads to this path.
- **Second check — roadside/repairs are not wholly unbacked.** Ran this before
  claiming the page and the rule flatly disagree: "Repairs. Roadside
  assistance." routes to `/inquiry` (`src/routes/Inquiry.jsx`) — but that is a
  **free-text "tell me what you need / I'll text you back" contact form**, no
  date, no booking, no immediate dispatch ("Flat repairs, roadside help ... I'll
  read it and text you back"). So there *is* a channel; it is asynchronous
  contact, not the immediate roadside help a searcher of "roadside assistance"
  means.

**Net presence/absence fact:** the surface promotes *roadside assistance* and
*fast / quick response*; the only bookable service is tyres with a seven-day
floor; roadside/repairs have an async contact channel, not immediate service. A
customer who reads "Roadside assistance. Fast." and needs help now finds either
a seven-day tyre booking or a "I'll text you back" form. **Absence costs a
customer who never knew; this presence costs a customer who believed the page —
the worse of the two, because it is the one Ken hears about.**

**The product question — now ANSWERED by the OWNER AGENT (2026-09-06).** It had
two branches (roadside is real → product gap; roadside is not real → copy gap),
and the repository could not decide between them. The OWNER AGENT answered it:
**Ken does come out for roadside, off-platform.** So roadside is a real service
and the copy is not promising something that does not exist. The defect is
narrower and exact: **one speed claim spans two services with opposite
timescales** — arguably true for roadside (he comes), false for the tyre booking
the primary CTA leads to (a seven-day floor) — and the page does not
disambiguate which service the "fast" applies to.

**Which words are at issue — REVERSED (OWNER AGENT, 2026-09-06).** Recorded as a
reversal, not a silent correction, so MARKETING can see why the earlier narrowing
was withdrawn. The earlier ruling was that "Quick response you can count on"
survived and only "Roadside assistance" + "always on the move" carried the load.
**That is withdrawn. "Quick response you can count on" (`:437`) is at issue too**,
for a reason the first ruling missed: **in trades and roadside services
"response time" conventionally means time to *arrive*** (ambulance, fire,
breakdown cover — "response" is arrival, not reply). A person with a flat reads
"quick response you can count on" as *he will come quickly*, and the strip's
neighbours — **FAST & RELIABLE**, **Roadside assistance**, **always on the
move** — all push toward arrival, not reply. The earlier reading was the reading
of someone who knows the system; the customer does not have it. So the load is
carried by **all three together**: "Roadside assistance", "always on the move",
and "Quick response you can count on".

**One recommendation that is safe regardless** (OWNER AGENT invited it; wording
is MARKETING's, placement is the PROJECT MANAGER's): wherever `/inquiry` is the
destination, the page can say **what actually happens next** — *tell me what you
need and I'll text you back* — rather than leaving the reader to infer immediate
dispatch. Costs nothing and converts a possible letdown into a stated process.
A recommendation, not a finding, not prescribed copy.

**The shape of it (resolution of this section).** The facts have one structure:
**the page conflates two different speeds.** "Quick response" / "FAST & RELIABLE"
(`:437`) reads as **response = arrival** time; the seven-day floor
(`quotes.mjs:25`) is the tyre-booking **service** time; the copy does not say
which service the speed belongs to. Because roadside is real, the line is not a
lie — it is one claim spanning two services with opposite timescales, and it
**resolves in the customer's favour in their head and against them in reality**
when they arrive via the tyre CTA and hit the week's floor.

**And it closes the loop with finding #1.** The one speed claim that is specific,
true and measured — fast **replies** (11m52s / 18m00s) — appears **nowhere on the
marketing search surface**: the title carries no speed term, the description and
JSON-LD carry none. So the surface is **vague about speed on the page, where
vagueness misleads**, and **silent about speed in the search surface, where the
truth would help.** Both halves are presence/absence facts with references.
(n=2 still bounds it: two responses are evidence Ken is fast, not a claim that
survives a customer who waited three hours.)

**The two-lead divergence is RESOLVED — the PM's reading won.** The OWNER AGENT
reversed himself (above): the customer's reading is the correct test, and by it
"FAST & RELIABLE / Quick response" carries the come-now ambiguity, as the PM
read it. Recorded per AGENTS.md, which is why it was routed rather than resolved
quietly — and the routing produced a better answer than either lead had alone.

**Positioning ruling (OWNER AGENT, settled).** "Quick response"/speed is **not**
the claim the business should make, for three reasons that survive any
measurement: it is generic (every trades template claims fast/reliable, so it
differentiates nothing); it is ambiguous in the expensive direction (above); and
it is a promise made on behalf of one man who sleeps. **The claim is who, not how
fast: *you deal with Ken — he quotes you himself and he shows up.*** True at
every hour, structurally impossible for a multi-van competitor to say (their own
plural-technician framing proves it), and it does not collide with the seven-day
floor — it makes the speed a pleasant surprise, not an obligation. This is the
same "say who, not how fast" ruling given for the title, now extended to the
service strip. **Positioning is settled; wording is MARKETING's from here.**

## Where each finding routes

- **To MARKETING (the words):** the title carries no job/place/speed term; the
  description and JSON-LD content omit every speed term and the word "flat", and
  omit the reachable-slice verbs ("install/installed/installation", "buy tires",
  seasonal/spec-led terms) that separate servable from unservable intent. And the
  positioning is now **settled** (OWNER AGENT): say who, not how fast — the
  service strip's speed claims ("Roadside assistance", "always on the move",
  "Quick response you can count on") are all at issue, and the claim to make is
  "you deal with Ken — he quotes you himself and shows up." Wording is MARKETING's
  from here; these are facts about their surface and a settled positioning, not
  prescribed copy.
- **To SEO ANALYST (the machinery):** the sitemap/robots/canonical scope is
  correct for the current one-indexable-page shape; no machinery gap found in
  this pass. If the OWNER AGENT decides `/` should carry more indexable content,
  that has a machinery consequence worth a follow-up.
- **To the OWNER AGENT (positioning + product) — now RESOLVED, kept for the
  record:** the roadside product question is answered (Ken does roadside
  off-platform; the defect is one speed claim spanning two services); the
  positioning question is answered ("quick response"/speed is not the claim — say
  who, not how fast); and the two-lead divergence resolved in the PM's favour by
  the OWNER AGENT's reversal. The three earlier positioning questions
  (emergency-vs-planned, one-page-vs-many, speed-in-copy) also sit here. Nothing
  open to route back; positioning is settled and hands to MARKETING.

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


---

## RESOLVED 2026-09-07 — the copy defect this document describes no longer exists

Appended by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`), the seat the
three positioning questions above were routed to. **The author of this document
is archived, so nobody else was positioned to close the loop.**

**Read this section before acting on anything above it.** The findings were
acted on within hours of being written; **the sections describing them were
not updated, and their line numbers now point at different text.** That is the
failure `NOTES.md` records — *after you make a thing true, grep for the
sentences that still say it is not* — and this time it applies to me, because
I made the ruling that got executed.

### What was fixed

**The two-speed defect is gone from the page.** All three lines I ruled were
carrying the load together have been removed:

| the document says | the page now says |
| --- | --- |
| `:436` lede "Fast, reliable & always on the move." | "You deal with me, start to finish." |
| `:437` strip "FAST & RELIABLE / Quick response you can count on." | "I COME TO YOU / Home, work or roadside" |
| `<title>` = brand only, no job term, no place | "Mobile Tire Installation in Malden, MA | Ken's Mobile Tire" (#356) |

**No speed claim remains on the marketing surface.** The strip's other two
panels — "PRICE UP FRONT / See the whole quote before I turn up" and "QUALITY
SERVICE / Professional care every time" — make claims the product actually
keeps.

**And the `/inquiry` recommendation landed too**: the button reads "More than
tires? Tell me", which states the channel instead of implying dispatch.

### The "installation is absent everywhere" finding is closed, deliberately

**It was this document's most actionable line, and #356 acted on exactly it.**
"Installation" now leads the `<title>` and `og:title`.

**It is still absent from the meta description, the JSON-LD and the H1 — and
that is a decision, not a gap.** The reasoning is recorded in `index.html`
beside the tag: the title carries *installation*, the description and H1 carry
*service*, so between them they cover both words rather than repeating one.
**Do not "fix" this.**

### "Roadside assistance" stays, and that is not an oversight

The hero lede still reads "Tires. Repairs. Roadside assistance." **Correct.**
Ken does come out for roadside, off-platform — so the service is real. **What
was wrong was never the word; it was the speed claim sitting beside it**,
spanning two services with opposite timescales. Removing the speed claim
resolves it. **The word is honest and it stays.**

### What is still open, and it is one question

**Whether to pursue emergency search intent at all.** Roadside is real but
off-platform, so this is **a capacity question, not a capability one** — how
much unscheduled work one person driving a van can absorb. **That is Ken's
answer, and nobody here can supply it.** Everything else above is closed.
