# Conventions

<!-- Read by forge before every run. Keep it short: it is context, not documentation. -->

## Stack and commands

React + Vite + Tailwind, plus a Node backend under `backend/` (SQLite via
`node:sqlite`, HTTP API, supplier refresh job).

- `npm run dev` — the app
- `npm run build` — production build, and the check that the tree is sound
- `npm run lint` — eslint, expected to be silent
- `node --test backend/owner.test.mjs` — the backend suite
- `node .forge/dead-end-audit.mjs` — every click path still reaches a next action
- `node .forge/responsive-check.mjs` — no overflow at 375px or 1280px
- Both audits drive a real browser against `vite preview --port 4179`, so build
  and start the preview first.

## Rules that have been paid for

- Verification means running the checks above, not reading the diff. A change
  that lints and builds can still dead-end a click path.
- The Tailwind vocabulary is extracted and shared. Do not invent a second
  version of an existing card, button or heading.
- Deployment is part of done, not a follow-up. It goes to Fly through CI on
  every push to `main` -- https://kmt.fly.dev -- and the deployed site runs the
  owner backend, so production exercises the live path and not just the demo
  fallback. Check it on a real phone.
- CI runs the browser audits on every pull request and again against the
  deployed site after a merge. Run them locally first anyway -- a red PR costs
  a round trip: `dead-end-audit.mjs`, `responsive-check.mjs` and
  `request-flow-check.mjs`, with `AUDIT_BASE` pointed at your preview.
- Start a preview on a port you have confirmed is free and stop it when you are
  done. A leaked server is bound by the next audit, which then reports a failure
  that is not there. CI does this with a trap; locally it is on you.
- Supplier prices are last-seen listings, never guaranteed quotes, and an owner
  price always overrides what markup proposes.
- This repository is shared with other agents. Read `.forge/AGENTS.md` before
  starting, and stay in the lane your branch claims.

## Routes

- `/` customer request flow, `/status` the customer's quote, `/confirmation`
- `/owner` the owner's inventory workspace
- `/owner/quotes` quote review and approval, reached from the owner nav
