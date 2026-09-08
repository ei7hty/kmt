# Release handoff and candidate contracts

This is coordination data and read-only validation. It neither grants authority
nor executes a merge, deployment, provider request or production mutation.
The owner authorizes a specific merge; another agent reviews the exact PR head;
an assigned release executor performs it under the existing deployment queue.
The author never merges their own work.

## Measured starting point — 2026-09-08

| Evidence | Observation | Consequence |
| --- | --- | --- |
| [#430](https://github.com/ei7hty/kmt/pull/430) | Open 20:53:59Z September 7; merged 01:39:03Z September 8: 4h45m04s. Last-head gate 01:27:19–01:30:05Z. Final commits have earlier authored timestamps and 01:22:17Z commit timestamps. | Hardening and head replacement occurred; elapsed time alone cannot attribute all delay to rebasing or authorization. |
| [#435](https://github.com/ei7hty/kmt/pull/435) | Open 01:27:19Z; gate green 01:29:52Z; merged 02:11:35Z. | 41m43s elapsed after the gate, including review/coordination; do not call all of it idle time. |
| [#436](https://github.com/ei7hty/kmt/pull/436) | Two green PR gates at 02:13:37–02:16:35Z and 02:22:56–02:25:37Z; merged 02:35:26Z. | Changed heads repeated the full gate. |
| [#436 main run](https://github.com/ei7hty/kmt/actions/runs/34180582280) | Build/gate/deploy passed; deploy completed 02:38:58Z. At 02:39:49Z the live audit expected generated 135/80R12 tires, got zero plus the truthful empty state. 68/69 passed. | A stale expectation was discovered after deployment. |
| [#438](https://github.com/ei7hty/kmt/pull/438) | Audit-only repair opened 02:47:34Z, merged 02:59:03Z, 23m37s after #436 merged. | The same contract must run on the candidate. |
| [#437](https://github.com/ei7hty/kmt/pull/437) | Real same-millisecond ordering flake fixed; open 02:42:42Z, merge 03:06:10Z. Gate took 2m34s. | Repeated green reruns are not a substitute for repairing a measured flake. |
| [#439](https://github.com/ei7hty/kmt/pull/439) | At inspection still open at `e7fac14073c878fc881b7aee8fbc7612d91c42b8`; gate took 2m58s, independent review reported to PM. | Readiness and owner merge authorization are separate facts. |
| [Premature claim removal](https://github.com/ei7hty/kmt/commit/9fdaf261eb14ca27ea10dba20e3eb19ef0df7ef9) and [restoration](https://github.com/ei7hty/kmt/commit/2b041660682b450721b67432a1e7ebf60cc0730e) | #435 claim removed 01:28:16Z while open, restored 02:06:42Z: 38m26s without its coordination row. | Check main against open and ended PRs; author readiness never releases a claim. |

The assignment also reports circular PM routing, repeated requests for existing
authorization, branch-only claims and stale rows reintroduced by stale pushes.
Those are reported failure classes, not durations established by these PR API
timestamps. `.forge/AGENTS.md` documents the stale-edit mechanism. A current
read-only scan at 07:21Z saw eight claims, two open PRs, no missing/ended-PR
claim errors and six preparation/review warnings. Counts are observations, not
a permanent baseline.

## Priorities and target flow

| Priority | Before | After | Target for the next 10 eligible releases |
| --- | --- | --- | --- |
| P0 | Local gates omit a deployed-only application assertion. | Same script runs 53 candidate contracts before the flow audits; 69 remain in live acceptance. | Zero late failures caused by an assertion already executable against the candidate; candidate overhead under 45 seconds. |
| P0 | Permission is relayed as prose; next action returns to PM or author. | Queue entry names source, authorized head/action, independent reviewer and a distinct release executor. | Zero circular routes or self-merges; executor acknowledges a complete authorized handoff within 5 minutes. |
| P0 | Branch-only or prematurely released claim is invisible to others. | Claims stay on current main until merge/closure; read-only consistency scan before queue reconciliation. | Zero unclaimed open PRs; release ended rows before the release run finishes. |
| P1 | Every main movement prompts a new rebase/full local cycle. | Freeze a reviewable head; check overlap/integration against current main. Rebase for actual conflict or semantic dependency. | At most one full local verification per unchanged candidate tree, plus CI; zero rebase solely for claims/docs churn. |
| P1 | All work waits behind shipping. | Independent implementation/review/gates proceed concurrently; only ship-scoped merge through verified deployment is serialized. | No overlapping ship merges; authorized-ready to merge within 10 minutes when no earlier ship is in flight. |
| P1 | “Ready” is mistaken for “running”; external boundaries are implicit. | Executor records observed release commit and evidence after existing CI; explicit prohibitions remain on every entry. | Every ship has release evidence; zero provider/secret/customer actions inferred from merge authority. |

Targets are acceptance criteria for a trial, not measured improvements yet.
Do not skip a required gate to meet them. Changes to the candidate head invalidate
review/verification records; preserve the original authorization source and
reconfirm whether it covers the new head instead of silently widening it.
An unchanged valid authorization must not be requested again.

## Queue protocol

`.forge/release-queue.json` begins empty deliberately: this change does not
invent grants, adopt another task's PR or declare it ready. The PM records a
candidate after checking the original source. `.forge/release-schema.json`
defines required fields; the validator rejects unknown fields and unsafe states.

Each entry carries:

- PR number, branch and full reviewed `head`; author, coordinator and executor
  task IDs. Shared GitHub login is not agent identity. Executor must differ from
  author and coordinator; reviewer must differ from author.
- `authorization`: owner identity, original message/artifact locator, exact
  head, `action: "merge"` and timestamp, or `null` while absent. A relay is
  insufficient evidence without checking the owner's source.
- `review`: independent reviewer task ID, exact head, source, timestamp and
  `verdict` (`clean` or `changes-requested`). Ready requires `clean`.
- `verification`: exact PR head, integration base, evidence locator, time and
  `result` (`passed` or `failed`). Ready requires `passed`.
  CI's synthetic merge `GITHUB_SHA` identifies the tested artifact, and must be
  recorded in the evidence; it is not substituted for the reviewed PR head.
- `boundaries`: only `merge-via-existing-ci`; `prohibitions`: all of
  `no-direct-deploy`, `no-secrets`, `no-production-data`, `no-provider-contact`,
  `no-self-merge`. Broader operational authority belongs in a separate explicit
  owner instruction, never an extra capability smuggled into this queue.
- `waiting` with concrete `blockers`; `ready` only with all evidence and no
  blockers; `merging` when the independent executor has acquired the existing
  release turn; `deployed` only with observed `release.commit`, evidence `source`
  and timestamp. `closed` records an ended non-shipping/cancelled item.
  All timestamps use UTC `YYYY-MM-DDTHH:mm:ssZ`.

The queue is not an atomic lock, authorization service or automatic scheduler.
Only one ship-scoped entry can say `merging`, but agents still announce/acquire
the release turn and re-read GitHub/live state immediately before acting, as
`.forge/AGENTS.md` requires. A green validator proves record consistency, not
truth of supplied evidence, identity or current deploy status. Its source
locators must contain no secrets or private finding details.

The owner must approve queue adoption and assign its writer/executor before
operational use. Queue publication uses a reviewed PR unless the owner explicitly
authorizes metadata-only main updates. For an authorized main update, use the
same fresh disposable plain worktree, explicit path staging, staged diff review,
fetch, re-read/reapply and fast-forward push discipline as CLAIMS. Never replay
a stale whole queue or claim table; never force-push main. The exact queue path
is push-ignored by Deploy so an update cannot evict a waiting deployment.
Schema and validator changes still trigger the gate. CLAIMS publication and
release follow the existing protocol; this document grants no new write rights.

## Commands and verification boundary

```sh
node .forge/release-check.mjs
node --test .forge/release-check.test.mjs
node .forge/release-check.mjs --github
```

The first two are local and deterministic. `--github` explicitly uses `gh` GET
requests to read current **main** claims and all PR pages, reports its observation
time/claims blob, and exits nonzero on missing, duplicate or ended-PR claims,
head drift or premature completion, including a merged shipping PR recorded as
closed without deployment evidence. Preparation/review claims without a PR are
warnings. It never edits rows, labels, reviews or PRs. This mutable global scan
is intentionally not a required PR gate: unrelated stale rows cannot idle every
candidate. A snapshot race requires a fresh observation, not an automatic repair.

After build and Playwright install, start `backend/server.mjs` with a throwaway
DB/password/session secret, `KMT_BIND=127.0.0.1`, `PORT=4173`, no mail/provider
configuration, and `KMT_RELEASE` set to the artifact's seven-character SHA. Then:

```sh
node --test .forge/release-browser.test.mjs
AUDIT_MODE=candidate AUDIT_BASE=http://127.0.0.1:4173 AUDIT_EXPECTED_RELEASE=<artifact-sha> node .forge/deployed-site-check.mjs
```

Candidate mode refuses missing/invalid local configuration or release identity,
allows only GET/HEAD/TRACE at its exact numeric loopback origin, follows no
redirects, blocks browser external requests/WebSockets/service workers, and uses
no owner session. Forbidden attempts (including CSP-blocked requests) make the
candidate audit fail even if its visible assertions still pass. Canonical metadata stays canonical; asset reachability maps
its canonical path to loopback. The negative egress test uses a second local
origin as a trap and asserts zero hits and zero mutation requests, while proving
the attempted operations (including CSP-blocked fetches) make acceptance fail.

Candidate keeps every BASE-relative assertion. Its catalog budget can calculate
Brotli size from a bounded identity body because loopback lacks Fly compression;
the output says **candidate-computed Brotli**. Live acceptance still requires
actual br/gzip encoding and actual wire bytes. Candidate never substitutes for
the 16 production-only DNS, canonical/alias and other-host checks, or for the
post-deploy release-header confirmation. No production audit is run by the
candidate command. The existing live command remains available to an authorized
acceptance agent.

## Owner decisions after review

Approve or decline this PR's merge, which is ship-scoped because it edits the
workflow. Assign an independent release executor and retain the one-at-a-time
shipping boundary. Decide whether to adopt the queue and authorize its narrow
metadata publication protocol. Broader merge-queue automation, environment
protection rules and reusable gate artifacts remain follow-up designs; no such
platform controls or external permissions change here.
