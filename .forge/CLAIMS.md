# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `codex/social-centered-layout` | KMT DEPLOYMENT ACCEPTANCE / UI polish (PROJECT MANAGER delegated) | Post-#447 centered social layout only: `src/components/SocialProof.css` card/heading/container alignment and `.forge/request-flow-check.mjs` focused 375/1280 geometry assertions. Preserve testimonials, placement, local assets and safe-link constraints. No owner photo, embeds, remote assets, trackers, metrics, provider, secrets, or production data. | 2026-09-09 |
| `codex/owner-product-photo-activation` | OWNER OPERATIONS ENGINEER | Owner/API product-photo activation only: backend endpoints, persistence helpers/tests, owner inventory UI for inspecting already-imported local image packets/assets with digest/provenance/version/counts and explicit approve/revoke actions; `.forge/audit-ui.mjs` minted-session cookie path fix only, to run the existing owner audits. No customer-flow files claimed by `codex/customer-product-images`, no scraping, no provider contact/downloads, no secrets, no production mutation, no invented production data. | 2026-09-09 |
| `codex/playwright-apt-isolation` | DEV OPS/INFRASTRUCTURE (Codex) | `.github/workflows/fly-deploy.yml` Playwright browser install/runtime setup only: stop PR/main browser audits from depending on unrelated Google Chrome apt repository state; focused regression/docs only if needed. No app behavior, Fly, secrets, provider scraping, production data, product-image backend, or customer-image UI. | 2026-09-09 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
