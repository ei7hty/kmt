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
[Notes to each other](#notes-to-each-other). Update `.forge/state.json` if you
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
passes; see the notes below. Always set `AUDIT_BASE`.

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

## Notes to each other

Append, newest last. Date each entry and say who you are.

**2026-09-05 — Claude (forge/CLI session)**
CSS specificity is the trap in this codebase. Phase 1 bolted dark theming onto
Tailwind-default screens with broad element selectors — `.min-h-screen button`,
`.customer-shell input` — at specificity `(0,1,1)` with `!important`. They
outranked the component classes meant to sit inside them, which produced three
separate bugs: tire cards and size chips rendering as solid red CTAs with
selection inverted, and a search field with `#222` text on `#090909` that was
invisible to anyone who typed in it. Fixed at the root in `7890ae5` with one
border-box reset and `:where()` around the catch-alls, dropping them to
`(0,0,1)`. **Do not reintroduce broad `!important` element rules — scope to a
class.**

**2026-09-05 — Claude (forge/CLI session)**
`src/App.jsx` is a single ~23KB file holding all four routes. It is the main
reason agents exhaust their context trying to edit it — two runs burned their
entire budget reading before writing a line. Splitting it by route is contained,
unclaimed, and pays for itself the moment phase 3 starts.

**2026-09-05 — Claude (forge/CLI session)**
Playwright: a locator matching two elements is a strict-mode violation that
throws, and a `.catch(() => false)` turns that into a silent "not visible". An
audit check failed this way while the app was fine. Scope your selectors.

**2026-09-05 — Claude (forge/CLI session)**
`wire-scraped-catalog` was rebased onto `main` (`9ae376c`) on your behalf: it was
eight commits behind and did not have the CSS specificity fix. Your three commits
survived and were replayed cleanly — no conflicts — and lint, build, the
responsive check, the dead-end audit and the request-flow check all pass on the
rebased branch. Your commits have new SHAs. The pre-rebase tip is kept at
`backup/wire-scraped-catalog-prerebase` (`14e1f22`) if you want to compare or
recover. The branch is not pushed: publishing unfinished work is your call.

**2026-09-05 — Claude (kmt CLI session)**
`.forge/dead-end-audit.mjs` reads **`AUDIT_BASE`**, not `BASE` or `B`, and falls
back to port **4179**. Pass the wrong variable and it silently audits whatever
else is listening on 4179 instead of erroring. Mine hit a stale `vite preview`
from an earlier worktree and failed at the Quote requests step — which reads
exactly like a regression in the owner routing and was not one. It also means a
*passing* run can be testing a stale build, which is the worse direction: I
reported a green audit for a commit it never touched. Check what is on 4179
before believing either result. `request-flow-check.mjs` and
`responsive-check.mjs` read the same variable.

**2026-09-05 — Claude (kmt CLI session)**
Supplier prices and KMT prices are now two different things, and the boundary is
`src/markup.js`. `quotedPrice()` resolves them: an owner price from the backend's
`offers.price_cents` wins outright, otherwise the markup rule proposes one, and a
tire the owner disabled leaves the customer catalog. The owner sets the rule on
`/owner`; the default rate lives in `DEFAULT_MARKUP_SETTINGS` and the backend
imports it rather than restating it, so the two cannot drift. The rate shipped is
still a placeholder — `isPlaceholder` says so, and it is not Ken's number. If you
add real pricing rules, they go inside `retailPrice` and nowhere else.

**2026-09-05 — Claude (kmt CLI session)**
`buildCatalog()` skips generated rows only for sizes that end up with *real*
rows, not for every size in `scraped-tires.json`. Those differ once the owner
deselects tires: a size he empties gets its generated coverage back instead of
becoming a dead end. If you change that filter, re-run the dead-end audit — this
is exactly the invariant it protects.

**2026-09-05 — Claude (kmt CLI session)**
Deployment now exists and is at https://kmt.fly.dev -- one Fly machine in `ewr`,
always on, SQLite on a volume at `/data`. Vercel is retired to a 307 redirect;
the old `temporary-flying-slate-pie8smm.vercel.app` link still works and forwards.
Five things bit during that cutover, none of which show up locally:

`fly launch` reads the *working directory*, not the repository. Run in a checkout
without `Dockerfile`/`fly.toml` on disk and it scaffolds its own -- here a
`FROM pierrezemb/gostatic` static file server with `min_machines_running = 0`.
That deploys cleanly and serves no backend at all, which is the worst kind of
wrong. Deploy from a checkout that is actually on `main`.

`ENV NODE_ENV=production` before `npm ci` means `--omit=dev`, and Vite is a
devDependency, so the image build dies with `vite: not found`. Playwright is
also a devDependency needed at *runtime* by refreshes, so never prune dev deps
in the image.

`xvfb-run` needs the `xauth` package, which `xvfb` does not pull in. Without it
it exits 3 before Node starts, Fly restarts ten times and gives up, and there is
no application log to explain it.

`fly secrets set --stage` stages without applying. The machine keeps booting
with the old value and the failure looks like the new secret was wrong. Drop
`--stage` unless you are deliberately batching before a deploy.

`fly machine stop` does not retire an app when `auto_start_machines = true` --
the next HTTP request wakes it and it answers 200. `fly scale count 0` removes
the machine and keeps the volume.

Fly app names are immutable and map to `<name>.fly.dev`, so renaming means a new
app, a new volume and re-setting every secret. Pick the public-facing name
first. Fly deploy tokens are app-scoped by default; a token made for one app
will not deploy another, and CI fails on permissions.

**2026-09-05 — Claude (docs session)**
`README.md` now describes the project as it stands (screens, pricing, the
owner backend, verification, deployment) instead of the Vite template. A root
`AGENTS.md` and `CLAUDE.md` point here, so a tool that reads those on start-up
finds this protocol without being told. Keep the README's layout table and
verification commands current when you add a directory or a check.

Also: the local `main` in the shared checkout had diverged from `origin/main`
when I looked. Both had merged `owner-inventory-backend`, through different
merge commits; only the local one carried `.forge/reset-runbook.md`, and only
`origin/main` carried the Fly deployment, `backend/server.mjs` and
`backend/auth.mjs`. `origin/main` is what CI deploys, so treat it as the truth
and reconcile the local branch before branching from it. This branch was cut
from `origin/main`.

**2026-09-05 — Claude (kmt CLI session)**
Preview servers you start locally outlive you, and a stale one turns an audit
into a lie. Two sessions lost time to this on the same afternoon, in opposite
directions.

`( npx vite preview & )` detaches the server from the shell. When the shell
exits the process keeps running, keeps its port, and nothing that tracks child
processes can reach it any more.

**Backgrounding `npx` is not enough either, and an earlier version of this note
got that wrong.** `npx` spawns the real server as a *grandchild*, so `$!` is the
wrapper: kill it and the server keeps the port. Measured, not assumed --
`npx vite preview --port 4187 &`, then `kill $!`, and the port still answered
200. That is how 4187 and 4197 leaked.

Start the server directly, so `$!` is the thing holding the port:

```bash
node node_modules/vite/bin/vite.js preview --port 4173 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
```

Same test against that form: after `kill $!` the port was dead. Or skip the
bookkeeping and kill by port when you are done, which is the only reliable move
once something has already detached:

```powershell
Get-NetTCPConnection -LocalPort 4173 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

CI is unaffected either way -- the runner is destroyed at the end of the job, so
nothing there survives to hold a port. Do not read the workflow as the model for
local runs.

The damage is not the process, it is the port. The three audits default to
4179, 4183 and 4173 (see the verification contract above), so a forgotten server
on one of those gets audited instead of the build you meant to test. It failed
in both directions here: a stale 4179 serving an older build produced a
confident 36/36 for a commit it had never seen, and later a *false failure* that
read exactly like a regression in the owner routing. Another session found
seventeen strays and a run where the UI had changed and none of the checks ran.

Before believing an audit result, check what is actually listening:

```powershell
Get-NetTCPConnection -LocalPort 4173,4179,4183 -State Listen |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
```

Kill only your own: other agents run servers from their worktrees, and the
command line tells you whose it is.

**2026-09-05 — Claude (kmt CLI session)**
A scrape run on your own machine can now reach a server that is already up:
`npm run import-tires` posts `src/data/scraped-tires.json` (or any snapshot
path) to `POST /api/owner/import-snapshot`, locally by default or at
`--to https://kmt.fly.dev` with `KMT_OWNER_PASSWORD` set. Before this the
snapshot only seeded an empty database, and `importSnapshot` still does only
that; the new `Inventory.applySnapshot` is the one that writes into a live one.
Two things worth knowing. The default import is *partial*: the scraper keeps
the cheapest eight per size, so an import retires nothing unless you pass
`--complete`, and you should only pass it for a `--limit 0` scrape that read
every page -- otherwise you mark tires the owner may be offering as no longer
listed. And `--dry-run` asks the server, so it reports against what that
server holds, not against the tracked file. The CLI test in
`backend/owner.test.mjs` spawns the real script against a password-gated
server, so it takes most of a second; that is the point of it.

**2026-09-05 — Claude (kmt CLI session)**
**Do not run two `backend/dev.mjs` at once when you audit.** I had one on 4191
for a manual check and started another on 4180 for the owner-inventory audit,
and the audit failed with six `WebSocket closed without opened.` page errors
after every functional check had passed. That is not the app: `dev.mjs` runs
Vite in middleware mode with no `hmr` setting, so every instance's HMR client
points at the same default socket port, 24678, and the second server's pages
reach the first server's socket. Killed the extra server, ran the same audit
against the same branch alone: zero errors, everything PASS. Measured, not
inferred -- I first assumed it was pre-existing and it was not; unmodified
`main` passed too. If that assertion fails on you, check for a second dev
server before you check your diff.

**2026-09-05 — Claude (forge/CLI session)**
The three browser audits no longer touch `localStorage`. They perform every
state through the interface -- submit the form, approve on the owner screen, pay
on the status page -- and read what reached the owner off the owner's screen.
Seeding a store proved a row existed; it never proved a customer could get a
quote, and it stopped working the moment requests moved to the backend.

They now run against `backend/server.mjs` with the built `dist/`, not a
`vite preview`, in CI and locally: build, then start the server with `PORT`,
`KMT_BIND=127.0.0.1`, a throwaway `KMT_OWNER_DB` and `KMT_OWNER_PASSWORD`, and
pass `AUDIT_BASE` plus that password to each script. A hosted server asks for a
password and they sign in; a local one never asks.

Counts to hold: **36** dead-end, **30** request-flow, **8** responsive. Request
flow went 26 to 30 because two checks that read the browser store became four
that read the owner's screen. A count that drops is a check that stopped running.

Proven rather than asserted: hiding the Pay action on an approved quote -- one
line -- fails the dead-end audit ("no visible Pay action for the approved
quote") and makes two responsive screens UNREACHABLE. The break was reverted in
the same PR.

**2026-09-05 — Claude (kmt CLI session)**
The size selector now spans the supplier's metric passenger / light-truck
range: 23 widths (135–355), 13 ratios (25–85) and 13 rim diameters (12–24),
read off giga-tires.com's size menu; `src/data/fitment.js` says what was left
out and why. `isPlausibleFitment` in `src/data/catalog.js` is now a per-rim
band table plus an overall-diameter check (500–900 mm). Measured by counting
`TIRE_CATALOG`: 910 sizes and 3,846 rows, up from 290 and 1,213. Three
comments still say "290" -- `backend/inventory.mjs` (markup JSDoc),
`src/owner/OwnerInventory.jsx` (MarkupRule JSDoc) and `.forge/dead-end-audit.mjs`
("all 290 paths") -- left alone because they are other lanes, and two of the
files were in open PRs (#31, and #34 since merged); correct the number when you
next touch them.
Owner-facing consequence: "Refresh all N sizes" on `/owner` is now 910 browser
scrapes rather than 290, so roughly three times as long.
