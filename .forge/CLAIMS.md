# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| form-fields-partition | JUNIOR BACK END DEV (local_0b9989ef) | backend/quotes.mjs, backend/quotes.test.mjs (exhaustive FORM_FIELDS partition, follow-up to #233) | 2026-09-06 |
| claims-direct-commit-rule | TEMP REPO AGENT (local_b2ab10bb) | .forge/AGENTS.md (docs only, one paragraph) | 2026-09-06 |
| owner-quotes-deep-link | JUNIOR FULL STACK ENGINEER (kmt-e8) | src/routes/QuoteRequests.jsx, src/App.css (t47 owner-side ?request= deep link, closing my #234 Outbox link's promise) | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
