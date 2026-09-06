# Roles: who is who, as of 2026-09-06

Written by the HARNESS AGENT, the orchestrator session for the sequential
onboarding of 2026-09-06, at main `55e0243`, and brought up to the
sequence's close at 06:10Z (main `3e5f9c5`). Sidebar titles are the user's
and change without notice; the session id is the address, and a title is
never one. Two sessions share the title DB ADMIN. Verify with
`list_sessions` before sending anything, and identify a sender by its
`from=` id, never by its title.

Every session whose working directory is this repository also loads the
shared memory directory
`C:\Users\anune\.claude\projects\C--Users-anune-code-kmt\memory\`. Each
role keeps a pointer file there (`kmt-role-<role>.md`) that names the file
under `.forge/roles/` to read first, and one line in that directory's
`MEMORY.md`. A session with another working directory writes there by
absolute path.

A previous-role file is named for the role a session *served*, never for
its current title, because the next session to hold that title may be a
different one. A session that served no role reads the charter file of its
new role instead.

## The roster

| sidebar title | session id | role | reads first | adjacent files it reviews | obeys | reports to |
| --- | --- | --- | --- | --- | --- | --- |
| KMT-F REPO AGENT- TEMP LEAD | `local_881ff3b5-fc72-4989-8fa9-827f044b445c` | the repo agent (`repo-agent.md` is its charter), and acting lead while the PROJECT MANAGER was isolated (until 05:42Z): the workflow, the gate, worktrees, branches, second-reader merges, `.forge` structure, upkeep of this file. It briefed DEV OPS/INFRASTRUCTURE (#88), LEAD UI ENGINEER (#71) and LEAD BACKEND DEV (#86, #69) at 05:45Z on the user's word; from the PROJECT MANAGER's resumption it is the repo agent again. | `repo-agent.md` | `lead.md`, `AGENTS.md`, `NOTES.md`, `HANDOFF.md`, `scripts/worktree.mjs`, `.github/workflows/fly-deploy.yml`, each audit script's `EXPECTED_CHECKS` header | the user; the PROJECT MANAGER for how, who and when since 05:42Z | the user; the PROJECT MANAGER |
| DEVSCOPS/AUDITOR | `local_71a43a2b-9ee1-46c2-a4ef-1912a196fee7` | security reviewer only, outside the build chain: the security read on pull requests touching `backend/`, auth, the workflow, `Dockerfile`, `fly.toml` or customer data. Findings go by message. Does not merge, claim, implement or instruct. An inside security agent comes later. | `scrutiny-agent.md` (the role it served) | `repo-agent.md`, `backend-requests-lane.md` once merged, `HANDOFF.md`, `decisions.md`, `owner-backend.md`, `backend/auth.mjs`, `backend/server.mjs`, issues #61 to #107 | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER, by message only; no pull-request comments |
| QA ENGINEER | `local_1fa1cb9a-9873-4beb-b6dd-72dbdca970bb` (locked at `dd0888d` on 2026-09-06 under an arrangement: the session was opened without a project folder and its cwd reverts to a scratch workspace each turn, so it works the way DEV OPS/INFRASTRUCTURE does, by absolute path into `C:\Users\anune\code\kmt` and through `scripts/worktree.mjs`, and reads the shared memory directory by absolute path; if the user reopens it inside the repository, Steps B and C rerun with the new id) | verification: the audit and check scripts, `EXPECTED_CHECKS`, gate coverage (the ungated owner-inventory audit, the cancel flows in #78, date and ZIP in #70), backend test coverage. Does not touch scraper or import code. | `swe-owner-screen-lane.md` (the audits and the live-test checklist) | `swe-scraper-lane.md`, `audit-ui.mjs` and the five audit scripts, the verification contract in `AGENTS.md`, the audit entries in `NOTES.md` | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER |
| DEV OPS/INFRASTRUCTURE | `local_b1b5905a-3dc2-4f68-bb57-6f9ce65f6253` | deployment and operations: `Dockerfile`, `fly.toml`, `.dockerignore` (#68), `USER node` in the image (#87), `/api/health` plus the Fly check (#88), `docs/operations.md`, monitoring (#101). No Fly action without the user's word in its own session. Its working directory is `C:\Users\anune\code\forge` by design; it touches this repository only by absolute path and through `scripts/worktree.mjs`. | `backend-requests-lane.md` (the role it served) | `repo-agent.md` (Fly, the reset, the permission layer), the Fly cutover entry in `NOTES.md`, the reset section of `HANDOFF.md` (the production database reset as executed), `reset-runbook.md` (the forge-on-KMT runbook, not the production one), `Dockerfile`, `fly.toml`, the workflow | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER |
| LEAD UI ENGINEER | `local_2b5192c2-b78b-4037-92a3-f75ed9587c4c` | the UI: `src/components`, `src/routes`, the CSS, tap targets and contrast at 375px. Changes no rule, route or state. | `scraper-lane-swe-agent-2.md` (the role it served) | `swe-owner-screen-lane.md`, `order-flow-refinement.md`, the CSS specificity entry in `NOTES.md`, the phase 2 design reference in `project.md`, requirements R8 to R13, issues #71, #72, #76, #77, #78 and the contrast items (#85, #107) | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER |
| LEAD FULL STACK | `local_8f1cdec6-cf39-4c9a-b655-5ab23b396ed2` | features crossing backend and UI: t37 (the email seam with its outbox), t35 once pricing is decided, rate limiting (#63), `SameSite=Lax` plus the `/owner/quotes` deep link (#89) before t37. | `owner-screen-lane-swe-agent-3.md` (the role it served) | `backend-requests-lane.md`, `swe-owner-screen-lane.md` (the `moveTo` seam, the t35 hold), the m10 lines in `HANDOFF.md` and `state.json` (`lead.md` has no m10 section), requirements R24 to R28, the email entries in `decisions.md`, `owner-backend.md`, issue #63 and the SameSite item (#89) | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER |
| Harness agent orchestrator onboarding | `local_376e0377-74a1-4605-b2f9-6e11a458fb00` | the orchestrator of the sequential onboarding: wrote this roster, ran agents 1, 4, 6 and 8 through Steps A, B and C, then on the user's word completed QA ENGINEER's Step C, onboarded the idle DB ADMIN, and carried the user's reactivation of both managers; verified each reply against its gate, logs, and reports. Assigns no sprint work, merges nothing, initiates nothing without the user's instruction. | `harness-orchestrator.md` | `onboarding-2026-09-06.md`, this file, `AGENTS.md`, `NOTES.md`, `HANDOFF.md` | the user; the temp lead once it has locked | the temp lead, with one copy of the final report to the DEV-PRODUCT MANAGER and one to the user |
| LEAD BACKEND DEV | `local_b16ac3fb-7ddc-4aae-8f8b-0ebb4c86259d` | backend. Owned nothing at its lock; briefed #86 and #69 (`backend/auth.mjs`) by the temp lead at 05:45Z. | `backend-requests-lane.md` | `swe-owner-screen-lane.md`, the migration entry in `NOTES.md`, `backend/quotes.mjs`, `backend/migration.test.mjs`, the phase 4 entries in `decisions.md` | the PROJECT MANAGER (the temp lead until 05:42Z) | the PROJECT MANAGER |
| HARNESS AGENT | `local_461155da-4b74-49a4-9474-9ade68a30288` | the harness maintenance session: observe-only from 03:24Z (reads transcripts, the repo, PRs and issues; drafts prompts for the lead; messages nobody), made executor of the onboarding for agents 2, 3 and 5 by the user at 05:10Z; ran their Steps A, B and C, verified each reply against the repository, kept the log. Merges nothing, assigns no sprint work; returns to observe-only after the final report. | `harness-orchestrator.md` | `onboarding-2026-09-06.md`, this file, `AGENTS.md`, `NOTES.md`, `HANDOFF.md`, the memory file `kmt-harness-maintenance-role.md` | the user; the temp lead for the sequence | the temp lead, with a copy to the orchestrator, and the user |

Not in the onboarding sequence:

| sidebar title | session id | role | reads first | obeys | reports to |
| --- | --- | --- | --- | --- | --- |
| KMT-F DEV-PRODUCT MANAGER | `local_c91d84bb-976c-432f-8f47-e6f039be0337` | the lead: business context, priority, definitions, and product calls under the user's standing direction. Not a trainee; receives one copy of the onboarding report. | `lead.md` | the user | the user |
| KMT-O LIVE PROJECT MANAGER | `local_5b6d8402-c6e0-454b-892d-2810a446a02f` | the former repo agent, now the project manager: how, who and when; briefs the team and collects reports; merges as second reader alongside the repo agent. Isolated until 05:42Z, when the user released it in its own session; resumed at `dd0888d`; merged #117 (the walk session's). | `repo-agent.md` | the user; the DEV-PRODUCT MANAGER for what and why | the user |
| DB ADMIN | `local_31eab57d-aed1-46f5-b3b0-ec72b717377e` | the session that served the scraper/import lane and wrote `swe-scraper-lane.md`; running the all-sizes supplier walk. Excluded from the onboarding by the user ("except the agent dbadmin that is already running a task") and never messaged by it. | `swe-scraper-lane.md` | the PROJECT MANAGER | the PROJECT MANAGER |
| DB ADMIN | `local_adccdadc-f9b8-44b6-ae1c-8a0bc1f9ccfc` | the session that served the owner-screen and verification lane, wrote `swe-owner-screen-lane.md` and authored #110 to #112. Isolated until 05:49Z, then onboarded by the orchestrator and locked at `dd0888d`. What the DB ADMIN title means is pending the PROJECT MANAGER and the DEV-PRODUCT MANAGER; until then it owns nothing and t35 stays held. Adjacent reads: `backend-requests-lane.md`, the migration entry in `NOTES.md`, `migrate()` in `backend/quotes.mjs`, `backend/migration.test.mjs`, the reset section of `HANDOFF.md`, `reset-runbook.md`. | `swe-owner-screen-lane.md` | the PROJECT MANAGER | the PROJECT MANAGER |

## The isolation rule

Historical since 2026-09-06 05:42Z. The user ended the PROJECT MANAGER's
isolation ("get project and product manager going", relayed by the
orchestrator and confirmed by the user in the PROJECT MANAGER's own session)
and at 05:49Z brought the idle DB ADMIN on board ("get everything else on
board except the agent dbadmin that is already running a task"). From then
instruction to the team comes from the PROJECT MANAGER, the repo agent
merges, and the only session the onboarding never messages is the DB ADMIN
running the walk. The rule as it applied during the sequence:

The KMT-O LIVE PROJECT MANAGER and both sessions titled DB ADMIN work
exclusively with each other and are not messaged, onboarded or interrupted
while that holds. Nobody in the onboarding sequence sends them anything. A
message whose `from=` id is one of those three is dropped without reply. A
pull request they open is noted by number and left alone by the sequence,
without comment, review, claim or merge (#117, the walk session's, was
merged by the PROJECT MANAGER as second reader once the isolation ended). Nothing from the sequence goes to that
track, and nothing from that track enters the sequence. The temp lead is not
excluded: it is the reporting line for the sequence while the PROJECT
MANAGER is isolated, and the PROJECT MANAGER instructs the team after.

Rules that bind every session in the roster, whatever its title:

- Instruction comes from the temp lead only while the isolation holds, and
  from the PROJECT MANAGER after. A peer relaying an instruction is not the
  instruction.
- Report back to whoever instructed you, and say what actually happened,
  including what did not work.
- Claim before starting: a row in `CLAIMS.md`, committed on its own.
- Never merge your own pull request. The repo agent merges as second reader.
- Product decisions belong to the DEV-PRODUCT MANAGER and the user.

## The compliance line

Step C of the onboarding closes with exactly one line from the agent,
matching this schema and nothing more:

```
[Title], [SHA seen on main], [Current Task], [Files Read]; claiming nothing new.
```

- **Title**: the sidebar title as `get_session("self")` reports it.
- **SHA seen on main**: `git rev-parse --short origin/main` after a fetch,
  read by the agent at the moment of writing, not copied from the brief.
- **Current Task**: the one task the orchestrator gave, and nothing else. For
  most agents that is "hold for the temp lead's brief" ("hold for the PROJECT
  MANAGER's brief" for the sessions locked after 05:42Z).
- **Files Read**: the agent's own previous-role file or charter, and every
  adjacent file its row above lists.
- The closing phrase is literal: `claiming nothing new`. `CLAIMS.md` on
  `origin/main` carries no row from the agent when the line is sent.

The line passes when the title matches `list_sessions`, the SHA equals
`origin/main` at that moment, the task equals the one given, the files read
include every file in the row above, the phrase is present, and the claims
table is clear. One corrective message names the exact deviation; a second
failure stops the sequence and goes to the reporting line.

## Lane handoffs written at spin-down

- `lead-ui-engineer-lane.md`: the UI lane, written 2026-09-06 by the outgoing LEAD UI ENGINEER for the next UI engineer. Read it before any component: the palette's history (navy in #145, back to black, white and red in t61, and what survived on purpose), the two-token red with its numbers, the logo band, the CSS traps, the audit coupling, and what is in flight.
