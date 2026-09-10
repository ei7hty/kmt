# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| owner-image-approval-screen | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | On the user's instruction, the last piece before a product photo can reach a customer: the owner screen for approving imported image packets. `src/store.js` (three helpers only — `ownerImagePackets`, `ownerImagePacket`, `decideImagePacket` — beside the existing owner helpers; NOT the site-copy, outbox or social-proof helpers), `src/owner/Images.jsx` and `src/owner/Images.css` (new), `src/App.jsx` (one route `/owner/images` and its nav entry only). Calls the already-live `GET|POST /api/owner/images[/<digest>]` mounted at `server.mjs:155`; the state machine is imported -> approved -> revoked with optimistic `expectedVersion`. NOT `backend/` — no route, schema or publication change; the API is complete. NOT the acquisition pipeline (#451). NOT `src/components/TireProductImage.jsx` or `src/catalog-image.js`, which already render approved images customer-side. | 2026-09-09 |
| image-packet-unhardcode-count | PRODUCT MANAGER / OWNER AGENT (local_44d1e1f9) | On the user's instruction: remove the compiled-in packet size of 5 so the image pipeline can carry however many product images are available. `backend/image-manifest.mjs` (derive the asset count from the manifest, bound it, require candidates/enrichedRows/observations to match, loop to it, and retire the `owner-mapped-five-seeded-v1` selection tag), `backend/image-provider-profile.mjs` (candidate count from `IMAGE_PILOT_POLICY.candidateLimit` rather than a literal), `backend/image-publication.mjs:152`, `backend/image-staging-coordinator.mjs:41,126`, `scripts/image-pilot-packet.mjs`, `scripts/seal-image-packet.mjs`, and the two affected test files. NOT `PM_APPROVALS` — that empty compiled allowlist is the real execution gate and it is a product decision I am raising separately, not folding into a mechanical change. NOT the scraper, NOT the frontend. | 2026-09-09 |
| `codex/owner-product-photo-activation` | OWNER OPERATIONS ENGINEER | Owner/API product-photo activation only: backend endpoints, persistence helpers/tests, owner inventory UI for inspecting already-imported local image packets/assets with digest/provenance/version/counts and explicit approve/revoke actions; `.forge/audit-ui.mjs` minted-session cookie path fix only, to run the existing owner audits. No customer-flow files claimed by `codex/customer-product-images`, no scraping, no provider contact/downloads, no secrets, no production mutation, no invented production data. | 2026-09-09 |
| `codex/playwright-apt-isolation` | DEV OPS/INFRASTRUCTURE (Codex) | `.github/workflows/fly-deploy.yml` Playwright browser install/runtime setup only: stop PR/main browser audits from depending on unrelated Google Chrome apt repository state; focused regression/docs only if needed. No app behavior, Fly, secrets, provider scraping, production data, product-image backend, or customer-image UI. | 2026-09-09 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
