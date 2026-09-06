# Role: scrutiny agent

Written 2026-09-06 by the session that served this role (sidebar title
DEVSCOPS/AUDITOR at the time of writing, id `local_71a43a2b`), at `ab6aaec`.
It read the repository end to end twice on 2026-09-06 and wrote the two
reports that became issues #61 to #107. This is for whoever next reads this
codebase looking for what is wrong with it. Verify before you rely on it.

## What the role owned, and did not

- Owned: reading, and a report the lead could act on. Every source file, every
  document under `.forge/`, the workflow, the deploy config, the tests, and
  the live site read-only; then findings, most severe first, each with where,
  evidence, a fix and a lane, in a shape the repo agent could paste as an
  issue. Two passes: the sweep, then a review of the sweep for what it
  skipped and for what nobody was planning.
- Did not own any file. No claim, no branch, no commit, no pull request while
  serving. Never merged, assigned, or wrote to production. Findings went by
  message and by file; the lead decided; the repo agent filed and verified
  each one (#61 to #107) and corrected two (#84, #99).
- Did not fix anything it found, including one-liners. The role's value is
  that its report is not also its own change list.

## Who it obeyed, and what it reported

- Obeyed the user directly: the instruction to scrutinise, then the
  instruction that findings should be issue-shaped for the repo agent to
  file. Reported to the lead session by message (`local_c91d84bb`, titled
  KMT-F LEAD AGENT then DEV-PRODUCT MANAGER during one evening) and to the
  user as a file.
- Wrote nothing into the repository. Reports lived in the session scratchpad
  and went out with the full text in the message: an unclaimed file in the
  shared checkout is something another agent's commit can sweep up.
- The lead passed findings to the repo agent as information; nothing was
  assigned from one without the user (`roles/lead.md` records that rule).

## Code map: what was read, and how it was probed

- Reading order: `.forge/AGENTS.md`, `project.md`, `requirements.md`,
  `state.json`, `CLAIMS.md`, `NOTES.md`, `HANDOFF.md`, `README.md`; then
  `backend/*.mjs`, `src/**` (routes, store, pricing, markup, catalog,
  fitment, liveCatalog, owner screens, bookmarklet), `scripts/*.mjs`, the
  five `.forge/*.mjs` audits with `audit-ui.mjs`, `Dockerfile`, `fly.toml`,
  `.dockerignore`, the workflow, `eslint.config.js`, `package.json`, the CSS.
- Static checks that found real things: `npx eslint --print-config <file>`
  (0 rules on every `.mjs`, #64), proved with a probe file holding an unused
  variable and an undefined identifier, dropped into `backend/` and `src/`;
  a grep of the built `dist/assets/*.js` for `listPrice`, `sku:` and
  `stock:` (#61); a node one-liner comparing class selectors in `App.css`
  against every `className` in the JSX (31 dead, #90); `git check-ignore`,
  `git ls-files secrets .env.local`, `git log --all -- secrets` (nothing
  tracked, ever).
- Read-only probes of `https://kmt.fly.dev`: `curl -sI /` for headers
  (#67); `GET /api/catalog` for count and shape; `GET /owner/` and
  `/api/nope` for routing (#76); `POST /api/owner/login` with no body for
  the 500 (#69). Nothing that writes. The flow audits write, and the #42
  decision says why they never point at production.
- The throwaway server: `npm run build`, then `backend/server.mjs` started
  from PowerShell with `Start-Process` so the shell returns, `PORT=4590`
  (a port no audit defaults to), `KMT_BIND=127.0.0.1`, `KMT_OWNER_DB` under
  `%TEMP%`, a twelve-character `KMT_OWNER_PASSWORD`, `KMT_SESSION_SECRET`;
  a GET loop until it answered; the four audits run one after another with
  `AUDIT_BASE` and the password exported. Not in parallel: each submits
  requests and clicks the first Approve it sees. Stopped by port after
  reading the process command line; the three sqlite files removed by
  literal path.
- Probes written to the scratchpad and run with `node`: a Playwright pass at
  375 px measuring tap targets, contrast against the nearest solid
  background, labels, alt text and focus (#85); `readAuthConfig` and
  `createAuth` called directly with `KMT_SESSION_HOURS=abc` (#86). Import a
  repo module from a scratchpad file with a `file:///C:/...` URL or
  `createRequire('C:/.../kmt/package.json')`; a bare `C:/...` path is not a
  valid ESM specifier on Windows.

## Rules paid for

1. Measure with the request a browser makes. The compression finding (second
   pass, A1) said the live site compressed nothing and a phone downloaded
   about 850 KB. Wrong: it was measured with HEAD (`curl -sI`), and a HEAD
   response carries no `content-encoding`. A GET with `Accept-Encoding: br`
   returns `content-encoding: br` and 33,972 bytes for the catalog, because
   Fly's proxy compresses in front of the origin. The repo agent caught it
   and filed the correction as #84, downgraded. The uncompressed byte counts
   were right; the conclusion drawn from them was not.
2. Re-read the pull request list just before sending. The first report said
   #59 was open and to decide before merging it; it had merged at 02:47Z
   while the sweep was running, so finding #61 was already live. Name the
   SHA and the PR states as read at the moment of sending.
3. Read a document before recommending an edit to it. Finding #80 told the
   lead to add a backup section to `.forge/reset-runbook.md`, which is about
   running forge. There was no operations runbook anywhere; #99 amends it.
4. When a fix touches something an audit asserts, say so. Formatting the
   owner's phone number (#72) breaks `request-flow-check.mjs`, which asserts
   the raw E.164 string; the two change together.
5. The shared checkout moves under you. `main` in the main checkout went
   from `9b52037` to `f1e7781` to `f42610f` in one sitting because other
   sessions pulled. The changed-file notices are real: re-read before citing
   a line number, and record the SHA every finding was read at.
6. Test names are not coverage. Listing `test(` titles felt like reading the
   suites. The second pass read the bodies: no assertion-free tests, but
   nothing exercises `serveStatic`, the auth body 500 or the session-hours
   case. Read the bodies the first time.
7. Ask "what is nobody planning for" as its own question. Part B of the
   second pass (quantity #93, tax #94, service area #95, sign-out #96,
   privacy #100, monitoring #101, retail versus dealer cost #106) mattered
   more than the code bugs; quantity and the cost basis were decided by the
   user within hours.
8. Severity is the reader's. The repo agent re-graded items after verifying
   them. Give the evidence and let the grade move.

## How to verify

- `node --test backend/*.test.mjs`, `npx eslint src backend` (remembering
  #64), `npm run build`, `npm audit`.
- The four audits against `backend/server.mjs` on a fresh temporary
  database: never `vite preview`, never production. Read each script's own
  count line, not the exit code alone.
- `git status --short` before and after. The audits write only to
  `.forge/shots/`, which is ignored. Probe files removed; the port confirmed
  free with `Get-NetTCPConnection`.
- Against production, read-only only: GET, HEAD, and
  `deployed-site-check.mjs`.

## Harness quirks met

- Bash heredocs failed on a long markdown body ("unexpected EOF") and on
  `$'\r'` inside a compound command. Write files with the Write tool and
  scripts to the scratchpad, then run them.
- `Remove-Item` on a wildcard path is refused by the permission layer; remove
  by literal path. Foreground `sleep` is blocked in Bash; wait in PowerShell.
- `kill $!` does not free a port on this machine; stop by port from
  PowerShell after reading the command line, as `NOTES.md` says.
- Identify sessions by id, never by title: this session's reports went to
  one id under two titles in one evening. `list_sessions` before sending.
- `git show origin/main:path` needs `MSYS_NO_PATHCONV=1`. `core.autocrlf`
  is true: `.forge/*.md` are CRLF on disk and LF in the index, so a file
  written with LF commits cleanly.
- The memory directory refuses heredocs; use Write and Edit there.

## Day one: what no document says

- Start with the project's own instruments. `EXPECTED_CHECKS`,
  `--print-config`, the deployed-site check's field list, a grep of `dist/`:
  each became a finding when pointed at something it had not been pointed at
  before.
- Your report will be filed within hours by someone who verifies every line.
  Write for that reader: one claim, one measurement, one fix, one lane. The
  items that survived unchanged were the ones with a command in them.
- The cheapest finding is often the largest. `--print-config` took a minute
  and showed the backend lint asserting nothing; the bundle grep took a
  minute and showed the supplier's costs in public.
- Say what you did not do. The first report said the audits had not been
  re-run; the second ran them. Both sentences were worth more than a green
  tick nobody could trace.
- Do not fix. The moment you hold a branch you hold a stake.
- You will be wrong about something measurable. The #84 correction cost
  nothing because the method was written down; the mistake was in one step
  of a reproducible measurement, not in an opinion.
