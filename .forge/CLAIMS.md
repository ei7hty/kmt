# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `inventory-matrix-backend` | ASSISTANT AGENT (local_6f7d8794), for the OWNER AGENT | Inventory matrix stage 1, the backend only. `backend/inventory.mjs` (add `sort`/`dir`/`pageSize` to `list()` behind allow-lists, a derived margin in SQL, and a new bulk `saveOffers`), `backend/api.mjs` (one new `PUT /api/owner/offers` branch, nothing else), `backend/owner.test.mjs` (new tests only). NOT `src/owner/OwnerInventory.jsx` or its CSS -- stage 2 is a separate PR and does not open until this is on main. NOT `src/owner/Images.jsx`, `backend/image-api.mjs` or `backend/image-publication.mjs`: another agent holds the preview fix. NOT `.forge/owner-inventory-audit.mjs` -- its EXPECTED_CHECKS counts size-filter checks only and stage 1 adds none, so the constant stays 6. | 2026-09-10 |
| `codex/owner-product-photo-activation` | OWNER OPERATIONS ENGINEER | Owner/API product-photo activation only: backend endpoints, persistence helpers/tests, owner inventory UI for inspecting already-imported local image packets/assets with digest/provenance/version/counts and explicit approve/revoke actions; `.forge/audit-ui.mjs` minted-session cookie path fix only, to run the existing owner audits. No customer-flow files claimed by `codex/customer-product-images`, no scraping, no provider contact/downloads, no secrets, no production mutation, no invented production data. | 2026-09-09 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
