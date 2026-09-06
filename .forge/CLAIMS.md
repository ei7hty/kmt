# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `t49-copy-signout-contrast` | LEAD UI ENGINEER | t49: `index.html` title, `src/owner/OwnerInventory.jsx` and `src/owner/OwnerInventory.css` (copy, sign-out), `src/routes/QuoteRequests.jsx` (phone, sign-out), `src/App.css` and `src/RequestFlow.css` (contrast, footer control); `.forge/request-flow-check.mjs` phone string only with QA (#72 #96 #85) | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
