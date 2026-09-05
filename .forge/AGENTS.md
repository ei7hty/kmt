# Working here alongside other agents

Several agents work on this repository — Claude sessions, GitHub Copilot,
ChatGPT — and none of us can message each other. **The repository is the only
channel.** If it is not written down here or in `.forge/`, the next agent does
not know it.

That has already cost real work: one session's staged changes were swept into
another's commit, under a message describing something else entirely, on a
branch nobody had checked they were on. This file exists so that stops
happening.

---

## The protocol

**Before you start.** Read this file top to bottom, then `.forge/project.md`,
`.forge/requirements.md` and `.forge/state.json`. Run `git branch --show-current`
and `git status`. If someone else has uncommitted or staged work in the tree,
you are sharing a workspace — behave accordingly.

**When you claim work.** Add a row to [Active claims](#active-claims), commit
that change on its own, and push it before you start. A claim costs one small
commit and prevents two agents rewriting the same file in opposite directions.
Your branch name is the claim: make it describe the work.

**While you work.** Stay in your lane (below). If you must touch a file outside
it, say so in your claim row first.

**When you finish.** Remove your claim row. If you learned something the next
agent would otherwise rediscover the hard way, append it to
[Notes to each other](#notes-to-each-other). Update `.forge/state.json` if you
closed a task, and record architecture decisions in `.forge/decisions.md`.

---

## Active claims

Remove your row when you are done. Stale rows are worse than no rows.

| branch | agent | files / area | started |
| --- | --- | --- | --- |
| `deployable-owner-backend` | Claude (kmt CLI) | `backend/`, `Dockerfile`, `src/owner/` auth UI | 2026-09-05 |

`scraper-catalog-updater`, `codex/refine-order-flow`, `wire-scraped-catalog` and
`owner-inventory-backend` were all merged into `main` on 2026-09-05 and their
rows removed. If you are still working on any of them, branch again from current
`main` rather than continuing on the old branch -- all four are now behind it.

---

## Lanes

Not ownership for its own sake — it is how two agents avoid editing the same
file from opposite ends.

| area | typically |
| --- | --- |
| `src/App.jsx`, `src/App.css` | UI work |
| `src/data/catalog.js`, `src/pricing.js` | catalog and quoting rules |
| `scripts/`, `src/data/scraped-tires.json` | supplier / scraper work |
| `.forge/*.md`, `.forge/state.json` | planning, requirements, task status |
| `.forge/*-audit.mjs`, `.forge/responsive-check.mjs` | verification tooling |

`package.json` and `README.md` are shared. Touch them in a commit of their own so
a conflict is trivial to resolve.

---

## Git, with more than one agent in the tree

- **Never `git add -A` or `git add .`.** Stage explicit paths. Another agent's
  work may already be staged and you will commit it under your message.
- **Never commit a file you did not change**, even when it is staged.
- **Check the branch before committing.** Do not assume `main`.
- **Need another branch while someone is editing? Use `git worktree add`,** not
  `git switch`. Switching moves the checkout under whoever is writing.
- **Push promptly.** The divergence window is where this goes wrong.

---

## Verification is the contract

Nothing is done until these pass. Run them; do not assume them.

```bash
npm run build
npx eslint src
node .forge/responsive-check.mjs     # 8 checks, overflow at 375px and 1280px
node .forge/dead-end-audit.mjs       # 36 checks across the full click path
```

The audits need `npm run preview` running, or `AUDIT_BASE` pointed at a
deployed URL.

**Run the dead-end audit against the live URL before calling a deploy good.**
This build has passed every local check and 404'd in production: a missing SPA
rewrite meant `/owner` and `/status` returned 404 on hard navigation while
click-through worked fine.

**A script that cannot drive the UI is not a passing audit.** The dead-end audit
silently stopped running when the customer flow became a wizard — it failed on
its first action, and `state.json` still claimed fifteen passing checks. If a
script errors before reaching its assertions, say so loudly.

---

## Standards

- **Measure claims before making them.** "Most sizes will now find stock" was
  actually 3%: the selector allowed 891 combinations against a catalog covering
  30. One line of arithmetic would have caught it. If you are about to write
  *most*, *few*, *all* or *none*, compute it.
- **Do not describe code you have not read.** Ask for the file.
- **Report what actually happened**, including what did not work. An honest
  failure is worth more than an unverified success.
- **Product decisions belong to the owner** — what to build, what to cut, what
  the exception rules are, and whether pricing stays manual or moves to a
  supplier feed. Engineering decisions are yours: make them, then say why.

---

## Settled — do not relitigate without asking

- No backend. `localStorage` carries state between the customer and owner views.
  The catalog is generated. Payment always succeeds. These are demo choices.
- Brand red is for the single primary action on a screen and for key figures.
  Approve/Reject stay green/red: a paired opposed decision needs colour to carry
  meaning. Green and amber are legitimate semantic accents — the production site
  already uses green for "In Stock".
- Mobile-first. The real user is on a roadside with a flat.
- No new dependencies without a justification that beats keeping the surface small.

---

## Notes to each other

Append, newest last. Date each entry and say who you are.

**2026-09-05 — Claude (forge/CLI session)**
CSS specificity is the trap in this codebase. Phase 1 bolted dark theming onto
Tailwind-default screens with broad element selectors — `.min-h-screen button`,
`.customer-shell input` — at specificity `(0,1,1)` with `!important`. They
outranked the component classes meant to sit inside them, which produced three
separate bugs: tire cards and size chips rendering as solid red CTAs with
selection inverted, and a search field with `#222` text on `#090909` that was
invisible to anyone who typed in it. Fixed at the root in `7890ae5` with one
border-box reset and `:where()` around the catch-alls, dropping them to
`(0,0,1)`. **Do not reintroduce broad `!important` element rules — scope to a
class.**

**2026-09-05 — Claude (forge/CLI session)**
`src/App.jsx` is a single ~23KB file holding all four routes. It is the main
reason agents exhaust their context trying to edit it — two runs burned their
entire budget reading before writing a line. Splitting it by route is contained,
unclaimed, and pays for itself the moment phase 3 starts.

**2026-09-05 — Claude (forge/CLI session)**
Playwright: a locator matching two elements is a strict-mode violation that
throws, and a `.catch(() => false)` turns that into a silent "not visible". An
audit check failed this way while the app was fine. Scope your selectors.

**2026-09-05 — Claude (forge/CLI session)**
`wire-scraped-catalog` was rebased onto `main` (`9ae376c`) on your behalf: it was
eight commits behind and did not have the CSS specificity fix. Your three commits
survived and were replayed cleanly — no conflicts — and lint, build, the
responsive check, the dead-end audit and the request-flow check all pass on the
rebased branch. Your commits have new SHAs. The pre-rebase tip is kept at
`backup/wire-scraped-catalog-prerebase` (`14e1f22`) if you want to compare or
recover. The branch is not pushed: publishing unfinished work is your call.

**2026-09-05 — Claude (kmt CLI session)**
`.forge/dead-end-audit.mjs` reads **`AUDIT_BASE`**, not `BASE` or `B`, and falls
back to port **4179**. Pass the wrong variable and it silently audits whatever
else is listening on 4179 instead of erroring. Mine hit a stale `vite preview`
from an earlier worktree and failed at the Quote requests step — which reads
exactly like a regression in the owner routing and was not one. It also means a
*passing* run can be testing a stale build, which is the worse direction: I
reported a green audit for a commit it never touched. Check what is on 4179
before believing either result. `request-flow-check.mjs` and
`responsive-check.mjs` read the same variable.

**2026-09-05 — Claude (kmt CLI session)**
Supplier prices and KMT prices are now two different things, and the boundary is
`src/markup.js`. `quotedPrice()` resolves them: an owner price from the backend's
`offers.price_cents` wins outright, otherwise the markup rule proposes one, and a
tire the owner disabled leaves the customer catalog. The owner sets the rule on
`/owner`; the default rate lives in `DEFAULT_MARKUP_SETTINGS` and the backend
imports it rather than restating it, so the two cannot drift. The rate shipped is
still a placeholder — `isPlaceholder` says so, and it is not Ken's number. If you
add real pricing rules, they go inside `retailPrice` and nowhere else.

**2026-09-05 — Claude (kmt CLI session)**
`buildCatalog()` skips generated rows only for sizes that end up with *real*
rows, not for every size in `scraped-tires.json`. Those differ once the owner
deselects tires: a size he empties gets its generated coverage back instead of
becoming a dead end. If you change that filter, re-run the dead-end audit — this
is exactly the invariant it protects.
