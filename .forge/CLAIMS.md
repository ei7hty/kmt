# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| codex/image-provider-staging | CATALOG IMAGE PROVIDER/STAGING ENGINEER (Codex delegated task) | `scripts/image-mirror.mjs`, `backend/image-assets.mjs` recordStored/recordFailure candidate-state guard, new provider-safe fetcher and non-production staging-storage adapter, image-mirror tests/docs only; no provider contact, production writes, Fly/secrets, or customer serving | 2026-09-08 |
| codex/social-proof-discoverability | KMT SOCIAL PROOF DISCOVERABILITY ENGINEER (Codex delegated task) | `src/components/SocialProof.jsx` and `.css` marketing copy/layout/link rendering; `src/routes/CustomerRequest.jsx` social-proof/footer placement only; `src/owner/SocialProof.jsx` and `.css` enabled-state labeling only; new `.forge/social-proof-visibility-audit.mjs` browser regression. Keep verified profile URLs evidence-only, no ratings/reviews/follower counts, no request-flow behavior changes, and no backend/metadata changes. | 2026-09-07 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
