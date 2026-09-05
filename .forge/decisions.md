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
