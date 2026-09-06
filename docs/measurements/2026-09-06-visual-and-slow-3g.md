# Rendered screens and Slow 3G timings, 2026-09-06

Measured by LEAD FULL STACK on 2026-09-06 for the PROJECT MANAGER's t61
brief. Method by JUNIOR FRONT END DEV, adopted by the PM: two surfaces
reported side by side, because a local server has no latency and throttling
it measures only what the throttle adds, not Fly's proxy, brotli or a real
round trip; screenshots from a local build because that is the only way to
reach the owner screens with data in them; times from performance marks in
the page rather than a stopwatch, because a stopwatch measures the harness.
A snapshot, not a live view: verify any number here before acting on it.

## 1. Rendered screens, 375 and 1280

28 screenshots in `2026-09-06-visual-and-slow-3g/`, JPEG at quality 60 for
the record (the PNG originals were reviewed by eye). Served by
`backend/server.mjs` from a build of main `6339725` on a throwaway database
seeded from the snapshot, so the owner screens carry data. Fourteen screens
at each width: home at the width stage; the wizard at the ratio, diameter and
size-chosen stages; the tire step collapsed and expanded; the service step;
`/status` empty and with an unknown id; `/confirmation` with no params; the
not-found page; `/owner` sign-in, `/owner` signed in, `/owner/quotes`.

- **No horizontal overflow on any of the 28** (`scrollWidth <= innerWidth + 1`,
  measured on each).
- **No browser runtime errors** on any screen at either width.
- **Readable throughout**: navy ground, red primary actions, silver headline;
  body copy, labels, prices, stock lines, placeholders and helper text all
  legible at 375.

Visual notes, none blocking, in the order they would bother a person:

1. **Wizard ratio stage at 375** (`02-wizard-ratio-stage-375.jpg`): the guide
   illustration is cropped to a thin slice of tire and the "Aspect Ratio"
   annotation with its arrows is clipped at the top of the 140px visual. It
   reads as a cut-off image rather than a diagram. Desktop is fine.
2. **Width grid at 375** (`01-home-width-stage-375.jpg`): 23 widths in a
   3-column area with a 252px max height; the fifth row is cut in half at the
   bottom edge, which is the only cue that the list scrolls.
3. **Tire step expanded** (`06-tire-step-expanded-*.jpg`): 178 tires make a
   30,268px page at 375 and 22,649px at 1280. The twelve-first cap (#40) is
   doing its job; expanding is deliberate.
4. **Owner inventory at 1280** (`13-owner-inventory-1280.jpg`): 24 cards per
   page in a centred column, 10,953px tall. Dense, not broken.
5. **Empty and error states** (`08` to `11`) are short centred cards with a
   clear next action at both widths.

## 2. Slow 3G: seconds to the first size list and to the tire list

Standard Slow 3G over CDP `Network.emulateNetworkConditions`: 400 ms round
trip, 400 kbps down, 400 kbps up. A fresh browser context per run, so nothing
is cached: the roadside first visit. Three runs per cell. Times are
`performance.now()` marks set inside the page by a `MutationObserver` when
the first `.fitment-option` and the first `.tire-option` enter the DOM, and
the catalog response's `responseEnd` from a `PerformanceObserver`. 375 and
1280 differ by under 0.3 s throughout; 375 is shown.

| surface | build | first size list | tire list | live catalog lands | catalog response |
| --- | --- | --- | --- | --- | --- |
| production `kmt.fly.dev` | `6339725` (after #169) | 3.0 / 3.0 / 3.0 s | 4.0 / 3.9 / 4.0 s | 4.6 / 4.5 / 4.5 s | `?size=`, 5 KB brotli |
| local build, uncompressed | `6339725` (after #169) | 7.1 / 7.1 / 7.0 s | 8.0 / 7.9 / 7.9 s | 9.1 / 9.1 / 9.1 s | `?size=`, 30 KB raw |
| local build, uncompressed | `5b07355` (before #169) | 7.2 / 7.0 / 7.0 s | 8.2 / 8.0 / 8.0 s | 12.5 / 12.3 / 12.3 s | full catalog, 189 KB raw |

Reading the table:

- **Production is what a person feels: 3 s to the size list, 4 s to the tire
  list, live prices at 4.5 s** on this connection.
- **The local rows are harness artefacts and are kept so nobody re-measures
  them expecting production numbers.** The local server sends the 259 KB
  JavaScript bundle uncompressed where Fly sends 89 KB brotli, has no proxy
  and no real round trip; the 7 s first paint is that bundle at 50 KB/s.
- **What the two local rows are for is #169.** Same surface, same harness,
  the only difference the build: fetching one size after it is chosen instead
  of the whole catalog on first paint moved the live catalog from 12.3 s to
  9.1 s and the response from 189 KB to 30 KB, and the swap window (section 3)
  from about 4.4 s to about 1.2 s. On production, where the per-size response
  is 5 KB brotli, that window is about 0.5 s.

What loads on production, in order, as transferred:

| stage | request | bytes |
| --- | --- | --- |
| load | `/` | 870 |
| load | `/assets/index-*.js` | 89,015 |
| load | `/assets/index-*.css` | 13,116 |
| load | `/brand/kens-dark-600.webp` | 37,812 |
| load | `/where-to-find.webp` | 10,724 |
| tire step | `/api/catalog?size=205/65R15` | ~5,000 |
| tire step | `/tire-selector-ratio.webp` | 12,126 |
| tire step | `/tire-selector-diameter.webp` | 14,274 |

Before #169 the load stage also fetched `/api/catalog` in full: 133,029 bytes
brotli, 1,117,485 raw, 6,169 rows after the supplier import.

## 3. Finding: the tire list a customer sees first is not the live catalog

The page renders the size selector and then the tire step from the built-in
fallback catalog, and swaps in the live rows when the catalog response lands.
On Slow 3G that swap happens after the customer can already act. In every run
on every surface the first tire shown was the generated "Budget Economy" and
it was replaced by the real supplier row "Waterfall Quattro" once the response
arrived: about 4.4 s later before #169, about 1.2 s later on the local build
after it, about 0.5 s later on production. The "Checking today's prices"
banner says a fetch is in progress; the list swap itself is silent, and a
customer who has tapped a generated tire holds a selection by an id that no
longer exists in the list.

This is a correctness finding, not a performance note: a person chooses a
thing and the thing becomes something else, in the situation the product
exists for. It cannot be seen at full speed, which is why no audit found it.
#169 shrank the window and did not remove it. Two separable calls are with
the lead as product decisions, neither built here: hold the tire list until
the live answer arrives, or carry the selection across the swap by size and
name rather than by id.

## 4. What did not go to plan

- A first production run reported "99 KB by the tire list", which read as if
  the catalog were no longer fetched; listing the requests showed the 133 KB
  catalog was in flight and simply had not finished before the fallback list
  rendered. The request table above is the corrected view.
- The first in-page timing run returned no marks at all: the observer was
  attached to `document.documentElement`, which does not exist when an init
  script runs, so it threw silently. Attaching to `document` fixed it.
- An earlier pass used a 2000 ms round trip (Chrome's older "Slow 3G"
  modelling) and stopwatch timing; those numbers (6.5 s / 7.0 s / 12.0 s on
  production before #169) are superseded by the table above and not
  comparable to it.

Scripts were temporary and are not in the repository; the method is fully
described above and in `.forge/audit-ui.mjs`, whose `signInIfAsked` and
`expandTireList` the capture reused.
