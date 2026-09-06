# #85 measured at 375px, against main `deb0aed`

Measured 2026-09-06 by JUNIOR FRONT END DEV with `a11y-85-measure.mjs` in
this directory, against `backend/server.mjs` serving the built `dist/` on
`127.0.0.1:4301` with a scratch database and a throwaway password, driven
by Playwright at 375x812 through the same helpers the audits use. Every
number below is from the script's output (`a11y-85-results.json`, the
summary sections; the per-element raw data was kept out of the repository).
Nothing was applied; the proposals are values for LEAD UI ENGINEER to fold
into #145 or not.

Fourteen states: the wizard's three steps before and after a choice, the
acknowledgement, `/status` with a draft and with a sent quote, the owner
sign-in, `/owner`, `/owner/quotes` with a draft and an exception and after
an approval, `/confirmation` after paying, and an unknown path. 3491 text
elements and 784 interactive elements were measured; no state scrolled
sideways.

## How contrast was computed

WCAG 2.x relative luminance and contrast ratio, AA thresholds 4.5:1 for
normal text and 3:1 for large text (24px, or 18.66px at weight 700 or
more). The background is the element's own `background-color` composited
over every ancestor's until one is opaque. Where an ancestor paints a
gradient, every stop of the gradient is a candidate background and the
number reported is the worst of them; the best is shown beside it. That is
the one methodological choice worth knowing about: a screen reading
"4.57:1" on the flat ground can read "2.84:1" for the same text where the
hero's radial gradient is lightest, and the phone shows both.

## The issue's four numbers, confirmed

| claim in #85 | measured |
| --- | --- |
| footer "Owner review" 335 x 12 px on every step of `/` | 335 x 12 px (`.site-footer button`, `padding: 0 !important`, 11px text) |
| white on `#ed1c24` is 4.38:1 on the phone link, the hero CTA, every `.primary-action`, the active step number | 4.38:1 on `a.phone-link` (12px/900), `button.hero-cta` (13px/900), `button.primary-action` (13px/900), the current `.order-step span` (10px/900 on `/`, 11px/900 on `/status`), and also `.btn-primary` "Pay" (12px/800), the confirmation's "Start a New Request" (12px/800) and the not-found page's "Order tires" (12px/800) |
| inactive stepper labels `#626267` on near-black, 3.32:1 at 10px | 3.32:1 on `#070707` at 10px/700 and 10px/900 on `/`; **2.80:1** on `/status`, where the stepper sits on the `.panel` gradient (worst stop `#1c1c1c`) |
| fitment progress labels 3.41:1 | 3.41:1: `#ef4b54` on `#f8f8f8`, `.fitment-progress-item` "Width" (11px/900) and the `.fitment-wheel` glyph (17px) |
| the owner tablist has no arrow-key handling | not measured; this script measures colour and size, not keyboard behaviour |

## Brand red, everywhere it carries meaning

| where | pairing | size | ratio | AA |
| --- | --- | --- | --- | --- |
| hero eyebrow "WE COME TO YOU" | `#ed1c24` on hero gradient, worst stop `#343434` (best `#080808` 4.57) | 13px/900 | **2.84** | fail 4.5 |
| hero headline word "SERVICE" | same | 67.5px (large) | **2.84** | fail 3.0 |
| nav "Order Tires" (active) | `#ed1c24` on `#050505` | 11px/900 | 4.65 | pass |
| eyebrow "SHOP KMT" | `#ed1c24` on `#070707` | 13px/900 | 4.60 | pass |
| footer "Owner review" text | `#ed1c24` on `#070707` | 11px/800 | 4.60 | pass (height is the fault, below) |
| phone link, hero CTA, `.primary-action`, current step number, Pay, confirmation and not-found actions | `#ffffff` on `#ed1c24` | 10 to 13px / 800 to 900 | **4.38** | fail 4.5 |
| "Track this quote" on the acknowledgement | `#ed1c24` on `#0c170f` (the success panel) | 14px/400 | **4.18** | fail 4.5 |
| `/status` eyebrow "YOUR QUOTE" | `#ed1c24` on panel gradient, worst `#282828` | 13px/900 | **3.36** | fail 4.5 |
| `/status` "Cancel this request" | `#ed1c24` on `.panel`, worst `#1c1c1c` (best `#0d0d0d` 4.44) | 14px/400 | **3.87** | fail 4.5 |
| `/confirmation` eyebrow "CONFIRMED" | same | 13px/900 | **3.87** | fail 4.5 |
| `/status` and `/confirmation` totals "$ 243.11" | same | 28 to 30px/800 (large) | 3.87 | pass 3.0 |
| sign-in and status brand mark "." | `#ed1c24` on `#0b0b0c` / `#070707` | 26 to 32px (large) | 4.49 to 4.59 | pass 3.0 |
| owner "Off-road tire" glyph | `#ed1c24` on `#0b0b0b` | 27px/700 (large) | 4.49 | pass 3.0 |

Red text on the flat ground (`#070707` to `#080808`) passes by a hair,
4.57 to 4.65. Red text on any gradient panel fails, because every stop
lighter than about `#0f0f0f` takes `#ed1c24` under 4.5. White text on red
fails everywhere, by 0.12.

## Other contrast failures found on the way

| where | pairing | size | ratio |
| --- | --- | --- | --- |
| `/owner/quotes` customer email link | default anchor blue `#0000ee` on `.panel` (unstyled `a`) | 13px/400 | **1.80** |
| `/status` inactive stepper label and number | `#626267` on `.panel`, worst `#1c1c1c` | 11px | **2.80** |
| `/owner/quotes` "Approve & Send" | `#ffffff` on `#3ca75b` | 12px/800 | **3.06** |
| `/` inactive stepper label and number | `#626267` on `#070707` | 10px | 3.32 |
| fitment progress label and glyph | `#ef4b54` on `#f8f8f8` | 11px/900, 17px | 3.41 |
| footer brand text "KMT / KEN'S MOBILE TIRE" | `#737377` on `#070707` | 11px/400 | 4.27 |

Excluded: the `.tire-art` glyph on step 2 reports 1.13:1 at a computed
font size of 0px; it is a drawn ring, not text.

## Tap targets under 44 x 44 CSS px

55 of 353 distinct interactive elements. By height, the ones that matter:

| element | size | states |
| --- | --- | --- |
| `.site-footer button` "Owner review" | 335 x **12** | every step of `/` |
| customer email `a` in an owner request | 100 x 15 | `/owner/quotes` |
| supplier links `a` in an inventory row | 119 to 189 x 17 | `/owner` |
| "Offer this tire" checkbox `input` | 18 x 18 (its `label.oi-check` 305 x 24) | `/owner` |
| `.link-action` "Track this quote", "Cancel this request" | 98 to 136 x 23 | acknowledgement, `/status` |
| `.oi-brand` / `.brand-word` "KMT." | 55 to 58 x 23 to 31 | sign-in, `/status` |
| `.owner-view` tabs (Open, Needs you, With customer, To fit, Closed) | 79 to 144 x 31 | `/owner/quotes` |
| `.oi-button.oi-inline` "Use $x" | 71 to 81 x 33 | `/owner`, one per tire |
| `.fitment-back` | 49 x 35 | step 1 with a size chosen |
| `summary` "Supplier details" | 305 x 37 | `/owner` |
| `.btn-neutral` (New request, Owner review, Inventory, Back to customer flow, Sign out, Cancel) | 90 to 281 x 40 | `/status`, `/owner/quotes` |
| `.btn-primary` "Pay $243.11" | 281 x **40** | `/status` (sent) |
| nav "Services", "My quote" | 104 x 42 | `/` |
| size search `input`, `#fitmentZip` | 259 to 309 x 42 to 43 | `/` |
| `summary` "Prefer to type your vehicle in one line?" | 195 x 43.2 | step 2 |

Widths under 44 do not occur; every failure is height.

## Proposed values, computed, not applied

**One red token cannot do both jobs.** `--accent` is the fill under white
text on every primary action and the colour of red text on the dark
ground. Moving its lightness in either direction fixes one and breaks the
other; the table in the results file walks lightness 38 to 60 at the
brand hue:

| candidate | white text on it | as text on `#080808` | as text on `.panel` light stop `#1c1c1c` |
| --- | --- | --- | --- |
| `#b80e14` (current `--accent-dark`) | 6.75 | 2.97 | 2.52 |
| `#e3121a` | 4.81 | 4.16 | 3.54 |
| `#e8121b` | 4.65 | 4.31 | 3.67 |
| `#ed1c24` (current `--accent`) | 4.38 | 4.57 | 3.89 |
| `#ed1720` | 4.43 | 4.52 | 3.84 |
| `#f04249` | 3.76 | 5.32 | 4.53 |

White-on-red needs lightness 49 or below; red text on the flat ground
needs 51 or above; red text on the panel gradient needs 60 or above. So:

1. **A fill token for white-text actions**, separate from the text token.
   `--accent-fill: #e3121a` gives 4.81:1 (margin over 4.5) with the same
   hue; `--accent-dark` `#b80e14`, which already exists as the hover, gives
   6.75:1. Apply to `.primary-action`, `.btn-primary`, `.hero-cta`,
   `.phone-link`, `.order-step.current span` and `.fitment-footer
   .primary-action`. The alternative that keeps `#ed1c24` is making every
   such label large (18.66px at weight 700 or more), where 4.38 passes the
   3:1 threshold; the 10px step number cannot be made large, so it needs
   the fill change regardless.
2. **Red text on gradient panels**: either lighten the text where it sits
   on a `.panel` (`#f04249` reaches 4.53 on the `#1c1c1c` stop; `#f25e64`
   reaches 4.62 on the hero's `#282828` stop; `#f4767b` reaches 4.57 on
   the hero's `#343434` stop and is visibly pink), or stop putting small
   red text on gradients: give `.eyebrow` and `.link-action` inside
   `.panel` and `.hero-section` a white or `--text-h` colour with a red
   rule or marker instead, which keeps the brand red for large figures
   (the totals pass at 3.87 against 3.0) and fills. The headline word
   "SERVICE" at 67.5px needs only 3:1 and reaches 3.03 at `#ee2f36`.
3. **"Track this quote" on the success panel**: `#ef343b` reaches 4.55 on
   `#0c170f`.
4. **Muted greys**: `.order-step` `#626267` to `#78787f` (4.62 on
   `#070707`) and, because the same stepper sits on a panel on `/status`,
   `#85858b` (4.64 on `#1c1c1c`), or one value `#85858b` for both;
   `.site-footer` `#737377` to `#78787c` (4.58); `.fitment-progress-item`
   `#ef4b54` to `#df141f` (4.65 on `#f8f8f8`).
5. **"Approve & Send"**: `.btn-approve` background `#3ca75b` to `#308549`
   (4.58 with white), or keep the green and set the text to `#080808`.
6. **Owner request email link**: give `.owner-request a` a colour; the
   default `#0000ee` is 1.80:1 on the panel. `#7474ff` reaches 4.57; `--text-h`
   with an underline reaches far more.
7. **Tap targets**: `.site-footer button` needs `min-height: 44px` and
   vertical padding in place of `padding: 0 !important` (or
   `display: inline-flex; align-items: center; min-height: 44px`);
   `.link-action`, `.brand-word`, `.oi-brand`, `.owner-view`, `.btn-neutral`,
   `.btn-primary`, `.oi-button.oi-inline`, `.fitment-back`, `summary` and the
   nav buttons need `min-height: 44px` with padding to match (the Pay
   button at 40px is the one a customer must hit at the roadside); the
   "Offer this tire" checkbox needs a 44px-tall label hit area with the
   18px box centred in it, and the supplier and email links need block or
   inline-block display with `min-height: 44px` or padding to reach it.

## What did not work the first time

The first run treated every `background-image` as unmeasurable and listed
31 text elements as "over an image"; none of them were. They sat on
gradient panels, which have stops that can be composited. The script was
corrected to measure against every stop and rerun; the numbers above are
from the second run. The only difference between the runs is that gradient
text now has a worst-case number instead of no number.

The server was started in the background, used for both runs, then stopped
by port after checking the command line was `backend/server.mjs`; the
port was confirmed closed and the scratch database removed. The harness
reported the stopped background process as "exit 127", which is the kill,
not a failure during the runs.
