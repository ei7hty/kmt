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

**Before you start.** Read this file top to bottom, then `.forge/project.md`,
`.forge/requirements.md` and `.forge/state.json`. Run `git branch --show-current`
and `git status`. If someone else has uncommitted or staged work in the tree,
you are sharing a workspace — behave accordingly.

**When you claim work.** Add a row to [Active claims](#active-claims), commit
that change on its own, and push it before you start. A claim costs one small
commit and prevents two agents rewriting the same file in opposite directions.
Your branch name is the claim: make it describe the work.

**While you work.** Stay in your lane (below). If you must touch a file outside
it, say so in your claim row first.

**When you finish.** Remove your claim row. If you learned something the next
agent would otherwise rediscover the hard way, append it to
[`.forge/NOTES.md`](NOTES.md). Update `.forge/state.json` if you
closed a task, and record architecture decisions in `.forge/decisions.md`.

---

## Active claims

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| _none_ | | | |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.

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

`package.json` and `README.md` are shared. Touch them in a commit of their own so
a conflict is trivial to resolve.

---

## Git, with more than one agent in the tree

- **Never `git add -A` or `git add .`.** Stage explicit paths. Another agent's
  work may already be staged and you will commit it under your message.
- **Never commit a file you did not change**, even when it is staged.
- **Check the branch before committing.** Do not assume `main`.
- **Need another branch while someone is editing? Use `git worktree add`,** not
  `git switch`. Switching moves the checkout under whoever is writing.
- **Push promptly.** The divergence window is where this goes wrong.

---

## Verification is the contract

Nothing is done until these pass. Run them; do not assume them.

```bash
npm run build
npx eslint src backend
node --test backend/*.test.mjs       # 52 tests: owner (34) and quotes (18)
node .forge/responsive-check.mjs     # 8 checks, overflow at 375px and 1280px
node .forge/dead-end-audit.mjs       # 36 checks across the full click path
node .forge/request-flow-check.mjs   # 26 checks across the request flow
node .forge/owner-inventory-audit.mjs  # needs the owner server running
```

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
a `vite preview` of the build. It then deploys `main` to https://kmt.fly.dev and
runs the audits a second time against the live site. Nothing deploys from any
other branch.

The second run is not redundant: only it exercises the SPA fallback on the real
host, which is server configuration a preview cannot test. What the first run
buys is that a change breaking a click path fails **before** it merges, instead
of passing its PR and only failing once main is already deployed.

**Nothing enforces any of this. The gate is convention.** Branch protection is
unavailable on this repository -- it is private on a free plan, and the API
answers `403: Upgrade to GitHub Pro`. Every pull request here has been
self-merged with no review. GitHub will let you merge a red check, a failing
audit, or a PR whose checks never ran, and nobody will stop you.

So the green check is the whole gate, and the person merging is the rest of it.
Read the diff, not the badge: confirm the audit counts in the log rather than
trusting the tick, and merge nothing red. A check that was skipped is not a
check that passed.

**Run the dead-end audit against the live URL before calling a deploy good.**
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

## What each check run proves

Two runs, two different questions. Confusing them is how a green tick starts
meaning less than it looks like.

| run | where | proves |
| --- | --- | --- |
| the gate, on every pull request | `backend/server.mjs` with the built `dist/`, a temporary database and a throwaway password | **the flow**: a customer submits, the owner approves, the customer pays, and every click path leads somewhere |
| the deployed-site check, after a merge deploys | `https://kmt.fly.dev`, read-only | **the deploy**: the site is up, the catalog is the shape the customer flow expects and leaks no supplier fields, the routes resolve through the SPA fallback, the owner API still refuses without a session, nothing scrolls sideways |

The flow audits perform the journey -- they submit, approve and pay. That is
right against a database built for the run and thrown away after it. It is
wrong against production, where it would leave a fabricated request in the
owner's list on every deploy, marked paid. So the deployed-site check reads and
never writes, signs into nothing, and needs no production password in CI.

Counts: **36** dead-end, **30** request-flow, **8** responsive, **19**
deployed-site. A count that drops is a check that stopped running.

## Notes to each other

They live in [`NOTES.md`](NOTES.md), next to this file. Read them before you
start: several describe failures that look exactly like regressions and are
not. If you learned something the next agent would otherwise rediscover the
hard way, append it there, newest last, dated, saying who you are. This file
keeps the protocol; that one keeps the experience.
