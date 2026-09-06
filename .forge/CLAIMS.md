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
| analytics-marketing-only-spec | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | new file .forge/analytics.md only (GA4 on marketing routes only: why not in index.html, the CSP change, the dev/CI gate, the /privacy obligation). Planning lane, no code. | 2026-09-06 |
| record-then-grep-the-negation | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | .forge/NOTES.md, one appended entry only. OVERLAP DECLARED: TEMP REPO AGENT holds pr-author-me-identity-note on the same file with nothing pushed; the file is append-only so two entries conflict only at the last line, and I resolved exactly that on #253 tonight. At the PROJECT MANAGER's request. | 2026-09-06 |
| brand-black-optimised | JUNIOR FRONT END DEV (local_376e0377) | public/brand/ (the 14 tracked files regenerated with the same names: navy ground to black, the lockups and badges on consistent ratios, the icons smaller; not the og ratio, not the icon sizes), public/manifest.webmanifest (theme/background colour and icon version query), index.html (brand hrefs' version query only, not the head copy), the ten src/ brand references (version query and width/height only), src/App.css (the hero panel's navy behind the logo, two declarations, so a black logo does not sit in a navy box), docs/brand.md (the ground line and file table only), .gitignore (the untracked van photos in public/brand/). OVERLAP DECLARED: public/brand/ and docs/brand.md are growth and marketing's per AGENTS.md; the user authorised this by name via the OWNER AGENT. Sources are the three ignored seller files in public/, not the four IMG_ photos. | 2026-09-07 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
