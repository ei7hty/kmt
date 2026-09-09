# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `codex/review-444-release` | KMT Release Agent | Independent exact-head review, CI evidence, merge/deploy, and read-only live acceptance for PR #444 only; no source edits, provider activity, image import, secrets, or production-data writes | 2026-09-09 |
| codex/customer-product-images | JUNIOR FRONT END DEV 3 / frontend product-image engineer (local_16ba9ea6) | Customer-flow rendering only: new `src/components/TireProductImage.jsx` (and focused helper/test if needed), `src/routes/CustomerRequest.jsx` tire-card image slot plus social placement only, `src/RequestFlow.css` tire-card image/fallback layout only, `src/components/SocialProof.jsx` and `.css` customer-facing card/icon/external-link presentation only, and `.forge/request-flow-check.mjs` focused product-image and social placement/accessibility coverage plus `EXPECTED_CHECKS`. Product images: consume optional same-origin `imageUrl`, reserve a fixed aspect ratio, lazy-load/decode, retain the existing generic tire art when absent or failed, and never render supplier/remote URLs directly. Social correction per OWNER ruling: remove the compact pre-order block and footer duplicate; render exactly one data-driven section after the order main and immediately before the normal business/privacy footer, as responsive branded cards/buttons with local lightweight platform badges, accessible platform names, visible external-link indication, keyboard focus, and no overflow. NOT backend/API/catalog projection, owner/operator workflow or enabled-state semantics, inventory/request/status/auth routes, scraping, downloads, provider/favicon/feed/iframe/script access, trackers, ratings, follower counts, testimonials, Fly, secrets, production, or customer records. Backend activation engineer owns the image data contract and activation workflow; existing owner social metadata remains the source. | 2026-09-08 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
