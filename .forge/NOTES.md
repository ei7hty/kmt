# Notes to each other

What the agents sharing this repository learned the hard way, so the next one
does not. The protocol -- claims, lanes, git rules, the verification contract
-- is in [`AGENTS.md`](AGENTS.md); this file is only the notes, moved out of
it because three agents editing one file for three reasons conflicted on four
pull requests in a day.

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

**2026-09-06 — Claude (kmt repo agent)**
`gh run watch --exit-status` returns non-zero for a *cancelled* run, not only a
failed one. The `fly-deploy` concurrency group cancels a queued run whenever a
newer push lands in the same group, so a merge quickly followed by another
routinely leaves a cancelled run behind.

I read `exit=1` from a superseded run and announced that main was red. It was
not: the job list was empty and `.conclusion` was `cancelled`. Read `.conclusion` before calling a run
failed:

```bash
gh run view <id> --json status,conclusion --jq '"\(.status)/\(.conclusion)"'
```

**Amended later the same day, once the cause was found rather than the
symptom.** The group was `fly-deploy` with no ref key, so *every* run in the
repository shared one queue: any branch push superseded a queued run on main and
vice versa. Six runs died that way in one afternoon, and one of them is the run
described above. Fixed in #44 as `fly-deploy-${{ github.ref }}`. Everything here
still holds -- a cancelled run is not a failed one -- but if runs are vanishing
in numbers, read the concurrency block before you read the runs.

An empty `.jobs[]` is the tell -- a run that was cancelled before its jobs
started has no jobs to have failed.

Two related traps from the same afternoon: greping a CI log for step output
breaks silently when the step is renamed (#34 renamed "Audit the built
frontend" to "...against the real server", and a count grep against a branch
that predated the rename returned zero -- merged on that zero, which was wrong
even though the check was genuinely green); and the audit counts moved from
36/26/8 to 36/30/8 in that same PR, so a hardcoded expectation of 26 is stale.

**2026-09-06 — Claude (kmt CLI session)**
**`git worktree remove --force` follows a `node_modules` junction and deletes
packages out of the main checkout.** Worktrees here get their dependencies as a
junction (`mklink /J .worktrees/<name>/node_modules node_modules`) to the main
checkout's install, which every other worktree shares. `--force` walks into
that junction as if it were a directory: mine deleted 84 of 193 packages,
`.bin` among them, before failing with "Invalid argument", and every agent on
this machine had a broken install until it was restored. The safe order is to
remove the junction first -- `cmd /c rmdir <worktree>\node_modules` (rmdir on
a junction unlinks it and touches nothing behind it), or `Remove-Item` on the
junction path with no `-Recurse` -- and only then `git worktree remove`,
without `--force`. If git still refuses, delete the directory by hand after
the junction is gone and run `git worktree prune`.
Restoring: `npm ci` cannot run while any Vite dev server on this machine holds
a native binding open (`EPERM: unlink ...@rolldown...node`) -- and someone
usually does. `npm install` against the untouched lockfile is the fallback; it
fills the gaps without wiping first. It rewrites `package-lock.json` in
passing, so `git checkout -- package-lock.json` afterwards. The 46 packages
still "missing" after that are all platform optionals that never install on
Windows.

**2026-09-06 — Claude (kmt CLI session, SWE agent 3)**
"Refresh all" on `/owner` no longer means every supported size. With 910
sizes in the catalog that was 910 supplier page loads at a 1.5-second pause
from the hosted machine. The inventory summary now carries `refreshableSizes`
-- supported sizes with supplier rows or a coverage row, i.e. sizes the
supplier has already been asked about -- and `Refresher.start` refuses a list
of more than one size that reaches outside it (400, naming the size). One size
on its own may still be anything supported: that is the owner picking it from
the size filter. The full walk is `npm run scrape-tires -- --from-catalog` from
a home connection, then `npm run import-tires`. If you write a test that starts
a two-size refresh, give the second size a coverage row first
(`db.recordFailure(size, ...)` is enough), and give each size its own supplier
id -- ids are unique across sizes, so one fixture row reused for two sizes
fails the second refresh with a constraint error that reads like a parser bug.
Backend tests are now 55 (owner 37, quotes 18).

**2026-09-06 — Claude (kmt CLI session, SWE agent 3)**
Two Windows traps that each cost a round of false results this weekend.

Most source files here are CRLF on disk. An edit script that matches text
containing `\n` finds nothing, and if it asserts on the match count it aborts
on the first file -- mine did, edited nothing, and left three red tests for
code that did not exist. Detect the file's newline first and normalise the
search and replacement strings to it (`'\r\n' if '\r\n' in text else '\n'`),
or open the file with universal newlines and write it back the same way.

`kill $!` on a node server started directly (not via npx) does NOT free the
port here, even though the Linux-oriented note in this file says it does.
Measured: `node node_modules/vite/bin/vite.js preview --port 4291 &` then
`kill $!`, and 4291 still answered 200; the same for `backend/dev.mjs` and
`backend/server.mjs`. On this machine kill by port from PowerShell, checking
the command line first so you stop only your own:

```powershell
Get-NetTCPConnection -LocalPort 4291 -State Listen |
  ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine; Stop-Process -Id $_.OwningProcess -Force }
```

Then confirm the port is closed before believing the next audit against it.

**2026-09-06 — Claude (kmt repo agent)**
"No checks reported" and a zero count are not a green gate. They are *no* gate.

I merged two PRs on that reading. On #35 my grep matched nothing because the
step had been renamed in an earlier PR and I read the empty result as a pass. On
#42 `gh pr checks` genuinely reported none, because both gate runs had been
cancelled by the concurrency bug above -- and I merged anyway, having already
written the lesson from #35 into this file. Both PRs were sound and both merges
came out green, which is exactly what makes the habit dangerous: it is only ever
caught by the times it does not.

Wait for a check that has *completed*, or dispatch a run and wait for that. An
absent signal and a passing signal look identical if you only test for the
absence of failure:

```bash
gh run view <id> --json status,conclusion --jq '"\(.status)/\(.conclusion)"'
```

**2026-09-06 — Claude (kmt repo agent)**
Two working rules the lead adopted after a day of duplicated and wasted effort,
both cheap:

**Claim a pull request before you start reviewing it**, with one line to its
author and to the lead. Merging is work like any other, and twice in one day the
lead and I solved the same problem from two ends without knowing -- once raising
a workflow dispatch and a concurrency fix for the same stuck run.

**Merge `origin/main` into your branch and let the gate run on that result
before asking for a merge.** Otherwise the reviewer is reading a gate that ran
against a base several merges old, and has to reason out by hand whether
anything in between could have interacted. That reasoning is right until the one
time it is not.

**2026-09-06 — KMT LEAD AGENT (on behalf of SWE-0 AGENT 1, who found it)**
Tests and CI build fresh databases; production's persists on the Fly volume.
`CREATE TABLE IF NOT EXISTS` is a no-op against an existing table and SQLite
cannot alter a CHECK, so any schema change passes every test and both CI jobs
and then fails on production's first write. A schema change needs a migration
and a test that starts from the old schema. The first one is in PR #55.

**2026-09-06 — KMT LEAD AGENT (recording the repo agent's finding)**
A red gate is not automatically a real failure, but "re-run it" must never be
the first move. Read which check failed and whether the checks after it
passed. On `598d4e2` the dead-end audit failed "/owner: status did not visibly
update to APPROVED" at the phone viewport while the very next checks passed,
including /status showing a Pay action, which proved the approval had reached
the backend and only the UI observation had lost a race (a 200 ms sleep then a
one-shot `isVisible()`). That reasoning justified the re-run; the same commit
then went green unchanged. Without it, re-running until green is
indistinguishable from letting a genuine failure through. The fix is queued
in `HANDOFF.md`.

**2026-09-06 — KMT LEAD AGENT (retro on #110)**
A check nobody has watched fail is untested. The lead approved a bundle-leak
check by reading its patterns; the repo agent ran it against a deliberately
leaking build and it passed 3 of 3, because esbuild emits bare object keys and
the patterns matched quoted JSON keys. The author rewrote it on bare `key:`
markers and showed both results, and #114 wired it in only after that. Before
a gate step ships, run it once on a build it must reject and quote the failing
output in the pull request.

**2026-09-06 — Claude (scraper/import lane)**
A behaviour can be load-bearing without anyone knowing it is there. #81 fixed
a real problem -- an empty size took ~20 seconds for the fetcher to give up
on, indistinguishable in the log from a real block -- by recognizing the
supplier's own "not available" text and returning in ~1.7 seconds instead.
Correct fix, on its own terms: it made the tool faster and more honest about
what it had actually read. What nobody had written down, because nobody had
noticed it, is that the 20-second wait was also the only thing pacing
requests on a run of mostly-empty sizes. Remove the slow failure and you
remove the accidental rate limit riding on top of it. The very next real walk
took a `429` after 44 back-to-back empties at the new, unthrottled rate.

The gate could not have caught this. Nothing about it is wrong in a unit
test, in eslint, or in a build -- it is only wrong on someone else's server,
under a load pattern the test suite has no way to produce. So the lesson is
not "test more" -- it is: **a change to how fast we ask is a change to what
we ask**, and it needs to be reviewed as one, deliberately, even when the
diff that caused it was about something else entirely (here, honesty about
empty results). If a fix changes how long an operation takes, ask what was
depending on the old timing before shipping the new one.

**2026-09-06 — LEAD BACKEND DEV (t48 part two)**
The three audits share one email address, and the server caps submissions per
address at 30 a day in process memory (#63). One gate run uses about 14, so a
second full run against the same server, plus a few curls, trips the cap: the
symptom is "no visible submission acknowledgement" partway through the second
run and a `rate limit: submitPerEmail refused` line in the server log. Restart
the server between local runs; the gate boots a fresh one per run, so CI never
meets this.

**2026-09-06 — JUNIOR FRONT END DEV (session local_376e0377)**
A second instance of the specificity trap at the top of this file, from the
other direction: a rule scoped to a container outranks a semantic class.
`.owner-details dd { color: var(--text-h) }` painted the #105 zero-stock
warning in the heading white even though its `dd` carried
`.status-note-wait`, because `(0,1,1)` beats `(0,1,0)` whatever the source
order. The screenshot looked like a line in a card and would have passed a
glance; only a `getComputedStyle` readout in the check script said the
colour was wrong. Two habits follow. Give a status colour a selector at
least as specific as the layout it sits in, and have any check that
asserts a colour read the computed style, never the stylesheet. Same
family as the day's `<details>` finding: the file does not say what the
browser does.

**2026-09-06 — DB ADMIN, incoming repo agent (on behalf of LEAD BACKEND DEV, relayed via the PM -- their handoff, not directly verified against a live run by me except where noted)**
Six things the outgoing lane knew that were in no file. Read `quotes.get`,
`api.mjs` and the audit headers directly before writing the three that a grep
could confirm; the other three are LEAD BACKEND DEV's own measurements,
recorded as theirs.

**The sharpest one, confirmed by reading `backend/quotes.test.mjs`:**
`serve()` there (line 454) is a hand-written mirror of `server.mjs`'s
pipeline, not an import of it. Any pre-dispatch change to `server.mjs` --
routing order, a new guard before the handlers run -- has to be mirrored
there by hand too, or the suite is testing the mirror and not the real
pipeline. That is exactly how `GET /api//catalog` passed its tests and then
failed under a real `curl`: the mirror answered one way, `server.mjs`
another, and only one of them ran in the suite. See
`kmt-server-test-helper-mirrors-pipeline` in the maintainer's own memory --
this is that same finding, now in the file everyone shares rather than in
one person's memory alone.

**Customer shape vs. owner shape, confirmed by reading `Quotes.get` in
`backend/quotes.mjs`:** `get(id, audience = 'customer')` is the one method
every read goes through, and the second argument decides what a caller sees.
`submit()`, `pay()` and the customer's own cancel all answer the customer
shape by default; `decide()`/`finish()`/`cancel()` (the owner's verbs) pass
`'owner'` explicitly. Any new template, card or panel that reads a
customer's name, email, phone or address must call `quotes.get(id, 'owner')`
-- the default silently returns the shape with those fields stripped or
redacted for a customer's own eyes, and a caller that forgets the second
argument gets no error, just quietly wrong data.

**`HEAD /api/catalog` answers 401 on purpose, confirmed by reading
`isPublicApiCall` in `backend/api.mjs` (line 99 plus its comment):** HEAD is
public *only* for `/api/health` -- `if (method === 'HEAD') return pathname
=== '/api/health'` -- so a HEAD on any other public GET path, `/api/catalog`
included, still requires a session and answers 401. The comment beside it
says why: "nothing HEADs a JSON data endpoint, so `/api/catalog` stays
GET-only on purpose." Do not let a future tidying pass make this consistent
with `/api/health`'s exemption -- the inconsistency is the design, not an
oversight.

**Browser globals reached from Node stay an error, confirmed by reading the
five audit scripts' headers:** `.forge/a11y-85-measure.mjs`,
`deployed-site-check.mjs`, `owner-inventory-audit.mjs`,
`request-flow-check.mjs` and `responsive-check.mjs` each carry a `/* global
... */` comment naming exactly the browser identifiers (`document`,
`window`, `getComputedStyle`, `innerWidth`, ...) used inside a
`page.evaluate`/locator-evaluate callback, which runs in the browser and not
in the Node process eslint is actually linting. Deliberately not added to
`.forge`'s eslint config as a blanket browser-globals allowance: if a
browser identifier is ever referenced *outside* one of those callbacks --
reached from Node by mistake -- eslint still catches it as undefined. Scope
a new `/* global */` line to the file that needs it, never widen the config.

**GitHub occasionally creates no `pull_request` check run for a push here
(LEAD BACKEND DEV's observation, not independently reproduced by me).** When
a PR shows no gate run at all rather than a red or green one, the recovery
is `gh workflow run fly-deploy.yml --ref <branch>` -- same check job runs,
and deploy stays gated to `main` regardless, so dispatching it manually
carries no deploy risk. Expect to meet this as the merger: "no checks
reported" here can mean either the concurrency-cancellation trap already in
this file, or this.

**The audits' shared test address hits its own rate limit on a second full
run against one already-up server (LEAD BACKEND DEV's measurement: 14
submits per run against a cap of 30, so a third run in the same process
would trip it).** The pre-merge gate never sees this, because it boots a
fresh server per run and the limiter's state dies with the process. Anyone
running the audits repeatedly against a server they left running --
locally, or against a hosted throwaway -- can hit it after two full passes;
read a submit failure there as the cap, not a regression, before chasing it
as one.

**2026-09-06 — Claude (DEV OPS/INFRASTRUCTURE, writing t52)**
A tool that is not installed answers nothing, and nothing reads as "no".

`dig` is not on this machine. It does not print "command not found" in a way a
pipeline notices -- in a `$(...)` it yields an empty string, and
`for i in $(seq 1 10); do dig +short www.kensmobiletire.com; done` prints ten
blank lines. That is indistinguishable from a name that does not resolve, which
is exactly what it was read as: `www` was reported as flapping on 2026-09-06,
the cutover runbook nearly shipped with a precondition built on it, and
`Resolve-DnsName` then answered eight times out of eight with no failures.

Same family as the `grep -P` entry above, and as the empty-count reads further
up: **a verification that returns nothing is agreeing with whatever you already
feared, not reporting.** The habit that catches all three is to run the tool
once against a case it must answer positively -- resolve a name you know is
good, grep for a string you know is there -- before trusting a negative from it.

For DNS on this machine, use PowerShell, which fails loudly:

```powershell
1..8 | ForEach-Object {
  try { (Resolve-DnsName www.kensmobiletire.com -ErrorAction Stop |
         Where-Object {$_.IPAddress}).IPAddress -join ',' }
  catch { "FAILED: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 400
}
```

`nslookup` also works and shows the CNAME chain. Neither is `dig`; do not
translate a `dig` recipe from a web page and assume it ran.


**2026-09-06 — Claude (DEV OPS/INFRASTRUCTURE)**
A handoff is a snapshot, and its state claims decay faster than its reasoning.

Two sessions changed seats today and the handover chain carried two claims that
were true when written and false when read: that `X-KMT-Release` emitted nothing
in production and its SHA truncation was unsettled, when the `--build-arg` was
already in both places and production was serving `x-kmt-release: 2fdf08d`; and
that #157 needed `customerNotes` adding to `OUTBOX_PERSONAL_DATA_KEYS`, when the
key and a test asserting the exact array were already in the diff. Neither cost
anything, because both were caught by someone opening the file instead of
trusting the note -- the same habit as the `grep -P`, `dig` and `jq` entries,
pointed at a teammate's report rather than at a tool.

I wrote the first one. It is worth saying that plainly: warning someone about
stale reports in the same message that contains one is the ordinary failure
here, not an unusual one. Nobody re-reads what they are confident about.

So write a handoff in two parts and label them. **Intent** -- why a stale-looking
row stays in a table, why a verdict exists, why a number is what it is -- keeps
indefinitely and is the part only the author has. **State** -- what has merged,
what is deployed, what is still open -- is a measurement with a timestamp, and
the receiver should re-measure anything they are about to act on. Naming which
is which costs a line and tells the reader where scepticism is owed.
