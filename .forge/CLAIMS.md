# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| codex/image-activation-offline | KMT Image Adapter Remediation (Codex task 01a0807e-ff38-7de2-a02e-27cd44eec50b) | New backend/image-decoder*, image-provider-profile*, image-run-provenance*, image-staging-coordinator* modules/tests and fixture helpers; scripts/image-decoder.py and pinned decoder requirements; scripts/image-mirror.mjs observation hooks only; docs/image-mirroring.md offline activation prerequisites; `.github/workflows/fly-deploy.yml` decoder-runtime setup and test environment only. Implement isolated decoder, immutable PM approval-bound profiles, staging snapshot/database coordinator and private run provenance. Execution remains disabled; exactly five candidates; no provider contact, catalog approval, public serving, production/customer writes, secrets or deploy. | 2026-09-08 |
| codex/social-proof-discoverability | KMT SOCIAL PROOF DISCOVERABILITY ENGINEER (Codex delegated task) | `src/components/SocialProof.jsx` and `.css` marketing copy/layout/link rendering; `src/routes/CustomerRequest.jsx` social-proof/footer placement only; `src/owner/SocialProof.jsx` and `.css` enabled-state labeling only; new `.forge/social-proof-visibility-audit.mjs` browser regression. Keep verified profile URLs evidence-only, no ratings/reviews/follower counts, no request-flow behavior changes, and no backend/metadata changes. | 2026-09-07 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
