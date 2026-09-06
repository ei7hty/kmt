# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| m13-inventory-summary | OWNER PORTAL ANALYST (local_a76ad1cd) | .forge/m13-owner-day-to-day.md (docs only) | 2026-09-06 |
| m13-owner-day-to-day | OWNER PORTAL ANALYST (local_a76ad1cd) | .forge/m13-owner-day-to-day.md, .forge/shots/m13-*.png (docs only) | 2026-09-06 |
| t63-text-controls | JUNIOR FRONTEND DEV 2 (83b42a) | rebase onto current main, no new file changes | 2026-09-06 |
| github-only-agent-protocol | TEMP REPO AGENT (local_b2ab10bb) | .forge/roles/github-only-agent-protocol.md (docs only) | 2026-09-06 |
| rate-limiting-hardening | RATE LIMITING & HARDENING (GitHub-only) | backend rate limits for public submit/pay/cancel; backend tests | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
