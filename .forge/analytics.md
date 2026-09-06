# Google Analytics, on the marketing pages only

Written by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) on 2026-09-06,
on the user's instruction: GA4 `G-6VS1BEJ3TS`, **marketing pages only**. The
what and the why; the PROJECT MANAGER turns it into briefs.

## This reverses a ruling I made today, and the user has overruled it

Earlier today, on the funnel report, I ruled: **"no cookie, no third party,
ever — aggregate and server-side, or it does not happen."** That is in
`.forge/funnel-report.md`. **GA is both.**

The user has overruled it, which is their call — it is their business. **The
ruling is not quietly abandoned; it is narrowed**, and the narrowing is the
point of this document: GA answers a question our own data cannot, and it is
kept away from the pages where the objection was never really about cookies.

**What GA buys that the funnel report cannot.** The funnel report measures
people who *submitted* — requests per day, conversion, time-to-approve,
time-to-pay, all from our own database. **It has no denominator.** It cannot
see someone who opened the site, looked at a tyre and left. GA can. They are
complementary and only one of them needs a third party.

## The constraint that decides the whole design

**`index.html` is one static shell serving every route.** The routing is a
`pathname` switch in `src/App.jsx`; there is no per-page HTML.

So **the tag as Google gives it — pasted into `<head>` — loads on every
route**, including `/status`, `/confirmation` and `/owner`. That is not
"marketing pages only", and no amount of GA configuration fixes it: the
script has already loaded and set its cookies by the time any config runs.

**Therefore: the snippet does not go in `index.html`.** GA is loaded from
JavaScript, only on the routes that should have it.

## Why `/status` in particular must never load it

`/status?request=<id>` carries a customer's own request, and **the id is the
credential** — anyone holding that URL can see that person's request. GA sends
the **full URL, query string included**, with every page view.

**So a tag on `/status` hands Google a working key to a customer's record, on
every visit, forever.** That is the real objection, and it is worth more than
the cookie argument: the emailed link that t37 sends is precisely this URL.

`/confirmation` carries the same id. `/owner` is Ken's workspace. **All three
are excluded for reasons that have nothing to do with analytics preference.**

**In scope:** `/` and `/privacy`. That is the whole marketing surface, and it
matches what `public/sitemap.xml` already lists as the only indexable pages —
so the boundary is one somebody has already drawn for a different reason and
got right.

## The CSP will silently block this, and that is the second real decision

`backend/site.mjs` sets `script-src 'self'` and `connect-src 'self'` (t46).
**GA would not load and nothing would visibly break** — no error a customer
sees, no failing check, just no data, discovered weeks later.

Loading it needs `https://www.googletagmanager.com` in `script-src` and
`https://*.google-analytics.com` in `connect-src`.

**That is a genuine security cost and it should be paid narrowly.**
`script-src 'self'` is a strong posture: it says nothing but our own code
runs. Widening it site-wide means a compromise at Google's CDN could execute
script on the customer flow and on Ken's workspace.

**Recommendation: widen the CSP only on the marketing routes.** Serve the
relaxed policy for `/` and `/privacy`, keep `script-src 'self'` everywhere
else. The header is already computed per response in `site.mjs`, so this is a
condition rather than a redesign — and it means **the pages holding customer
data keep the strict policy they have today.**

If that turns out to be awkward, the fallback is a site-wide widening, and
that is a real downgrade that should be a decision rather than a side effect.

## It must not run in development or in CI

**Every browser audit drives the real UI at 375 px and 1280 px.** The
dead-end audit, the responsive check and the request-flow check would each
register as page views, and `npm run dev` would too.

That is the same trap already ruled on for the funnel report: *"at current
volume a naive counter would be mostly our own CI, and a number that is
largely our robots quoted to Ken as demand is not a weak measurement but a
false one informing a real decision about his business."*

**Gate on the hostname**, not on a build flag: load GA only when
`window.location.hostname` is the canonical host. Localhost, preview builds,
the audits and any scratch server are excluded by construction, and nobody has
to remember a flag.

**And prove it the way this project proves checks:** run the audits with GA
present and confirm the counter does not move. A counter nobody has watched
*not* count is unproven in the direction that matters.

## `/privacy` gains a line in the same pull request

**Not optional, and not a formality.** That notice's entire value is that it
is complete. A customer who later discovers undisclosed third-party tracking
has learned the notice is a partial list, and at that point it is worth
nothing — the same reasoning that put `/privacy` into t65's inquiry work.

One plain sentence: that the public pages use Google Analytics to count
visits, that it is not used on the pages showing their own request, and that
it is never tied to their name or their request. **Written in the third
person like the rest of that page** (`t62-voice.md` keeps `/privacy` out of
Ken's first person: it is a statement of obligations, not a conversation).

## What this document does not decide

**Consent.** There is no general cookie-consent requirement in Massachusetts,
and a mobile tyre service in Malden realistically has no EU visitors — so a
consent banner is very likely unnecessary here. **That is a judgement, not a
legal opinion, and I am not qualified to give the second.** If the user wants
certainty it is a question for the same person who answers the tax question in
`.forge/pricing-settings.md`. GA4 anonymises IPs by default, which is the main
thing a banner would otherwise be protecting.

**Whether to keep the funnel report.** Yes — it answers what happens *after*
someone submits, which GA cannot see, and it needs no third party. **Neither
replaces the other.**

## Definition of done

- GA loads on `/` and `/privacy`, and **provably does not load** on `/status`,
  `/confirmation` or `/owner` — checked in a browser, not asserted in a test
- the relaxed CSP is scoped to the marketing routes, and the strict one still
  covers the pages carrying customer data
- the audits run with GA present and register **no** page views
- `/privacy` says so, in the same pull request
- a real page view appears in GA from a phone on the live site — **the walk
  reaches the delivered form**, as every item in this sprint does
