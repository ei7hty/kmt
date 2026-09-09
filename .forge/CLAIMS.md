# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| codex/customer-product-images | JUNIOR FRONT END DEV 3 / frontend product-image engineer (local_16ba9ea6) | Customer-flow rendering only: new `src/components/TireProductImage.jsx` (and focused helper/test if needed), `src/routes/CustomerRequest.jsx` tire-card image slot only, `src/RequestFlow.css` tire-card image/fallback layout only, and `.forge/request-flow-check.mjs` focused image-present/image-absent/broken-image/phone/no-remote-source coverage plus `EXPECTED_CHECKS`. Consume optional same-origin `imageUrl`, reserve a fixed aspect ratio, lazy-load/decode, retain the existing generic tire art when absent or failed, and never render supplier/remote URLs directly. NOT backend/API/catalog projection, owner/operator workflow, inventory/request/status/auth routes, scraping, downloads, provider access, Fly, secrets, production, or customer records. Backend activation engineer owns the data contract and activation workflow. | 2026-09-08 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
