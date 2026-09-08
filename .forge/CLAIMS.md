# Active claims

Who is working on what, right now. One row per branch in flight; the protocol
that says when to add and remove a row is in [`AGENTS.md`](AGENTS.md). This
table has its own file because a claim edit used to land in the file everyone
else was editing too, and three pull requests in one day went dirty on it.

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| codex/ga4-csp-remediation | DEPLOYMENT ACCEPTANCE AGENT (Codex task 01a07c98) | GA4 CSP remediation only. `backend/site.mjs`: marketing-route CSP source lists in `securityHeaders()` only; `/` and `/privacy` gain the minimum GA4 script/connect/image hosts, while every other route keeps the byte-for-byte strict policy. `backend/site.test.mjs`: positive marketing directives plus exhaustive negative sensitive/status/owner/customer/API route assertions. `.forge/dead-end-audit.mjs`: existing GA4 intercepted canonical-host block only, strengthening positive `/` and `/privacy` resource attempts and negative sensitive-route no-attempt/CSP-violation checks without contacting Google and without changing `EXPECTED_CHECKS` (the existing check is expanded, not counted twice). No analytics runtime changes, no Ads/DoubleClick/google.com/frame-src/unsafe-inline/unsafe-eval, no workflow/deploy/provider/production changes. Disjoint overlap: `gate-copy-reaches-the-visitor` owns the landing-copy block and count in the same audit, not this GA4 block. | 2026-09-08 |
| codex/image-provider-staging | CATALOG IMAGE PROVIDER/STAGING ENGINEER (Codex delegated task) | `scripts/image-mirror.mjs`, `backend/image-assets.mjs` recordStored/recordFailure candidate-state guard, new provider-safe fetcher and non-production staging-storage adapter, image-mirror tests/docs only; no provider contact, production writes, Fly/secrets, or customer serving | 2026-09-08 |
| codex/review-431-normalization | KMT REPO/RELEASE AGENT (project-manager delegated review) | Independent read-only review of PR #431 exact head: supplier-ingress and public catalog plain-text normalization, entities/malformed markup/script-event removal, existing-row read behavior, identity/price invariance, scope/ancestry/merge-tree/CI. No implementation edits, provider requests, production mutation, or merge. | 2026-09-07 |
| codex/catalog-description-normalization | JUNIOR FULL STACK ENGINEER (Codex, project-manager delegated bug fix) | New `backend/catalog-description.mjs` and focused test; `backend/inventory.mjs` only at supplier-row write normalization and customer `catalog()` description projection; public catalog API regression in the existing catalog test region; `package.json`/`package-lock.json` only to add the maintained `parse5` HTML parser required by private review. Convert supplier HTML/entities to plain text at ingress and again at the customer-safe read boundary so existing rows are fixed immediately. No `src/`, scraper/provider behavior, image assets/PR #430 files, social-proof work, production mutation, or HTML rendering. | 2026-09-07 |
| codex/social-proof-discoverability | KMT SOCIAL PROOF DISCOVERABILITY ENGINEER (Codex delegated task) | `src/components/SocialProof.jsx` and `.css` marketing copy/layout/link rendering; `src/routes/CustomerRequest.jsx` social-proof/footer placement only; `src/owner/SocialProof.jsx` and `.css` enabled-state labeling only; new `.forge/social-proof-visibility-audit.mjs` browser regression. Keep verified profile URLs evidence-only, no ratings/reviews/follower counts, no request-flow behavior changes, and no backend/metadata changes. | 2026-09-07 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.
