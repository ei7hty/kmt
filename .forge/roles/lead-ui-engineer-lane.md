# Role: the UI lane (LEAD UI ENGINEER)

Written 2026-09-06 by the outgoing LEAD UI ENGINEER at main `cbed14d`, for the
next UI engineer. Verify every SHA, branch and PR state below before acting on
it: a snapshot, not a live view. Read `.forge/AGENTS.md` first, then this,
then `README.md`; only then a component.

## What this lane owns, and does not

Owned: `src/components`, `src/routes`, the three stylesheets (`src/App.css`,
`src/RequestFlow.css`, `src/owner/OwnerInventory.css`) and the tokens in
`src/index.css`; in `index.html`'s head, only the app shell — `viewport`,
`theme-color`, the icon links and the manifest link, per the PROJECT
MANAGER's 2026-09-06 ruling (`.forge/roles/growth-marketing.md`) — and the two
numbers every screen is measured against: **44px tap targets and AA contrast
at 375px**. The owner
screens' markup (`src/owner/OwnerInventory.jsx`, `src/routes/QuoteRequests.jsx`)
as screens, not as lifecycle.

Not owned, and never edited from this lane: `src/store.js`, `src/pricing.js`,
`backend/`, the five audit scripts under `.forge/` (QA ENGINEER's; see "audit
coupling"), `scripts/` and `.github/` (the repo agent's). This lane changes
**no rule, route, store or state**. When a change needs one of those, it is
two PRs from two lanes, sequenced, never one PR from this one.

The successor's first read is the roster in `.forge/roles/README.md`, then
the PROJECT MANAGER's brief. The PM instructs; the repo agent merges; you
never merge your own PR. Claim a row in `.forge/CLAIMS.md` committed alone
and pushed first; release it in the last commit; the file nets to zero.

## The palette's history, which is the thing most likely to be undone

The tokens went **navy in #145** (t59, the brand overhaul) and **back to
black, white and red in t61** (#207), on the user's ruling: "original black
white and red scheme". A newcomer seeing black, white and red will assume it
was always that and that #145's navy work was wasted. It was not. Everything
else from #145 survived the revert deliberately: the logo and favicon set
under `public/brand/` (see `SOURCES.md` there; the three watermarked preview
JPGs in `public/` are git-ignored and must never be referenced by filename),
the type and composition, the request id and age on the owner card, oldest
first in "Needs you", the metric wording, the `--muted` token, the two-token
red, and every tap-target rule.

**The two-token red looks redundant and is not.** `--accent-solid #d9121a`
is for white text on a red fill (5.18:1). `--accent-text #ff6b72` is for red
text (7.8:1 on the black ground, 5.5:1 on the lightest card). Someone will
try to collapse them into the brand red `#ed1c24`, and the numbers say why
not: `#ed1c24` is 4.57:1 as text on the ground, which passes, but **3.89 on
the panel's light stop, where most red text sits**, and white on it is 4.38.
One token cannot serve both. The brand red itself stays for borders, rings
and the logo, where contrast is not read. If anyone wants red text closer to
the brand red on black, the number to design to is `#ee262d` (4.71 on the
ground, 4.01 on the panel): **that is a ruling for the lead, not a
measurement for you.**

The greys are neutral because t61 mapped #145's navy ramp back literal by
literal, each navy to the neutral grey of the same lightness. The map is
#145's own diff read backwards; the values are in #207's first commit. The
mapper read hex; three panel gradients and the navs used `rgba()` and were
mapped by hand. If you ever move the ground again, grep for both forms.

**The logo band is a decision, with evidence.** Every logo file carries its
ground baked in, measured at rgb(13, 28, 35) in every corner of every file,
one unit off the old `#0d1b24` token, which is enough to show an edge. On a
black page the logo read as a faint rectangle. Both treatments were shot at
375 before choosing (a soft-edged plate on black still read as a plate), and
the lead chose: the nav and the hero keep the logo's exact ground `#0d1c23`
as a deliberate band, the hero logo has no shadow and no radius, everything
below is black. The rules are the last block in `App.css`. Do not "fix" the
navy nav on a black page; and if you must put the logo on anything, use
`#0d1c23`, not the token.

## The CSS traps, all found the hard way

1. **A closed `<details>` unrenders its children**, so an audit reading
   `innerText` sees `""`; `visibility: hidden` empties `innerText` too. A fold
   that an audit reads is a `<button aria-expanded>` with a body clipped to
   zero height and `inert`. The owner tools panel is built that way; keep it.
2. **A container rule outranks a semantic class.** `.owner-details dd`
   painted a status note white although the `dd` carried `.status-note-wait`,
   because `(0,1,1)` beats `(0,1,0)` whatever the source order. The screenshot
   looked fine. Only `getComputedStyle` told the truth; have any check that
   asserts a colour read the computed style, never the stylesheet.
3. **A later rule pinned `.site-links button` at 42px** with higher precedence
   than the brand block appended after it. Source order alone is not
   precedence. Measure the box; do not trust the rule you wrote.
4. **`background-clip: text` reads as a background to a contrast probe.** The
   chrome headlines (the `--chrome` silver sheen on `h1`/`h2`) print as six
   failures at about 1.03:1 in `.forge/a11y-85-measure.mjs` when the true
   contrast is the fill against the ancestor ground, 6.8:1 for the silver and
   7.8:1 for the red span. QA ENGINEER has the rule to fix the probe (treat
   the clipped element's own background as the fill, measure it against the
   nearest ancestor's background; a child span with its own colour likewise).
   Until it lands, those six lines are expected and the pattern stays.
5. The site's CSP is `style-src 'self'`, so Playwright's `addStyleTag` is
   blocked. To compare treatments on a built page, set styles per element
   with `element.style.setProperty` inside `page.evaluate`.
6. The customer shell has a button catch-all; a new button on the light
   fitment panel needs `!important` on its background, border and colour
   (see `.fitment-clear`), or it inherits the dark shell's look.

## The audit coupling

`.forge/audit-ui.mjs` and the three flow audits (`dead-end-audit.mjs`,
`request-flow-check.mjs`, `responsive-check.mjs`) drive your screens by
selector and by visible text. They are QA ENGINEER's files. Rules that held
all day:

- A selector or count change happens **only with QA's agreement, in the same
  commit as the markup that needs it, and told to the PM first**.
  `EXPECTED_CHECKS` moves with the repo agent watching the run.
- **A client-side validation change lands after the audit fixtures it would
  reject.** Found twice in one day (R4 after #176, the ZIP/date wizard change
  after #182). Do not push an expected red; hold the branch and say so.
- To prove a change against a prerequisite that has not merged, run the gate
  with the prerequisite's files applied for the run only (a throwaway branch
  with it merged, or `git checkout <ref> -- <file>` then restore). Say in the
  PR body that you did.
- The gate's seed tires are picked by name and are priced above every
  supplier tire in their size, so they sit last in the list. `expandTireList`
  loops on `button.tire-show-more` until it is gone (QA's text). Rename that
  class and you change the gate.
- Two `dev.mjs` at once collide on Vite's HMR port 24678 and fail the owner
  inventory audit with "WebSocket closed without opened". Run one, or serve a
  built `dist` with `backend/server.mjs` on a spare port, which is what this
  lane did all day:

  ```
  npm run build
  KMT_OWNER_DB=<tmp.sqlite> KMT_SESSION_SECRET=audit-only-session-secret \
    KMT_OWNER_PASSWORD=audit-only-password-not-a-secret PORT=4191 KMT_BIND=127.0.0.1 \
    node backend/server.mjs
  AUDIT_BASE=http://127.0.0.1:4191 KMT_OWNER_PASSWORD=audit-only-password-not-a-secret \
    node .forge/dead-end-audit.mjs
  ```

  Kill the server by port afterwards and confirm the port is closed; a
  survivor makes the next run's numbers lie.

## The tire step, and why two names for one list

`src/routes/CustomerRequest.jsx` fetches one size after it is chosen
(`loadCatalogForSize`, #169). The tire step **shows no tire until the live
answer arrives**; the standard list appears only if the answer fails or is
not in within 8 s (`LIVE_ANSWER_WAIT_MS`); a late live answer is **offered
as a refresh, never swapped in**; on refresh the choice is found again by
size and name, and if it is gone the choice is cleared and Continue is
disabled until a new one (#183; the lead's principle: a choice never changes
under the person making it). The size is part of the list value so a list for
one size is never shown for another.

The data layer answers `source: 'static'` (its word for the built-in
catalog) and the step shows `data-source="standard"` (the word the customer
reads above the list). **Both names are deliberate and QA's gate asserts the
DOM value**; renaming either side alone breaks a check for a reason unrelated
to what it tests. #200 carries the comment at the relabel.

The list reveals in pages of 24 ("Show 24 more", #195); fully revealed, the
busiest size is 54,005px, which is now the customer's choice rather than the
default. To watch the rare branches, route the request in Playwright
(`page.route('**/api/catalog?size=*', ...)` with a delay, an abort, or a
fulfilled body of your own); the four shapes this lane proved are in #183's
body. Locally the answer lands before the step opens, so the audits never see
the wait.

## Measuring, so the numbers stay comparable

Use QA's instrument, `.forge/a11y-85-measure.mjs`, for contrast and tap
targets, because every baseline figure (24 text failures and 55 sub-44px
targets on the morning of 2026-09-06, then zero on the customer screens) came
from it; a fresh probe gives numbers nobody can compare. It writes
`.forge/a11y-85-results.json`, which is not committed. At spin-down the
customer path reads zero apart from the six chrome-headline lines in trap 4;
the owner screen's 18px checkboxes and its supplier link are known and
unowned.

Measurement habits that paid: measure on main before touching anything, and
say which container you measured (the "nav wraps to two rows" versus "the
actions sit on one row" contradiction in the t59 review was two correct
measurements of two different things); read boxes and computed styles from
the built page by script, never from a screenshot alone; put the numbers in
the PR body as before and after.

## In flight at spin-down (verify before acting)

- **#207** t61, branch `t61-black-white-red`, head `0287003`, CI green. Held
  behind the deploy-scope fix going live, not on merit; the lead signs off the
  logo band from the screenshots the PM holds. Complete.
- **#200** the `static`/`standard` comment, head `e1bd9c5`, green. Trivial.
- **#214** (draft) the ZIP required and the date floor, branch
  `wizard-zip-and-date`, head `b8905f3`. **Complete and verified** (48 of 48
  with #182 merged in locally), red on main by design until #182 lands its
  rewritten fixtures. To land: merge main after #182, run the gate, take it
  out of draft. Not abandoned.
- The junior's **#210** (t63: every phone control is a text control; plus
  t62's app half, the approved list applied in a later commit). This lane's
  first-reader approval covers the t63 head `ebe4733` only; the t62 commit
  `b11819e` (26 rows, including two error strings in `src/store.js`) is the
  repo agent's read. Approved on that head: zero `tel:` and zero "call" on
  every customer route, one sms module, the owner card's `tel:` to the
  customer as the one deliberate exception.

## What this lane would do next

1. Land #214 behind #182.
2. The email templates on the settled palette, against LEAD FULL STACK's seam
   (`backend/mail-templates.mjs`, #206): replace `render(data)` only, keep the
   plain-text alternative, bump `version` for any new data field and add it in
   `data()`, never in `render`.
3. The `/owner` outbox panel R25 wants, on `GET /api/owner/outbox`
   (session-gated).
4. When the docs batch moves: the rule about validation and fixtures into
   `.forge/AGENTS.md`, and traps 1 to 3 into `.forge/NOTES.md`.

## Shipped from this lane on 2026-09-06, for the archaeology

#169 per-size catalog fetch; #170 owner card supplier facts and the grey
swap; #175 the size search accepts a whole size; #183 the tire step waits;
#190 owner nav one row at 375 and the coverage line into the tools panel;
#191 R4, the owner link off the customer path; #192 the fitment illustration
at its own shape, all widths on screen, two owner cards per row; #195 the
paged tire list. Before the role: the scraper and import lane
(`scraper-lane-swe-agent-2.md`).
