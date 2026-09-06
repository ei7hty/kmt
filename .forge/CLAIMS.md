# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| index-head-lane-ruling | TEMP REPO AGENT (local_b2ab10bb) | .forge/AGENTS.md (lanes table + the two overlap paragraphs), .forge/roles/growth-marketing.md, .forge/roles/lead-ui-engineer-lane.md (index.html head line only) -- transcribing the PM's index.html/SEO ruling verbatim, docs only | 2026-09-06 |
| removal-completeness | TECHNICAL ARCHITECT (local_5b133312) | new file .forge/personal-data-removal.md only; reads across backend/, docs/, .github/ (completeness audit of the removal set + redact() design, no code change) | 2026-09-06 |
| t35-quote-adjustment | JUNIOR BACK END DEV (local_0b9989ef) | backend/quotes.mjs, backend/quotes.test.mjs, src/routes/QuoteRequests.jsx, .forge/dead-end-audit.mjs, backend/api.mjs, src/App.css, src/routes/Confirmation.jsx, src/routes/Status.jsx, src/store.js (inherited: rebasing and reviewing an orphaned agent's finished-but-unopened PR, not new work) | 2026-09-06 |
| doc-staleness-note | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/NOTES.md, one appended entry (the three stale-record instances of 2026-09-06 and a detection proposal). At the PROJECT MANAGER's request. | 2026-09-06 |
| terra-t65-inquiries | TERRA AGENT | backend/inquiries.mjs, backend/inquiries-api.mjs, backend/{server,dev,api}.mjs (api: PUBLIC_POST_PATHS and isKnownApiPath only; t35 holds owner dispatch), backend/*.test.mjs, src/routes/components/CSS for the inquiry form, src/routes/Privacy.jsx, docs/operations.md (post-wire handoff paragraph, at PM instruction), audit coverage | 2026-09-06 |
| seo-canonical-tag | SEO ANALYST (local_f596e88c) | src/App.jsx (new region only: a route-keyed effect adding/clearing one `<link rel="canonical">`, not the route dispatch conditionals -- flagging in case terra-t65-inquiries also needs a new route there), .forge/deployed-site-check.mjs (two new checks for `/` and `/privacy`'s canonical tag, EXPECTED_CHECKS moved with them). Not index.html: it is one static shell for every route and cannot carry two pages' canonical tags statically, per the PM's ruling and Google's own guidance for this constraint. Not src/noindex.js or its call sites. | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
