# Role: junior front end dev, as served on 2026-09-06

Written by the session that held the title (`local_376e0377`, earlier the
onboarding orchestrator) at its spin-down, main at `09bccf4`. Verify every
SHA, PR state and file shape below before acting on it: a snapshot, not a
live view.

## What the role owned, and did not

Owned, one task at a time from the PROJECT MANAGER, inside the LEAD UI
ENGINEER's lane with them as first reader and design authority: the
privacy page and its footer link (#163, #193), the owner card's zero-stock
warning (#171), the robots `noindex` meta on the private screens (#177),
the #85 accessibility measurement and its report (#156), and t63, every
call control becoming a text control (#210, with t62's app half).

Did not own: any pricing rule, route state, the store, the backend, the
audit scripts and their counts (QA ENGINEER's), the scraper, the workflow
(the repo agent's), deployment (DEV OPS's), the owner screens as such,
and the email templates (LEAD UI ENGINEER's). The two customer-facing
strings that originate in `backend/` (the t48 refusal in #182, the
rate-limit line in #204) were LEAD BACKEND DEV's to change; this role
supplied the wording and touched no backend file.

## Who it obeyed, and what it reported

The PROJECT MANAGER, one task at a time, with the LEAD UI ENGINEER as
first reader on every PR and the repo agent merging on the PM's slotting.
Product decisions belonged to the DEV-PRODUCT MANAGER and the user. Every
report said what actually happened, including what did not work the first
time and what could not be verified; twice a claim of the PM's was checked
against the code and found wrong, and reporting that plainly, without
touching what was not this role's, was what the PM asked for.

## Code map

- `src/contact.js`: the shop number, the `sms:` link and the label, in one
  place. Every customer-facing phone control imports it.
- `src/noindex.js`: `useNoIndex()`, a meta robots tag for as long as a
  private screen is mounted, called at the top of `OwnerInventory`,
  `QuoteRequests`, `Status` and `Confirmation` before any early return.
- `src/routes/Privacy.jsx`: the notice, in the lead's ruled words, and the
  exported `PrivacyFooter` every screen renders.
- `src/routes/QuoteRequests.jsx`: the amber zero-stock note after the
  details list, on the boundary agreed with LEAD UI ENGINEER (they render
  the supplier facts row; the note fires only when stock is 0 and the
  tire is still listed).
- `.forge/a11y-85-measure.mjs` and `a11y-85-report.md`: the probe and its
  findings; the lightness table there shows why one red token cannot
  serve both as a fill under white text and as text on the dark ground.

## The instance map for t63, so nobody greps it again

Customer-facing phone controls on main at `09bccf4`, found by grepping
the number and "Call", not by component: the header `a.phone-link` on `/`;
the empty-size panel's button and sentence; the submit-failure panel's
button and sentence; the `/status` error panel's button; `/confirmation`'s
"Need a hand?" in its missing and not-found states. The footer carries no
phone control at all. Server side: the t48 refusal in `backend/quotes.mjs`
(#182) and the rate-limit line in `backend/api.mjs` (#204). The owner
card's link to the customer's own phone stays a `tel:` link by the PM's
ruling: t63 is customer-facing only, and that link is Ken calling a
customer. The empty-size panel cannot be reached in the built app,
because generated coverage fills every size the selector offers; the
dead-end audit asserts exactly that.

## Three rulings worth keeping

- The `sms:` href is `sms:+16174108319?body=<encoded>`. `?body=` is what
  Android and current iOS read; older iOS used `&body=` or `;body=` and
  still opens the messages app addressed to the number with an empty
  draft. The href can be verified from a build; a messages app cannot be
  opened from one, and the PR said so.
- The privacy page's removal sentence keeps the lead's ruled words, and
  its number is plain text, tappable nowhere: the ruled words stand, and
  removal is a right, not a lead. An `sms:` link there would be the only
  one on the site without the tires opener, and someone would "fix" it.
- No email address for Ken exists in the repository, and the page names
  the phone only. The address the user gave is configuration, never a
  file; when the business has one, the page gains it from a setting.

## Rules paid for

- **Check the diff stat before opening a PR.** Mixed line endings once
  made a 26-line change present as six rewritten files; an inserted
  line landed between a `\r` and its `\n`. A shape you cannot explain
  is the finding; one you can explain (a spec landing on main after your
  rebase) is a fact.
- **Read the computed style, not the stylesheet.** `.owner-details dd`
  outranked `.status-note-wait` and painted the zero-stock warning in
  the heading white; a screenshot looked like a line in a card. The
  check's colour readout caught it. Same family: `background-clip: text`
  chrome reads as a background to a compositor and gave 1.03:1 where the
  truth was 8.21.
- **Measure text over a gradient at every stop and report the worst.** A
  first pass called every gradient panel "over an image" and measured
  nothing; the corrected pass found the hero eyebrow at 2.84:1 and the
  `rgba` panels LEAD UI ENGINEER's hex-only mapper had missed.
- **Reach the state the way a person does.** A zero-stock tire did not
  exist in the seed, so one was imported at stock 0 through
  `scripts/import-tires.mjs --to` and a request submitted for it; the
  negative case was proved by intercepting the row as delisted.
- **`CLAIMS.md` bit three people in one day.** Its placeholder row comes
  and goes; replace `_none_` when it is there and append after the last
  row when it is not; on a rebase, read the table on every commit rather
  than trusting a conflict resolver, and rebuild the three commits from
  the base's table when it goes wrong.
- **Ask "is this mine?" before building.** #97 was built twice by two
  people once; the #105 boundary was drawn with LEAD UI ENGINEER before
  either wrote a line, and the split held.
- **When a claim contradicts the code, the code wins, and say so.**
  `.text-secondary` was twice reported swapped to `--muted` and was still
  raw hex on main; the audits were said to reach `/owner` by URL and in
  fact click the very button R4 removes.

## How to verify

`npm run build`, `npx eslint src backend`, `node --test backend/*.test.mjs`,
then `backend/server.mjs` serving the built `dist/` on a scratch database
(`KMT_OWNER_DB` under the scratchpad, a throwaway `KMT_OWNER_PASSWORD` of
twelve characters or more, `KMT_BIND=127.0.0.1`, an unusual `PORT`),
`AUDIT_BASE` set explicitly for the three browser audits, and a throwaway
Playwright script in `.forge/` that reads the built page (boxes, computed
styles, `document.head`) rather than a screenshot. Stop the server by
port after checking its command line is `backend/server.mjs`, confirm the
port closed, remove the scratch database, delete the script. The
background-task harness reports the stopped server as "exit 127"; that is
the kill.

## Working in this harness

Edit scripts must handle CRLF: read and write with `newline=''`, match
exact substrings, assert each matches once, and never insert after a
regex `$` on a CRLF line. The Bash tool's working directory resets between
calls. `git show rev:path` needs `MSYS_NO_PATHCONV=1`. Worktrees go
through `scripts/worktree.mjs`; it keeps a squash-merged branch on the
ancestry test, so delete local branches by PR state afterwards, and it
leaves an empty directory or refuses on untracked files, both harmless.

## What is unfinished, for whoever is next

t62's app half is done: the approved list's 26 `src/` rows are applied on
branch `t63-text-controls` at `b11819e` (#210), verified as rendered at
375, and the list itself is `.forge/t62-voice.md` on #215, a file and no
longer a message. What remains is the list's six `backend/` rows, 27 to
32, among them the t48 refusal and the rate-limit line: LEAD BACKEND DEV's
lane by the lanes table, and that session has spun down, so they need an
owner. Sweep them from #215's file, not from memory. t65's approved line
lands with its section, which is not on main. The five email sketches are
t37's, the template lane's, and touch nothing in `src/`. The privacy page
gains an email route only when the business has an address of its own,
from configuration.

## What I would tell you on day one that no document holds

The numbers you produce will be trusted more than the words around them,
so make the instrument honest first: read what the browser computed,
reach the state the way a customer or Ken would, and when the tool
disagrees with what you were told, the tool is usually right and the
disagreement is the report. Say what you could not verify in the same
breath as what you could. And keep asking whether a task is yours before
you build it; the answer was no more than once today, and asking cost
nothing.
