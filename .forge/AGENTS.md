# Working here alongside other agents

Several agents work on this repository — Claude sessions, GitHub Copilot,
ChatGPT — and none of us can message each other. **The repository is the only
channel.** If it is not written down here or in `.forge/`, the next agent does
not know it.

That has already cost real work: one session's staged changes were swept into
another's commit, under a message describing something else entirely, on a
branch nobody had checked they were on. This file exists so that stops
happening.

---

## The protocol

**Before you start.** If you are the lead, read `HANDOFF.md` first; it is the
state at the last pause. Then read this file top to bottom, then `.forge/project.md`,
`.forge/requirements.md` and `.forge/state.json`. Run `git branch --show-current`
and `git status`. If someone else has uncommitted or staged work in the tree,
you are sharing a workspace — behave accordingly.

**When you claim work.** Add a row to the table in [`CLAIMS.md`](CLAIMS.md),
commit that change on its own, and push it before you start. A claim costs one
small commit and prevents two agents rewriting the same file in opposite
directions. Your branch name is the claim: make it describe the work.

**While you work.** Stay in your lane (below). If you must touch a file outside
it, say so in your claim row first.

**When a decision reaches you second-hand, the source wins and you ask.** A
routing, a ruling, a claim row that describes someone's decision — these are
relays, and relays gain and lose fidelity silently. The fix is not to read them
more carefully: a relay that is internally coherent and simply wrong survives
any careful read, because a closer look at a coherent-but-wrong statement only
confirms it. So when a relayed decision conflicts with your own reading of the
source — the PR diff, the file, the person's own words — trust the source and
ask, rather than act on the relay. This happened four times in one night: a
"can follow" tightened into "blocks merge" in transit; a claim row describing a
ruling with a specificity nobody gave it; a relayed confirmation passed on as
fact and then retracted; a held, contested PR routed as ready. Each was caught
by going back to the source, never by a more careful reading of the relay.

**Work that outran its record — the inverse of a stale record, and not caught the
same way.** A stale record has fallen behind the world; you catch it by
re-reading it against reality (the doc says three audits, you count five). Work
that outran its record is the opposite: the document is coherent, internally
consistent, and describes a world that *was* true — nothing in it is wrong, it
has simply been overtaken, and re-reading confirms it. Only measuring the code
catches it, and nothing prompts you to measure what you have no reason to doubt.
The tell, seen three times here: someone says "nobody owns X" and X is already
done — regression tests about to be rewritten that already existed, a copy defect
recorded open and fixed hours earlier, an audit path placed for conversion that
was already built. Each finder was doing something else; a document review would
have found none of them, because the documents were internally fine. One way it
bites in particular: **searching for the old thing and reading its presence as
the new thing's absence.** `audit-ui.mjs` still held `KMT_OWNER_PASSWORD`, so the
conversion looked undone — but that is the fallback, and the minted-session path
sits above it. A grep for what you expect to be gone answers a different question
than the one you asked; the question is *what does this code do now*, and only
reading it answers that. So: before assigning work a document says is open, read
the code, not the document — and when a document says a thing is missing, the
cheapest check is whether it is there.

**A claim row names a region, not a lock on the whole path.** Two agents may
hold the same file at once when their work sits in different parts of it --
BUG FIXER held `backend/quotes.mjs`'s `cleanDate()` near the top while JUNIOR
BACKEND DEV held the quote-adjustment functions forty-plus lines away, and
both merged clean. Name the region when you claim a file someone else's row
already covers -- `backend/api.mjs (PUBLIC_POST_PATHS and isKnownApiPath
only; t35 holds the owner dispatch block)`, not just the bare filename --
so the next reader can tell at a glance whether two rows actually collide.

**Check before you block.** A `git diff` against the other branch answers in
seconds whether the regions in fact overlap; read as a lock instead of a
statement of intent, this table has already idled a remote agent with no way
to ask on a collision that did not exist. But checking the diff is advice
for whoever arrives second, not permission to ignore a row: if the regions
genuinely overlap, the row wins and you wait, and if the two sides disagree
about anything once you've looked, that disagreement is a finding to report,
not something to resolve quietly.

**A row guards edits, not designs.** It tells you whether two changes will
clobber each other's lines. It cannot tell you whether two changes that merge
cleanly are compatible. t35 and the cancel work sat forty lines apart in one
component, merged without a marker, and rendered two textareas at once — a live
price editor beneath a cancel confirmation. A clean region check means no lost
edit, not a coherent screen. Two people building in one file still owe each
other a look at what the other is building, which no claim row can do for them:
the row is a collision guard, not a design review.

**When you finish — and finished means merged, not opened.** A claim row is
released when the PR lands on `main`, not when you push it and open the PR: an
open PR is still a claim on the file, and it can sit an hour or more waiting on a
second reader — for that whole window a released row would tell the busiest
coordination file that nobody is touching a file you are, and the reader who
needs it is the one who has *not* read your PR. **The agent who merges removes
the row, in the same pass** — they are the party who always observes the merge,
they are already committing to `main` at that moment, and the author is elsewhere
on someone else's clock with no reason to look. "Released when it merges" but
owned by the author has no agent and produces the opposite staleness — rows that
outlive their merged PR (four accumulated in one night behind an earlier sweep).
An author who happens to see their PR land may remove their own row, but the
merger owns it; match it by branch name, the row's first column. Then, if you
learned something the next agent would otherwise rediscover the hard way, append
it to [`.forge/NOTES.md`](NOTES.md). Update `.forge/state.json` if you closed a
task, and record architecture decisions in `.forge/decisions.md`.

**Claim and release commits go straight to `main`, never through a pull request.**
`CLAIMS.md` changes several times an hour across every agent working here, so a
PR against it re-enters a losing race on every push in its review window — a
correct rebase collides again within minutes, repeatedly, because the file it
touches is the busiest one in the repo. `.forge/` is in neither `build_paths`
nor `ship_paths` in `fly-deploy.yml`, so a claim commit runs the gate and ships
nothing regardless of how it lands. One small commit, straight to `main`, is
the whole mechanism — the same discipline as any other commit here (explicit
paths, no `-A`, check the branch first), just without a PR wrapped around it.

**Make that commit from a disposable worktree off `origin/main`, not the shared
checkout.** `CLAIMS.md` is the busiest file here, and the shared checkout cannot
safely hold its edits at this concurrency — in either direction, both seen in
one night:

- A `git reset` (even `--soft`), rebase, or amend run in the shared checkout by
  any session unmakes another session's *committed but unpushed* claim. The
  reflog is the recovery, and it worked the once — but the loss leaves nothing
  in `CLAIMS.md` itself, so it is found only when someone asks where their row
  went.
- Worse: every session stages the same one path, so `git add .forge/CLAIMS.md`
  — the explicit-path staging the rules above *require* — sweeps up another
  session's *uncommitted* edit to that file from the shared working tree. Ride
  it along and it is at least committed (caught once tonight, by attention not
  process); a `git checkout -- .forge/CLAIMS.md` or `reset --hard` instead
  discards it with no commit and no reflog entry, nothing anywhere to recover.
  "Stage explicit paths, never `-A`" protects *across* files and has no force
  *inside* the one file every session writes.

**If you find another session's uncommitted edit to `CLAIMS.md` in the shared
checkout, commit it with attribution — never `checkout --` or `reset --hard` it
away.** That is the live case until everyone works from a worktree: a row is
already sitting in the shared tree, put there by someone. Riding it along under a
one-line note in your commit message costs nothing; discarding it destroys a
claim with no artifact anywhere, and its author finds out when they ask where it
went.

A fresh worktree's `CLAIMS.md` holds your row and nothing else: no other
session's edit to sweep up, discard, or reset over. That makes the collision
structurally impossible rather than a matter of who notices. The recipe, every
line earning its place because an earlier form of this rule failed at each:

```bash
git worktree add .worktrees/claim-tmp origin/main   # plain add, NOT scripts/worktree.mjs
#   edit .forge/CLAIMS.md in that tree
git -C .worktrees/claim-tmp add .forge/CLAIMS.md
git -C .worktrees/claim-tmp commit -m "Claim <branch> (.forge/CLAIMS.md)"
git -C .worktrees/claim-tmp fetch origin
git -C .worktrees/claim-tmp rebase origin/main      # origin moves; re-sync first
git -C .worktrees/claim-tmp push origin HEAD:main    # explicit refspec: HEAD is detached
git worktree remove .worktrees/claim-tmp
```

- **Plain `git worktree add`, never `scripts/worktree.mjs`.** The script links
  the shared `node_modules` junction; a claims tree needs no dependencies and a
  plain tree has none — which is what makes `remove` safe without `--force`
  (`--force` through that junction is what once deleted into the shared install).
- **`origin/main` gives a detached `HEAD`, so a bare `git push` fails** ("not
  currently on a branch"). Push the explicit refspec `HEAD:main`.
- **Expect a `! [rejected]` when the board is busy — that is the rule working,
  not failing.** `origin/main` can move in the seconds between commit and push,
  so the race now surfaces as a loud push rejection instead of a silent sweep.
  On rejection, `fetch`, `rebase origin/main`, and push again — **re-read the
  table and re-apply your row to the new tip; do not replay your edit** (the same
  stale-branch trap the rebase note records). Read a rejection as "someone
  claimed in parallel," never as "I did this wrong" — the second reading is what
  sends people back to the shared checkout this rule exists to empty.
- **On Windows, `git worktree remove` can fail `Permission denied` if that
  directory was recently your shell's cwd;** `rm -rf` it then `git worktree
  prune` — safe only because a plain tree has no junction to follow.

Use `.worktrees/` (`.gitignore` covers it), never a sibling that never gets
cleaned up. The same holds for any direct-to-`main` commit: the shared `HEAD`
and working tree are shared state, not yours alone to rewrite. A recipe that
does not run is worse than none — it fails at the moment of use and the fallback
is the unsafe path; this one is verified, not assumed.

**A subagent has no row of its own.** Work you spawn as a subagent — not a new
session — has no session id, cannot be messaged, and cannot hold a `CLAIMS.md`
row in its own name. So the session that spawns it owns the subagent's claim
and owns its report: keep the row under your name for as long as the subagent
runs, and speak for its result when it finishes. A subagent holding its own row
would be the GitHub-only agents' problem again — work in flight that nothing in
this repo can address, on a claim nobody can release — with none of the
compensating protocol. The user's instruction to prefer subagents over new
sessions is why this needs saying: the cheaper the spawn, the easier the
orphaned claim.

---

## Active claims

The table is in [`CLAIMS.md`](CLAIMS.md), next to this file. Add your row
there before you start and remove it when you are done; this file is not
touched by a claim. Stale rows are worse than no rows.

---

## Lanes

Not ownership for its own sake — it is how two agents avoid editing the same
file from opposite ends.

| area | typically |
| --- | --- |
| `src/App.jsx`, `src/App.css`, `src/RequestFlow.css`, `src/components/` | UI work |
| `src/data/catalog.js`, `src/pricing.js` | catalog and quoting rules |
| `scripts/`, `src/data/scraped-tires.json` | supplier / scraper work |
| `.forge/*.md`, `.forge/state.json` | planning, requirements, task status |
| `.forge/*-audit.mjs`, `.forge/*-check.mjs` | verification tooling |
| `backend/`, `src/owner/` | owner workspace and its API |
| `src/markup.js` | supplier price -> customer price |
| `Dockerfile`, `fly.toml`, `.github/workflows/` | deployment |
| `index.html`'s marketing head (title, description, JSON-LD content, `og:*`/`twitter:*`), `public/brand/`, `docs/brand.md`, landing copy | growth and marketing (`roles/growth-marketing.md`) |
| `index.html`'s `<link rel="canonical">`, `public/robots.txt`, `public/sitemap.xml` | SEO — crawler plumbing, no copy; see the ruling below |

`package.json` and `README.md` are shared. Touch them in a commit of their own so
a conflict is trivial to resolve.

Two rows above overlap on purpose and the split is by *kind of change*, not by
file. In `src/routes/CustomerRequest.jsx` the landing **copy** is growth's and
the **markup and CSS** are UI's: changing a string is one lane, anything
needing structure is a claim row that says so and a pairing.

**`index.html`'s head splits three ways, ruled by the PROJECT MANAGER on
2026-09-06.** The split is by *whose question a tag answers*, not by position
in the file: growth owns `<title>`, the meta description, `og:*`/`twitter:*`
and the structured data's **content**; UI keeps `viewport`, `theme-color` and
the icon and manifest links — the app shell; SEO owns `<link rel="canonical">`
— crawler plumbing, no copy. Three lanes now hold regions of one file, the
same region-not-lock principle as a claim row applied to a whole document:
say which region you are touching, in your claim row, every time.

**`public/robots.txt` and `public/sitemap.xml` are SEO's outright** — not
shared, not growth's: machine directives about what to fetch, not statements
about the business. The general rule the ruling drew: **growth owns what the
page says; SEO owns what the site is to a crawler, and whether it behaves
that way live.** Verification of the live surface is SEO's even where the
file being verified is marketing's — a problem SEO finds in growth's content
routes to the PROJECT MANAGER with the measurement, not a quiet fix from
either side.

---

## Git, with more than one agent in the tree

- **Never `git add -A` or `git add .`.** Stage explicit paths. Another agent's
  work may already be staged and you will commit it under your message.
- **Never commit a file you did not change**, even when it is staged.
- **Check the branch before committing.** Do not assume `main`.
- **Need another branch while someone is editing? Use `git worktree add`,** not
  `git switch`. Switching moves the checkout under whoever is writing.
- **`node scripts/worktree.mjs add <name>` and `remove <name>`** do that with
  the shared `node_modules` link handled in the safe order. Never
  `git worktree remove --force` a tree whose `node_modules` is a link: it
  deletes through the link into the install every worktree shares.
- **Push promptly.** The divergence window is where this goes wrong.
- **An author does not merge their own pull request.** A second agent reads the
  diff and the audit counts in the check log, and merges. That has been the
  working rule all day; a green badge is not a review.

---

## Verification is the contract

Nothing is done until these pass. Run them; do not assume them.

```bash
npm run build
npx eslint src backend
node --test backend/*.test.mjs         # every backend suite
node .forge/dead-end-audit.mjs         # the full click path, both viewports
node .forge/request-flow-check.mjs     # the request flow, both widths
node .forge/responsive-check.mjs       # overflow on every screen at 375px and 1280px
node .forge/deployed-site-check.mjs    # read-only, against a deployed URL
node .forge/owner-inventory-audit.mjs  # needs the owner server running
```

Each of the five audit scripts carries its own `EXPECTED_CHECKS` at the top,
prints it on its last line, and fails the run when a different number of
checks executed. The numbers live there and nowhere in prose: fewer checks than
expected means something stopped running, more means the baseline was not
updated, and either fails on the spot instead of being noticed in a document
later. When you add or remove a check, change the constant in the same commit.

Start the app with `node backend/dev.mjs` (http://127.0.0.1:4180), not
`npm run preview` -- preview serves the built frontend only, so `/owner` shows
"backend is not connected" and any check touching it is meaningless.

**The audits read `AUDIT_BASE`, and each defaults to a different port** --
4179 for the dead-end audit, 4173 for the responsive check, 4183 for the
request-flow check, and the owner-inventory audit is fixed at 4180. Pass
anything else -- `BASE`, `B` -- or nothing, and they silently audit whatever is
on that port instead of erroring. That produces false failures *and* false
passes; see `NOTES.md`. Always set `AUDIT_BASE`.

GitHub Actions runs the backend tests, lint, build **and the three browser
audits** on every push to `main` and on every pull request -- the audits against
`backend/server.mjs` serving the built `dist/`, with a temporary database and a
throwaway `KMT_OWNER_PASSWORD`, not against a `vite preview`. It then deploys
`main` to https://kmt.fly.dev and runs the read-only deployed-site check against
the live site. Nothing deploys from any other branch.

Two runs, two different questions. Confusing them is how a green tick starts
meaning less than it looks like.

| run | where | proves |
| --- | --- | --- |
| the gate, on every pull request | `backend/server.mjs` with the built `dist/`, a temporary database and a throwaway password | **the flow**: a customer submits, the owner approves, the customer pays, and every click path leads somewhere |
| the deployed-site check, after a merge deploys | `https://kmt.fly.dev`, read-only | **the deploy**: the site is up, the catalog is the shape the customer flow expects and leaks no supplier fields, the routes resolve through the SPA fallback, the owner API still refuses without a session, nothing scrolls sideways |

The second run is not redundant: only it exercises the SPA fallback on the real
host, which is server configuration the first run cannot test. What the first
run buys is that a change breaking a click path fails **before** it merges,
instead of passing its PR and only failing once main is already deployed.

The flow audits perform the journey -- they submit, approve and pay. That is
right against a database built for the run and thrown away after it. It is
wrong against production, where it would leave a fabricated request in the
owner's list on every deploy, marked paid. So the deployed-site check reads and
never writes, signs into nothing, and needs no production password in CI.

**Nothing enforces any of this. The gate is convention.** Branch protection is
unavailable on this repository -- it is private on a free plan, and the API
answers `403: Upgrade to GitHub Pro`. Early pull requests here were self-merged
with no review; since then a second agent reads the diff and the check log
and merges, which is a convention held by the people following it and not a
rule GitHub enforces. GitHub will let you merge a red check, a failing
audit, or a PR whose checks never ran, and nobody will stop you.

So the green check is the whole gate, and the person merging is the rest of it.
Read the diff, not the badge: confirm the audit counts in the log rather than
trusting the tick, and merge nothing red. A check that was skipped is not a
check that passed.

**Run the deployed-site check against the live URL before calling a deploy
good.** Not the flow audits: they submit, approve and pay, and against
production that writes a fabricated request into the owner's list.
This build has passed every local check and 404'd in production: a missing SPA
rewrite meant `/owner` and `/status` returned 404 on hard navigation while
click-through worked fine.

**A script that cannot drive the UI is not a passing audit.** The dead-end audit
silently stopped running when the customer flow became a wizard — it failed on
its first action, and `state.json` still claimed fifteen passing checks. If a
script errors before reaching its assertions, say so loudly.

---

## Standards

- **Measure claims before making them.** "Most sizes will now find stock" was
  actually 3%: the selector allowed 891 combinations against a catalog covering
  30. One line of arithmetic would have caught it. If you are about to write
  *most*, *few*, *all* or *none*, compute it.
- **Do not describe code you have not read.** Ask for the file.
- **Report what actually happened**, including what did not work. An honest
  failure is worth more than an unverified success.
- **Product decisions belong to the owner** — what to build, what to cut, what
  the exception rules are, and whether pricing stays manual or moves to a
  supplier feed. Engineering decisions are yours: make them, then say why.

---

## Settled — do not relitigate without asking

- **There is a backend now** (this bullet used to say there wasn't). `backend/`
  is a node:sqlite service behind `/owner`, deployed at https://kmt.fly.dev and
  run locally with `node backend/dev.mjs`. Quote state is still `localStorage`
  and payment still always succeeds -- those remain demo choices.
- The catalog is no longer purely generated. Real scraped tires from
  giga-tires.com cover four sizes; generated rows cover the rest. Customer price
  = the owner's price if he set one, else the markup rule. See `src/markup.js`.
- **The markup rate is a placeholder, not Ken's number.** `isPlaceholder` says
  so in the data. Do not present those prices as real, and do not invent a rate.
- Brand red is for the single primary action on a screen and for key figures.
  Approve/Reject stay green/red: a paired opposed decision needs colour to carry
  meaning. Green and amber are legitimate semantic accents — the production site
  already uses green for "In Stock".
- Mobile-first. The real user is on a roadside with a flat.
- No new dependencies without a justification that beats keeping the surface small.

---

## Notes to each other

They live in [`NOTES.md`](NOTES.md), next to this file. Read them before you
start: several describe failures that look exactly like regressions and are
not. If you learned something the next agent would otherwise rediscover the
hard way, append it there, newest last, dated, saying who you are. This file
keeps the protocol; that one keeps the experience.
