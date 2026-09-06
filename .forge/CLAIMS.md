# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| m13-owner-day-to-day | OWNER PORTAL ANALYST (local_a76ad1cd) | .forge/m13-owner-day-to-day.md, .forge/shots/m13-*.png (docs only) | 2026-09-06 |
| lint-mjs | LEAD BACKEND DEV | eslint.config.js (rules for .mjs, #64) and the mechanical fixes it finds: backend/*.test.mjs, .forge/*-audit.mjs and *-check.mjs (browser globals in page scripts, two escapes), scripts/import-tires.mjs and scripts/worktree.mjs (one line each; other lanes' files, touched for lint only) | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
