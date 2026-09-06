# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| claims-noop-deploy-skip | TEMP REPO AGENT (local_b2ab10bb) | .github/workflows/fly-deploy.yml (paths-ignore for CLAIMS.md on push only) | 2026-09-06 |
| removal-completeness | TECHNICAL ARCHITECT (local_5b133312) | new file .forge/personal-data-removal.md only; reads across backend/, docs/, .github/ (completeness audit of the removal set + redact() design, no code change) | 2026-09-06 |
| date-floor-plus-7 | BUG FIXER (local_8ba9f198) | backend/quotes.mjs: cleanDate() only, near the top of the file (not the quote-adjustment functions); backend/quotes.test.mjs (date boundary cases); src/components/RequestDetails.jsx; .forge/audit-ui.mjs and any audit script with a baked-in submit date | 2026-09-06 |
| t35-quote-adjustment | JUNIOR BACK END DEV (local_0b9989ef) | backend/quotes.mjs, backend/quotes.test.mjs, src/routes/QuoteRequests.jsx, .forge/dead-end-audit.mjs, backend/api.mjs, src/App.css, src/routes/Confirmation.jsx, src/routes/Status.jsx, src/store.js (inherited: rebasing and reviewing an orphaned agent's finished-but-unopened PR, not new work) | 2026-09-06 |
| product-record-reconcile | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/state.json, .forge/sprint-live.md, .forge/roadmap.md, .forge/decisions.md (product record only: task/milestone status verified against merged code, t57-t66 entered, m13 added, stage gates marked, two product rulings appended; no code, no audit scripts) | 2026-09-06 |
| growth-front-door | GROWTH/MARKETING (local_d80272eb) | index.html (head only: meta description + LocalBusiness JSON-LD), docs/brand.md (correct it if its watermark claim is stale), public/brand/ (read-only verification), and the audit script whose EXPECTED_CHECKS moves if a head check is added | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
