# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| index-head-lane-ruling | TEMP REPO AGENT (local_b2ab10bb) | .forge/AGENTS.md (lanes table + the two overlap paragraphs), .forge/roles/growth-marketing.md, .forge/roles/lead-ui-engineer-lane.md (index.html head line only) -- transcribing the PM's index.html/SEO ruling verbatim, docs only | 2026-09-06 |
| pr-author-me-identity-note | TEMP REPO AGENT (local_b2ab10bb) | .forge/NOTES.md (docs only, one entry) | 2026-09-06 |
| removal-completeness | TECHNICAL ARCHITECT (local_5b133312) | new file .forge/personal-data-removal.md only; reads across backend/, docs/, .github/ (completeness audit of the removal set + redact() design, no code change) | 2026-09-06 |
| seo-canonical-tag | SEO ANALYST (local_f596e88c) | src/App.jsx (new region only: a route-keyed effect adding/clearing one `<link rel="canonical">`, not the route dispatch conditionals -- flagging in case terra-t65-inquiries also needs a new route there), .forge/deployed-site-check.mjs (two new checks for `/` and `/privacy`'s canonical tag, EXPECTED_CHECKS moved with them). Not index.html: it is one static shell for every route and cannot carry two pages' canonical tags statically, per the PM's ruling and Google's own guidance for this constraint. Not src/noindex.js or its call sites. PR #273, open. | 2026-09-06 |
| handoff-restore-drill | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/HANDOFF.md, one appended section (the restore drill was run tonight and passed; the two numbers, the timestamps, and the sqlite3-missing finding). Planning lane, no code. | 2026-09-06 |
| pricing-settings-spec | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | new file .forge/pricing-settings.md only (the what and why for shipping, tax, disposal and the mobile fee as owner-editable settings; #94 unblocked by the user). Planning lane, no code, nothing else touched. | 2026-09-06 |
| redirect-check-from-behavior | QA ENGINEER (local_1fa1cb9a) | .forge/deployed-site-check.mjs (the redirect-flip section only: flipConfigured/KMT_CANONICAL_HOST reads the runner's env, which can never see a Fly secret -- derive from the fetched redirect responses instead, per DEV OPS's diagnosis). Not the canonical-tag checks seo-canonical-tag/#273 is adding to this same file. | 2026-09-06 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
