# Decisions

<!-- Maintained by forge and by you. Edit freely: the agent reads this before it plans. -->

Append-only. Each entry records a decision that would otherwise be re-litigated
in six weeks by someone who does not remember the trade-off.

Format: date, decision, why, and what was rejected.

## 2026-09-05 — Use browser localStorage as the shared "backend" for demo state, no real API/server
Requirements say data need not persist across reloads/sessions unless the lack of persistence makes a step read as broken, and the demo explicitly depends on the owner seeing what the customer submitted in the same sitting on the same device. localStorage (or an equivalent in-browser store) gives cross-route, cross-tab-on-one-device visibility without building a real backend, matching the "minimal dependencies" and "no real integrations" constraints. The data layer will still model quotes/requests as plain objects/functions so a later swap to a real API is a matter of replacing the storage adapter, not a rewrite.

**Rejected:** A real backend (Node/Express + DB or serverless functions with a datastore) was rejected as infrastructure the prototype doesn't need -- it adds deployment and state-management complexity with no payoff for a phase whose only job is to be tapped through once by the client. Passing state through URL query params was rejected because it doesn't scale past one request/quote and gets unwieldy with multiple fields.

## 2026-09-05 — Two fixed routes (/ and /owner) via manual path check, no router library
The MVP has exactly two top-level routes with no nested or dynamic routing needs. Reading window.location.pathname (or a tiny custom switch) is enough and keeps the dependency surface minimal, which the requirements call out explicitly since Copilot is doing much of the implementation and a smaller surface is easier for it to reason about.

**Rejected:** react-router-dom was rejected for now as unnecessary weight for two static routes; can be added later if the real product grows more screens/routes.

## 2026-09-05 — Deploy to Vercel
Vercel has first-class Vite support with zero-config static builds and free public URLs, satisfying the deployment requirement with the least setup friction.

**Rejected:** Netlify would work equally well but there's no reason to evaluate both; Vercel was picked arbitrarily as the simpler default for a Vite app.

## 2026-09-05 — Phase 2 shared UI components are hand-written CSS classes added to App.css, not a component library or CSS-in-JS
Phase 1 already established a single-file App.jsx + hand-written App.css/index.css pattern with reusable global classes (eyebrow, panel-kicker, primary-action, order-step) alongside Tailwind utilities. Phase 2 requirements (R8, R10) call for /owner, /status, /confirmation to reuse the same nav/typography/button/card look as /. The cheapest way to do that without new dependencies is to generalize a handful of existing/near-existing classes (nav bar, card panel, button variants, eyebrow/heading/secondary text) into shared classes applied across all four routes, exactly like order-step/primary-action already are. This keeps the dependency surface minimal (explicit Phase 2 non-functional requirement) and matches how Copilot-assisted implementation worked in Phase 1.

**Rejected:** A component/UI kit library (e.g. shadcn, Radix, Headless UI) was rejected: Phase 2 scope explicitly excludes new dependencies without a justification that outweighs the minimal-dependencies constraint, and a styling-only phase gives no functional payoff for the risk of adding one. Splitting App.jsx into multiple component files was also considered and rejected for this phase specifically -- it's a structural refactor orthogonal to the visual requirements (R8-R13 are about appearance, not code structure) and can be revisited if a later phase adds enough real functionality to justify it.

## 2026-09-05 — /owner, /status, /confirmation get a simpler internal top bar, not the full marketing hero nav reused verbatim
The nav on / (brand mark, "Order Tires"/"Services" scroll links, phone CTA) is built for the marketing landing page and its in-page anchors don't apply to internal screens. R8/R10 require /owner, /status, /confirmation to look like the same product as /, not to literally reuse the landing nav's links. The plan is a shared, simpler branded top bar (KMT wordmark + route-appropriate back/forward links, same dark background/border/typography tokens as the marketing nav) used consistently across the three internal screens.

**Rejected:** Reusing the exact site-nav markup (with Order Tires/Services anchors) on internal screens was rejected as confusing -- those links point at sections of the homepage that don't exist on /owner, /status, or /confirmation.

## 2026-09-05 — Phase 3 wires the customer catalog to the real owner backend through a new customer-safe read endpoint, not by exposing /api/owner/inventory directly
The owner backend already computes the customer-visible price for every tire via markup.js's quotedPrice (owner price wins, markup proposes, disabled tires are excluded) -- see backend/inventory.mjs and .forge/owner-backend.md. Reusing that logic through a new endpoint (e.g. GET /api/catalog) that returns only the same shape src/data/catalog.js already produces (id, name, size, price, inStock, category, description) avoids a second pricing implementation drifting from the first, and avoids ever sending a customer request supplier SKUs, list prices, owner notes, or the enabled/disabled state of tires the owner chose not to sell.

**Rejected:** Pointing the customer flow directly at /api/owner/inventory was rejected: that endpoint is explicitly the owner's local workspace (see the deployment boundary in .forge/owner-backend.md), returns every supplier row including disabled/unoffered ones and internal fields (SKU, notes, list price), and paginates for an owner curating 290 sizes rather than serving a customer picking one tire.

## 2026-09-05 — Customer flow falls back to the static generated catalog when the owner backend is unreachable, rather than making the backend a hard dependency
The owner backend is SQLite + a Playwright browser process and cannot run on the static Vercel deployment that is this project's production environment (see the deployment boundary section of .forge/owner-backend.md). Making the customer flow require it would break the public demo URL the client opens on their phone. A fetch-with-fallback keeps the public deployment working exactly as it does today while allowing a richer, owner-curated demo whenever the backend is running locally.

**Rejected:** Deploying the backend so the public URL always has it was rejected for this phase -- it is a hosting decision (persistent DB, browser execution environment) that the owner has not made, and is called out as an open question in roadmap.md rather than assumed here.
