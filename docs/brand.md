# Brand assets: provenance and the swap rule

Derived on 2026-09-06 by the KMT lead from the three source files the user
placed in `public/` (git-ignored there, as source art rather than shipped
assets): the primary "KENS / MOBILE TIRE" lockup on the navy ground, the same
lockup on white, and the sheet of compact "KMT" and "KENS" badges.

**The art is the business's own.** Confirmed by the user on 2026-09-06, after
this file had spent a day asserting the opposite.

> **Correction, 2026-09-06.** Until this revision, this file made a claim about
> the licensing of this art, and named the designer alongside it. **Both were
> inferences drawn from a faint mark in the images, and neither was ever
> checked with the person who bought the art.** Both are wrong and both are
> withdrawn. The repository is public, so that text was a published claim about
> a real business and a named supplier; it should not have been written from an
> inference. The designer is deliberately not named here now, and the
> provenance below is what a maintainer actually needs.
>
> The measurement that prompted it was sound and is kept below. **The
> inference drawn from the measurement was never put to the one person who
> could settle it in a sentence** -- which is the failure worth remembering,
> not the number.

Whether the files now in `public/brand/` are final or will be reissued from
newer source art is **not settled here**, and this file no longer guesses. If
they are ever replaced, follow the cache rule below.

**A faint mark is present in the source art and is not visible.** Those are two
claims and only the first was being made, which is how it came to be read as
both. Measured on 2026-09-06 **against the three navy-ground files, which are
the only lockups that ship**, the tiled diagonal mark peaks at **2 levels out
of 255 in `og-1200x630.jpg` (1.02:1), 3 levels in `kens-dark-1200.webp`
(1.03:1), and nothing detectable in `kens-dark-600.webp`** -- against the 3:1
at which WCAG 1.4.11 treats a graphical object as perceptible at all. The
method was proved
in both directions before the numbers were trusted: the same measurement was
run against copies of `og-1200x630.jpg` with a diagonal watermark stamped on
at known strengths, where it rises monotonically and crosses 3:1 between grey
90 and grey 140, and a stamp measuring 1.61:1 is plainly visible in a 600px
link preview while the shipped file at 1.02:1 is not. The mark is recoverable
only by cropping the empty ground and stretching the contrast several times
over.

So: nobody sharing a link, loading the hero or looking at the favicon sees a
mark, and **no work is owed on visual grounds.** The earlier version of this
paragraph went on to say the swap was owed on licensing grounds instead. It is
not; see the correction above.

> **Scope correction, 2026-09-06.** The paragraph above measured three files
> and, until this revision, stated its conclusion for all fourteen. **On the
> white-ground variants it is false by this document's own yardstick.**
> Re-measured over the outer 7% margin band, where the lockup does not reach:
> `kens-light-600.webp` **1.35:1**, `kens-light-1200.webp` **1.38:1**,
> `kens-badge-light-800.webp` **1.92:1**, `kmt-light-800.webp` **1.98:1** --
> against the **1.61:1** stamp this same document calls *plainly visible in a
> 600px link preview*. Cropping `kmt-light-800.webp`'s margin at 4× with **no
> contrast enhancement at all** renders the designer's mark as legible
> letterforms. The worst pixels are near-neutral greys (219, 222, 182-186), so
> it is the mark and not the logo's red-and-black art bleeding into the band.
>
> **The physics is obvious afterwards and invisible in advance:** the same grey
> mark has far more luminance to work with on white than on near-black navy.
> Every elevated reading in the original sweep came from a light file or an
> artwork edge, and the sweep dismissed the whole set after spot-checking one
> that turned out to be artwork. **One spot-check does not clear a category.**
>
> **What does not change: no white variant is referenced by `src/`,
> `index.html` or the manifest.** Only the three navy lockups and the five
> icons ship, so the conclusion above still holds everywhere a customer can
> reach. The document was claiming more than it had measured, not describing a
> live exposure.

> **Measured 2026-09-06, before the regeneration.** Everything in this section
> describes the asset set as it stood that day. **Regenerating the files on
> black takes the mark off every flat surface** -- `kens-light-1200.webp` went
> from 1.38:1 at 96.5% flat ground to **1.00:1 at 100%** -- leaving only faint
> residue where it crosses the artwork, which the product owner has ruled is
> not to be chased. **So treat every figure below as dated, and re-measure
> before repeating one.** The method is in this file; the numbers are a
> snapshot.

**The icons were never measured by either sweep**, which is worth saying
because they are the most-displayed brand assets in the product -- `icon-64.png`
renders on seven screens and `icon-32.png` is the favicon. Measured on flat
interiors: `icon-32` and `icon-64` have **no flat region at all** to measure,
`icon-180` **1.033:1**, `icon-192` **1.035:1**, `icon-512` **1.160:1**. Worst
reading anywhere is 1.16:1, far under the 3:1 floor. **Two caveats from the
measurer, kept because a number without them invites over-reading:** the
sources are JPEG, so part of 1.12-1.16 is codec noise that cannot be separated
from a mark; and that instrument has a ceiling -- its control climbs 1.020 to
1.148 across +1 to +12 levels and then reads **1.000** at +30, because a strong
mark falls outside its tolerance and is excluded rather than measured. Safe at
~3 levels on navy, blind above ~24.

**All four white variants are publicly fetchable at guessable URLs**, and
`.forge/deployed-site-check.mjs` asserts they are -- it lists them among the
assets that must answer 200 with the right content type. So a check holds them
in place on the public site while nothing in the application references them.
**Publicly fetchable and pinned by a test is not the same as shown to a
customer, and the two want different fixes**; the regeneration above closes it
either way.

**Every file on disk carried the mark** on the date measured, the navy ones
included -- invisibly
there, legibly on white. That is true of the master lockup added later the same
day as well, whose aspect ratio matches the shipped `kens-dark-*` files closely
enough to be the source they were cut from. **There is no unmarked art in this
repository.** The product owner has asked the user for a clean delivery; until
it arrives the reissue below is worth doing, on the plain ground that the files
we have are marked. That is a quality matter and **not** a licensing one -- see
the correction at the top of this file, which stands.

**If the files are ever reissued**, from newer source art or for any other
reason, one condition applies: `/brand/*` is served with `Cache-Control:
public, max-age=86400`, so a browser that has seen a file keeps it for a day.
That PR must also bump a version query on every reference
(`/brand/icon-192.png?v=2`) or give the files new names, so nobody is served a
day-old cached copy after the replacement is live. This is a caching rule, not
a deadline -- nothing here is waiting on it.

This note lives in `docs/`, not in `public/brand/` beside the files, because
everything under `public/` ships to the site as-is: for a while it was readable
at `/brand/SOURCES.md`, announcing the provenance and the watermarks to anyone
who asked. The files' provenance belongs in the repository, not on the web.

| file | use |
| --- | --- |
| `kens-dark-1200.webp`, `kens-dark-600.webp` | primary lockup on the dark theme: hero (1200) and nav (600). 1200x1028 and 600x514 |
| `kens-light-1200.webp`, `kens-light-600.webp` | primary lockup on white: light surfaces, email templates. Same 1200x1028 and 600x514 as the dark pair; they were 2:1 letterboxes of the same square artwork before |
| `kmt-dark-800.webp`, `kmt-light-800.webp` | compact "KMT" badge, dark and light. 800x800; they were 800x801 |
| `kens-badge-dark-800.webp`, `kens-badge-light-800.webp` | compact "KENS" badge, dark and light |
| `icon-512.png`, `icon-192.png`, `icon-180.png`, `icon-64.png`, `icon-32.png` | the wheel alone on black: manifest icons, apple-touch-icon (180), favicon fallbacks. Palette-indexed PNG, which is what took the set from 584 KB to 190 KB |
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

Brand ground: black `#080808` -- the site's own black, the same value as the
`theme-color` meta and the customer shell, not a new one. It was navy
`#0d1b24` until the assets were regenerated on black; the nav and hero band
that existed to hide the logos' baked-in navy went with it (`src/App.css`,
the t61 block). Brand red: `#ed1c24` (already `--accent`), unchanged.
Chrome/silver is reserved for the wordmark and the page headline; the flame
appears nowhere except inside the logo.
