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

**When you finish.** Remove your row from `CLAIMS.md`. If you learned something
the next agent would otherwise rediscover the hard way, append it to
[`.forge/NOTES.md`](NOTES.md). Update `.forge/state.json` if you closed a task,
and record architecture decisions in `.forge/decisions.md`.

**Claim and release commits go straight to `main`, never through a pull request.**
`CLAIMS.md` changes several times an hour across every agent working here, so a
PR against it re-enters a losing race on every push in its review window — a
correct rebase collides again within minutes, repeatedly, because the file it
touches is the busiest one in the repo. `.forge/` is in neither `build_paths`
nor `ship_paths` in `fly-deploy.yml`, so a claim commit runs the gate and ships
nothing regardless of how it lands. One small commit, straight to `main`, is
the whole mechanism — the same discipline as any other commit here (explicit
paths, no `-A`, check the branch first), just without a PR wrapped around it.

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
