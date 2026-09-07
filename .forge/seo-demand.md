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
   not serve.** Ken is one owner, by appointment, inside an enforced radius —
   not 24/7 emergency. Demand fact: chasing emergency-intent queries draws
   searchers whose job Ken will refuse. The intent Ken *does* serve — planned
   new-tyre replacement at the customer's location, with a fast honest quote —
   is a real and less-contested slice of the same market. Which intent the
   visible surface should speak to is a positioning decision.

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

## Where each finding routes

- **To MARKETING (the words):** the title carries no job/place/speed term; the
  description and JSON-LD content omit every speed term and the word "flat".
  These are facts about their surface; the wording is theirs.
- **To SEO ANALYST (the machinery):** the sitemap/robots/canonical scope is
  correct for the current one-indexable-page shape; no machinery gap found in
  this pass. If the OWNER AGENT decides `/` should carry more indexable content,
  that has a machinery consequence worth a follow-up.
- **To the OWNER AGENT (positioning):** the three questions above.
