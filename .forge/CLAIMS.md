# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `codex/social-card-icons-polish` | KMT DEPLOYMENT ACCEPTANCE / UI polish (PROJECT MANAGER delegated) | Post-#444 customer social visual polish only: local `public/brand/social/*.svg` Instagram/YouTube/TikTok/Facebook assets, `src/components/SocialProof.jsx` and `.css` icon/card presentation, and focused `.forge/request-flow-check.mjs` assertions without EXPECTED_CHECKS change unless checks are added. Preserve single after-order/before-footer placement and testimonials. No owner product-photo files, embeds, remote assets/feeds, trackers, counts/ratings, provider, secrets, or production data. | 2026-09-09 |
| `codex/owner-product-photo-activation` | OWNER OPERATIONS ENGINEER | Owner/API product-photo activation only: backend endpoints, persistence helpers/tests, owner inventory UI for inspecting already-imported local image packets/assets with digest/provenance/version/counts and explicit approve/revoke actions; `.forge/audit-ui.mjs` minted-session cookie path fix only, to run the existing owner audits. No customer-flow files claimed by `codex/customer-product-images`, no scraping, no provider contact/downloads, no secrets, no production mutation, no invented production data. | 2026-09-09 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
