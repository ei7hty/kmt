# Social profile integration

Implementation specification written 2026-09-07 at `origin/main` `2eb7def`.
It prepares t66's social-profile half without supplying facts on Ken's behalf.
No handle, profile URL, follower count, rating, review, testimonial, or platform
claim is known from this repository. Until the owner supplies and verifies a
profile, the correct public output is no link and no `sameAs` entry.

The site remains a funnel for tire sales and schedulable work. Social links are
supporting identity and trust signals, not a new emergency-search strategy, a
feed, or a substitute for the order and inquiry paths.

## Owner input required before any public implementation

For every profile Ken wants linked, obtain all of the following directly from
the owner:

1. Platform name and the complete public HTTPS profile/channel URL copied from
   the signed-in profile page (not a handle, search result, share redirect, post,
   reel, video, or shortened URL).
2. Confirmation that the profile represents **Ken's Mobile Tire**, is controlled
   by Ken, and may be linked from `kensmobiletire.com`.
3. Whether it is enabled now and its preferred display order.
4. The public label only if the platform's normal name is insufficient. Never
   derive or display follower counts, ratings, review totals, or activity claims.

Supported in version one: Facebook, Instagram, TikTok, YouTube, X, and LinkedIn.
This is a capability allow-list, not a claim that KMT uses any of them. Add a new
platform by code review before accepting its URL; do not provide a free-form
"other" platform escape hatch. A Google Business Profile may later be supported
as a separate business-listing identity, but it is not presented as a social
network or added without its own verified canonical listing URL.

## Data model and one source of truth

Social URLs are structured business facts, not editable prose. They must not be
added to `SITE_COPY_FIELDS` or stored inside the existing `siteCopy` value.
Follow the same safe storage precedent with a separate metadata key,
`socialProfiles`, and one shared registry module (proposed
`src/social-profiles.js`) imported by browser and backend.

The stored value is an ordered array:

```js
[
  { platform: 'instagram', url: 'https://www.instagram.com/<verified-profile>/', enabled: true },
]
```

The example is schema notation only; `<verified-profile>` must never ship.
`platform` is a stable enum key, `url` is the canonical verified URL, `enabled`
is explicit, and array position is display order. Platform display name, icon,
allowed hosts, and URL normalizer live in the registry rather than storage.
Reject duplicate platforms and duplicate normalized URLs. Saving an empty array
is valid and means no public social output. Preserve the previous complete array
for one-tap undo, mirroring site-copy reversibility.

The owner API returns the full stored model only behind the existing owner
session. Public rendering receives only validated entries where `enabled` is
true, in saved order. Unknown or legacy entries fail closed and do not render.
Do not expose account ownership notes, verification timestamps, or disabled
profiles to the customer bundle.

## URL allow-list and validation

Apply validation on the server at write time and again when resolving public
output. Client validation is feedback, not the trust boundary.

All URLs must:

- parse with `new URL`, use `https:`, contain no username/password, and use the
  platform's exact allow-listed hostname or approved `www` variant;
- contain no fragment and no tracking parameters (`utm_*`, `fbclid`, `gclid`,
  or equivalent); version one accepts no query string;
- identify an account/profile/channel, not platform home, login, search, share,
  post, reel, story, playlist, or individual video URLs;
- be normalized to the platform's canonical host, casing and trailing-slash
  convention before duplicate checks and storage.

Initial host allow-list:

| platform | allowed hosts | required profile shape |
| --- | --- | --- |
| Facebook | `facebook.com`, `www.facebook.com` | one profile/page path segment; reject `/share`, `/watch`, `/groups`, `/events`, `/marketplace` |
| Instagram | `instagram.com`, `www.instagram.com` | exactly one account path segment; reject `/p`, `/reel`, `/stories`, `/explore` |
| TikTok | `tiktok.com`, `www.tiktok.com` | exactly one `@account` segment; reject individual `/video/` paths |
| YouTube | `youtube.com`, `www.youtube.com` | `/@handle`, `/channel/<id>`, `/c/<name>`, or `/user/<name>` only |
| X | `x.com`, `www.x.com` | exactly one account segment; reject `/i`, `/home`, `/search`, `/hashtag` and `/status/` |
| LinkedIn | `linkedin.com`, `www.linkedin.com` | `/company/<slug>` or `/in/<slug>` only; prefer the company form for a business |

Host matching must compare the parsed `hostname`, never suffix text; for
example, `facebook.com.example.test` is not Facebook. Validation proves URL
shape, not ownership. The owner's direct confirmation is the ownership proof.

## Public rendering and accessibility

Render the ordered links only on the marketing routes already defined for
analytics and indexing: `/` and `/privacy`. Do not put them in the shared
`PrivacyFooter` unconditionally because that component also appears on customer
status, confirmation, inquiry, owner, sign-in, and not-found surfaces. The home
placement belongs in `CustomerRequest.jsx`'s `.site-footer`; `/privacy` needs an
explicit marketing-only social group or a route-aware footer variant.

When the resolved array is empty, render no heading, wrapper, icon, separator,
placeholder, reserved gap, or `sameAs`. This is the shipping default.

Each link must have visible text (platform name is sufficient), an accessible
name such as `Ken's Mobile Tire on Instagram`, and a real anchor `href` so it
works without JavaScript. Icons are decorative when visible text is present;
otherwise the icon needs the accessible name. Keep a minimum 44-by-44 CSS-pixel
tap target, visible keyboard focus, and AA contrast in both viewports. External
profiles open in a new tab with `target="_blank"` and
`rel="noopener noreferrer"`; the accessible label must announce that behavior,
for example with visually hidden `opens in a new tab` text. Do not use embedded
feeds, platform SDKs, follow buttons, counters, or remote icon assets.

## `sameAs` from the same resolved data

`index.html` currently has one valid `AutoRepair` JSON-LD block and deliberately
omits `sameAs`. Public HTML must add `sameAs` only when at least one validated,
enabled profile exists, using the exact normalized URLs and order rendered in
the marketing footer. With zero profiles the property remains absent, not an
empty array.

The production server already injects resolved site-copy data into the shell in
`backend/static.mjs`. Extend that shell-composition boundary so one resolved
social array produces both (a) a non-executable JSON data block consumed by the
marketing components and (b) the `sameAs` array in parsed/serialized JSON-LD.
Do not maintain a second URL list in `index.html`, JSX, or an audit. A static
Vite-only build has no owner metadata and therefore correctly renders neither
links nor `sameAs`.

Parse and serialize the JSON-LD; do not string-replace JSON. Preserve its current
facts and continue omitting opening hours, price range, ratings, reviews, and
testimonials until separately supplied and approved.

## Social preview assets

The current marketing head points `og:image` to
`/brand/og-1200x630.jpg?v=2` and declares `summary_large_image`. Before changing
the asset or expanding tags, Ken must approve the image and confirm rights to
publish it; `docs/brand.md` records that the current preview asset's licensing
is unsettled. No profile integration should be blocked on a speculative asset
replacement, and no platform-specific scraper or remote image is needed.

An approved replacement must be a locally served, rights-cleared 1200×630 image,
legible at small preview sizes, with important logo/text inside a safe central
area, no fabricated ratings or urgency claims, and a versioned URL when bytes
change. Add explicit `og:image:width`, `og:image:height`, and descriptive
`og:image:alt`; mirror title, description, image and alt for Twitter/X only if
tests confirm the tags resolve to the same canonical facts. Verify JPEG content
type, dimensions, cache/ETag behavior, absolute canonical URLs, and rendered
previews with platform validators after deployment.

## Privacy and analytics

Plain outbound anchors load no platform code before a person clicks. With
`noreferrer`, the destination also receives no referrer from the browser. Keep
the current CSP unchanged: local icons and anchors require no new `script-src`,
`connect-src`, `img-src`, frame, cookie, or SDK allowance.

Do not add GA events in version one. The current privacy notice says GA counts
visits, and analytics is independently gated in `src/analytics.js` and
`backend/site.mjs` to `/` and `/privacy`. If the owner later requests outbound
click measurement, make that a separate decision: emit only the platform enum
(never handle, profile URL, customer/request id, or contact data), only on those
two routes, update the analytics specification and privacy wording in the same
PR, and prove the strict CSP remains on every customer and owner route.

## Staged implementation and claim regions

1. **Owner facts only:** collect the URLs and confirmations above. No repository
   change and no public placeholder.
2. **Model and owner control:** claim a new shared registry
   `src/social-profiles.js`, a focused backend store/validation module and tests,
   owner API dispatch regions, owner store calls, and a dedicated owner screen
   (recommended `/owner/social`). Reuse the `metadata` table and owner auth; do
   not claim or change `SITE_COPY_FIELDS`.
3. **Public output:** separately claim `backend/static.mjs` shell composition,
   `backend/server.mjs`'s `createStaticHandler` options, `index.html`'s JSON-LD
   content, `CustomerRequest.jsx` footer markup, a `/privacy`-only footer region,
   and the corresponding narrow CSS. Coordinate because these files sit across
   growth, UI, backend, and SEO verification lanes.
4. **Verification and preview:** claim focused backend/static tests and the
   relevant regions plus `EXPECTED_CHECKS` in the browser and deployed-site
   audits. A head-check change belongs with its fail-direction control. Preview
   asset/tag changes are a later growth claim after owner approval and rights
   confirmation.

Testimonials are explicitly outside this implementation. They need the original
customer wording, attribution/permission, and an owner decision before a
separate spec; an empty social model must never be filled with testimonial or
review placeholders.

## Acceptance criteria

- Fresh database, missing metadata, empty array, all-disabled entries, malformed
  legacy data, and static Vite build each render zero social UI and no `sameAs`.
- Every accepted platform has positive URL tests; wrong scheme, deceptive host,
  credential, query, fragment, content URL, duplicate platform/URL, and unknown
  platform tests fail at the server boundary.
- Enabled profiles render once, in owner-selected order, on `/` and `/privacy`
  only. They do not render on `/status`, `/confirmation`, `/inquiry`, any
  `/owner` route, sign-in, or not-found.
- The DOM links and parsed `AutoRepair.sameAs` are byte-for-byte the same
  normalized URL list; disabling, reordering, undoing, or deleting a profile
  changes both on the next page load and moves the shell ETag.
- Links are keyboard reachable, have visible focus, accessible platform and
  new-tab names, 44×44 targets, valid `noopener noreferrer` behavior, and no
  horizontal overflow at 375px or 1280px.
- No third-party script, request, cookie, embedded content, remote icon, or CSP
  widening occurs. Existing GA route isolation remains green.
- JSON-LD parses, retains all current business facts, and gains no unsupported
  hours, price, rating, review, testimonial, or follower data.
- The approved OG image returns the expected type and dimensions and its tags
  use canonical absolute URLs; deployed preview validators show the intended
  card without unsupported claims.
- `npm run build`, `npx eslint src backend`, all backend tests, all required
  browser audits with their exact count sentinels, and the read-only deployed
  check pass under the process in `.forge/AGENTS.md`. The implementation PR is
  read and merged by a second agent.
