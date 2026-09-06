# Lead handoff, 2026-09-06

Written by the outgoing KMT lead session at the agreed pause point, for the
next lead. Read this, then `AGENTS.md`, `NOTES.md`, `CLAIMS.md`, `project.md`,
`requirements.md`, `roadmap.md`, `state.json`, in that order. Everything here
was true at the pause; verify the SHAs and PR states before acting on them.

## Where the project is

Phase 4's first milestone is done: **m9**, 33 of 38 tasks, requests and quotes
live in the backend and the flow was proven between three devices on the
public site (PR #50). The second milestone, **m10**, has its first task, t34
contact fields, merged (PR #53) and the rest planned: t35 owner adjusts the
quote, t36 lifecycle, t37 email, t38 proof between two inboxes.

`main` at the pause: `e086760` (the #56 merge; this document lands on top of
it), green through all three CI jobs. Merged in the final hour: #53 contact
fields (`1e0489c`), #54 size-filter checks (`fb19a0f`), #56 one description of
the gate (`e086760`). #45 was closed as superseded by #56.

One thing the previous lead got wrong, kept here so the next does not repeat
it: the lead asked the repo agent to self-merge a docs PR "under the docs-only
exception", and no such exception exists in the checked-in rule. The repo agent
refused, correctly, and the lead merged it as second reader. If a docs-only
exception should exist, write it and have someone else merge that first.

Production: https://kmt.fly.dev, one Fly machine, SQLite on a volume. The live
catalog serves 118 supplier tires across four sizes plus generated coverage for
906 more. One real request exists, the t33 proof: id
`f80ada133275b41c327b6c35fb5555a4`, vehicle "TEST 2021 Honda Civic (forge t33
verification)", status paid, stored before contact fields existed. It stays
until t36 adds "done"; the owner then marks it done. No owner price is set in
production; every price is the placeholder markup.

## The one open PR, and why it is open

**PR #55, t36 request lifecycle** (SWE-0 AGENT 1, branch `request-lifecycle`)
is open, green, and deliberately unmerged. Its first commit is a schema
migration: a rebuild of the `quotes` table without its status CHECK, foreign
keys off around it, deciding whether to run by inspecting the stored schema,
with status validation moved into code. `backend/migration.test.mjs` builds the
old schema by hand, seeds it with the shape of the production row, and proves
the paid row survives with its version intact. It exists because tests and CI
build fresh databases while production's persists, and SQLite cannot alter a
CHECK, so t36's new statuses would have failed on production's first write.
Commits two and three are the lifecycle itself: `done` only from paid, `sent`
written while `approved` stays readable, `finish()` and `cancel()` as separate
methods over one version check, customer cancel answering 404, a `reason`
column through `shapeRow`, owner list filters, the refund sentence.

**Merging it is deploying it.** The workflow deploys every push to `main`
with no gate between merge and deploy; the migration runs on the new
release's first boot against the real volume. Re-deploying an earlier commit
restores code, not data, so the volume snapshot is the only rollback. Your
first act:

1. Merge `main` into it if #53 landed after its last run (both touch
   `QuoteRequests.jsx` and `quotes.mjs`); re-run the gate; the baseline is
   then 42 / 34 / 8.
2. Read it as its second reader (the lead reads anything that runs before the
   repo agent merges it). Check: the old-schema test starts from the narrow
   CHECK and the paid row survives; a second open is a no-op; an invalid
   status is still refused; the audits that now assert SENT run in the check
   job only.
3. Have the user run `fly volumes snapshots create kmt_data -a kmt`.
4. Tell the repo agent "merge". Watch all three jobs and the post-deploy
   19-check log line. Then have the owner mark the TEST request done.
5. Then t35 (SWE-S AGENT 2): read `moveTo()` first; it is the seam the
   adjustment work wants, and `decide()` no longer has this morning's shape.

## Who is who

Sessions are named in the user's sidebar. All PRs come from one GitHub login,
so authors are told apart only by branch and message; from now on every PR
body opens with `Author: <session name>`. Write that into `AGENTS.md`.

| Session | Lane | State at pause |
| --- | --- | --- |
| KMT LEAD AGENT | planning, briefing, product calls, second reader for anything that runs | stopped; this document |
| KMT REPO AGENT | merges every PR after reading the diff and each script's own count line; owns `.github/workflows/` | stopped after the queue drained |
| SWE-0 AGENT 1 | backend and customer flow: t25–t33 done; #55 (migration + t36) open | stopped |
| SWE-S AGENT 1 | scraper and import lane; did t34 (#53) | stopped |
| SWE-S AGENT 2 | owner screen and verification; #54 | stopped, holding t35 |
| SWE-F AGENT 1, SWE-F AGENT 2 | former SWE 3 and SWE 2, high-usage models | spun down, archived; their handoffs are forwarded to SWE-S 2 and SWE-S 1 |

The user's rules: no new high-usage sessions; a replacement does not start
until the agent it replaces has stopped; the lead says "go".

## Rules in force that the docs may not yet say

- An author never merges their own PR. The repo agent merges; anything that
  runs gets a second reader first (the lead); docs-only changes the repo
  agent authors may be self-merged once the gate completes.
- The merger claims a PR by a one-line message before starting on it.
- An author merges `origin/main` into the branch and lets the gate run on
  that before asking for a merge.
- "No checks reported" or a zero count is no gate. Cancelled is not failed;
  read `.conclusion`.
- Merges are announced by SHA to the lead and the author.
- The post-deploy job is read-only by design (#42). Never point the flow
  audits at production; they write.
- Each audit script carries `EXPECTED_CHECKS` and fails on any mismatch, up
  or down. No numbers live in prose.
- Claims go in `CLAIMS.md`; notes in `NOTES.md`; `AGENTS.md` is the protocol.

## Queue after #55, in order

1. **t35** owner adjusts the quote (SWE-S AGENT 2): totals computed
   server-side from lines, never trusted from the client; every transition
   bumps the version; draft kept alongside the sent quote; a later migration
   that adds columns checks for the column the way #55's checks the schema.
   SWE-0 AGENT 1 is free for t37's backend seam meanwhile if you want the two
   in parallel; they do not share files until the send hooks.
2. **t37** email through a provider's REST API behind one module with an
   outbox; needs the user's provider account and a verified sending domain.
3. **t38** two-inbox proof on the live site; the user does the owner side.
4. Repo agent lane, after the above are not touching the workflow: fold the
   check and verify jobs into one definition with two targets; add a fixture
   step (one owner price, one delisted tire) before the flow audits; add the
   owner-inventory audit to the gate now that it reads `AUDIT_BASE`.
5. Small follow-ups, any idle agent: comments in `scripts/worktree.mjs`
   stating the two guards it relies on, and wrapping its `git worktree add`
   failure into the one-line `fail()`; a comment pair tying `compactSize` in
   `OwnerInventory.jsx` to `fitment.js`'s exclusion of other size grammars;
   the bookmarklet's 910-entry size select on `/owner`.

## Waiting on the user

- Volume snapshot before the migration merge (above).
- Mark the TEST request done once t36 lands.
- Ken's real markup rate; the placeholder is still what prices untouched
  tires.
- For t37: an email provider account, a domain with SPF and DKIM, Ken's
  address, the sending address. Secrets go to Fly by the user, never through
  an agent or a PR.
- Phase 5 will need a payment processor account.

## Hazards, briefly (full text in NOTES.md)

Tests and CI build fresh databases; production's persists on the Fly volume.
Any schema change needs a migration and a test that starts from the old
schema, or it passes everything and fails on production's first write.
SQLite can add a nullable column but cannot alter a constraint or add a
required column without a rebuild. The owner-inventory audit is real but
ungated: no workflow runs it, so run it yourself against `backend/server.mjs`
before trusting a change to `/owner`.

Worktrees share `node_modules` by junction; `git worktree remove --force`
deletes through it into the main checkout. Use `scripts/worktree.mjs`, or a
real `npm ci` per worktree. Two `dev.mjs` at once share Vite's HMR port and
poison the owner-inventory audit. `kill $!` does not free a port on Windows.
Edit scripts matching LF miss CRLF files. `git show origin/main:path` needs
`MSYS_NO_PATHCONV=1` in Git Bash. Registered worktrees on merged branches are
not work in flight; each is its owner's to remove.

## Decisions made tonight that are in `decisions.md`

Post-deploy read-only (#42); email instead of SMS for m10 (#33); the m10
answers (#30); the migration split (in the migration PR's body; add it to
`decisions.md` when it merges).
