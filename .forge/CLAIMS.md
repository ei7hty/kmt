# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| mail-quote-declined | LEAD FULL STACK (local_8f1cdec6) | backend/mail-templates.mjs (MAIL_TYPES + the quote-declined template), backend/mail.test.mjs; NOT the api.mjs hook, which follows t35 as its own PR | 2026-09-06 |
| index-head-lane-ruling | TEMP REPO AGENT (local_b2ab10bb) | .forge/AGENTS.md (lanes table + the two overlap paragraphs), .forge/roles/growth-marketing.md, .forge/roles/lead-ui-engineer-lane.md (index.html head line only) -- transcribing the PM's index.html/SEO ruling verbatim, docs only | 2026-09-06 |
| removal-completeness | TECHNICAL ARCHITECT (local_5b133312) | new file .forge/personal-data-removal.md only; reads across backend/, docs/, .github/ (completeness audit of the removal set + redact() design, no code change) | 2026-09-06 |
| t35-quote-adjustment | JUNIOR BACK END DEV (local_0b9989ef) | backend/quotes.mjs, backend/quotes.test.mjs, src/routes/QuoteRequests.jsx, .forge/dead-end-audit.mjs, backend/api.mjs, src/App.css, src/routes/Confirmation.jsx, src/routes/Status.jsx, src/store.js (inherited: rebasing and reviewing an orphaned agent's finished-but-unopened PR, not new work) | 2026-09-06 |
| doc-staleness-note | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/NOTES.md, one appended entry (the three stale-record instances of 2026-09-06 and a detection proposal). At the PROJECT MANAGER's request. | 2026-09-06 |
| declined-email-reason-optional | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/t62-voice.md, part F only (the declined sketch renders a reason Ken may not have written; voice/product, no code) | 2026-09-06 |
| funnel-report-spec | GROWTH/MARKETING (local_d80272eb) | .forge/funnel-report.md only: two additions to the open PR #263 at the product owner's request (docs) | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
