# Brand assets: provenance and the swap rule

Derived on 2026-09-06 by the KMT lead from the three files the user placed in
`public/` (git-ignored there as watermarked previews from the seller,
DesignNoirCo): the primary "KENS / MOBILE TIRE" lockup on the navy ground, the
same lockup on white, and the sheet of compact "KMT" and "KENS" badges.

The user chose to ship these as they are. Every file below still carries the
seller's watermark; when the licensed, unwatermarked art arrives, regenerate
`public/brand/` from it with the same names and nothing in `src/` changes.

**The watermark is present and is not visible.** Those are two claims and the
sentence above only makes the first, which has been read as both. Measured on
2026-09-06 against the flat ground of each file that actually ships, the
seller's tiled diagonal mark peaks at **2 levels out of 255 in
`og-1200x630.jpg` (1.02:1), 3 levels in `kens-dark-1200.webp` (1.03:1), and
nothing detectable in `kens-dark-600.webp`** -- against the 3:1 at which WCAG
1.4.11 treats a graphical object as perceptible at all. The method was proved
in both directions before the numbers were trusted: the same measurement was
run against copies of `og-1200x630.jpg` with a diagonal watermark stamped on
at known strengths, where it rises monotonically and crosses 3:1 between grey
90 and grey 140, and a stamp measuring 1.61:1 is plainly visible in a 600px
link preview while the shipped file at 1.02:1 is not. The mark is recoverable
only by cropping the empty ground and stretching the contrast several times
over.

So: nobody sharing a link, loading the hero or looking at the favicon sees a
watermark, and no work is owed on visual grounds. **The swap below is still
owed on licensing grounds** -- these are unlicensed previews whatever they
look like -- and that is the reason to do it, which is worth stating plainly
because "you cannot see it" is a good answer to the wrong question.

One condition on that swap, from the lead: `/brand/*` is served with
`Cache-Control: public, max-age=86400`, so a browser that has seen a file keeps
it for a day. The PR that swaps in the licensed art must also bump a version
query on every reference (`/brand/icon-192.png?v=2`) or give the files a new
suffix, so nobody holds a watermark for a day after the real art is live.

This note lives in `docs/`, not in `public/brand/` beside the files, because
everything under `public/` ships to the site as-is: for a while it was readable
at `/brand/SOURCES.md`, announcing the provenance and the watermarks to anyone
who asked. The files' provenance belongs in the repository, not on the web.

| file | use |
| --- | --- |
| `kens-dark-1200.webp`, `kens-dark-600.webp` | primary lockup on the dark theme: hero (1200) and nav (600) |
| `kens-light-1200.webp`, `kens-light-600.webp` | primary lockup on white: light surfaces, email templates |
| `kmt-dark-800.webp`, `kmt-light-800.webp` | compact "KMT" badge, dark and light |
| `kens-badge-dark-800.webp`, `kens-badge-light-800.webp` | compact "KENS" badge, dark and light |
| `icon-512.png`, `icon-192.png`, `icon-180.png`, `icon-64.png`, `icon-32.png` | the wheel alone on navy: manifest icons, apple-touch-icon (180), favicon fallbacks |
| `og-1200x630.jpg` | link preview image for shared URLs |

Eight of these fourteen files are referenced by `src/`, `index.html` or the
manifest. The other six -- both `kens-light-*`, both `kmt-*-800` and both
`kens-badge-*-800`, 276 KB together -- are named in the table above for uses
that do not exist yet (light surfaces, email templates, the compact badges),
and ship to the public site reachable by anyone who guesses the filename.
Measured 2026-09-06; recount before acting on it, because the intended uses
are real and one of them arriving would change the answer. Whether they stay
is the owner's call, not a cleanup to do quietly: deleting an asset someone is
about to reference is worse than 276 KB.

## The structured data in `index.html`

The JSON-LD block in the head is what a search engine reads to decide Ken
serves a caller's town. Every value in it traces to something the business
already states, and the sources are recorded here rather than in the file,
because that comment ships to the public web:

| field | where the value comes from |
| --- | --- |
| `name`, `description` | the site's own copy; the description matches `<meta name="description">` word for word |
| `telephone` | `+1-617-410-8319`, the number on `/privacy` and throughout the app. **Not** the `(617) 555-0100` in the mobile field's placeholder, which is a form hint and a test fixture |
| `address` | locality and region only. Malden is already public in the site copy; there is no street address because there is no storefront, and inventing one would send customers to a driveway |
| `areaServed` | a `GeoCircle` on 02148's Census centroid (`backend/zip-centroids.json`) with a 25-mile radius, which is `KMT_SERVICE_REVIEW_MILES` -- the distance served without the owner being asked first |
| `image`, `logo` | `og-1200x630.jpg` and `icon-512.png`, the files already shipped |

**Absent on purpose, and each one needs the owner before it can be added:**
opening hours, a price range, and any social profile for `sameAs`. Nobody has
supplied them and structured data is the wrong place to guess. `aggregateRating`
and `review` are absent for a stronger reason: KMT has no collected reviews, and
fabricating them in markup is both a search penalty and a lie told on a real
person's behalf.

**That last one is a standing rule, ruled on 2026-09-06 by the product owner,
not a decision taken once for this file:** `aggregateRating` and `review` stay
absent permanently until real customer reviews exist. There is no placeholder
version, no example version and no "just to show the layout" version --
a rating is a stranger's judgement of whether to trust Ken with their car, and
inventing one misrepresents him to exactly the person deciding. The way to earn
them is to ask after a paid job, which is t66's territory and a conversation
with Ken about what he is comfortable asking for.

One judgement worth knowing before changing it: the radius is 25 miles, not the
100 in `KMT_SERVICE_RADIUS_MILES`. A request past 25 miles is accepted and
routed to the owner to look at; past 100 it is refused. Twenty-five is what the
site's own copy already claims ("Malden, MA and Greater Boston") and the
distance nobody has to approve, so it is the conservative and consistent
number. Widening it toward 100 would reach more of Massachusetts and bring in
leads Ken then has to decline. **Settled on 2026-09-06 by the product owner:
25 stands**, so this is a decision to reopen deliberately rather than a gap to
close.

Note also that the radius here is static while the server's is configuration:
if `KMT_SERVICE_REVIEW_MILES` is ever changed, this number does not follow it.

**The two radii are independent on purpose and must not be wired together.**
The server's 100 is a straight-line floor on how far the owner may be *asked*
to go, set deliberately under road distance so that a refusal errs toward
letting someone through; `areaServed` answers a different question -- where
Ken should turn up when somebody searches -- which is his market, and his
scarce resource is hours, not leads. Pointing this number at
`KMT_SERVICE_RADIUS_MILES` to stop the two disagreeing would silently
advertise him to 100 miles, and nobody would notice until he started declining
work from Worcester. A listing that says 25 while enforcement allows 100 is not
drift: it is the review band doing its job, so that someone at 40 miles who
finds Ken another way still reaches his judgement instead of a closed door.

Brand ground: navy `#0d1b24`. Brand red: `#ed1c24` (already `--accent`).
Chrome/silver is reserved for the wordmark and the page headline; the flame
appears nowhere except inside the logo.
