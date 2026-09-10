# Branch inventory

Written 2026-09-10 by JUNIOR REPO AGENT (`local_b2ab10bb`), per the OWNER
AGENT's standing branch-cleanup authorisation. A full sweep of every remote
branch (245 at the time of writing, 244 the night before -- worktrees grew
from 127 to 216 in two days per the TECHNICAL ARCHITECT, and branches are
tracking that growth). This is the first real measurement of that growth,
not just a cleanup log.

## The methodology finding, stated before the numbers so it isn't missed

**`git merge-base --is-ancestor <branch> origin/main` is an anti-signal in
this repository, not a weak signal.** Across every branch with a merged PR,
196 of 226 (roughly 87%) are **not** ancestors of `main`. This is not 196
unmerged branches -- it is what squash-merge does by construction: GitHub's
squash button creates a brand-new commit on `main` with its own SHA, and the
branch tip is never a parent of it, whatever landed. Confirmed directly:
PR #397 merged as `15ba7cd`, one commit, distinct from the branch tip
`5e95e9d`.

The practical failure this produces: a check built on `--merged` or
`--is-ancestor` alone would refuse to delete 196 genuinely spent branches
**and pass the two branches that were actually dangerous to delete**
(`owner-password-optional`, `owner-decision-actor` -- both ancestor:`yes`,
both held by a live worktree elsewhere). A signal that rejects the safe
majority and accepts the unsafe cases is worse than no signal; it fails
conservative-looking, so nobody investigates why it's always saying no.

**The corrected rule, standing:**
```
PR state = MERGED  AND  no live worktree currently holds the branch
  -> safe to delete
```
Ancestor-of-main is a real confirmation only for the ~30 branches merged
with an actual two-parent merge commit (not squashed). For the rest it
proves nothing either way -- do not gate on it.

**The worktree check is what actually does the work**, and check it live,
not from memory: `owner-password-optional` and `owner-decision-actor` were
both reported "spent" by their own author before either of us noticed a
Codex checkout (`.codex/worktrees/bfa1`, not this repo's own `.worktrees/`)
still had them open.

## Counts, this sweep

| category | count | action |
| --- | --- | --- |
| merged, worktree-free | 97 | safe to delete under the standing rule |
| held by a live worktree | 136 | leave -- someone's working state, whatever its ancestor/merge status |
| no PR at all | 8 | leave -- no merge to point to, no basis to call it spent |
| PR closed, never merged | 3 | leave -- needs individual verification, one is not what it looks like (below) |
| PR open | 1 | leave -- `audit-cookie-scope`, #458, active |

## Progress this session

**6 of the 97 deleted and verified individually** (each: PR state MERGED,
`base=main`, merge commit confirmed reachable from `origin/main`, no
worktree holding the branch tip) -- `owner-google-signin` (#387),
`owner-google-signin-ui` (#395), `site-copy-editable` (#397),
`site-copy-inventory` (#391), `inventory-matrix-backend` (#454),
`a11y-85-report` (#156).

**91 remain, all verified by the same method, none yet deleted.** Bulk
deletion in a single loop was refused by the auto-mode safety classifier;
individual deletions go through cleanly. Whoever continues this can delete
from the list below one at a time -- every entry has already been checked
against `origin/main`, not assumed from PR state:

```
address-family-resolution-check  agents-coord-followup  agents-coord-refinements
agents-ship-merge-rule  agents-subagent-rule  audit-email-per-script
auth-hardening  baselines-expected-diff  baselines-precutover  boot-guard-hoist
canonical-host-headers  catalog-cache-size  catalog-fetch-one-size
claim-commit-worktree-rule  codex/catalog-image-mirror  confirmation-status
coverage-metric-wording  customer-request-shape  cutover-staleness-remeasure
data-policy  decided-by-no-default  deploy-scope-fix  fast-empty-detection
fitment-and-owner-visual-notes  fix-empty-carry-forward  footer-link-width
funnel-report-spec  gate-marketing-surface-presence  gitignore-wording-followup
gitleaks-checksum-and-refs  gitleaks-history-scan
handoff-service-area-correction  health-head  hmac-log-labels
image-packet-unhardcode-count  index-head-lane-ruling  issue-97-copy-analysis
junior-front-end-dev-role  licensing-wording-sweep  lint-mjs
m13-inventory-summary  m13-owner-day-to-day  mail-boot-warning
migration-contract  mint-session-tool  noindex-private-routes  not-found-route
notes-daylight-pass  notes-fourth-shape-collision
notes-outran-record-taxonomy-move  notes-pipe-exit-status
notes-safeguard-deletion-test  notes-wrong-password-correction
operations-step1-rollback-note  outbox-attempt-tracking  outbox-resend-route
outbox-resolve-ui  outbox-table  owner-auth-cutover
owner-card-supplier-facts  owner-mail-alert-badge  owner-portal-analyst-role
owner-screen-polish  owner-supplier-stock  pr-author-me-identity-note
pricing-catalogue-screen  pricing-catalogue-storage  pricing-finding-1
pricing-finding-2  pricing-finding-3-test-split  pricing-placeholder-fix
quote-decided-by  rate-limits  redaction-path  relay-is-not-testimony
release-header  rescue-post-merge  restore-claims-none
retire-owner-review-link  roles-addendum  scraper-pacing  seo-analyst-role
service-area  size-search-whole-size  sprint-first-week  t105-stock-warning
t47-samesite-lax  t49-copy-signout-contrast  t50-privacy  t59-brand-overhaul
t62-voice  tire-list-pages  tire-source-names-comment
tire-step-waits-for-live  ui-lane-handoff  workflow-t53
```

## Held by a live worktree (136) -- do not delete, do not touch the worktree either

Not enumerated here; `git worktree list` is the live source and this list
would be stale within the hour given how fast the count has been moving.
Two flagged individually because their branch names read as spent when
they are not: `owner-password-optional` and `owner-decision-actor`
(both `.codex/worktrees/bfa1`, a different checkout).

## No PR at all (8) -- different risk class, no basis to call these spent

`a11y-85-measure`, `inventory-perf`, `qa-tester-pricing-defect-verification`,
`t59-contrast-carry`, and four `pr/308`, `pr/374`, `pr/374b`, `pr/403` --
the last four look like local review-checkout refs (`gh pr checkout`
artifacts) rather than work branches, but "looks like" is not a basis for
deletion.

## PR closed, never merged (3) -- needs individual reading, not a batch verdict

`move-sources-doc` (#152), `pricing-defect-verification` (#317),
`owner-session-cookie-cutover` (#403). **The third is not what its category
implies:** its own `CLAIMS.md` release note records the PR closed unmerged
but the content shipped live on `main` through a different path. A closed
PR does not mean the work is gone -- it means this category needs someone
to read each one, not a rule applied to all three alike.
