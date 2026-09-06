# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| wizard-zip-and-date | LEAD UI ENGINEER | src/components/RequestDetails.jsx, src/routes/CustomerRequest.jsx ZIP label and date min (t48 wizard half of #182) | 2026-09-06 |
| m13-owner-day-to-day | OWNER PORTAL ANALYST (local_a76ad1cd) | .forge/m13-owner-day-to-day.md, .forge/shots/m13-*.png (docs only) | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
