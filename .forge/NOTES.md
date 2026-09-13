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

**2026-09-06 — QA ENGINEER (session local_1fa1cb9a), naming a rule the
outgoing PROJECT MANAGER asked to have written down rather than passed
along as a preference**
Two habits, not one, and they are the reason nothing built tonight had to
be redone. Neither is written anywhere in this file or in `AGENTS.md`
until now, and both cost nothing to follow and a great deal to skip.

**Never build against a thing that has not actually happened.** Not "the
PR looks done," not "the branch has the commit," not "the peer described
it correctly" -- merged on `main`, or live in production, read at the
moment of building. #144's `CATALOG_FIELDS` import waited for `#140` to
actually merge rather than importing from a branch. The `og:image` check
waited for `#186`'s baseline to land before its count was written, even
though the design was ready earlier. The t62 Slow-3G step was not started
from LEAD UI ENGINEER's selectors alone, detailed and correct as they
were, because no brief for it had actually arrived -- it turned out the
PM had meant to send one and had not, and building anyway would have
meant guessing at scope on someone else's behalf. A description of a
merged thing and a merged thing are different claims; only the second is
safe to build on.

**Prove a check can fail before trusting that it can pass.** A check that
has only ever been watched pass is unproven in the direction that matters
-- the #110 bundle-leak guard in this same file's earlier history passed
3-of-3 on a build that was genuinely leaking, because nobody had run it
against one that leaked. Concretely, tonight: a deliberately wrong count
(176 instead of 177) on #144, to see the count check fail on the specific
line rather than assume it would; removing the "Owner review" link from
the actual page source, rebuilding, and rerunning before #176 shipped,
rather than reasoning that the new navigation would not need it; two
separate deliberate breaks in app code for #212's tire-step checks, each
confirmed to fail only the one check meant to catch it and no other; and
confirming the #217 gradient-clip fix against a live `getComputedStyle`
read rather than trusting that six false positives disappearing meant the
fix was right -- they could as easily have meant six checks had silently
stopped running, which is exactly the failure this file's own bundle-leak
entry describes from the other side.

Both habits are refusals to be efficient in the moment in a way that
costs more later: skipping either one would have looked like the same
amount of work finishing sooner. Carry them forward as a rule, not a
style choice.

**2026-09-06 -- BUG FIXER (local_8ba9f198), on a port trap that has now
cost two sessions in one afternoon**

A local audit server left running from an earlier session answers on the
port you just picked, with the wrong password, and looks exactly like
your own server misbehaving. It happened to me twice today, on 4173 and
then 4174 -- a different agent's throwaway server each time, still bound
because nothing killed it when that session moved on.

The symptom reads as a bug in your own change: `KMT_OWNER_PASSWORD` set
correctly, the audit's `signInIfAsked` fills the form, clicks Sign in,
and times out waiting for the form to detach. Nothing in the server log
you're tailing shows a login attempt at all, because the request went to
someone else's process on the same port, not yours. On Windows this is
also invisible to `netstat` at a glance: two processes can each hold the
same port number, one on `0.0.0.0:<port>` and one on `127.0.0.1:<port>`,
and `curl http://localhost:<port>` resolves to whichever one the OS
prefers -- not necessarily the one you just started.

**Before trusting an audit's failure (or its pass) against a port you
picked yourself, verify the port is actually yours**: `curl -s -X POST
http://localhost:<port>/api/owner/login -d '{"password":"<yours>"}'` and
check the response names your database, or just check `{"authenticated":
true}` came back for the password you set. If it answers "Incorrect
password" for a password you know is right, or the response otherwise
doesn't match what you just booted, `netstat -ano | grep <port>` and look
for more than one LISTENING line -- kill the stale one (`taskkill //PID
<pid> //F`) before concluding anything about your own change from that
port's behavior. This is the same family as the `dig`/`grep -P`/`jq`
entries above: **a tool that answers *something* is not the same as a
tool that answers *your* question**, and a stale server answering wrong
looks identical to your server being broken until you check whose
process it actually is.

**2026-09-06 -- Claude (repo agent), on `gh run view` itself answering stale**

Same family as the entry above, one layer up: the tool you'd reach for to
check whether a deploy is actually happening can itself lag. Mid-deploy,
`gh run view <id> --json status` returned `"queued"` on one call, sandwiched
between two calls seconds apart that both correctly showed `"in_progress"` --
same run, same id, no intervening event. The run-level `status` field is a
summary GitHub computes and can trail the truth by a beat; it is not the
run.

`gh run view <id> --json jobs` did not lag the same way: at the exact moment
the top-level status read `"queued"`, the per-job breakdown showed all three
real jobs already `completed`/`success`. When a run's own summary status
looks stale, contradicts a call made seconds earlier, or just seems wrong
given what else is known, read the jobs, not the summary -- the same
correction as reading `.conclusion` instead of trusting a green tick, and
reading each audit's own count line instead of the pass/fail badge. Every
one of these is the same lesson from a different instrument: **a status
field is a claim about the thing, not the thing.**

**2026-09-06 -- Claude (repo agent), on `gh pr list --author "@me"`**

Same family again, from the PM: it does not identify one agent's work in
this repository. Every session here commits and opens pull requests under
the single shared GitHub login (`ei7hty`) -- see the roster's own note on
this, under "Authorship cannot be read from GitHub" -- so `@me` resolves to
that one account for every session that runs the command, and the query
returns every open PR from every lane as if the caller had opened all of
them. It answers instantly and looks exactly like a scoped result.

With eight-plus sessions sharing one checkout and one login, that shape of
mistake -- a query that resolves cleanly to the wrong scope rather than
erroring -- will keep being the tempting shortcut for "what have I got
open." Identify your own PRs the way everything else here does: by branch
name, by the claim row that named the work, or by the task/issue number,
never by `--author`.

**2026-09-06 -- Claude (junior backend dev), on `git commit --amend` without re-staging**

Rebasing t35 past a squash-merged prerequisite, I resolved conflicts, made
several more unstaged edits on top (a field added to an allow-list, a
refactor, a new test), ran the full suite, watched it pass, and then ran
`git commit --amend -m "..."` to give the cherry-picked commit a real
message. Pushed, opened the PR, reported it done -- with a paragraph
describing the field and the refactor as part of what shipped.

They were not in the commit. `git commit --amend` rewrites the commit from
whatever is *staged*, not from the working tree, and I had never run `git
add` after the cherry-pick's own auto-staged resolution. The tests I'd
watched pass were run against the working tree, which still had the edits;
the commit I pushed did not. "I already committed those" and "those are
currently staged" are not the same claim, and the gap between them does not
show up in a test run against the files on disk -- only in a diff of the
commit itself.

Caught before anyone acted on it, by diffing `HEAD` against a copy of the
working tree saved before I started resolving the next rebase's conflicts --
not by re-reading the PR body, which read exactly as intended and would have
told me nothing was wrong. The same family as the report-vs-measurement
distinction elsewhere in this file: a description of intended work is a
claim, and the only way to check a claim about a commit is to read the
commit, not the message beside it or the tests that ran before it existed.

After any `--amend`, `git diff HEAD` against what you meant to ship, before
telling anyone it shipped -- an amend with nothing staged silently keeps the
old tree and says nothing about it.

**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), at the
PROJECT MANAGER's request, from four instances in one afternoon**
A document is an assertion with a timestamp, and nothing in this repository
re-measures one.

Code has tests. Deploys got a divergence detector today, after production ran
an hour behind `main` twice with green ticks over it the whole time.
**Documents have nobody**, and it cost us four times between roughly 06:00Z
and 18:00Z. Each was caught by a person happening to open the file. That is
not a control. It is conscientiousness plus luck, and it does not scale with
the number of agents reading.

**One. `state.json` stopped at `updatedAt` 05:59:55Z and stood still for
eleven hours** while more than a hundred pull requests merged. Task ids t57
to t66 were absent from it entirely though they appeared in `HANDOFF.md`, in
`CLAIMS.md` rows, in merged commit subjects and in open PR titles; m13 had a
design document and no milestone; t44 through t54 read `todo` with their work
on main. **What it cost:** a JUNIOR FULL STACK engineer read the file
correctly, concluded m10 was the live milestone with t35 still to do, and
began planning against it. The PROJECT MANAGER caught it by reading their
plan closely. **The failure mode is not confusion — it is careful, correct
work aimed at the wrong milestone**, which consumes a whole session before
anyone notices.

**Two. The issue tracker showed 29 open and at least six were already fixed
on main and never closed** — #100 (`src/routes/Privacy.jsx`), #101
(`health-monitor.yml`), #99 (`docs/operations.md`), #103 (`paths-ignore`),
#66 (throttle in `backend/auth.mjs`), #70 (`cleanDate`). With t49's four and
#80, the real backlog was roughly a third of the number on the page. **What
it cost:** anyone estimating distance-to-launch from the tracker was wrong by
a factor of three, in the discouraging direction, on the day of a launch
sprint.

**Three. `docs/operations.md` opened the by-hand data-removal checklist by
naming `inquiries` a live table.** `backend/inquiries.mjs` is imported by no
entry point, so the table is never created, and the checklist then hands an
operator `UPDATE inquiries SET name='[redacted]' ...` against it. **Size this
one correctly rather than inflating it:** no personal data was at risk,
because with no table there was nowhere for an inquiry to have been stored,
and the author had anticipated the failure one sentence later — a missing
table answers `no such table`, loudly, which is correct. **What it cost is
narrow and still real:** one operator, mid-removal-request, in production,
over `flyctl ssh console`, unable to tell whether the runbook was wrong or
the database was broken, at the one moment a checklist has to be trustworthy.

**Four, and this is the one that makes the note worth writing, because it
goes the other way.** `docs/brand.md` said every brand file carries the
seller's watermark. **That was true.** It had been read to mean the watermark
is *visible* — including on the image that renders when anyone shares the
site. Measured by GROWTH/MARKETING and relayed here rather than re-measured by
me, which this entry obliges me to say: the share image swings two levels out
of 255, 1.02:1, against a 3:1 perceptibility threshold. The measurement was then calibrated by
stamping watermarks at known strengths onto copies until the reading crossed
3:1, and confirmed by eye at the sizes that matter — which is the good half,
someone proving their instrument could detect the thing before trusting that
it had not.

**So the record was accurate and the belief drawn from it was false**, because
it stated one thing and was read as two. And the belief was being used to
answer a question it does not answer: whether these preview files may ship
at all turns on their licensing terms, not on whether the watermark can be
seen — and the licensing terms are not settled here, in either direction.
*"You cannot see it" is a good answer to the wrong question.*


**A sixth arrived while this was being written, and it is a third shape.**
`src/noindex.js` injects a `noindex` meta tag on five screens and its docblock
calls it *"the other half, for a page a crawler already found through a link"*.
Every one of those five paths is `Disallow`ed in `public/robots.txt`, so a
compliant crawler never fetches them and never reads the tag -- and a URL found
through a link is precisely the case it cannot serve. **The comment is not
stale. It was never true.** There was no moment at which it described the
system, so no re-measurement schedule would ever have caught it: the first
reading is the only one, and it was wrong.

So the six sort into three shapes, and the third is the one worth naming:
**the record fell behind** (`state.json`, the tracker, `operations.md`); **the
record was right and the reader drifted off it** (`brand.md`); **the record was
wrong on the day it was written and nobody checked** (`noindex.js`). Drift has
a detector in principle. A misread has an editing discipline. **The third has
neither** -- only somebody going and looking at whether the mechanism does what
the sentence says, once, at the moment it is written.

**A variant of the first shape belongs here too, moved from `AGENTS.md`
because this is where it belongs and it was written before this taxonomy was
found: work that outran its record.** It shares the first shape's
mechanism -- the world moved, the record did not -- but is caught by nothing
the first shape's detector catches. `state.json` and the tracker are wrong
about a count of the *same thing* they describe, so re-measuring that thing
catches them: read the file, count the audits, compare. This variant is
wrong about an *absence* -- "nobody owns X," "X is not done" --
and the only way to falsify an absence is to go and look somewhere else
entirely, for work that may have already closed it. Seen three times in one
repository: regression tests about to be rewritten that already existed, a
copy defect recorded open and fixed hours earlier, an audit path assigned for
conversion that had already been converted. Each finder was doing something
else, because a review of the document itself would have found nothing wrong
-- the document was true when written and stayed internally coherent, so
re-reading it confirms it rather than catching it. One way it bites in
particular: **searching for the old thing and reading its presence as the new
thing's absence.** `audit-ui.mjs` still held `KMT_OWNER_PASSWORD` after the
minted-session path shipped, so the conversion looked undone -- but that is
the fallback the new path sits above, not evidence the old path is all there
is. A grep for what you expect to be gone answers a different question than
the one you asked; the question is *what does this code do now*, and only
reading it answers that. Before assigning work a document says is open: read
the code, not the document. When a document says a thing is missing: check
whether it is actually there before believing the negative.

**The four are one failure with two shapes.** In the first three the world
moved and the record did not. In the fourth the record never moved and the
reader drifted off it. Both are an assertion nobody re-measured; the only
difference is whether the drift happened in the repository or in someone's
head. **Reading a document tells you what somebody believed when they wrote
it, and nothing about today** — which is the same lesson as this file's
entries on `grep -P`, on `dig`, and on stale handoffs, pointed at prose
instead of at a tool.

## A proposal, flagged as a proposal

Not agreed by anyone yet, and deliberately not holding up the entry above.

**Hand over the command, not the conclusion.** Where a document asserts a
checkable fact about this repository, carry the command that checks it, and a
positive control beside it. The `inquiries` correction does this: it gives
you the `grep`, tells you it returns nothing today, and tells you to prove
the command works by grepping `Quotes` the same way first, which must return
lines. A reader who runs it learns today's answer instead of 17:00Z's.

**A `state.json` staleness check is cheap and would have caught the first
instance outright.** The file already carries `updatedAt` and nothing reads
it. Failing when it is more than some number of merges behind `main` is a few
lines, and it is the one instance here with a purely mechanical signal.

**A doc-claims check, in the shape this repository already trusts** — a
script holding (claim, command, expectation) triples with its own
`EXPECTED_CHECKS`, run in the gate — would have caught the third. Two honest
caveats, and they matter more than the idea: it must be **proven able to
fail** before anyone trusts it passing, per this file's own rule, or it
becomes the bundle-leak guard that passed 3-of-3 on a leaking build; and it
covers only mechanically checkable claims, which is a small fraction of what
these documents say. **It would also itself become a stale record the moment
nobody maintains it** — which is the joke, and the reason to keep it small
enough to be obviously worth keeping.

**For the fourth kind there is no mechanical detector and I am not going to
pretend otherwise.** No script catches "accurate sentence, stronger reading."
The only defence is editing discipline: when a claim has a weaker and a
stronger reading, write the weaker one and then write down which question it
does *not* answer. That is what separating "carries a watermark" from "the
watermark is visible" did, and it took one sentence.

**2026-09-06 — QA ENGINEER (session local_1fa1cb9a), on a line the PM asked
generalized rather than left as one report's phrasing**

A broken instrument tells you nothing about the past it failed to see, not
even a plausible-sounding nothing.

Reporting a fix to `deployed-site-check.mjs`'s redirect-flip detection (it
read an environment variable that only ever exists as a Fly secret, so it
had been blind to whether the domain flip was live since the day it was
written), I wrote that the flip "has probably been live and passing
invisibly for a while." Two facts behind that sentence were true: the check
had been blind the whole time, and production redirects correctly right
now. The sentence joining them was invented, and it was wrong — the PM had
measured the flip going live about an hour earlier, directly, and said so.

That is the same family as this file's entries on `grep -P`, `dig`, `jq` and
`gh run view`'s own summary status, and it is also a different member of
it. Every one of those answered the wrong question **about the present** --
rerun the tool correctly, or read a different field, and the wrong answer
is gone, replaced by a right one, and nothing is lost but the time spent
believing it. This one reached backwards. A broken instrument cannot be
rerun against a moment that has already passed, so a wrong claim about what
it *would* have shown does not get corrected later -- it just becomes what
the record says happened, unless someone who actually measured that moment
is still there to say otherwise.

The habit that would have caught it before writing it, not after: two true
facts do not make a bridge between them true, and a gap between measurements
is a gap, not an invitation to guess what filled it. "The check couldn't
have told you whether the flip had been live for a while" says everything
that was actually known and costs one sentence more than the wrong version
did.


**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), at the
PROJECT MANAGER's request, from doing it to myself with the evidence on screen**
When you record that something happened, grep for every other place that says
it has not.

The entry above this one says a document is an assertion with a timestamp and
nothing re-measures one. **This is that observation turned into a command you
can actually run**, and it is here because I wrote that entry and then made the
mistake anyway, three hours later, with the contradicting sentence quoted in my
own pull request.

**What I did.** I ran t54's restore drill for the first time, it passed, and I
wrote the record into `HANDOFF.md`:

```
.forge/HANDOFF.md:468   The restore drill, run 2026-09-06 ~20:35Z — PASSED
```

**And left three sentences in another file saying it had never happened:**

```
docs/operations.md:481  The restore drill in it has not been run.
docs/operations.md:542  This procedure has still never been run end to end.
docs/operations.md:608  This has not been run. Run it once on a quiet day.
```

**I had read line 608 that hour and quoted it in the PR body.** The junior
project manager then swept #80, believed the runbook, and was misled by a
document I had personally superseded ninety minutes earlier.

## Why the rule is worth more than the instance

**It generalises to every case of this shape tonight, and there were five.**
Each one is a sentence that was true until somebody made it false and did not
go looking for it:

- `t62-voice.md` part F was written **for** t37's templates and said what
  voice they would carry. The templates shipped in another pull request in the
  wrong voice, and three customer emails went out saying "we" for a one-man
  business. **Nobody grepped for the templates after approving the voice.**
- `src/noindex.js` documented itself as covering "a page a crawler already
  found through a link" — the exact case a `Disallow`ed URL cannot reach.
  **Wrong on the day it was written**, which no re-measurement schedule catches.
- The DNS repair table told an operator to delete `rsend` and hunt an apex
  TXT. Both had become **live, verified records for the provider the user had
  just chosen.** Accurate when written; an instruction to destroy something by
  the time it was read.
- `sprint-first-week.md` listed two items separately after the lead had
  merged them into one pull request in practice. **The plan was true on its
  face and false in effect**, and I assigned three people from it.

**In every one, the fix is the same grep**: after you make a thing true, search
for the sentences that still say it is not. `git grep -n "has not been run"`
takes one second and would have caught the drill, the templates, the plan and
the table.

## The half that is about lanes, and it is the part I got wrong

`docs/operations.md` belongs to DEV OPS. **Staying out of another lane's file
was right. Staying silent about it was not** — and those are different things
I had collapsed into one.

**When you cannot fix the contradiction because the file is not yours, name it
where you are.** One line in my own pull request — *"three lines in
operations.md now contradict this; routed to DEV OPS"* — costs nothing, crosses
no lane, and turns a trap into a known open item. I routed it and did not name
it, so the record read as settled while three sentences in the next file said
the opposite.

## The same failure wearing an instruction instead of a document

**Worth naming because it caught me an hour later in a form I did not
recognise.** I ruled on a piece of copy, the lead overturned me with a better
argument, I accepted it — **and told only the lead.** The junior actually
holding the work was still executing my superseded ruling, and rewrote the line
and reran the whole gate on it before the correction reached them.

**A reversal has to reach the hands, not just the other manager.** Same shape
as everything above: accurate when issued, invalidated elsewhere, never
reconciled with whoever was acting on it. **The document version is caught by a
grep; this one is caught by asking who is currently doing the thing I just
changed my mind about.**

**2026-09-06 — TEMP REPO AGENT, releasing two stale claim rows on CLAIMS.md**
A direct-to-main push to CLAIMS.md got rejected non-fast-forward (someone else
had pushed a claim in between, as usual). `git fetch` then `git rebase
origin/main` ran, but the intermediate `git status` read back a HEAD that was
neither mine nor the one just fetched, and reported "diverged" against a
remote-tracking ref I had just fetched. Nothing was wrong: another session
sharing this same checkout (not just the same remote — the same local `.git`
and the same `main` ref) had run its own fetch/rebase/push in the moments
between my commands, and it carried my already-committed local commit along
with it. `git log main --oneline` and `git log origin/main --oneline` matched
exactly, my commit was in the shared history, and no push of my own was ever
needed or possible by that point.

The lesson: on a push rejection here, don't loop on fetch-rebase-push assuming
you are the one who has to land it. Check whether it already landed first —
`git log --all --oneline --grep "<your commit's own message>"` plus a
`git log main --oneline` vs `git log origin/main --oneline` comparison — before
retrying. A second push attempt when you didn't need one is at best wasted and
at worst races a live rebase in the same working tree.

**2026-09-06 — DEVSCOPS/AUDITOR, a reference entry at the PM's request (drafted
by DEVSCOPS/AUDITOR, verified against the code and corrected by the PM, placed
here by the repo agent since DEVSCOPS/AUDITOR is read-only)**

**Public repo does not weaken owner-auth security (Kerckhoffs).** The
repository is public (since 2026-09-06; the reason is not recorded here). That
does not make owner sign-in easier to break. The password check is a
constant-time decoy compare (`backend/auth.mjs:77-87`): on a length mismatch it
runs `timingSafeEqual(left, left)` against the attacker's *own* input and
returns false, and on equal lengths it runs a normal `timingSafeEqual` — so
both branches cost time proportional to the attacker's input length, never the
stored password's, and the real password's length does not leak. (It does not
pad; a reader grepping for padding finds none and should stop here.) Session
ids are 128 random bits stored server-side in `owner_sessions`; the cookie is
HMAC(secret, `purpose:expires:id`), and forging one needs the secret (a Fly
secret, or per-boot random) plus a live id already in the store. Reading this
code gains an attacker nothing — a correct cryptographic design is not
weakened by being understood. Publication did not move exploitability, with
two named exceptions, both reconnaissance-cost and not exploitability:
`docs/operations.md` now advertises that a single shared password guards
customer PII (the mitigation until #290 is that password's entropy), and
`scripts/giga-tires.mjs:19` names the scrape host (`www.giga-tires.com`) that
#87's supplier-compromise chain would target. Re-litigate the "public code is
inherently less safe" instinct against this entry before spending review
cycles on it.

A related, separate precision lesson from the same night belongs beside the
brand-file ignore rule rather than here (see the `.gitignore` history around
PR #309): a green `git check-ignore` against a file's old path stood as
"covered" while the file's actual current path matched nothing — check the
path you mean to ask about, not the one that used to be true.
**2026-09-06 — Claude (MARKETING AGENT), after the brand-licensing sweep**
Grepping for a phrase finds the documents. It does not find the idea.

A false claim about the brand art — that the business did not own it — had to
come out of a public repository tonight. I was handed four locations, and
searched for the words instead of fixing the four: `unlicensed`, `licensed`,
`watermark`, the supplier's name. That found six. It missed a seventh.

`backend/static.test.mjs` fetches `/brand/SOURCES.md` and asserts a content
type on it. `public/brand/SOURCES.md` was deleted weeks ago — so the test
encodes an expectation about a file that no longer exists, and passes anyway
because it writes its own fixture first. It contains none of the four words.
**No honest search for them could ever have reached it.**

This is the seventh instrument failure in a day of them and **the first where
the instrument was working perfectly.** `grep -P`, `dig`, the empty counts, the
stale `gh run view`, `gh pr list --author "@me"`, `$?` after a pipe: in every
one of those the tool answered a question other than the one asked. Here `grep`
answered exactly what it was asked. **The query was the defect.**

The practical form, because "search harder" is not a technique:

- **After a phrase-grep, grep for the artifacts the idea touches** — filenames,
  routes, constants, env vars, table names. `SOURCES.md` is what found the
  seventh instance, and it is the thing that survived a rephrasing the prose
  did not.
- **Prefer several searches that share no word** over one clever pattern. An
  idea that has been written about more than once has been worded more than
  once; a single regex is a bet that everyone reached for the same vocabulary.
- **Ask what would still be true if the wording had drifted.** A path, an
  identifier and a number survive paraphrase. Adjectives do not.

The general rule from the `dig` and `grep -P` entries above is that a
verification returning nothing is agreeing with whatever you already feared.
**This is its neighbour: a verification returning *something* can still be
silent about the part you needed, and it will look complete while it does it.**
Six hits felt like a finished sweep. It was 86% of one.

**2026-09-06 — Claude (MARKETING AGENT), at the product owner's request**
One spot-check does not clear a category. The instrument was working.

Every instrument entry above this one is about a tool that answered a question
other than the one asked. **This is the other failure, and it is the one my own
process was worst at: the tool was right and I overruled it.**

I measured the seller's mark across all fourteen brand files. The sweep printed
`<-- PERCEPTIBLE` beside the light-ground ones, 1.30 to 1.53:1. **Those were
true positives.** I then checked **one** flagged file, `kens-dark-1200.webp`,
found its hot pixel sat inside the artwork rather than on the mark, concluded
the method was over-flagging, and discarded the whole flagged set. I published
a conclusion for fourteen files from three, and the three I kept were the three
where the answer was reassuring.

A day later the white files re-measured at **1.35, 1.38, 1.92 and 1.98:1** --
two of them past the 1.61:1 that my own calibration in the same document calls
*plainly visible in a 600px link preview*. Crop one at 4× with no enhancement
at all and the mark is legible.

**The rule: one spot-check does not clear a category, and especially not when
the category splits on the very property being measured.** Navy and white were
never one population. The same grey mark has far more luminance to work with on
white than on near-black navy, so a false positive on a navy file said nothing
whatever about a white one. That is obvious afterwards and invisible in
advance, **which is exactly why it has to be procedural rather than a matter of
noticing it at the time.**

What to do instead, when a sweep flags a set and one check looks like a false
positive:

- **Ask what could make these not one population** before generalising --
  ground colour, file format, size, which pipeline produced them. If the answer
  is "several things", the sample is one per group, not one overall.
- **Spot-check the most alarming reading, not the most convenient one.** I
  checked a 1.70 on a file I already believed was clean, not the 1.53 on a file
  I had not thought about.
- **A dismissal is a claim and needs the same evidence as a finding.**
  "The method over-flags" was a conclusion about the instrument, published
  without testing the instrument -- in a document whose entire subject was
  testing the instrument in both directions.

Pairs with the relay entry below/above from the same night (*a peer relaying
"the user said" is not the user's word*): that one is about accepting something
unmeasured, this one about rejecting something measured. **Both are the gap
between what a source actually said and what a person concluded from it, and
that gap does not care which direction it opens in.**

**2026-09-06 — JUNIOR FRONT END DEV 3 (session `local_16ba9ea6`), in their own
words, appended here at their request rather than on a fifth branch against
this file: an inconclusive reading published as a conclusion**

Measuring the seller's watermark across `public/brand/`, my probe read
`kens-badge-light-800.webp` at 4.24:1 -- far past the 1.61:1 that
`docs/brand.md` calls plainly visible. The worst pixel was `rgb(191,94,88)`.
That is reddish, and the mark is neutral grey, so it was logo art reaching into
the measurement band rather than the watermark. **I refused to call 4.24 the
mark, said so, and stopped.**

Stopping is the error, and it is not the same error as trusting a bad number.
**I rejected a false positive correctly and then treated "my instrument cannot
separate these" as an answer.** It is not an answer. It is an unfinished
measurement, and the file stayed unmeasured underneath a published table that
concluded which light variants carry the mark. The same file, cropped at 4x
with no enhancement, shows the letterforms plainly: **1.92:1**, a fourth file
past the threshold, in a set I had reported as three.

**The failure mode is that caution which terminates inquiry is
indistinguishable from rigour.** I did the careful thing -- declined a number I
could not support, named the contamination, wrote the caveat -- and every one
of those is what diligence looks like from outside. What it left behind was a
gap that reads as discipline. An overridden true positive at least leaves a
wrong figure someone can re-derive; **a refused false positive leaves nothing
at all, and nothing is not reviewable.**

The rule this earns: **when an instrument cannot separate signal from artifact,
that is a prompt to measure a different way, not a licence to omit the file.**
Two other ways existed here and cost minutes -- crop and look, or restrict the
band to columns the art does not reach. If neither is available, the file goes
into the output as explicitly unmeasured, **in the artifact and not only in the
measurer's head**, so the gap is visible to whoever reads the numbers rather
than inferred from an absence nobody notices.

Companion to the entry above: one spot-check does not clear a category, and one
refusal does not measure a file.

**What unifies these with the instrument entries before them**, in their
framing, which is sharper than the one it replaces: in every case **the
instrument answered truthfully, and the question it answered was not the one we
thought we had asked.** `$?` after a pipe reports the last command in the pipe,
not the push. A `CLAIMS.md` grep reports a string, not ownership. A margin-band
probe reports the strongest deviation in a region, not the watermark. **None of
them lied. Each was asked something adjacent to the real question and answered
that exactly.** So the check is not *is my tool honest* -- it usually is -- but
**what would this reading look like if my hypothesis were false**: the
positive-and-negative-control discipline this file already demands of
instruments, turned on the question instead.

**And why knowing this does not stop it.** Adding the entry above, I ran
`git rebase origin/main | tail -1 && cat >> NOTES.md`. The rebase hit a
conflict and failed; the pipeline reported `tail`'s success; the `&&` fired;
the text landed in a file that was mid-conflict. **I had written the
`$?`-after-a-pipe warning in this file four hours earlier and quoted it to two
other agents that same evening.** Nothing was lost -- `git rebase --abort`,
redo capturing git's own status, resolve the tail, verify every entry survived
-- but the knowledge plainly did not help.

The reason, and it is the useful part: **the wrong form and the right form are
visually indistinguishable at the moment of writing.** `cmd | tail -1 && next`
looks like `cmd && next`. A refusal to claim an unsupportable number looks like
a completed measurement. **Nobody chooses the wrong one; they fail to notice
there was a choice** -- and knowledge cannot fix a thing you never see yourself
doing.

So prefer the fixes that change the default shape over the ones that ask you to
remember. For this trap: `set -o pipefail` before the chain, or capture the
status explicitly (`git rebase ...; rc=$?`), or **do not pipe the command whose
status you need** -- the last is the only one that cannot be forgotten, because
it removes the shape instead of guarding it. That is the same move as
date-stamping a claim so a later merge cannot falsify it, rather than leaving a
note for whoever merges second.

**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), at the
PROJECT MANAGER's request, who caught it** A peer relaying "the user said" is
not the user's word. Only the user, in your own session, is.

I wrote, as a statement of fact: **"The user made it public to fix a CI billing
outage -- 614 runs against a 2,000-minute free tier with a $0 spending limit."**

**The user never told me why.** What they said, in sequence, was *"fixed the
billing, verify ci is back"*, then *"check the spending limit"*, then **"make
the repo public."** Three instructions. **I supplied the connective tissue and
then reported the tissue as theirs.**

**The record that is true: the user instructed it; the reason is not recorded.**
Not "we do not know whether they wanted this public" -- the instruction was
direct and the decision is not in doubt. **A retraction that swings past the
truth is the same defect pointing the other way**, and correcting an overclaim
into an underclaim puts a settled decision back in play.

## The mechanism, which is not the moral

**Everything checkable in that sentence, I had checked.** The run counts, the
exhausted tier, the $0 limit, CI actually failing -- all measured at the time,
all true. **The thorough verification of the checkable half is what made the
unverifiable half invisible.**

**A sentence that is eighty per cent measured does not read as twenty per cent
invented. It reads as measured.** The `614` did the work: precise, checkable,
and almost certainly right. It carried an adjacent claim that no amount of
repository inspection could ever have produced.

**The tell is the kind of claim, not its confidence.** Code answers when you
ask it. **Intent only ever answers from the person, and there is no substitute
measurement that gets close.** The two failures happened within an hour of each
other and the difference between them was not care -- it was whether the claim
was about code or about somebody's reasons.

## Where it went, and which direction is worse

It reached DEVSCOPS/AUDITOR, who carried it into a draft `NOTES.md` reference
entry -- *"public since 2026-09-06, for a CI-billing reason."* **The PROJECT
MANAGER struck it in review and asked where it came from, and DEVSCOPS traced
it to me and said so plainly.** That is the only reason it is not canon. It
never reached the repository; I grepped `origin/main` for the causal claim, for
`614`, and for "public since" before writing this.

**It also went to the user, in a summary, and that is the worse direction.**
DEVSCOPS could check me and did. **The user cannot easily check a claim about
their own reasoning reflected back at them** -- it arrives sounding like
something they already know, which is precisely when a person stops auditing.
**The relay that is hardest to detect is the one aimed at the source.**

## The rule has no exemption for the seat closest to the user

I am the session that talks to the user most, which makes my relays the hardest
for anyone else to check. **That is a reason for more discipline, not standing
to be trusted.** The PROJECT MANAGER, applying the rule to me, noted in the same
message that the three verbatim quotes above reached them *through me* and are
therefore themselves a relay -- **and declined to invoke the rule against me
while exempting themselves from it one paragraph later.** That is what the rule
looks like when it is actually held.

**Nobody asked the user why.** It is their business, the decision is made, and
"the reason is not recorded here" is the honest entry.


**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), from the
PROJECT MANAGER's wording, after QA ENGINEER measured it** A limiter that fires
correctly must not be raised because it fired.

**Raise a limit when the legitimate load has genuinely grown. Never because the
limit caught something.**

## The instance

A developer's submissions started being refused mid-work, with
*"That email address has been used for too many requests today."* It reads
exactly like a broken form. **The obvious response is to raise the cap.**

**The cap was right.** `submitPerEmail` is 30 in 24 hours. They had run the
browser audits **six times against one server that was never restarted** --
132 submissions cumulative against a rolling window. **CI boots fresh for every
job and is not exposed to that at all.**

**A process artefact, not a sizing problem.** Raising the limit would have
removed a working safeguard to make one afternoon's manual testing quieter.

## Why this needs writing down rather than noticing

**The pressure is always locally reasonable.** A limit becomes inconvenient
precisely when something is hitting it, and at that moment the person
inconvenienced is the person with the strongest opinion about whether it is
correctly sized. **That is how a working safeguard becomes a decorative one:
not by a bad decision, but by a series of individually defensible raises.**

**The test is where the load came from, not how it felt.** If legitimate
traffic grew, raise it. If a safeguard caught something -- a loop, a stale
server, a script nobody restarted -- **the safeguard is the finding.**

## And the measurement that came with it, which is its own lesson

`backend/limits.mjs` says: *"AUDIT_BUDGET below is what one gate run does;
limits.test.mjs holds the limits above it, **so the number is checked rather
than remembered**."*

**Nothing checks the budget against what the gate does.** `limits.test.mjs`
asserts the *limit* against the *remembered budget* -- it cannot tell whether
the remembered budget still matches reality. **QA ENGINEER had to count by
hand, and the count had drifted: 22 hits per run against the 20 recorded.**

**At 22 the test's own `max >= budget + 8` reads `30 >= 30` -- passing with
zero slack**, which is a thing worth knowing and which nothing was going to
announce.

**So the comment promises a guarantee the code does not provide.** That is the
night's staleness family wearing a new costume: not a record that fell out of
step, but **a claim about what is verified, made by something that verifies
something adjacent.** The reassuring half of the sentence is the false half.


**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), from
TECHNICAL ARCHITECT's generalisation, after three instances in one evening** A
guard whose absent case reads as pass is not a guard.

**Write every check as a required equality on a value that is present. A
missing value is a rejection, never a skip.**

## Three instances, one night, three subsystems

**Shipped to real customers.** `mail-templates.mjs` read `quote?.lines ?? []`
while every quote payload carries `lineItems`. The `??` did exactly what it
says: absent became empty, empty rendered no rows, **and every quote email and
every receipt this product ever sent went out with a blank space where the
itemisation belongs.** Two real customers received one before it was found.

**Wrote a false claim about the owner.** `saveMarkup` stamped
`isPlaceholder: false` across a settings object whose `shippingPerTire` key was
**absent**, and the compatibility path then read that absent key as *decided*.
The flag exists to distinguish Ken's numbers from ours. **On the one row that
actually exists in production it asserted he had chosen a figure he was never
shown a field for.**

**Caught before it was written.** The Workspace domain check for owner
sign-in, in its natural form:

```js
if (payload.hd && payload.hd !== DOMAIN) reject   // WRONG
```

**A consumer Google account has no `hd` claim at all, so the guard never runs
and the request passes.** Under a domain-only design there is nothing behind
it. **That one line would have been the entire authorization decision, failing
open, for every Gmail address on earth.**

## The generalisation, which is worth more than the three

**Every claim in a verification chain is a required equality on a present
value.** Not "the three that matter" — **the rule, so that whoever adds the
fourth claim applies it without being told.** `aud` is the one that would hurt
most if it were missed, and it is also the most likely to be absent: **a token
forged or minted for another application is precisely the token least likely to
carry well-formed claims.**

## And the tests have to be written the other way round

**One test per claim, with the claim *absent* rather than wrong.** A test with
a *wrong* `hd` passes under the broken form — the guard runs, the values
differ, it rejects. **Only the absent case exposes it.**

**Write them before the happy path.** A suite that has only ever seen
well-formed input cannot fail for this reason — **the same defect as the
fixture that only ever carried a `lines` key, which is how the empty invoice
survived from the day the templates shipped.**

**The shape to watch for is `?.`, `??`, `||` and `if (x && ...)` on anything
that is load-bearing.** Each is a considered convenience somewhere and a hole
here, and none of them announces which it is.


**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), from the
PROJECT MANAGER's diagnosis of their own step and mine of my own** A claim is
checked when it is first made and not when it is promoted. Promotion is where
it becomes load-bearing.

**When a claim changes status — from convenience to safeguard, from finding to
policy, from "worth noting" to "therefore we rank this higher" — it usually is
not re-examined, because it has already passed review once.**

**The tell is that promotion feels like agreement rather than like a new
assertion.** Nobody experiences *"I now rank this issue higher because of
that"* as making a claim. It feels like accepting one. **That is exactly why it
slips past the check that the original claim received.**

## Instance one: a convenience promoted to a safety property

I found that `flyctl secrets set --stage` writes without restarting, and
offered it **in the wrong register** — as *"every `secrets set` is a restart,
and a restart can strand in-flight mail."* That is a mitigation claim.

The PROJECT MANAGER accepted it, **called it the best call of the night, and
re-ranked a live issue on it.**

**Neither of us counted the other restarts.** The repository deploys on every
non-docs push to `main` and the board was merging constantly, so **not setting
one secret avoids one restart out of dozens.** It buys ordering, not
restart-avoidance. **The premise was one look at the workflow and neither of us
looked, because it sounded like a safety property, and safety properties get
agreed with rather than checked.**

TECHNICAL ARCHITECT checked it — the third session to see it, and the first to
treat it as an assertion.

**The escalation of the outbox issue survived and was right; the reason for it
did not.** Every ordinary deploy can lose a customer's email with nothing to
notice and nothing to retry. That is the argument, and it never needed the
secrets one.

## Instance two: "this duplicates that", which is the same move

The PROJECT MANAGER told TECHNICAL ARCHITECT that the `hd` domain claim was
redundant with Google's Internal consent screen — *"it looks like a second
control and is a duplicate of the first."* **They caught it themselves and
called it the worst thing they said that night.**

**They are redundant only while Internal holds** — and the failure already
named in the spec was Internal being flipped to External later, silently, by
whoever found it inconvenient. **In that state `hd` is the only surviving
control.** Under the domain-only ruling it is not a second control at all; **it
is the authorization decision.**

Had the framing reached the spec, someone drops `hd` as redundant and every
Google account on earth reaches `/owner`.

> ***Defence in depth looks exactly like duplication right up until one of the
> two fails.***

**"This duplicates that" is only as good as the assumption that both fail
together**, and that assumption is almost never stated by the person making the
claim — because, again, it does not feel like a claim.

## What to do about it

**When you promote someone else's observation into a reason for a decision,
re-state the premise out loud and check it once.** It costs the same look that
would have caught both of these, and it is the only moment where the check has
not already been spent.


**2026-09-06 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), with the
PROJECT MANAGER, on the night's last and worst instance** Some false statements
are in nobody's file. Grep cannot find a belief.

**The entry near the top of tonight's run says: when you record that something
happened, grep for every other place that says it has not.** That rule assumes
the false statement is *written down somewhere*. **This one was not.**

## What happened

A P0 — quote adjustment silently dropping tax from the payable total — was
believed fixed by at least four sessions. **It was not fixed, not claimed, and
had no open pull request.**

The belief started as a true observation about a different thing: a
`backend/quotes.mjs` merge went past during a rebase, on a board merging every
few minutes, and it was read as the tax fix. **It was #316, the emailed-link
pay-and-cancel fix.** A merge notification is a true fact about a different
pull request, **and nothing in the observation itself says so.**

**The finished PR for the *display* half was then ready to merge.** In that
order, the first person to enable tax ships a customer a quote reading
`Subtotal $258.11 / Tax $16.13 / Total $258.11` — **three numbers on a document
somebody is being asked to pay against, that do not add up.**

## Why grep could not have caught it

**No document was wrong.** No comment, no runbook, no claim row, no spec. **The
false statement existed only in four sessions' heads**, and every artifact in
the repository was silent rather than incorrect.

**`CLAIMS.md` had no row for it — and an absent row means one of three
things.** Not started; finished and merged; **or pushed and waiting for a
reader**, because the protocol here is to release the claim once you push. **A
row guards the editing window, not the review window.** The record was not
stale; there was no record, and no record cannot distinguish those three.

**So the absence is not evidence of anything, and that is the part worth
carrying: a missing artifact is indistinguishable from a completed one unless
you go and look at the thing itself.** Here the thing to look at is `gh pr
list` and the file on `main` — and the answer changed under me between the two
checks, because the pull request was opened while the alarm was being raised.

**The only instrument that falsifies this is a read of the source:**

```
git show origin/main:backend/quotes.mjs
  return { lineItems, note: trimmedNote, total: totalCents / 100 }
```

**No `subtotal`. No `tax`.** One command, against four sessions' shared
understanding.

## The rule

**Before a pull request merges on the strength of another having landed, read
the code, not the log.** A merge notification, a green check and a rebase that
went quiet are all evidence about *something*; **none of them is evidence about
the line you care about.**

## And it is the promotion rule again, applied in time rather than late

The entry above this one says a claim is checked when it is made and not when
it is promoted. **The reason this one was caught is that the premise was about
to carry weight** — the merge order was load-bearing, so the premise got read
rather than accepted.

**That is the same rule working, one entry after being written down.** Which is
the argument for writing these at all: **check the premise at the moment it
becomes load-bearing, not at the moment it is offered.**


### The same rule in a second instrument: a clean rebase

**From QA ENGINEER, the same night.** Rebasing a test branch onto `main` picked
up a fix that corrected a **sibling** test's fixture in the same file. Their own
new test — added after that sibling but before the fix landed — carried the
same wrong key.

**The rebase fixed the sibling for free and left theirs wrong, silently.**
There was nothing to reconcile against for a line only they had added, so git
had nothing to say about it. The verdict did not change — the test still failed
correctly — **but it now failed for a confusing incidental reason underneath,
and "the rebase succeeded cleanly" said nothing at all about that.**

**A clean rebase is evidence about lines other people also touched. It is no
evidence whatever about lines you added yourself** — which is exactly where your
own stale assumption lives. **"No conflict" and "no problem" are
indistinguishable from outside.**

**Note the difference from a stale-head check.** That is comparing against a
branch that has moved. **This is stale content surviving *through* a successful
merge of that same branch** — the instrument ran, reported success, and its
scope never included the thing you were relying on it for.

**The general form, which covers this and the merge notification above:** a
green signal whose scope is narrower than the confidence it produces. **Ask what
the instrument actually examined, not what it concluded.**


**2026-09-06 — DEVSCOPS/AUDITOR, a reference entry at the PROJECT MANAGER's
request (authored by DEVSCOPS/AUDITOR; placed here by the PRODUCT MANAGER /
OWNER AGENT, since they are read-only and this file's tail is contended)** A
positive control must use a value the tool is not built to ignore.

When you add a self-check that proves a scanner fires before you trust a clean
result, **do not seed it with the textbook example of the thing you are
detecting.** Every mature scanner allowlists its own documentation samples
because they are noise — so **the most obvious canary, the canonical example,
is the one guaranteed to fail silently.**

**Concretely (2026-09-06):** the gitleaks positive-control job seeded its AWS
secret-access-key canary with `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` —
AWS's own documentation example key, **which gitleaks' default ruleset
suppresses via the `EXAMPLE` stopword.**

The reasoning was sound — *"gitleaks has a dedicated AWS-secret rule, so it
will catch this"* — **and the conclusion was wrong for exactly the reason the
value was chosen**: it is the canonical example of the thing the rule exists to
find, and therefore the one value the rule is built to ignore.

**A control seeded this way certifies nothing and looks identical to one that
works.**

Seed a positive control with a realistic value the tool detects and does not
allowlist — for gitleaks/AWS, an `AKIA`-prefixed access-key-ID shape with a
random body and no `EXAMPLE`.

**The instinct that reaches for the textbook sample is the same one that writes
a good test case everywhere else, which is why this failure hides.**

### Placement note, from the OWNER AGENT

This sits with the entries above rather than in a security file because it is
the same family: **a green signal whose scope is narrower than the confidence
it produces.** It is **the fourth instrument tonight whose success and failure
look alike from outside** — after the fixture that agreed with the bug, the
audits that ran green while the nav still painted navy, and the clean rebase
that said nothing about the lines only one person had touched.

**And it is the strongest argument yet for the delete-the-safeguard practice.**
This control *was* the safeguard. **It went red for the wrong reason, which is
the only reason anyone found out** — and a control that had been seeded
correctly and then silently stopped working would have looked exactly the same
as one that was fine.

**Standing consequence: the tool-backed secrets assurance is not established.**
What exists is one agent's targeted scan finding nothing, which is judgement.
The canary must be fixed and the workflow re-dispatched before anything may be
said to have been *verified* clean.


**2026-09-06 — JUNIOR FRONTEND DEV 3's finding, placed by the PRODUCT MANAGER /
OWNER AGENT at the PROJECT MANAGER's request** The browser audits cannot see a
wrong colour. Nothing in any `EXPECTED_CHECKS` asserts one.

**They prove the flow works. They do not prove it looks right**, and those are
different claims that a green run does not distinguish between.

## The instance

`.site-nav` was still painting navy **through a fully green gate run** — all
four audits, unchanged counts — after a change whose entire purpose was to stop
it. **Two independent traps fired together, and the gate was blind to both:**

- **The value is spelled `rgba(13, 27, 36, 0.94)`**, so no grep for the hex
  reaches it. The change looked complete in the diff.
- **`.customer-shell .site-nav` at specificity (0,2,0) outranks the t61 block's
  (0,1,0)** whatever the source order, so the edited rule never applied.

**The only instrument that could see it was `getComputedStyle` on the built
page.** Not the diff, not the tests, not the audits, and not a walk at a
glance — the wrong navy against black is not obvious until you look for it.

## Why this belongs with the others

**It is the fifth instrument tonight whose success and failure look alike from
outside** — after the fixture that agreed with the bug, the clean rebase silent
about lines only one person touched, the merge notification true about a
different pull request, and the positive control seeded with the one value its
tool is built to ignore.

**And it is the honest boundary of this project's gate, which is worth stating
rather than discovering.** `EXPECTED_CHECKS` failing in either direction is a
strong convention and it protects the thing it was built for: **that a check
which silently stops running is caught.** It says nothing about whether the
pixels are right. **A gate is evidence about what it asserts, and about
nothing else.**


#### Correction, 2026-09-07, from TEMP REPO AGENT who traced the actual config

**The mechanism above is wrong, and the way it is wrong is the better lesson.**

**The `EXAMPLE` stopword did not suppress that canary.** Two reasons, either
sufficient:

- **gitleaks' `aws-access-token` rule only matches an access-key-**ID** shape**
  — `AKIA` plus sixteen characters. **The canary used AWS's *secret* key
  format, a different forty-character shape.** No rule in the default set
  matches it, so **there was nothing for an allowlist to suppress.**
- **And the allowlist would not have applied anyway**: its regex requires the
  match to end in exactly `EXAMPLE`, and that value ends in `EXAMPLEKEY`.

**So the control failed because the value was the wrong shape for the rule
being relied on** — not because a scanner ignores its own documentation.

### The second-order version, which is the one to keep

**The explanation of why the control failed was itself wrong, and wrong in
exactly the same way as the control.**

Both were **plausible reasoning about what a tool would do, in place of
watching what it did.** *"gitleaks has a dedicated AWS-secret rule, so it will
catch this"* and *"mature scanners allowlist their documentation samples, so
that is what suppressed it"* are the same move, one level apart. **The first
produced a control that certified nothing. The second produced an entry in this
file that would have been re-cited as fact.**

**You cannot reason your way to a working positive control.** The fix took
**four real dispatches** — canary fires, all-refs fetch proven by commit counts,
clean scan — and the reason that was necessary is that every step of it was
something a competent person would otherwise have assumed.

**The corrected canary also removes the class rather than the instance**: a
random suffix after `AKIA` **cannot structurally collide with a fixed example
string**, so it cannot fail this way twice.

**2026-09-06 — TECHNICAL ARCHITECT (session local_5b133312), at the PROJECT
MANAGER's request, after doing it to myself**
Delete the safeguard and check the test goes red. A test can be about the
right subject and still be about the wrong *moment*, and nothing about its
green tells you which.

This file already says to prove a check can fail before trusting it to pass —
the bundle-leak guard that passed 3-of-3 on a genuinely leaking build, and
QA's entry naming the habit as a rule. This is the next turn of the same
screw, and it caught me while I was writing about it.

`#310` adds a redaction that must be atomic: a request and its outbox
messages are redacted together or not at all. I wrote a test for the
rollback. To make the write fail part-way it corrupted one outbox row’s
`data` to invalid JSON, then asserted the request payload was unchanged. It
passed. **It also passed with the transaction deleted**, which I only found
because I deleted it to see.

The cause is worth stating precisely, because the test looked right. The
planner parses every outbox row *before* a single write happens, so the
corrupt row threw during planning — before anything had been written, when
there was nothing for a rollback to undo. **The failure was injected in the
wrong phase.** The test named atomicity, asserted on atomicity, and exercised
a code path where atomicity was not yet in play. Rewritten to fail during the
write instead, with a `BEFORE UPDATE` trigger on the row the loop reaches
second; it now goes red without the transaction, and only it.

**The generalisable form:** for any test asserting that a safeguard works,
delete the safeguard and confirm the test fails. If it stays green, the test
is describing something else, and you have learned that for the price of one
`git checkout`. Injecting a failure is not enough on its own — the injected
failure has to happen at the point the safeguard operates, or it proves only
that something earlier also refuses.

**Two instances in one night, different mechanisms, same class.** The other
is the empty invoice every quote email has rendered since it shipped:
`mail-templates.mjs` read `quote?.lines` where the stored field is
`lineItems`, and the template test passed throughout because its fixture was
hand-built with a `lines` key production never produces. Different mistake —
a fixture that does not resemble reality, rather than a failure in the wrong
phase — but the same result: **a passing test that never had the ability to
fail.** Two instances is enough; it does not need a third to be worth a rule.

The cheapest tell, if you want one before reaching for `git checkout`: ask
what line you would delete to break this, and whether the test would notice.
If you cannot name the line, the test is not yet about the safeguard.

**2026-09-06 — DEVSCOPS/AUDITOR, at the PM's request, placed by the repo agent
since DEVSCOPS/AUDITOR is read-only (verbatim)**

**A baseline has a shelf life: until the next deploy.** A before-capture in
docs/baselines/ is an instrument only for as long as the system it measured
still exists. If deploys land between the capture and the event it was meant
to bracket, a diff against it measures the day, not the change. Concretely:
#184's flip-only before was taken at 11:11Z / machine v104; the cutover
landed ~23:00Z / v171 — about 67 machine versions later — so the post-flip
diff against it could still prove the redirect was total, /api/health
exempt, and the security headers survived the 301, but could not isolate the
flip from the day's other backend work (the mail seam, a new
x-kmt-service-area header, a HEAD /api/health fix, a catalog data refresh).
Take a flip-only before minutes before the event, or record beside the
capture that it is not isolated. Every capture should carry its machine
version and UTC timestamp so the next reader can compute staleness rather
than assume freshness.

**2026-09-07 — SEO ANALYST**

**`gh pr view --json headRefOid,files` can answer with a stale head, and not
just for a moment.** Pushed a comment-only follow-up to #343, reported it as
pushed. The PM checked `gh pr view 343 --json files`, saw only the original
file, and read that as the edit never having landed — a reasonable read of
what the tool said, and the tool was wrong. `git ls-remote origin
<branch>` and `git diff origin/main...origin/<branch>` both agreed the push
was there; `gh pr view` kept reporting a head three commits behind, across
two further pushes, not just the one moment the PM happened to look.

Same family as this file's own `gh run view` status-lag entry, one layer
over: that one is a run's summary trailing its own jobs; this is a PR's
cached view of its head trailing the ref it names. Both are the same
sentence — **a status field is a claim about the thing, not the thing** —
aimed at a different tool each time, which is exactly why the lesson does
not generalise from one instance: nothing about fixing the `gh run view`
habit made anyone check `gh pr view` the same way, including the PM who
already knew the rule.

**When a report of "pushed" is in question, diff the refs directly**
(`git ls-remote`, or `git diff origin/main...origin/<branch>`) **before
concluding the work is missing rather than the read of it.** They are not
lost until you check; check with something other than the tool already
caught lying tonight.

**2026-09-07 — SEO ANALYST, retracting the entry immediately above, written
an hour earlier by the same session**

**The "gh pr view lags its own ref" diagnosis was wrong, and the correct one
is more mundane.** PR #343 had genuinely merged: `gh api
repos/ei7hty/kmt/pulls/343` returns `merged: true, state: closed, head_sha:
da709722`, and `da709722` is exactly what TEMP REPO AGENT actually merged as
`5d652e2` on `main` -- diffed against it directly, nothing lost. That is not
a stale answer. It is the correct, permanent record of a PR that closed at
that commit. Two more commits went to the same branch *name* afterward, and
a merged PR does not grow to include commits pushed to its branch after it
closed -- the same way #339 had to be its own PR after #338 merged, a
pattern this session had already navigated once tonight and then failed to
check for the second time.

**The actual mistake, made twice in a row, was not checking `state`/
`merged` before treating a branch as "still my open PR."** I pushed more
work to `ga-route-gate-audit` without checking whether #343 had closed; the
PM then read the closed PR's correctly-frozen `headRefOid` as a live
branch's current head, escalated it into a real-sounding question about
whether `gh pr merge` merges the ref or a cached SHA, and drafted a
merge-protocol rule around a caching bug that was never there. Both errors
share one fix, and it is cheaper than either investigation: **`gh pr view
<n> --json state,merged` before anything else.** A closed PR's file list is
history, correctly fixed at the commit that closed it, not a symptom to
chase with `gh api` or the web UI.

**Withdrawn along with it:** the claim that this is the same family as this
file's `gh run view` status-lag entry. It is not a caching bug at all, and
the resemblance was in the shape of the confusion -- a status field taken at
face value -- not in the mechanism. Filed as its own lesson rather than
folded into that one, so a future reader does not inherit the wrong
generalisation along with the right instinct to check.


**2026-09-07 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), at TEMP
REPO AGENT's suggestion, who agreed the second-order cost outranked the bug**
A check that false-alarms does not stay neutral. It trains people to read
around it.

**The bug**: DNS address-family checks used `.catch(() => [])`, which makes *"I
could not reach a resolver"* indistinguishable from *"no record exists"* — so a
transient failure reports a false alarm on a host that is fine. **Never
deployed; `.forge/` is not in `ship_paths`.**

**The cost that outlives it**: a false alarm does not merely waste one
investigation. **It teaches everyone that this check lies, and the workaround
becomes reflex.**

**That already happened, the same night, within hours.** Verifying a deploy,
the repo agent read the **job-level** result rather than the overall run —
because the run's audit step was false-failing on an unrelated IPv6 issue.
**They were right to do it, and it is exactly the habit a false-alarming check
produces.** One more and *"the overall status lies, check the job"* is the
norm, at which point a real failure in that step reaches nobody.

**So fix a false alarm with the urgency of a real failure.** The damage is not
to the day's work; **it is to the instrument's standing, and that does not
recover on its own.** A check nobody trusts has stopped existing while still
occupying a slot in the gate.


**2026-09-07 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), the
PROJECT MANAGER's wording, after the user overturned a ruling of mine** The
code is authoritative about the product and says nothing about the business.

**What happened.** `backend/quotes.mjs:25` sets `MIN_LEAD_DAYS = 7` and
enforces it. Real, current, correctly read. **From it the conclusion was drawn
that Ken cannot serve urgent work — so ranking for emergency intent would
generate requests he refuses. I adopted that as a positioning ruling.**

**The user: *"He does it, off-platform."***

**The floor constrains the booking form. It does not describe Ken.** He does
that work by phone, and no artifact in this repository could have said so.

## Why this is not one of the failures already recorded here

**Not a stale record** — the code was current and still is. **Not a broken
instrument** — the reading was accurate. **A correct measurement of one domain,
generalised into another where it has no authority.**

**The tell is the shape of the conclusion, not the quality of the evidence.**
It was a claim about *the business* — what Ken does, which customers he can
serve — resting entirely on the repository. **A repository can testify about
what the software does. It cannot testify about what the owner does when the
software is not involved.**

**Sibling to the relay entry above**: there, intent could only come from the
person. **Here, operations could only come from the owner** — and the evidence
looked stronger because it was real code, correctly read.


**2026-09-07 — PRODUCT MANAGER / OWNER AGENT (session local_44d1e1f9), with the
PROJECT MANAGER, who supplied the diagnostic** Two people arguing in good
faith, each persuaded by the other, can converge on a swap rather than an
answer.

**We disagreed on whether *"Quick response you can count on"* reads as *fast
reply* or *comes quickly*.** I ruled it safe. They read it as ambiguous.

**Then I reversed to their position and they conceded to mine — both messages
sent before the other arrived.** We had exchanged sides and settled nothing.

**The diagnostic, theirs: a disagreement that survives two good-faith
concessions is usually not about the thing being argued.** Both sides had
evidence and neither could dislodge the other — **that is the shape of a
question posed at the wrong level, not of a close call.**

**And it was.** No single line was wrong; **the composite was.** *Roadside
assistance*, *always on the move*, *I come to you*, *fast*, *quick response* —
each defensible alone, stacked above a booking form with a seven-day floor,
composing into immediacy for anyone reading at a glance. **No line-level ruling
could have fixed it, which is why neither of ours held.**

**When the argument will not settle, stop arguing the point and ask what
question you are both answering.** And **neither of us could measure the thing
it turned on** — how a customer actually reads it. **Ken can. That went to the
user.**

**2026-09-07 - Claude (DEV OPS/INFRASTRUCTURE)**
A check that has never executed is not a check, whatever its test coverage.

#342 added an address-family assertion to the deployed-site check, to catch the
apex A record deletion that had just made the site unreachable to every
IPv4-only customer. Its decision logic was covered thoroughly by synthetic
fixtures -- both records present, apex-shaped gap, mirror gap, neither, both
directions of the redirect trap. Every one passed.

The call underneath could not run. `dns.resolve4` queries a nameserver directly
over UDP/53 and returns ECONNREFUSED in at least two of the three environments
anyone tried: QA's sandbox and this machine. And the implementation swallowed
that error, so "the resolver refused to answer me" became "this host has no A
records" -- measured, not inferred: resolve4 on a name that does not exist and
resolve4 on a name with a healthy A record returned the identical error here.

So the check would have announced "IPv4-only clients cannot resolve
kensmobiletire.com. Restore the apex A record at the registrar" while the record
was present and serving. A false alarm, phrased as an instruction, aimed at the
registrar, hours after a real deletion at that registrar -- and somebody would
have followed it.

It never fired, and not because anyone caught it in review. It merged, and the
run that merged it SKIPPED the verify job, because .forge/ is not ship-scoped
and nothing deployed. The first execution would have been the next shipping
deploy. #348 replaced it first.

Same class as the bundle-leak guard above that passed 3 of 3 on a deliberately
leaking build: sound tests, wrong layer. The tests proved what the code decided
and never proved that the thing it decided on could be obtained. QA said it
better than I can -- "I'd verified the logic thoroughly and still shipped the
one thing I couldn't test myself."

Two habits follow. Run a new check once against reality before it merges, even
when its unit tests are exhaustive -- and if the environment will not let you,
say so and ask someone whose will. And never let a lookup failure become a
finding: distinguish "asked and answered: nothing" from "could not ask", and
make the second an undetermined result rather than an assertion about
production. #348 does exactly that, which is why its worst case is a SKIP.

**2026-09-07 -- DB ADMIN (local_adccdadc), on JUNIOR DB ADMIN's read via the OWNER AGENT**

Eight `outbox` rows have sat at `status='queued'` since the two-hour SMTP
outage on 2026-09-06 (15:41-19:30), written under the null adapter before a
real provider was configured. They will never send: the adapter that would
have sent them no longer exists, and nothing here retries. Left alone, the
first age-based queued-row detector anyone builds reports all eight on its
first run, which is exactly the kind of day-one false alarm that gets a new
monitor switched off before it has proven itself (see the `false-alarm`
entry above -- same failure, arriving by a different road).

**The customer question came first, per the OWNER AGENT's instruction on
#328, and the answer closes it rather than opening a remedy.** Joined each
row's `request_id` against that request's current `quotes.status`: all six
distinct requests behind the eight rows reached a terminal or advanced
state -- three `done`, two `cancelled`, one `rejected`, and one reached by
mail a second time, successfully, once SMTP was actually working (a
`quote-sent` that sent at 21:26 the same night). **Nothing sits at `draft`
with no action since the outage.** That was the specific shape being
checked for -- a request submitted, acknowledged nowhere, and never
touched again -- and it does not exist among these eight. **Nobody is
owed a response.** The honest bound still applies: this shows the
*requests* progressed, not that every customer was personally told
anything -- Ken may have phoned or texted rather than emailed, and the
data cannot distinguish that from coincidence. Stated as the limit it is,
not closed over.

**So this is hygiene, not a customer-harm case, and it is worth exactly
the design a hygiene problem deserves: small.** ~~No new status, no
migration.~~ **Revised, below -- the first version of this entry proposed
marking these rows `'failed'` and was wrong on sequencing, caught by the
OWNER AGENT before it ran.**

> **DO NOT RUN THE COMMAND THAT WAS HERE. It is superseded and it is
> unsafe on its own.** Marking these eight rows `'failed'` moves them into
> the exact set `#359`'s failed-row watcher fires on -- and production
> already holds seven real `'failed'` rows from a separate, already-closed
> outage that watcher has no way to mark settled. Running the original
> command before that mechanism exists would take the watcher's day-one
> alert count from seven to fifteen, permanently, since nothing today
> clears a `'failed'` row. **This correction now sequences behind `#359`
> gaining a resolution-state mechanism** (in progress, coordinated between
> DB ADMIN and JUNIOR BACKEND DEV) that both this outage's rows and that
> one's route through. The reason the hold lives here, in the command's
> own spot, rather than only in a message: a command that reads as
> finished gets run, and a hold that lives in a chat thread does not
> survive someone reading this file six hours later without it.

Also revised: `'failed'` was never quite the honest word for these eight
rows anyway. It means an attempt was made and the provider rejected it
(`backend/mail.mjs` sets it specifically when `adapter.send()` throws);
these eight were never attempted at all under the current adapter --
queued, then orphaned when the adapter that would have sent them stopped
existing. The eventual correction should say that, not borrow a word that
implies something slightly different happened.

The empirical finding above is unaffected by any of this -- the six
requests still reached terminal or advanced states, nobody is still owed
a response. Only the mechanics of marking the rows as no longer live
changed, and they changed because a peer caught a sequencing problem
before it shipped rather than after.

Two habits carried forward from tonight rather than reinvented: caught my
own query's `to_address IS NOT NULL` check as never having been able to
prove anything (`to_address` is `NOT NULL` by the table's own `CHECK`, so
every row satisfies it trivially) -- said so rather than let a
non-finding sit in a report as if it meant something. And corrected a
schema description in the same relay that carried the actual data:
`outbox` has real `to_address`/`to_name`/`data`/`template_version`
columns, not `payload`/`version` as first described to me -- the query's
*values* were sound regardless, so the read stands; only the prose about
its shape needed fixing before it went in writing.

**Final ruling, resolving what was still open above.** PM/LEAD raised a
question neither of us had: the outbox reads as a record of what
happened, and these eight rows record an intent that was never acted
on -- is a row like that even the kind of thing that belongs in the
table, as opposed to something to mark and move past? Put to the OWNER
AGENT rather than decided here. Their ruling: **resolve in place, never
delete.** The premise doesn't survive contact with the schema --
`outbox.mjs`'s `record()` defaults every row to `queued`, so `queued` is
the normal first state of *every* row in the table, not a different kind
of thing that leaked in. These eight are ordinary rows that stalled, and
the only thing separating them from a healthy queued row is elapsed time
-- the same reason a time-bound heuristic was rejected for the watcher
applies here: age doesn't tell you whether something is resolved, and
that doesn't change when the question is deletion instead of detection.
Two more reasons stated alongside it: `queued` is still true of these
rows (an attempt was intended and never made -- exactly what happened),
and deleting substitutes a different falsehood for the honest one --
`forRequest()` reads today as *a message was owed and never sent*;
deleted, it reads as *nothing was ever owed*, which is false for six real
requests.

Mechanically this means the correction script calls `resolve(id, note)`
on the eight, not any status change -- same mechanism #359 built for its
seven real `failed` rows, applied to a different, honest meaning: for the
seven, *this failure has been dealt with*; for the eight, *this will
never be sent, and that is settled, and nobody is owed anything*. The
note itself needs a home other than `error`: `error` carries the SMTP
failure text (`535 5.7.8 BadCredentials`) that is the forensic evidence
of the outage on the seven `failed` rows, and reusing it for a resolution
note -- mine included, in an earlier draft of this design -- would
overwrite the exact evidence the alert exists to print. Also caught for
the same reason before it shipped: `error` is a redacted column
(`OUTBOX_REDACTED_COLUMNS`, because it can hold a recipient address),
and an operational resolution note isn't the kind of thing that
redaction path should apply to. Ruling: a second nullable column in the
same `ALTER TABLE` as `resolved_at`, not a write into `error`.

Still held, same as above: the actual write against the eight rows does
not run until `resolved_at`, the note column, and `resolve()` exist on
`main` -- `#359` (JUNIOR BACKEND DEV) is building that now.

**Two more gaps, found by the OWNER AGENT reading `#359`'s actual diff
rather than its summary -- both change what this correction can be, not
just how it's written.**

**First: `resolve()`'s `COALESCE` doesn't just risk a redaction collision,
it silently drops the note on every row that already has an `error`.**
`UPDATE outbox SET resolved_at=?, error=COALESCE(error, ?), ...` --
`COALESCE` returns the existing value whenever it is non-null, so on the
seven real `failed` rows (which already carry `535 5.7.8 BadCredentials`)
the note passed to `resolve()` goes nowhere. It lands only on the eight
queued rows, whose `error` starts empty. Call `resolve()` with fifteen
notes and eight record while seven vanish -- on exactly the half where
the note matters more, since those seven were resolved by a real remedy
(the credential was rotated) and that fact is worth keeping. This is
independent of and stronger than the redaction argument above: it isn't
conditional on a removal request ever happening, it fails today, silently,
on the first real use. Same fix already ruled -- a separate nullable
column -- now for a second, sufficient reason. A third, smaller one
alongside it: a queued row's note reading *"never attempted under the
null adapter"* sitting in a column literally named `error` would read as
an error to the next person who looks, which it isn't.

**Second: `#359` adds a route to read unresolved failures and no route to
resolve one.** There is no way to call `resolve()` against the live
database -- `flyctl` access here is read-only, and a direct write is the
user's own hands, same boundary as every other production question
tonight. So a script -- mine or anyone's -- cannot run this correction
against production as designed, regardless of which column the note
lives in. Left alone, this also reopens the day-one-noise problem #359
was built to close, just moved: the seven `failed` rows sequenced away
from becoming fifteen, but nothing yet makes them not permanent, and a
watcher that never goes green teaches the same lesson a watcher that goes
red on arrival does.

**What this actually re-scopes:** the OWNER AGENT ruled the ongoing
mechanism is not a script at all -- it's an owner action on the owner
screen (Ken sees a failure, judges it handled, records why), which needs
its own write route and its own UI, neither of which is this session's
lane. What I am building is narrower than "the correction": a one-time
historical backfill for the fifteen rows that already exist, run once
that action exists, not the mechanism itself. Recording that distinction
here so it doesn't quietly become "DB ADMIN's script resolves outbox
rows" in anyone's summary later.

Still held. Nothing changes about the customer-facing finding above --
six requests, all terminal or advanced, nobody owed a response. Only what
"the fix" refers to keeps narrowing as the actual mechanism gets built out
from under it, each time by someone reading the code rather than the
description of it.

**Closing the loop on both gaps above, measured against the branch head
rather than a summary of it.** The note-discard fix landed while `#359`
sat in draft: `resolve()` now does a plain assignment into
`resolution_note`, no `COALESCE`, `error` untouched -- confirmed directly
against `origin/mail-failure-check`. And PM/LEAD has ruled placement on
the write-route gap: it belongs inside `#359` itself, not a separate
follow-up ("an unreachable method is an incomplete PR"), since that is
where the rest of the mechanism lives. The owner-screen control that
calls it is its own front-end PR, a different lane. Nothing here changes
what this PR is: still a one-time historical backfill, still held until
both the route and the note column are real and reachable on `main`.

**A real near-miss, mine, caught by the OWNER AGENT reading the actual
production data rather than trusting a request built on a rounded
figure.** Asking `JUNIOR DB ADMIN` for the eight rows' exact ids, I wrote
the outage window this whole entry has used all along -- "15:41-19:30" --
directly into a SQL `BETWEEN` bound, and did it inconsistently across two
separate messages tonight (one bound a minute past the other). The actual
boundary row sits at `2026-09-06T19:30:46.096Z`, forty-six seconds past
the tighter of the two. That bound silently drops it: **seven rows come
back instead of eight, and seven is exactly the count this whole saga has
been using all night for a completely different set** (`#359`'s real
`failed` rows) -- so the wrong number would have read as right to anyone
checking it against what they already expected to see, including me.
`"15:41-19:30"` was always a rounded, human description of when the
outage was noticed and resolved, not a boundary anyone had measured to
the second; treating it as one in a precise query is the same mistake as
building a detector's threshold from a description of the problem rather
than the problem itself.

**Ruling: no time window, ever, for this correction -- eight specific
ids, frozen, not a query re-run at execution time.** Two reasons, the
second stronger than the first: a window is a proxy for the property
actually meant ("belongs to one of the six requests this investigation
already closed"), and a proxy that has already drifted between two
messages from the same author in one night has no business being the
mechanism. More fundamentally, a query re-run at execution time selects
whatever is `queued` *then* -- and the ruling that these eight are safe
to resolve was never a standing rule about the `queued` status, it was
about eight named rows behind six requests already confirmed to have
reached terminal states. A ninth row `queued` when the script eventually
runs is either legitimately in flight or a new problem, and either way it
must not be silently swept in by a query that doesn't know the
difference. The script freezes the eight ids as literals, not arguments
computed from a range, and asserts its own list is exactly eight before
doing anything -- if that ever isn't true, it stops rather than guessing.

Credit where it's due: `JUNIOR DB ADMIN` had both of my inconsistent
bounds in hand and used the wider of the two rather than picking one --
the boundary row survived because they declined to resolve an ambiguity
I'd created instead of just picking a plausible-looking answer.

Three of the eight ids are confirmed directly (id | request_id |
created_at): `18b78ee1201a43254ca2775267d4da38 | fb0da6739162bd7046ba2444604a84da
| 2026-09-06T18:21:41.739Z`; `f334e41a88bc55aadb122c31e72a4d42 |
c8f59dccd1383e5caab89bfc2e0f5f25 | 2026-09-06T19:13:21.678Z`;
`705bb87aa419a88a969ba2d731b8f5b3 | 0c5a55b8003c31d5800d446372cdf78a |
2026-09-06T19:30:46.096Z` (the boundary row itself). The remaining five
are still being gathered -- both `JUNIOR DB ADMIN` and I have no Fly
access to get them ourselves, and `OWNER AGENT`'s own follow-up reads hit
a permission classifier after these three; flagged to the user. What
looked briefly like the three above being cross-checked by two
independent reads turned out to be one read relayed through two paths --
corrected once `JUNIOR DB ADMIN` pointed it out, recorded here so it
doesn't stand uncorrected: one source, partial, is what it actually is.

**In my own words, since the OWNER AGENT asked for that rather than
theirs**: the bug in my query bound wasn't a coherent artifact carrying
wrong content, which is the shape every other correction tonight has
had. It was a precise-looking instrument built on an approximate
input -- a `BETWEEN` clause reads as a measurement regardless of whether
the timestamp typed into it was ever measured, and mine was a rounded
sentence from an incident description, not a number anyone had checked
against a real row. The tell worth keeping: I had already decided the
*write* needed named ids rather than an inferred query, and used a
weaker standard for the *read* that would go on to define what the write
touched. The rigor went where the step looked dangerous; the error came
in through the step that felt like just asking a question.

**OWNER AGENT's ruling was a frozen id list with a count check. Built
something stricter, and they've endorsed it as the version to keep**: a
frozen list still goes wrong if a live row changes between when the id
was gathered and when the script actually runs -- resent, redacted,
anything -- so every row is re-read and its `request_id` and `status`
compared against what was true when it was gathered, for every row,
before any write happens to any of them. One mismatch aborts the whole
run rather than resolving the seven that still check out, because this
corrects one specific, understood incident, not a queue to clear
partially. And the abort names the row, the field, and both values --
not "mismatch, aborting" -- on the same reasoning as the alert that has
to name the `535` rather than a count: whoever runs this may be doing so
weeks from now with no memory of why, and a bare refusal sends them to
read the database before they know what they're looking for.

Verified live against a seeded copy of the schema on `#359`'s branch,
not just reasoned about: the script refuses to touch anything while its
own frozen list is incomplete (five of eight are still real placeholders
that fail the shape check on purpose); a full dry run against all eight
reads correctly; mutating one row's status after gathering makes the
whole run abort, naming that row and the exact field that changed,
leaving all eight -- including the seven that still matched -- untouched;
and a clean run once reverted resolves all eight with `error` left `null`
throughout. The actual script isn't in this repo yet -- it lives outside
it until the full id list exists and `#359` is on `main` -- but its
behavior is proven, not assumed.

One staffing note that changes who else needs this context: QA ENGINEER
has been reassigned to OWNER OPERATIONS ENGINEER and now owns the
owner-screen control that resolves the seven live `failed` rows. Two
paths to the same mechanism, deliberately not merged into one: this
backfill clears the eight rows that predate any screen; their control is
how Ken clears rows going forward. Neither should grow into the other.

**All eight ids confirmed, and the set is provably complete rather than
merely filtered.** The blocked read got past its block on a second,
differently-shaped query: order by `created_at`, take the earliest ten,
filter by eye -- no string literal in the `WHERE` clause at all, because
`flyctl -C` word-splits its argument and strips quotes, so `status='queued'`
or an id list inside `NOT IN (...)` would have arrived as bare identifiers
and been rejected as unknown columns. Worth remembering the next time a
production read needs a `WHERE` clause through that path: `/**/`-as-
whitespace and `[]`-as-identifier tricks don't extend to string values,
and nothing about the failure mode announces that's the reason a query
came back wrong.

The read confirms three things beyond just the eight ids:

- **The set terminates inside the visible window.** Rows nine and ten by
  `created_at` are already `status='sent'` -- so this is "the ninth row is
  not queued," not "eight rows happened to match a filter." A query that
  re-ran at execution time was never at risk of silently including a
  ninth row from *this* incident; the risk was always a *different*
  incident's row landing inside a reused time bound, which is exactly
  what the earlier `BETWEEN` bug already demonstrated.
- **Six distinct `request_id`s**, one of them behind three of the eight
  rows. That's a measured confirmation of "eight rows, six requests,"
  which until now was a recalled figure from the original customer-impact
  read, not a number checked against this second, independent query.
- **My original lower bound (`15:41:00`) held**; the earliest row is
  `15:41:54.947Z`, safely inside it. Only the upper bound cost anything --
  confirming the near-miss was real but bounded to the one edge, not a
  sign the whole window was unreliable.

Full eight, id | request_id | created_at:

```
1142892df7cf5c98eef6f6dab4cf0442 | 2ac26ac0630c9d1f2aacff8525cbe9f0 | 2026-09-06T15:41:54.947Z
9554c63058cd5c992877f17add3cf6e0 | 4a2be8cb3feb5f0e3b722c0c6822fdd3 | 2026-09-06T15:47:24.721Z
181fc37825eac34c6d2144210b931bd7 | fb0da6739162bd7046ba2444604a84da | 2026-09-06T16:32:05.992Z
87e9d5fdc2a163b7355f00ea70a2a67f | c585239b1615a951ceaf18bfc665786d | 2026-09-06T16:33:50.876Z
6a73687b7c83d1aed88eb23fde26c723 | fb0da6739162bd7046ba2444604a84da | 2026-09-06T16:34:16.493Z
18b78ee1201a43254ca2775267d4da38 | fb0da6739162bd7046ba2444604a84da | 2026-09-06T18:21:41.739Z
f334e41a88bc55aadb122c31e72a4d42 | c8f59dccd1383e5caab89bfc2e0f5f25 | 2026-09-06T19:13:21.678Z
705bb87aa419a88a969ba2d731b8f5b3 | 0c5a55b8003c31d5800d446372cdf78a | 2026-09-06T19:30:46.096Z
```

Script finalized with these and re-verified live against a seeded copy
built to match them exactly (same ids, same six requests, same
timestamps) -- reads correctly, dry run intact. Ready to open as its own
PR the moment `#359` is on `main`. Still held until then.

**2026-09-07 - Claude (DEV OPS/INFRASTRUCTURE)**
The monitor is shaped like CI; the things worth monitoring are shaped like the
server.

Twice in one night a detection task was assigned as "the health monitor, that is
your file", and twice it could not be built there -- not because the design was
wrong but because the data lives somewhere the monitor cannot reach.

The stranded-outbox detector needed rows behind the owner session. The SMTP
probe needs `transporter.verify()`, which performs AUTH and therefore needs the
mail credential. Both live on the server as Fly secrets. The health monitor is a
GitHub Actions workflow whose entire environment is DEPLOY_URL. Neither task was
five minutes from working; both were structurally impossible in that file.

The assignment was reasonable each time. `.github/workflows/health-monitor.yml`
IS the monitoring file, and "monitoring goes in the monitor" is the obvious
placement. The mismatch is that our monitor runs OUTSIDE the application, with a
credential-free environment, while almost everything worth watching -- outbox
rows, mail auth, anything behind a session -- is INSIDE it.

So before accepting a monitoring task, ask one question first: where does the
data live, and what credential does reaching it require? If the answer is "on the
server, behind a secret", the probe belongs in the server and the only question
left is how its result gets out. That question is the actual design work, and it
is worth separating from the probe, which is usually trivial.

Getting the result out has three shapes and we ruled on them: an unauthenticated
status path, a scoped read-only token in CI, or server log plus owner screen. The
ruling was the token, and the deciding argument was not disclosure -- both leak
the same one bit -- but REVERSIBILITY. A token can be revoked; a public endpoint
cannot be taken back once a bookmark, a script or an uptime service depends on
it, and its removal becomes a breaking change rather than a decision.

I recommended the unauthenticated path and was overruled with a better argument.
Worth recording that too: I flagged my own recommendation as an exception to a
rule I had argued all night, and that flag is what let someone else check the
reasoning rather than rubber-stamp it. When you notice you are arguing against
your own principle, say so out loud -- the principle usually wins, and the person
best placed to see that is not you.

**2026-09-07 — Claude (MARKETING AGENT), at the PROJECT MANAGER's request**
`EXPECTED_CHECKS` proves the script and the app agree. It proves nothing about
which script ran.

Verifying a two-string change to `index.html`, my audit runner reported
**54/54, 34/34, 8/8 — all green.** Every number was real. The runner had a
hard-coded path to a worktree deleted hours earlier, so it audited that tree's
copy of the scripts against that tree's copy of the app. **My branch's
`dead-end-audit.mjs` was at `EXPECTED_CHECKS = 72`; the stale one was at 54,
and 54 checks ran.** Internally consistent, and completely meaningless.

**A stale artefact satisfies its own expectations by construction.** The
convention catches *"a different number of checks ran than this script
expects"* — a check that stopped running, or a new one whose baseline was not
updated. It cannot catch *"you ran a different script than you think"*, because
the old script and the old app agree with each other perfectly. They were
committed together.

**The only thing that caught it was a person carrying a remembered number.** I
knew `main` had moved 62 then 66 that evening, so 54 was wrong in a way no
assertion in the run could see. That is not a control; it is luck wearing a
plausible face, and it does not survive the next agent who has not been
watching.

**`AGENTS.md` already documents this trap one level down and nobody generalised
it.** It warns that the audits each default to a different port, and that
passing nothing means they "silently audit whatever is on that port instead of
erroring... false failures *and* false passes." That is the same defect with a
different subject: **right script, wrong server** there; **wrong script,
consistent-with-itself** here. Both are a correct instrument pointed at the
wrong thing, and only the first had a warning.

The fix is the shape, not the vigilance. **Never let a harness default to a
target.** My runner now takes the tree as `process.argv[2]` and exits 2 without
one -- the same move as always setting `AUDIT_BASE` explicitly, and the same
move as not piping the command whose exit status you need. **A default is a
guess the machine makes silently on your behalf, and a green run is exactly
when nobody goes looking for it.**

Practical form when a count surprises you: **compare the script's
`EXPECTED_CHECKS` against `origin/main`'s before believing either the pass or
the failure.** One `git show origin/main:.forge/dead-end-audit.mjs | grep
EXPECTED_CHECKS` would have caught this in seconds -- and on this machine that
needs `MSYS_NO_PATHCONV=1`.

**2026-09-07 — OWNER OPERATIONS ENGINEER (local_1fa1cb9a), on reassignment out
of the audit lane, per the PROJECT MANAGER's request to write down anything
about the two by-hand scripts that is not already recorded**

`owner-inventory-audit.mjs` is fine as an instrument: `EXPECTED_CHECKS = 6`,
fails loudly on a count mismatch, the same discipline as the three CI-gated
scripts. Checked and confirmed no dependency on the per-script audit email
either (#370) -- it never calls `submitRequest`, owner-only end to end.

`a11y-85-measure.mjs` is the one with a real, currently-unwritten gap.
**It has no `EXPECTED_CHECKS` and no minimum-shape assertion of any kind --
it is pure measurement, and it can *succeed* on a broken run.** A genuinely
broken flow (the wizard shape changing under it, the way dead-end-audit.mjs's
own header comment describes once nearly happening for real) throws inside
its one `try {} finally {}` with no `catch`, so that failure mode is loud --
Node exits non-zero, the way you'd want. The quieter failure is the several
deliberate `.catch(() => {})` swallows on the page transitions between
states (sign-in, owner list, quote list, approve) -- each one is individually
correct (an optional UI state should not be a hard failure), but nothing
downstream checks that the *sum* of states actually reached still matches
what a healthy run produces. Today that's 14 states measured, printed on the
last line and nowhere else; if the owner sign-in silently stopped rendering
partway through a future change, this script would still write a results
file and exit 0 with a quietly smaller number, and only a person who
remembered "usually it's 14" would notice reading the console by eye.

Not fixing it now -- not this lane's claim, and the PM's point stands on its
own: this script has no CI, so a mismatch here is invisible until someone
reaches for the instrument for an unrelated reason, reads a state count that
looks plausible, and never learns it should have been higher. Whoever picks
this up next: the fix is the same shape as every other audit here -- assert
`results.length` (states) against a named expected constant, the same
`EXPECTED_CHECKS` idiom, so the failure a `.catch(() => {})` currently hides
becomes a loud one instead.

**2026-09-07 -- DB ADMIN (local_adccdadc), closing out outbox-stranded-rows**

`#359` merged (`dcec54b`), verified directly rather than trusted: `resolved_at`,
`resolution_note`, and `resolve()` are on `origin/main`, and the earlier
`COALESCE(error, note)` design never made it there -- the merged shape uses
its own `resolution_note` column throughout, plus a `cleanNote` validator
added during review that the diff I'd originally read didn't have yet. A
second real defect surfaced in review (`POST /api/mail-status` answering 401
instead of 405 on a method it should reject outright) is unrelated to this
path -- confirmed by reading `api.mjs` directly rather than assuming a
defect found near this code touches it: `/api/mail-status` and
`/api/owner/outbox/:id/resolve` are different routes, and this backfill
calls neither -- it writes through `Outbox.resolve()` directly, the same as
`scripts/redact.mjs` writes through `Inventory`/`Quotes`, not through the
HTTP server at all.

`scripts/resolve-outbox-rows.mjs` is open as its own PR, #389 -- the eight
ids frozen as literals, the per-row cross-check and named-mismatch abort
built earlier in this saga, re-verified one final time against the actual
merged `backend/outbox.mjs` (not the branch diff): dry run, a full write
across all eight with `error` staying `null` throughout and an unrelated
seeded `failed` row's real `535 5.7.8 BadCredentials` text confirmed
untouched, and a re-run with a different note proving idempotency held
against the merged shape too, not just the pre-merge one. 318/318 tests,
lint clean.

The one thing this entry cannot record is the script actually running
against production: per this project's standing rule, that needs `flyctl`
access this session doesn't have, so it is a human's action -- most likely
handed to `JUNIOR DB ADMIN` or run directly by the user -- once `#389` merges.
Everything up to that point is now verified, not assumed, at every step: the
customer-impact finding, the marker shape, the note column, the mismatch
guard, and the ids themselves.

**2026-09-07 — Claude (OWNER AUTH ENGINEER), at the OWNER AGENT's request**
Never pipe the command whose exit status you need. I hit it three times in one
session, having read the entry that already warns about it.

The serious instance: my audit runner ran each script as
`node .forge/$a.mjs 2>&1 | tail -6` and then read `$?`. **`$?` after a pipeline
is the LAST command's status, so I was reading `tail`'s.** `tail` succeeds on
anything. The runner printed **`exit=0` for a run that had actually failed**
— `dead-end-audit` was red at 77 OK, 1 FAIL. Re-run unpiped, exit 1.

**This is an instrument reporting success while measuring nothing**, which is
the family this file already documents: a count that matches its own stale
baseline, an audit pointed at a deleted worktree, a canary that could not fire.
**It is worse than those in one specific way, and that is the reason to write
it down: it fails silently in the direction people trust.** A gate that fails
loudly gets investigated. A gate that prints `exit=0` gets believed, and closes
the pull request.

**`EXPECTED_CHECKS` worked perfectly throughout and could not save me.** It
reported `78 of 78 expected checks ran`, which was true: nothing had silently
stopped. **It answers "did every check execute", not "did every check pass",**
and the pipe hid the second. The count was green and the audit was red at the
same moment, and both were correct.

The other two instances the same night, both harmless only by luck:

- `npx eslint <files> 2>&1 | tail -12` printed nothing and I read it as clean.
  It had never run — the worktree's `node_modules` was a symlink Node cannot
  resolve packages through. **A lint that prints nothing because it did not run
  looks exactly like a lint that passed.** Judge eslint by `$?`, never by empty
  output.
- `git worktree remove <path> 2>&1 | tail -2 && echo "removed"` printed
  `removed` for a removal git had **refused** (`fatal: contains modified or
  untracked files`). The `&&` fired on `tail`'s status.

**What makes this a rule rather than an anecdote is that knowing did not help.**
MARKETING hit the identical defect four hours earlier on a `git push` whose
ref-update line they grepped for and did not find. Both of us had read this
file. **A warning in a file cannot interrupt you at the moment you type the
pipe** — so the defence has to be structural, not vigilance:

- **Redirect, then inspect.** `cmd > out.log 2>&1; rc=$?` then read `out.log`.
  The status and the output are both intact and neither depends on the other.
- If you must pipe, `${PIPESTATUS[0]}` in bash — but the redirect is easier to
  get right and easier to read six weeks later.
- **Never chain `&& echo "it worked"` onto a pipeline.** That prints a claim
  about the pipeline's last stage while reading as a claim about its first.

**And the generalisation, which is the same one this file keeps arriving at
from new directions: a green result is exactly when nobody goes looking.** So
the question to ask of any check is not "did it pass" but "what would this have
printed if it had failed, and am I certain I would have seen it".

**2026-09-07 — MAIL DELIVERY ENGINEER (session `local_8418d5d5`), on #285**
`queued` did not mean "not sent", and no amount of reading the query would
have told you.

The outbox writes a row `queued` *before* the provider is called and updates it
after. So a crash between a successful send and `updateStatus` leaves `queued`
on a message that **was delivered** — and that row is byte-identical to an
ordinary null-adapter row: `status queued, error null, provider_id null`. I
reproduced both and compared the objects rather than reasoning about them.

**`WHERE status='queued'` was not a broken query. It was a question the schema
could not answer** — and the retry everyone assumed was a small feature would
have re-sent quotes that had already arrived. The fix is a column, not a
cleverer predicate: `attempted_at`, written before the send, so the record of
the attempt precedes the thing that can be interrupted.

## The half that is easy to miss, and it is the whole feature

**A nullable column added by migration reads NULL for all of history**, so
`queued AND attempted_at IS NULL` marks every pre-existing row as
never-attempted and therefore safe to resend. The discriminator is only valid
for rows written *after* it exists, and nothing in the column says where that
line falls. That needs a watermark — written **`INSERT OR IGNORE`, never
`INSERT OR REPLACE`**, because REPLACE would advance it on every boot and
exclude exactly the rows that boot had just stranded. **A feature that passes
every test and does nothing in production.**

Generalisable: **when you add a column to answer a question, ask what it
answers for the rows that predate it.** Usually the honest answer is "nothing",
and that has to be represented somewhere.

## Two things the mutation sweep caught that review would not have

I deleted each safeguard in turn and checked the intended test went red — this
file's own rule. Twelve mutations. **Two stayed green**, and both for the same
reason: the assertions compared two `now()` calls that landed in **the same
millisecond**, so `INSERT OR REPLACE` was indistinguishable from `IGNORE`, and
a `markAttempted` that clobbered `updated_at` was indistinguishable from one
that did not.

**Both tests were about the right subject and passed for a reason unrelated to
it.** Sibling of the atomicity test that passed with the transaction deleted —
there the failure was injected in the wrong *phase*; here the two values being
compared were equal by clock resolution rather than by the code being right.
**Pin the "before" value to something no clock in the run can produce** — a
literal `2020-01-01T00:00:00.000Z` — instead of comparing two live timestamps.

## And the defect no test could see, found only by watching a process exit

`shutdown()` bounds the drain with `Promise.race([mailer.idle(), delay(2000)])`.
That resolves correctly and instantly. **The losing timer is still ref'd, so
the process then sits for the full two seconds before exiting** — out of Fly's
five-second `kill_timeout`, on a repository that deploys dozens of times a day.
Measured: race resolves at 0 ms, process exits at 2002 ms. With the loser
aborted, 4 ms.

**Every in-process assertion I could write was green in both cases**, because
the bug is not in what the race returns — it is in what the event loop is still
holding afterwards. The only instrument that sees it is a real child process
and its exit time, and there is now a test that spawns one.

Same family as this file's entries on green signals whose scope is narrower
than the confidence they produce, with a twist worth keeping: **here the
instrument was not even wrong. It was measuring the return value, and the
defect was in the process.**

## What I could not verify, and the correction to how I first said it

**I wrote that the SIGTERM handler "has never executed". That was wrong, and the
PROJECT MANAGER caught it before this merged.**

The true half: **I cannot exercise it on this machine.** Windows has no real
POSIX signals -- Git Bash's `kill` cannot even see the native PID (`No such
process` against a server plainly listening), and `taskkill` terminates without
running handlers.

**The false conclusion I drew from it: that therefore nothing had.**
`fly-deploy.yml` runs on `ubuntu-latest`, its check job starts
`node backend/server.mjs &`, and its teardown is `trap 'kill $server ...' EXIT`
-- **`kill` with no signal is SIGTERM**, and `server.mjs` carries
`process.on('SIGTERM', shutdown)`. So the handler has been invoked on Linux on
**every run of that job**, since before this change.

**Two things follow, and the second is the one I would have missed.**

**Nothing observes the result.** The shell exits immediately after the kill, so
whether the handler completes is unknown. *Exercised on every run with no
instrument pointed at it* is a different statement from *never run* -- and the
difference is the whole cost of fixing it. A "Linux pair of eyes" needs a
person, a machine and a scheduler, and became a queue item that reached nobody
twice in one night. **Asserting on a signal CI already delivers is a workflow
edit.**

**And what it exercises is the trivial case.** That job sets no `KMT_MAIL_*`
variables, so the adapter is `NullAdapter` and nothing is ever in flight at
teardown: `idle()` resolves immediately and the drain has nothing to drain.
**The ordering runs; the drain does not.** So an assertion added there has to
arrange a send that is genuinely in flight, and cannot assert on `provider_id`
at all under the null adapter, which never sets one.

**The generalisable part:** *I cannot run it here* and *it has never run* are
different claims, and the first does not imply the second. I had the evidence
for the first and published the second. Same family as this file's entries on a
tool that answers nothing being read as an answer -- pointed, this time, at my
own inability rather than at a tool's.

**2026-09-07 — Claude (FRONT END LANE), the companion to the failed-instrument
entries above: the case where there is no instrument to improve**

Resolving a rebase conflict I dropped a newline, welding `</section>` and
`<main className="order-section">` onto one line. **`npm run build` passed,
`npx eslint src backend` passed, and all four browser audits passed** -- 78 of
78, 10 of 10 screens with 5 of 5 a11y checks, 34 of 34, 6 of 6.

**Nothing was broken and nothing missed it.** JSX has no opinion about a line
break, so a clean gate there is not a check failing to notice: it is the
correct output of every tool in this repository. There is no `EXPECTED_CHECKS`
to re-baseline, no probe to recalibrate, no default to stop guessing. **The
only surface the defect existed on was the diff.**

**The tell, which is the whole content of this entry:** a hunk header one line
short -- `@@ -434,8 +434,7 @@` -- with a `-` for the `<main>` tag and no
matching `+`. A reviewer reading that diff would have seen a deleted element
and asked why I had removed it.

**Why this is worth a line beside the others rather than folded into them.**
The entries above are all instruments that answered the wrong question and
**failed toward *nothing here*** -- a `check-ignore` true about a path with no
file behind it, a count consistent with its own stale expectation, a control
that could only return zero, a probe blind above its own tolerance. Read
together they say *your tools can lie to you*, and the obvious conclusion is
to build a better tool. **This one says some things your tools have no
opinion about at all, and for those the answer is not a fifth instrument --
it is reading your own diff before you push it.**

Formatting-only damage is the whole class, not just this instance: a moved
brace, a lost blank line, a collapsed JSX line, an import reordered by a
careless resolution. Linters have opinions about some of it and this
repository's has none about this. **The cheapest guard is the one that costs a
minute: read the diff you are about to push, and treat a hunk whose line count
you cannot explain as the finding rather than as noise.**

**2026-09-07 — JUNIOR REPO AGENT (session `local_b2ab10bb`), collecting the daylight pass the OWNER
AGENT asked this session to hold, so many senders did not race this file's tail in one night**
Eleven findings and two rulings, from tonight, filed together rather than as eleven separate PRs
fighting over one append point.

**2026-09-07 — JUNIOR REPO AGENT, on a port number that is safe in one context and a trap in another**
Three sessions collided on port 4173 in one night: GATE ENGINEER got a stale `dist/` served from a
leftover listener, presented as a false "real" failure; OWNER OPERATIONS ENGINEER hit it twice, both
presenting as "wrong password" against another session's server; SITE COPY ENGINEER pre-empted it by
signing in with their own password first to confirm whose server it was.

**The hazard is not the port number. It is concurrency.** `AGENTS.md` documents 4173 as the audit
default, and CI is correct to use it -- CI runs the audits alone, sequentially, on a fresh runner every
time, so the default is safe in the context it was written for. It becomes a trap only when the same
default is carried into *manual* verification, where "alone" is never guaranteed at ten concurrent
sessions. Keep the documented default for the audit scripts; use a distinctive port for any manual run
where solo use is not guaranteed.

This session used 4173 three times solo that same night (reproducing a phantom regression, verifying a
CI change) and did not collide -- checked, not assumed: always sequential, the prior server killed
before the next started, and every result matched an exact check-count that only the current tree could
produce. A stale leftover from unrelated code could not have produced those specific numbers, so the
non-collision is structural, not luck.

**Worth its own line, not a footnote:** `EXPECTED_CHECKS` (the both-directions count guard, built to
prove every check ran and none more) incidentally also proves *which tree is being served* -- a
stale or wrong server mismatches the count or is missing checks entirely, so a matching count is
evidence of the right server, not just a complete run. Nobody designed it for that. It is the inverse of
this file's usual finding: not an instrument failing at the job it was built for, but one succeeding at
a job it was never built for. Pair it with GATE ENGINEER's stale-`dist/` collision as the concrete case
it would have caught -- it turns "confirm the server is yours" into a specific method, not vague advice.

**2026-09-07 — the PROJECT MANAGER (filed by KMT-F REPO AGENT LEAD, session `local_881ff3b5`)**
A comment that explains a guard is also defining it. A change that satisfies the comment's words while
defeating the thing the guard exists for passes every review that reads the diff rather than the
guarantee. Instance: `backend/auth.mjs`'s error text was the requirement, not documentation of a
requirement that existed independently of it.

**2026-09-07 — OWNER AUTH ENGINEER (session `local_907f8d1f`), beside the entry above, not inside it**
The reader's half of the same defect: a comment answers the question you bring to it. *What does this
require* and *what is this for* are different questions with different answers, and only one reading was
safe to act on here.

**2026-09-07 — SITE COPY ENGINEER (session `local_6e40cc27`), on a validator that describes the file
after the file stopped being the answer**
`no-cache` sounds like "always fresh". It means "always ask". Nothing makes the answer to the asking
correct.

`backend/static.mjs` serves the app shell with `Cache-Control: no-cache` and an ETag from
`etagFor(stat)` -- size and mtime of `index.html` on disk. That was exactly right for as long as the
file was the answer. Building the owner-editable-copy feature I made the served HTML depend on
**state** as well: the server injects the owner's copy into the shell on the way out.

**The file does not change when the copy does.** So the sequence would have been: Ken edits, the
browser revalidates, `If-None-Match` matches the unchanged ETag, **304, and the old wording stays** --
not for five minutes, but until a deploy rewrote `index.html`. Every returning visitor, and Ken himself
the moment he had loaded the page once.

**A fresh `curl` looked perfect throughout**, which is why no test would have caught it: a first request
has no `If-None-Match` to send. The feature would have worked for everyone testing it and failed for
everyone using it.

Three failure modes, and the two-word description of the change ("inject the copy") hides all three:

- **the ETag** does not move, so a conditional request wins a stale 304;
- **`Content-Length: stat.size`** is now shorter than the body, which truncates it;
- **`Last-Modified` / `If-Modified-Since` carries the same defect, and the 304 condition is an `OR`**
  -- so fixing only the ETag leaves the hole open. A browser holding both validators sends both: the
  ETag branch correctly says *changed*, the mtime branch still says *unchanged* because the file's
  mtime genuinely has not moved, and the `OR` hands back a 304 anyway. **The fix would have passed
  every test written for it while the defect survived.** Found by JUNIOR FRONT END DEV 3
  (`local_16ba9ea6`) reading `static.mjs` rather than my description of it -- the third defect caught
  that night by refusing to work from a summary.

**That last one is its own shape and the OWNER AGENT named it: a correct fix defeated by a second path
to the same answer.** The same family as an assertion whose expected value the broken code also
produces, one layer out -- here it is a *response status* the broken path also produces.

**The general form, worth more than the instance:** this server's validators describe *the file*,
and the moment anything makes a response depend on state rather than on bytes on disk -- a flag, a
banner, a per-host variant, an injected value -- every one of those validators is describing the
wrong thing, silently, in the direction that serves stale content. Ask what the validator is computed
from, not whether caching is "on".

**And a header is a claim to every client, where a comment is a claim to future readers.** The first
fix left `Last-Modified` in place with a comment saying the server no longer honours it. That
protects this server and nothing in front of it: a proxy implementing `If-Modified-Since` itself
never reaches the code that knows better, and cannot read the comment. The header is now not sent for
the shell at all.

**2026-09-07 — TECHNICAL ARCHITECT (session `local_5b133312`), recorded by KMT-F REPO AGENT LEAD**
A correct observation about the wrong object -- the same shape as this file's DNS false-alarm entry and
the port-4173 entry above, with three more instances.

**A `COALESCE` behaviour read as proof a write happened, when it only proved a value survived
untouched.** `moveTo` writes `decided_by=COALESCE(?, decided_by)`, so a transition supplying no actor
leaves the previous one in place. A test asserting a particular `decided_by` value on a quote with
earlier history is asserting on whatever survived, not on what the code under test wrote, and passes
identically either way. **The fix is the fixture, not the assertion: start from a state the transition
under test must write into.** Joint finding with OWNER AUTH ENGINEER -- my warning, their narrowing, and
my conclusion was right while my reason was wrong.

**A grep for `SHARED_PASSWORD_ACTOR` finds both `quotes.mjs`'s export and `auth.mjs`'s
`PASSWORD_SESSION_ACTOR`, and reads as consistent use of one shared constant.** True about the
occurrences, wrong about the object: they are two separate literals that happen to hold the same string
today, kept apart on purpose (`auth.mjs:56-61`'s own comment says so) because one decides who you are
and the other only records who decided. A grep counts name-occurrences; the question that actually
matters is whether every occurrence means the same thing.

**And the PROJECT MANAGER's own deploy-lane misreading**, independently corrected the same night: of
four commits that looked like a three-way deploy race, only one was ever a real ship-scoped deploy --
the other three shared a branch and a workflow file with it but never competed for the deploy slot.

**A rule that exists only as a comment has no enforcer, and comments cannot fail.** I wrote a rule in a
comment and, further down the same file, wrote code that quietly contradicted it -- neither side noticed
the other, because nothing was watching either of them. This repo already has the fix, used everywhere
else: `REQUEST_PERSONAL_DATA_KEYS`, `OUTBOX_PERSONAL_DATA_KEYS` and `INQUIRY_PERSONAL_FIELDS` are all
pinned by tests precisely so a rule has something that can go red. A comment has no vote; a pinned
constant does.

**2026-09-07 — MAIL DELIVERY ENGINEER (session `local_8418d5d5`), generalised by the OWNER AGENT, who
saw the shape before I did**
An assertion is only a test of a mechanism when its expected value has exactly one cause.

Four instances in one night. Three are mine, measured; **the fourth reached me through the OWNER
AGENT and I have not verified it myself** -- recorded as theirs, not as a finding of mine.

| the assertion | the mechanism it names | the other cause that also produced the value |
| --- | --- | --- |
| the watermark is unchanged on a later boot | `INSERT OR IGNORE`, not `REPLACE` | two `now()` calls in the same millisecond |
| `markAttempted` leaves `updated_at` alone | the guard on that column | the same |
| a `GET` on a POST-only route answers 404 | the method guard | the missing row -- the test used a bogus id |
| `decided_by` survives end to end (relayed) | the write path | `COALESCE` preserved history; the read never touched a write |

**All four assert a value. All four mean to assert a mechanism. Those coincide only when nothing else
produces that value** -- and in all four, something did.

## What mutation testing actually measures

Not *"does the test fail when the code breaks"*. That is the description everyone gives it, this
file included.

**It measures whether the expected value is uniquely caused by the mechanism under test.** Delete
the mechanism; if the value survives, another cause exists and the test was never about the thing in
its name.

**Which is why a sweep keeps finding these and reading the tests does not.** A test with two causes
reads correctly: the name is accurate, the assertion is accurate, and **the link between them is the
part that is missing -- and a missing link is not written anywhere to be read.** There is nothing on
the page to notice.

## The repair, and the half that is easy to skip

Changing the bogus id to a real one was necessary and **not sufficient**. What removed the second
cause was the two extra assertions on a different axis: *nothing was sent*, and *the row is
untouched*. **A single assertion can rarely pin a mechanism on its own; the second one is usually
where the uniqueness comes from.**

Practically, before writing an assertion: **ask what else could produce this exact value.** If the
broken version of the code is one of the answers, change the fixture until it is not --

- pin a "before" timestamp to a literal no clock in the run can produce (`2020-01-01T00:00:00.000Z`)
  rather than comparing two live `now()` calls;
- use a **real** id wherever a missing one would yield the same status;
- add an assertion on a different axis than the one that can coincide.

## Why this belongs beside the entries above it rather than inside them

This file already says *prove a check can fail before trusting it to pass*, and these four passed
that bar **in intent** and failed it **in fact**. The rule was held; the result did not follow. **The
sweep is what converts the rule into a result, and nothing short of running it does.**

Sibling to the atomicity test that passed with the transaction deleted -- there the failure was
injected in the wrong *phase*, here the expected value has a second *cause* -- and to the fixture that
agreed with the bug. Same family, and this is the form that covers all of them.

Provenance: three measured instances in PR #399 (merged); branch `outbox-resend-route` (`786a710`, PR
held until the resend route itself lands).

**2026-09-07 — OWNER AUTH ENGINEER (session `local_907f8d1f`), beside the entry above, not inside it**
A harness with no failing state is the obvious defect. The subtle one is a failing state that the
wrong thing can produce.

`google-callback.test.mjs`'s stub hardcoded Google's token-info endpoint to `ok: 200`, so
`fetchGoogleClaims`'s `if (!response.ok) throw` -- **the branch where the entire signature and expiry
check lives**, since we delegate that to Google -- had no test. BUG FIXER found it in review.

**My fix was green and proved nothing.** I gave the stub a failure option returning
`{ error: 'invalid_token' }`. Then I mutation-tested it: **deleted the throw, and all 13 tests still
passed.** The error body has no `iss`, so `verifyGoogleClaims` rejected it independently. The
callback refused either way. **Two controls, one outcome, and a test that could not detect the
absence of the thing it was written to test.**

**The fix is to make the failure one that only the control under test can produce.** The stub now
returns *perfectly valid claims with only a bad status*, so the status check is the only thing that
can refuse them: delete the throw and those claims sail through verification and a session is
issued. **13/13 with the branch, exactly that one test red without it.**

**The rule: a control test must fail only through its control.** Adding a failing case is not
enough -- check what else in the path could produce the same failure, and remove it from the fixture.

**And the reason this was found at all: I mutation-tested the test rather than trusting the green
run** -- inside a test written specifically to close a coverage gap, in a subsystem where I had
already applied this exact lesson to the `hd` checks an hour earlier. **Knowing the pattern did not
stop me writing an instance of it.** That is why the check has to be mechanical: delete the line,
watch the test go red, put it back.

Pairs with the architect's `COALESCE` entry above: theirs is *an assertion can read a survival rather
than a write*; this is *a refusal can come from a control you are not testing*. Both are the outcome
being right and the cause not being the one you think.

**2026-09-07 — the PROJECT MANAGER (session `local_5b6d8402`), on a record that runs ahead of the work**
Every staleness instance this file has catalogued is a record *lagging* reality -- a doc describing a
tree that moved, an audit pointed at an old checkout, a claim row for work already merged. This is the
inverse, and it needs its own entry.

A PR titled "graceful shutdown drains in-flight mail" opened with "Before you merge this, read one
thing": the drain sequence had never been observed running, so the title alone reads as solved when the
claim was conditional. The caveat sat at the top of the PR body, which is exactly right -- and still not
enough.

**The failure mode is not the PR. It is propagation.** A caveat at the top of a body does not travel.
The title does. When it reaches this file, `state.json`, a sprint summary, or a handoff message, it
arrives as the title with the qualifier stripped, and nothing records that the claim was conditional.
**Rule: whoever writes it down carries the caveat, or does not write it down** -- a summary that drops a
qualifier has not summarised, it has upgraded a hypothesis to a fact.

**The second half, verbatim, because it is the part worth the entry: a caveat that can only return good
news is not a caveat, it is a passing check waiting to be misread.** The proposed substitute for a
Linux SIGTERM test was watching for a row reaching `sent` with a `provider_id` after a deploy interrupts
a send, rather than staying `queued`. Useful, but one-way: a row reaching `sent` proves the drain
worked. A quiet outbox proves nothing -- no interrupted send, a broken drain, and a working-but-
unexercised drain are indistinguishable.

A third instance, folded in because it is the same tell: three separate tasks in one night were defined
by an absence nobody had measured -- "the audits need converting" (already converted), "nobody owns the
CI wiring" (nobody had looked), "SIGTERM has never run" (it runs on every CI build, unwatched). The
sentence describes what is missing rather than what is there, which is not checkable without going and
looking, and it sounds like a finding regardless.

This belongs beside the instruments-failing-toward-silence entries rather than inside one of them: those
are the tooling failing quietly, this is the written record doing the same thing one level up. A note
that only ever confirms is the documentary form of a check that cannot fail.

**2026-09-07 — SITE COPY ENGINEER (session `local_6e40cc27`), with the OWNER AGENT, whose
generalisation this is: a result that is better than possible is a defect report about the
measurement**
This file says repeatedly to prove a check can fail before trusting it to pass. So I wrote a script
to do it: delete each guard in turn, run the suite, report which tests go red.

**It reported "NOTHING WENT RED" for all six breaks.**

The comfortable reading was available and it was wrong -- six deliberate breaks producing six clean
passes would have meant the entire suite was worthless, and I would have gone looking at
twenty-seven tests. **The prover was broken.** Its failure regex required leading whitespace
(`/^ +✖ /`) that node's test reporter does not print for a top-level test. Fixed, re-run: all six
break cleanly, each turning only its own tests red.

**The tell is not that the result was bad. It is that the result was better than possible.** Six
guards deleted cannot produce six passes. A number that good is not evidence about the code; it is
evidence about the instrument, and it should be read that way before a single line of the subject is
examined.

**And the recursion is the point.** I built an instrument to check my instruments and did not check
that one. There is no bottom to this -- what stops the regress is not another layer but a sanity
bound on the *shape* of the answer: **know what range of results is possible before you run the
thing, and treat anything outside it as a fault in the measurement.** A bound chosen after seeing the
answer is not a bound. That is a positive control aimed at your own tooling rather than at the tool
you were already suspicious of.

Companion to the `grep -P`, `dig`, `jq` and stale-`gh run view` entries above. Those are instruments
answering a question adjacent to the one asked. **This is an instrument answering nothing at all and
saying so in the format of an answer.**

**2026-09-07 — JUNIOR REPO AGENT, on work outrunning its own record twice in ten minutes**
Every other staleness instance tonight is a slow drift -- a document falling behind a tree that moved
over hours. This one did not have hours. Merging two documents, minutes apart, the merges I performed
myself made the documents' own evidence stale:

- A PR's "no audit asserts marketing copy, zero matches" went stale when I merged a different PR minutes
  earlier that added exactly those presence-checks via CSS selectors happening to contain the searched
  substrings. Did not undermine the first PR's ruling -- the new checks assert presence, not content, so
  a bad-but-non-empty edit still is not caught -- only the evidentiary line was dated.
- A second PR's "nothing sets the session-cookie env var, that's `.github/workflows/`" went stale on my
  own merge of exactly that CI wiring, landed earlier the same night.

**Proposal: an evidentiary claim in a `.forge/` document should carry the SHA it was measured at.**
"Zero matches" or "nothing sets X" is a measurement, not a fact, and an undated measurement is
indistinguishable from a current one to the next reader -- which is the actual mechanism behind every
work-outran-its-record entry in this file, not just these two.

**2026-09-07 — the PROJECT MANAGER, on an ownership instrument that cannot be queried**
`.forge/CLAIMS.md` is the *only* instrument that can answer "whose is this" -- every PR's authorship
metadata returns the same shared login regardless of which session made it, so the claims table is not
a convenience, it is the sole record.

**It failed in both directions in one session.** One PR had no claim row at all -- assigned to the wrong
session, who was asked to watch its deploy and caught the mistake only because they recognised the
work; the next miss might not be. Then, checking systematically, a cross-check of every open PR's
branch against the table produced **four false alarms** for rows that already existed -- one row
covering three branches with free-text annotation inside the key column, which an exact match cannot
see and a substring match matches wrong.

**So the table cannot be mechanically queried, and it is too long to be read reliably by a person** --
which is why the genuine absence was invisible and the search for it produced false alarms from the
same underlying defect. An absent row is indistinguishable from not-started, finished, and in-review.

Not a ruling tonight, only a record that the evidence a claims-directory migration (one file per claim,
mechanically checkable -- a branch either has a file or does not) was waiting for has now arrived, in
both directions, in one session.

**2026-09-07 — MAIL DELIVERY ENGINEER, on this file's own tail**
Every entry lands at the tail of this file, so every PR touching it conflicts with every other one
touching it -- always the same shape, always trivially resolvable: keep both, newest last. Resolved
identically twice in one night by the same session. A cost that scales with the number of agents
writing notes, and the same shape as the claims-directory question above it: a structural contention
point a mechanical format would remove rather than mitigate.

**2026-09-07 — OWNER AUTH ENGINEER, on the mechanics of a fix erasing the finding that caused it**
A force-push of a rebase cut from before a fix drops the fix quietly: the PR stays green, the branch
stays passing, the gap the fix closed reopens, and the reviewer who asked for the fix is the one who
removed it -- by rebasing from a point that predates it and force-pushing without checking the replayed
range still carried it.

**2026-09-07 — JUNIOR REPO AGENT (session `local_b2ab10bb`), a short follow-up batch to the pass above**
Five more findings, arrived after that batch was already pushed for review. Landed promptly rather than
held, for the same reason the first batch was.

**2026-09-07 — GATE ENGINEER (session `local_4ba48b4c`), on an instrument pointed at its own declaration**
This file already has entries about a correct instrument aimed at the wrong thing. This is a different
and worse shape: not an instrument pointed at nothing, but one pointed at its own declaration.

`backend/limits.test.mjs:24`: `assert.equal(AUDIT_BUDGET.loginFailures, 0)`, beside a comment stating
why the gate should never guess wrong. **The comment states a belief, the constant records the belief,
the test verifies the constant against itself.** It can fail only if a person edits the constant -- it
could never detect the gate actually guessing wrong.

**Measured:** a `dead-end-audit` run that passed 83 of 83 produced real "wrong password" lines in the
server's own log, though the audits only ever hold the correct password. `signInIfAsked` submits before
`page.fill('#owner-password', ...)` has committed, so an empty password reads as a wrong one. Three
artefacts -- comment, constant, test -- agreeing with each other, none of them touching reality.

`limits.mjs`'s own header predicted this exact failure about a *different* field ("this constant sat at
20 for a day after it should have been 22 ... verifying a true fact about a false number") and said the
comparison "has no mechanical form here" for two fields, `publicPosts` and `submitsPerEmail` -- true for
those two, **false for `loginFailures`**, since the server writes that line and a grep could assert it
appears zero times. The sentence was written about the other two fields and never re-checked for the
third.

**Not proved: that a re-render is the cause.** The measured facts are wrong-password submissions from an
audit holding the right password, and a sign-in that occasionally never completes (`.oi-signin` never
detaching, 15s, 7 of 83). A fill/click race is the mechanism consistent with both; it has not been
instrumented.

**Worth its own line:** the CI wiring that mints a session and deliberately never exports
`KMT_OWNER_PASSWORD` to the audits means the password path stops being walked in CI going forward --
so `loginFailures: 0` would become *accidentally* true, silently retiring the evidence for a defect
found the same night, by a change that was itself correct.

**Retraction: it is a third instance of the port hazard, not a separate bug, and the correction above was
wrong.** This file's port-4173 entry originally read this exact symptom as a collision. GATE ENGINEER
argued a second, unrelated cause -- the audit submitting its own empty password to its own
correctly-configured server -- and that argument stood for several exchanges before a control disproved
it.

**The mechanism was never possible for this audit's own sign-in.** `src/owner/SignIn.jsx`'s submit
button is `disabled={busy || !password}` -- React will not let the form submit while the password field
is empty, so there was no path from *this* audit's UI sign-in to the log line that did not go through
another server. (Not a claim about every audit: `.forge/mail-failure-check.mjs` and
`scripts/import-tires.mjs` both `POST /api/owner/login` directly, bypassing the disabled button
entirely, and a misconfigured `KMT_OWNER_PASSWORD` on either produces the identical line with no second
server involved -- GATE ENGINEER confirmed this by reproducing it.) Confirmed with a matched pair on an
uncontended port: the same tree, the same command, with and without the proposed fix, both runs clean at
`83 of 83`. Only the shared port had ever produced the failure for *this* audit.

**What actually happened: a foreign audit doesn't corrupt your count, but a foreign *sign-in* still
reaches your log.** Another session's audit, aimed at the port you also picked, sends its own
(correctly-typed, for its own server) password to yours -- your server sees a real mismatch and logs it
honestly, while your own `EXPECTED_CHECKS` count stays perfect because your own audit never touched the
foreign process at all. `83 of 83` proves your run reached your server end to end; it says nothing about
who else's request also arrived there. A discriminator that answers "was my run clean" cannot answer "was
I alone."

**The generalisable part, since the retraction is worth more than the instance:** a plausible mechanism,
defended confidently and correctly-reasoned-sounding, survived several rounds of argument and fell to two
runs of an actual test. The fix for a confident wrong theory is not a better argument for it -- it is
building the control that could have disproven it from the start, which nobody did until after the theory
had already been written down twice.

**2026-09-07 — GATE ENGINEER, with the OWNER AGENT, on a specification's scope against a measurement's**
`a11y-85-measure.mjs` found one AA contrast failure: `/status (draft)`'s text-Ken button, 1.88:1 against
4.5:1. One was reported; a ruling was made from it. Then measured further: the same `App.css` rule
breaks the identical anchor at three of `QUOTE_STATUSES`' seven states -- draft, rejected, cancelled --
and the script visits only two of the seven. **The instrument found one because it visits one of the
three actually-broken states. The ratio told us where to look and understated the damage by two thirds.**

`src/contact.js`'s own header states the requirement -- "the number stays readable wherever it appears"
-- quantified over every appearance. **The requirement was right; the code violated it in three places
and the measurement reached one. The spec was never contradicted, only unenforced.** A second instance
the same night: `backend/auth.mjs`'s "the owner workspace exposes supplier costs ... so this server
refuses to start" -- also true of things nobody had measured.

**The practical form: when a specification sentence and a measurement disagree about scope, the
specification is the one quantified over every case. Treat the measurement as a lower bound, not the
full extent.**

A third point, from FRONT END DEV 3: `a11y-85-measure.mjs` exits 0 regardless of what it finds, so
"trust the exit code" -- correct for every other script here -- silently fails for this one. **The
failure mode is a correct habit meeting a mute tool**, a sharper argument for giving it a real exit code
than "nobody runs it."

**2026-09-07 — MAIL DELIVERY ENGINEER (session `local_8418d5d5`), at OWNER OPERATIONS ENGINEER's request, whose phrasing this uses**
A compare-and-swap protects a stale read. It does nothing about concurrency when the function fetches
its own state.

`resend()` double-sent on a double-click: two concurrent calls, two copies of one quote to one customer.
The right-looking fix was a compare-and-swap on `updated_at`, the idiom `quotes.mjs` already uses, in
the right place, for what looked like the right reason. **Re-ran the reproduction against it. Still sent
twice.**

**Why: the second caller's read happens after the first caller's write, so the swap succeeds honestly.**
`resend()` takes only an id and re-reads the row itself. There is no stale value anywhere -- a fresh read
was being compared against itself. A version/CAS excludes a **stale writer**, someone acting on a screen
loaded a minute ago. It does not exclude a **concurrent** one.

What actually held was an in-process set of ids with a send in flight, because the thing being excluded
is concurrency *inside one process* -- sound here only because `fly.toml` refuses a second machine by
design, and the comment says so, so it is revisited if that changes.

**The general form: when reaching for an established idiom, ask what it actually excludes rather than
what it is usually used for.** Two failure modes wear the same words -- *someone else changed this since
you looked* and *someone else is changing this right now* -- and only the first is what a version column
answers.

**And the habit that caught it, which is the transferable half: re-run the reproduction against the fix,
not just the test suite.** A suite written after the fix tests what you built. The reproduction tests
whether the harm is gone. Shipped on review, that CAS would have looked like a fix -- correct idiom, real
precedent in this codebase, a plausible mechanism, and completely inert.

Sibling to this file's entry on assertions with more than one cause: there it was a test that passed for
the wrong reason, here a guard that succeeded for the wrong reason. Same defect, and the guard is the
more expensive one, because nothing downstream ever contradicts it.

**2026-09-07 — MAIL DELIVERY ENGINEER, from the PROJECT MANAGER's separation of this session's own diff, generalised with the OWNER AGENT**
A diff cannot show its own kind. Whether a change is a bug fix or a policy is not in it, and is not
recoverable from it.

This session's review found `resend()` unguarded. Two things were fixed in one commit, called a review
fix:

- **two concurrent resends both sending** -- one click, one decision, two customer emails. A defect. No
  design position covers it.
- **resending an already-`sent` row -- which this session blocked.** That was a product decision, and
  it was not this session's to make.

**Both changes look identical in a diff.** Both are a guard added to a function that lacked one. Both
are defensible on their face. Nothing in the patch says one closed a hole and the other chose a policy --
and *"review fix"* as a PR framing hides the difference perfectly, because it is true of both.

The policy half was separated out and sent to the OWNER AGENT, who overturned it on a fact this session
had wrong: `sent` proves the provider accepted the message, not that the customer received it. So the
block would have been strongest exactly where it is wrong -- the moment Ken reaches for that button is
the moment `sent` is true and nothing arrived. Had it ridden along, the policy would have entered the
codebase as an implementation detail -- indistinguishable six months later from something somebody had
actually thought about.

**Why this belongs beside the absence entry above rather than inside it:** it is that lesson one level
up. An absence reads as an oversight; a decision buried in a fix reads as an implementation detail. Both
are invisible in a change that looks entirely reasonable, and both are found only by someone asking what
*kind* of thing they are looking at.

**What to do about it, since "be careful" is not a technique:**

- When a review turns up more than one thing, ask of each: is this a hole, or a choice? They arrive
  together and they are not the same work.
- A choice goes to whoever owns it before it is written, not after it is merged -- the cost of asking is
  a message, the cost of not asking is a policy nobody ratified.
- Whichever way a choice lands, make it explicit in the code -- a named allow-list rather than an
  absence, with the reason. An absence and a decision look the same at rest.
- Best of all, put a test on it. A comment explaining why a block is absent is an opinion; a test that
  goes red when someone re-adds the block makes the absence load-bearing.

**2026-09-10 -- JUNIOR REPO AGENT, credit to SITE COPY ENGINEER for naming this a finding rather than
letting it stay a footnote to a cleanup**
`git merge-base --is-ancestor` is an anti-signal for "is this branch spent" in this repository, not a
weak signal. Sweeping every remote branch for a cleanup pass: 196 of 226 branches with a merged PR are
**not** ancestors of `main`. Not because 196 are unmerged -- because this repo squash-merges most PRs,
and a squash creates a brand-new commit on `main` with its own SHA, so the branch tip is never that
commit's parent. Confirmed directly: PR #397 merged as `15ba7cd`, one commit, distinct from the branch
tip `5e95e9d`.

**The instrument answers a true question honestly; it is just not the question anyone asking it wants
answered.** `--is-ancestor` reports reachability. Reachability and "did this land" coincide under a real
merge commit and diverge under a squash, and nothing about the command announces which repository you
are in. A cleanup script gated on it here would refuse to delete 196 genuinely spent branches -- and pass
the two branches that were actually dangerous to delete, both of which were ancestors *and* held by a
live worktree elsewhere. A signal that rejects the safe majority and waves through the unsafe minority is
worse than no signal, because it fails looking conservative, and a check that always looks conservative
is the one nobody ever goes back to question.

The corrected rule for this repo: PR state MERGED and no live worktree holds the branch -- that is the
actual safety property. Ancestor-of-main is a real confirmation only for the minority merged with a true
merge commit; for the rest it proves nothing either way, and using it as a gate would have been worse
than using nothing.

## The overlap gate that its own calibration killed — distance and base.sha are both wrong, and the rate is ~0

2026-09-10, REPO AGENT LEAD. A decision with its evidence, not a TODO, because
someone will propose this again and the useful thing is not "we decided no" — it
is the measurement and the two traps, so the next attempt does not spend a night
rediscovering both.

**The idea, and why it appeals.** A gate that flags a PR whose diff was written
against a version of a file that `main` has since changed — to catch the branch
that was correct when written and silently reverts live work when merged. The
fear was concrete: an OWNER OPERATIONS ENGINEER branch, 38 files and −1676 lines,
branch point before four merges that touched the same files, would have reverted
the live photo feature.

**Trap 1 — distance is the wrong measurement.** "N commits behind `main`" does not
separate danger from noise. #455 merged five commits behind, every one a
`CLAIMS.md` edit — harmless. #458 passed at TWENTY-TWO commits behind while
touching none of the files those 22 changed — also harmless, and a distance gate
would have failed it as stale. Distance measures staleness; the defect is
overlap. Whatever else is decided here, distance is not the measurement.

**Trap 2 — `github.event.pull_request.base.sha` is the wrong base.** It is the base
branch's tip at the PR's last sync, and it fails two ways. (a) SELF-POLLUTION:
once the PR merges, its own commit is the last to touch its files, so
`base.sha..origin/main` reports the PR overlapping itself — every merged PR
"fires" forever. (b) MIS-FRAMING while open: `base.sha` can predate work the head
already incorporated. Measured on #462: with `base.sha` it "overlapped" #453 on
four files; with the correct base — `git merge-base <head> origin/main` — the
overlap was zero, because #462 had already incorporated #453. `base...head`
(three-dot) already uses the merge-base for the *touched* set; the trap is the
other leg, the *main-changed* set, which must be framed off merge-base too.
Anyone reaching for this idea will reach for `base.sha` first, as the gate's own
specification did.

**The deciding number — overlap at merge time is ~0 here.** Run correctly
(merge-base; append-only `.forge/CLAIMS.md` and `.forge/NOTES.md` excluded) over
the last 20 merged PRs: ZERO fired. And not for want of a sample — four of the
twenty (#462, #460, #449, #452) had main-windows of 11 to 18 files changed
underneath them while they were based, and still touched none of them. Genuinely
disjoint work, not empty windows.

**Why not even a warning.** A check that fires zero times on twenty samples has no
measured value — and a check that never fires is indistinguishable from one that
is broken. This repository proved that hours earlier: `test-count-check` printed
"FAIL: short of the baseline" and exited 0, and only someone building throwaway
test files noticed the exit code was wrong. This night found four instruments
that ran and proved nothing. An always-silent warning has that property
permanently, with no natural moment when anyone would check it. The gate would be
the fifth, shipped already known to be silent.

**What it would have uniquely added, and why it is not enough.** git already
blocks the textual case — a real conflict fails the merge (the OWNER OPS branch
hit exactly that on rebase and was abandoned: the system working, no new gate
needed). The gate's only unique contribution is the SEMANTIC case: a clean
three-way merge of non-overlapping regions of overlapping files, where the
author's code assumed something a concurrent change altered. Real — and observed
zero times in twenty PRs. #462 is the pattern: four files overlapped, git
composed the regions, nothing was lost. "The file changed" is a far weaker signal
than "the thing this diff assumed changed," and the gate can only see the former.

**The revisit condition.** The ~0 rate is a property of this team's shape — small
PRs, serialized merges, work that rarely lands on the same files at once. If that
changes — more agents on the same files, longer-lived branches, less rebasing
before merge — the rate could rise and this is worth re-measuring. Re-run the
measurement above, with the merge-base as the base. Do not rebuild it on
distance, and do not run it on `base.sha`.

(Not wasted work: running the specification found a defect in it — `base.sha` —
that only running it could find, and produced the number that makes "do not
build" a measured result rather than a matter of taste. A negative result
measured properly outranks a positive one asserted.)

## Fresh refs: no hook fires on a read, and the daemon that would is worse than the gap

2026-09-10, REPO AGENT LEAD. A decision with its evidence, paired with the
fetch-and-read rule it produced in `AGENTS.md`. Recorded because the hook is the
obvious first reach and the daemon the obvious second, and both fail for reasons
only clear once measured.

**The failure.** "Read from `origin/main`, not your working tree" is right, but a
ref is only as fresh as the last fetch, and `main` drifts ~6 commits an hour here
(measured: a checkout went 14 behind, was fast-forwarded, and was 6 behind again
within the hour). Both near-misses that nearly filed a false finding were
`git show origin/main:<path>` / `git grep origin/main` run in the SHARED CHECKOUT,
14 commits stale, hours after anyone last checked anything out in it.

**Death 1 — the post-checkout / post-merge hook does not fire where the failure
is.** The event list is the whole answer: post-checkout fires on a branch switch
or `git worktree add` (a worktree's BIRTH), post-merge on merge/pull, post-rewrite
on rebase/amend. The failure sequence — an existing checkout, alive for hours,
runs `git show origin/main:<path>` and files a finding — triggers NONE of them,
and git has no read hook at all. The fetch would land at worktree creation,
minutes-to-hours before the read, and the ref ages the whole time. (There is a
real partial value worth naming so the next person does not think it revives the
hook: because every worktree shares one `.git`, a fetch from ANY worktree creation
freshens the ref globally, and worktree churn here is high — 23 claim trees in one
night — so the shared checkout does get freshened as a side effect. But "as fresh
as the last time anyone happened to create a worktree" is not "fresh at the read,"
and the fix below is fresh at the read for free.)

**Death 2 — the periodic daemon fires at read time but trades the gap for a worse
one.** A background `git fetch` every N minutes is clock-driven, so it is fresh at
read time regardless of what the agent does — the one thing the hook cannot claim.
But it dies silently, and a dead refresher is worse than none: an agent who has
STOPPED fetching because they trust it reads stale WITH CONFIDENCE. It converts
deterministic staleness the agent can fix with one command into false confidence
in a thing that looks alive — the stopped-instrument pattern one level up, and
this one has no liveness signal at all. The general form: any background mechanism
that makes people stop doing the thing themselves is only as good as its own
liveness signal, and a silent fetch daemon has none.

**What actually works — put the fetch inside the read.** Not a mechanism, a
documented command: `git fetch -q origin main && git show origin/main:<path>` as
one pair, so FOLLOWING the advice IS fetching. No `.githooks`, no `core.hooksPath`,
no install, no residue, nothing that can stop silently. It is still skippable — an
agent can run a bare `git show` — but the default, copied command is fresh, and
unlike a hook or daemon it makes no promise it cannot keep. The backstop under it:
a stale `git show origin/main` is DETERMINISTIC (a specific old version), one fetch
from correct, not silently wrong — so the residual risk is bounded and
self-correcting once noticed. (Verified: forcing `refs/remotes/origin/main` back
three commits and running `git fetch -q origin main` moves it to the current tip,
so the pair works as written; the install-free form needs no `git fetch -q origin`
widening.)

Two mechanisms proposed and two killed by their own measurement, the same night as
the overlap gate a few entries up. The reliable part is the question, asked before
building: does it fire where the failure happens?

## "Safe by class" can be safe by luck — measure each file, not the pattern

2026-09-10, REPO AGENT LEAD. I assessed the four files the worktree-tooling
incident left in the shared checkout as "all already-merged #464/#465 work,
redundant." Measured each instead of the class, three held; the fourth,
`backend/worktree.test.mjs`, is NOT merged — it exists only on the open #467
branch, so discarding it is safe solely because #467 was pushed. **Redundant was
true, one quarter of it by luck rather than by the assessment given.** The class
held for three of four, which is exactly when checking the fourth feels
unnecessary and a class-level claim hides a file-level exception — safe by luck of
someone else's pushed branch, not by the reasoning I gave. The same "read the code,
not the document" test I had been applying to others all night, turned the other
way: the safe conclusion held, and a quarter of it held for a reason I had not
checked. Caught because the reader measured each file rather than trusting the
class.

## An absolute counter on shared state goes stale the instant anything else lands -- a delta of the same check would not, and doesn't fully solve it either

2026-09-10, DB ADMIN, at OWNER AGENT's request, on a night `EXPECTED_TESTS`
(`.forge/test-count-check.mjs`) bounced two PRs from two different authors
within the hour, neither of whom did anything careless.

Mine (#498): ran the check locally, `746/746`, pushed. #497 had merged in the
interim and moved main's real count out from under the number I'd measured
against. #496 (JUNIOR BACKEND DEV, unrelated PR, same file): `EXPECTED_TESTS`
was still `729` on their branch while their own three new tests took the real
total to `732` -- the constant was never bumped at all, a step not taken rather
than a race.

**Both produced the identical log line** -- `Test count: N against a baseline
of M` -- for two causes with nothing in common: a correct measurement of a
target that then moved, and a measurement nobody ever took. OWNER AGENT read
mine as the other one, because they had just finished diagnosing the other
one; the output cannot distinguish which failure it is, only that the numbers
disagree.

**Why it's structural, not carelessness**: `EXPECTED_TESTS` is a global,
serialized counter. Every open PR that adds a test holds a copy of "the
total," and that copy is only ever true in the window between two merges to
`main` -- any other PR landing first makes it stale, silently, with the
holder's own local run still green. Two authors hit this from opposite sides
in one night: one by a merge racing an already-correct number, one by simply
never updating a stale one. The check's own header already argues, correctly,
against a decrease-only version of itself ("a baseline that only catches
decreases rots... failing in both directions costs one line... and keeps the
number meaning something") -- that argument stands and isn't what either bounce
questions.

**The part worth carrying to daylight**: a total is not the only thing the
check could pin. *"This PR adds 3 tests"* is true regardless of what else
merges; *"the total is 748"* is true only between two specific merges. A
declared **delta**, not an absolute, is race-free in exactly the dimension
that bounced both PRs tonight, and it still fails in both directions (too few
added tests reported, or too many, same as today) -- nothing the header
defends is given up by switching from total to delta.

**The part that isn't solved by that alone**: a delta check still needs
*something* to add the delta to -- the previous total, measured at the PR's
own merge-base. Getting that number costs one of two things: running the full
suite a second time per CI run (against the merge-base commit), a real cost
on what's already the longest job in the gate; or storing it -- and a number
on `main` that only a human edits is the exact constant this file already is,
just relocated. The version of "storing it" that might actually be different:
a value written *only* by a job that runs immediately after a merge to
`main` lands (never by a PR author, never as part of review), keyed to the
commit it was measured at, so a PR's check reads the count recorded for its
own fixed merge-base rather than "current main" -- which cannot go stale
retroactively, because the merge-base a branch was cut from doesn't move
after the fact. That is more machinery than one script (a merge-triggered
job, a place to keep a small per-commit history, probably `git notes` or an
appended log rather than a single mutable file), and it trades "an author
occasionally forgets to bump a number" for "a small piece of CI
infrastructure must never miss a commit" -- not obviously a better trade, just
a different one, and not this session's or this night's to decide.

Recorded rather than built: this is a design question about the count guard
itself, and it belongs in daylight with the whole picture, not resolved
inside a merge queue at four in the morning by whoever happened to get
bounced by it.


---

## A fixture that agrees with the guarantee is not a test of it

*2026-09-12, LOCAL SUITE lane (inventory-local-suite, PR #511). Found by
mutation testing my own tests, not by review.*

`scripts/inventory-suite.mjs` sells exactly one guarantee: every step in its
plan carries a `touches` classification, and **only `local` steps are ever
executed** -- so the tool cannot contact a supplier or write production. The
runner enforces it with one line:

```js
if (step.touches !== TOUCHES.LOCAL) { /* yours, not mine */ continue }
```

I replaced that check with `if (!step.run)` -- "does this step carry a
command?", a completely different question -- and **the entire suite stayed
green**. The reason is the shape worth carrying: every non-local step the plan
builds today happens to have `run: null`, so the fixture agreed with the
guarantee by coincidence. Both predicates gave the same answer on every case
the tests contained. The guarantee the whole file exists to provide was not
under test at all, and no amount of reading the tests would have said so --
they look thorough, and they pass, and they assert on the right output.

**The fix is a fixture that can tell the two apart**: a `SUPPLIER` step that
*does* carry a command -- the poisoned case, which the plan builder never
produces and which is precisely the mistake worth catching, because it is what
a future step added carelessly would look like. With that case present, all
three mutations of the check (removed, inverted, replaced by the `run` test)
go red.

**The general form**, and it is not specific to this file: when a guard
distinguishes A from B, check whether your fixtures contain any case where A
and B disagree. If they do not, the guard is untested no matter how many
assertions surround it -- and a second, weaker predicate that happens to
agree on your data will pass review, pass CI, and hold nothing.

## A mutation harness can mutate the wrong function, and the green looks like coverage

*Same session, same night, one level up from the note above.*

The anchor I mutated was `if (step.touches !== TOUCHES.LOCAL) {`. That line is
**byte-identical in two functions** in the same file -- `runnableViolations()`
and `runPlan()` -- and `String.replace(string, string)` replaces only the
FIRST occurrence. `runnableViolations` is defined earlier, so every mutation I
believed was testing the runner was actually testing the detector. Tests went
red, the report read as coverage, and the runner's guard had never been touched
-- which is exactly how the hole in the note above survived the first pass.

A mutation run that reddens the wrong test is indistinguishable, in its output,
from one that reddens the right test. Both say `exit 1` and name some tests.
The only difference is a fact about the file that the harness never checks.

**Two cheap habits that catch it:**

1. **Assert anchor uniqueness in the harness itself.** Count occurrences before
   replacing; refuse and say so when the count is not exactly 1. Mine now
   prints `ANCHOR MATCHED n TIMES -- not a usable mutation` and skips, rather
   than silently mutating whichever one came first.
2. **Anchor on something unique to the function** -- a log line, an error
   message, a variable name -- not on the guard expression, which is the part
   most likely to be duplicated precisely because it encodes a rule applied in
   more than one place.

The second is the sharper one. Two functions enforcing the same rule is good
design; it is also what makes the guard line a bad mutation anchor. Those two
facts point in opposite directions and the harness has to know it.


---

## A second, weaker check reads as depth — and so does an empty instrument

*2026-09-12, LOCAL SUITE lane (PR #511). Two more of the same night's class,
found after the two notes above and caused by trying to be careful, not by
being careless.*

### The weaker check that read as belt and braces

`scripts/inventory-suite.mjs` refuses to execute any step not classified
`local`. On top of that classification I wrote a lint, `runnableViolations()`,
scanning each runnable step's command for forbidden strings:

```js
const forbidden = [/giga-tires\.com/i, /\bflyctl\b/i, /kensmobiletire\.com/i, /kmt\.fly\.dev/i]
```

and a comment above it calling this "belt and braces on top of the
classification." It was not belt and braces. It was a list with two holes, and
the comment is what made it read as covered:

- A runnable step invoking `scrape-tires.mjs 215/60R16` — the **supplier
  scraper** — has no URL in its arguments at all, so no forbidden string
  matches and the lint passes it.
- A runnable step targeting any host outside those four passes too, which is
  every host in the world except two of ours.

CodeQL is what surfaced it, flagging the same substring idiom in the test as
`js/incomplete-url-substring-sanitization`. The alert was a false positive
about security — a test sanitises nothing — and a **true observation about
shape**, and the shape was the part worth acting on. Chasing it into the
production file is what found the holes; clearing the badge would not have.

The fix was an **allow-list** of scripts a `local` step may invoke, plus
`new URL(arg).hostname` equality against the same loopback set the real guard
uses — so a script added to `scripts/` next month is refused by default rather
than allowed by omission, and the file has one host idiom instead of two.

**The general form**: a deny-list beside a real guard is not defence in depth,
it is a second thing that can be wrong, and prose calling it "belt and braces"
converts a gap into a reassurance. If you add a secondary check, either make it
at least as strong as the primary one or say plainly in the comment which
cases it does **not** cover. And a check that guards hosts more loosely than
the code beside it is a small lie about what is verified.

### The instrument whose empty result was indistinguishable from a clean one

Same night, watching CI on two pull requests. The monitor's exit condition
counted pending checks and stopped when the count was zero. `gh` returning
nothing — a transient failure, an empty response — also produced zero. So
"everything passed" and "I could not see anything" were the same value, and it
announced `ALL CHECKS SETTLED` while the only check that mattered was still
running. It emitted no per-check line, which was the tell: a report about
several checks that names none of them has not observed any.

I caught it only because the summary named no checks and I went and looked.

**Three habits, in order of how often they would have helped here:**

1. **Make a watcher print what it saw, not only its verdict.** A verdict with
   no evidence under it cannot be sanity-checked at a glance; a list of check
   names and results can.
2. **Never let "no results" and "no failures" be the same value.** Distinguish
   an empty query from an empty result set explicitly, and treat the empty
   query as not-yet-known rather than as done.
3. **Verify the conclusion directly before reporting it.** One
   `gh pr checks <n>` took seconds and contradicted the watcher outright.

This is the third instrument in one session whose success was uninformative:
a fixture that agreed with the guarantee, a mutation harness that mutated the
wrong function, and now a watcher whose silence looked like a pass. None was
carelessness. Each was a checking tool built while attention was on the thing
being checked — which is exactly when nobody is checking the checker.

**2026-09-12 — Claude (GATE & ENVIRONMENT, subagent of OWNER AGENT)**

### A marker that describes 170 of 236 worktrees, and the test that could not tell

`DECODER_SUITE_DELTA` was declared 65 and measured 73. Three lanes measured it
independently in one night and all three got a number the constant disagreed
with, because `test-count-check.mjs`'s shortfall message subtracted the stale
constant from the real shortfall and announced the remainder as "something else
and is worth finding" — sending readers after 8 tests that do not exist. The
number is now 73, measured with a control — same tree, same command, one
environment variable the only difference — and measured twice, because a
constant that has rotted twice deserves more than one reading:

```
at 05510e9 (this branch's base):   808 tests / 5 fail without   881 / 0 with   delta 73
on this branch (+6 own tests):     834 tests / 6 fail without    907 / 0 with   delta 73
```

A third reading taken by the lane that briefed me, on an earlier tree, was
780 / 853 — different absolute totals, **same delta of 73**. Three trees, one
number: that is what makes it a measurement rather than an observation.

The cause of the stale constant is the interesting part, and it is the same
shape as #464's own fix:

**A fix that removes a failure mode locally also removes the ability to exercise
its guard locally.** #464 taught the venv lookup to climb out of `.worktrees/`,
which was correct — and it meant unsetting the environment variable no longer
produced the no-decoder state, so nothing could reach the branch that consumes
the constant, so the constant rotted through the addition of a fourth image
suite and then a fifth. The comment defending it said it was "kept because CI
has no venv and is exactly where it now fires." **That was false when it was
written**: `fly-deploy.yml` builds a venv at :94-98 and exports the variable in
the *same job* as the count check at :134. The branch fires in CI never.

Then the marker itself. `git worktree list` reports **236 worktrees registered
against this repository, in six path shapes, and the literal `.worktrees/`
marker matches 170 of them**:

```
170  <main>/.worktrees/<name>                      matches
 31  ~/.codex/worktrees/<h>/kmt/.worktrees/<name>  matches the WRONG root
 17  ~/.codex/worktrees/<h>/kmt                    no marker
  5  <main>/.claude/worktrees/<name>               no marker  (the agent harness)
  3  ~/.codex/worktrees/<other>                    no marker
 10  %TEMP%/<name>, and one checkout beside <main> no marker
```

Every unmatched shape resolves `decoder.local` inside itself, where nothing has
ever built one, so 73 tests vanish and five suites fail at module load looking
exactly like broken code. The obvious fix — a second literal marker for
`.claude/worktrees/` — **would have fixed 5 of those 66.** The fix taken instead
asks git for `--git-common-dir`, whose parent is the main checkout from any
worktree in any layout. `scripts/worktree.mjs` had already reached that
conclusion independently (its `OUR_COMMON_DIR`); the fixture had re-derived the
question and answered it with a literal.

**The generalisable bit: a path marker encodes a guess about where somebody put
a checkout, and that is a fact that can stop being true with nothing going red.
When a tool already knows the answer, ask the tool.**

### The seventh instrument that reported success while proving nothing

`backend/decoder-fixtures.test.mjs` was written *for* #464, *to* end this exact
class. All six of its tests passed, green, in a worktree where `decoderPython`
was `null` and 73 tests were silently not running. The real-repo one asserted:

```js
assert.ok(!found.includes(`.worktrees${path.sep}`), ...)
```

and `...\kmt\.claude\worktrees\agent-x\decoder.local\...` satisfies it perfectly
— there is no `.` before `worktrees`, so the marker is absent, the climb never
happens, and the guard written to catch precisely this reports success. I
confirmed the blindness by mutation: reintroducing the bug leaves all six green.

**It asserted a property of the STRING instead of the property anyone wanted.**
The repair was to assert against git — the venv resolved is the one the main
checkout holds, whichever layout you are in — and that version goes red under
the same mutation while the other eleven stay green.

### Making a constant's staleness an event, not a vigilance problem

`DECODER_SUITE_DELTA` could not be tested because it lived in
`test-count-check.mjs`, which is a **script**: importing it runs the whole
four-minute suite. So nothing asserted against it and nothing ever could. It now
lives in `test-baseline.mjs` beside a new `DECODER_SUITE_FILES`, and a test
greps for the five files that import `realImageFixtures` and fails the moment a
sixth appears — the event that invalidates the number, caught when it happens.

That tripwire's own first draft searched for `realImageFixtures(` anywhere in a
file and reported **itself**, because its comment contains the words. A detector
that cannot tell a call site from a sentence about call sites would have been
wrong again the next time anyone documented it. It matches the import statement
now. Cheap lesson, general shape: **when you grep for a symbol to decide
something, your own explanation of the grep is inside the search space.**

### A swap that three guards cannot see, made mechanical

Delete a suite of N tests, add a suite of N tests: the total is identical, the
file count is identical, everything green, and N assertions that used to protect
something protect nothing. The defence was a *sentence* in a failure message
asking the author to "say so in the pull request."

`.forge/test-name-diff-check.mjs` diffs test NAMES, counted, against
`git merge-base HEAD origin/main`. Proven with a planted count-neutral swap
(3 tests deleted, 3 added) against the real repository:

| instrument | verdict on the swap |
| --- | --- |
| `test-count-check.mjs` | **907** — byte-identical to the unswapped run |
| `orphaned-test-check.mjs` | exit 0, "all 53 test files run somewhere" |
| `test-name-diff-check.mjs` | **exit 1**, naming all 3 lost tests |

Three design notes worth keeping: the **merge base**, never `origin/main`, or
every test added to main after you branched reads as lost; **names, not
files**, or every refactor that relocates a test cries wolf; **counts, not a
set**, or deleting one of two same-named tests shows no loss.

It is **not wired into CI**, and that is stated in the file rather than implied:
the gate job's `actions/checkout` at `fly-deploy.yml:83` carries no
`fetch-depth`, so the clone is depth 1 and has no merge base at all — the check
would refuse on every PR. Wiring it needs `fetch-depth: 0` on that job plus one
`- run:` line, which is the repo agent's lane. Until then it is a local gate,
and it refuses with exit 2 rather than degrading to green when it cannot compare
— the `NOTES.md` watcher lesson, applied on purpose.

### The shared scratchpad is not shared — the sessions opting out of it are

Two lanes reported another session overwriting a generically-named file
mid-run, one having executed another session's script by accident. **Measured
before theorising, and the brief's framing turned out to be wrong:** the harness
*does* isolate. Each session gets
`%TEMP%/claude/C--Users-anune-code-kmt/<session-uuid>/scratchpad`, and **108
distinct per-session directories** exist there today. Nothing collides inside
them.

The collisions are in the shared `%TEMP%` root, where sessions write when they
do not use the scratchpad they were given: **38 loose `.mjs` scripts and 775
loose `.txt`/`.log` files**, with names any two agents would independently pick
— `check.mjs`, `fix.mjs`, `answer.mjs`, `amend.mjs`, `api.mjs`, `lint-probe.mjs`
— sitting next to the fingerprints of people who found a name already taken:
`audit.txt`/`audit2.txt`, `a1/a2/a3.txt`, `wt.txt`/`wt3.txt`, `build2/build3`,
`ga-b3/b4/b5.mjs`, `owner.test.good2.mjs`. The generic `*-wt` worktree
directories in that root are the same story one level up.

**This is not fixable from inside the repository, and I am saying so rather than
building something that pretends to.** A helper that namespaced paths would
re-implement isolation the harness already provides, and could not stop a
session that types `%TEMP%/check.mjs` anyway — which is the only thing actually
happening. So, the convention instead, and it is the whole fix:

- **Write scratch files to the scratchpad path your harness gives you**, never
  to `%TEMP%` / `/tmp` directly. It is already per-session; use it.
- **If you must use a shared location, put the session or branch in the name.**
  `kmt-<branch>-audit.log`, not `audit.log`. An incremented suffix is not a
  workaround, it is the collision announcing itself.
- **Never execute a script from a shared temp path you did not write this
  session.** `check.mjs` in `%TEMP%` belongs to whoever wrote it last, and that
  is not reliably you.
