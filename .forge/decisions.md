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

## 2026-09-05 — Phase 4 moves requests and quotes into the existing backend, and retires the browser store for them rather than keeping it as a fallback
The phase 1 decision to use `localStorage` was explicit that it was a demo choice, made so the data layer could later swap its storage adapter. Phase 4 makes that swap. Requests and quotes go into the same SQLite database and the same server that already hold inventory, because a second process or database would be infrastructure the project does not need, and because the draft quote has to be computed over the catalog the backend already serves. The quote is drafted server-side by importing the existing `src/pricing.js`, the way the backend already imports `src/markup.js` and `src/data/catalog.js`, so there is still one pricing implementation and the rules do not change.

**Rejected:** Keeping `localStorage` as a fallback when the backend is unreachable, mirroring the catalog loader. For the catalog that is right: a stale list of tires is still useful. For a request it is wrong: a quote drafted locally is one no owner will ever see, and the customer waits for a reply that cannot come. A visible failure with a phone number is the honest answer. Also rejected: a separate service or database for orders, as infrastructure without a payoff at this size.

## 2026-09-05 — Customers reach their own requests by an unguessable request id and a per-browser key, not by accounts
The product has never asked a customer to log in and the roadside case argues against starting. A request gets a random 128-bit id from `node:crypto`; a link carrying it opens that request anywhere. The browser that submitted also holds a random per-browser key in `localStorage`, sent with each submit and used by `/status` to list that device's requests. Holding the key or the id is the access; there is no endpoint that lists requests without one.

**Rejected:** Email-or-phone lookup was rejected because it makes a phone number the password and needs a verification step to be safe. Accounts were rejected as out of scope in every phase so far and unchanged here. Sequential ids were rejected because they are enumerable.

## 2026-09-05 — The browser audits run against the real server, locally and in the CI gate, once submit needs the backend
Until phase 4 the gate audited a `vite preview`, which serves only the built frontend, and that was enough because the whole customer flow lived in the browser. Once a request is stored by the backend, a preview cannot complete the flow, and an audit that cannot complete the flow proves nothing. The audits therefore start `backend/server.mjs` with the built `dist/`, a temporary database and a known password, and sign in at the owner step. This is more faithful, not just necessary: the gate now tests the thing that is deployed.

**Rejected:** Keeping the preview-based gate and letting the post-deploy run be the only real test. That was the exact gap the phase 3 compose bug fell through, and it would have shipped a broken customer flow through a green check. Also rejected: a test-only mode in the frontend that bypasses the backend, because it would mean the gate tests code paths production never runs.

## 2026-09-05 — The three phase 4 open questions are answered "build it", on the client's direction
The client's representative said this is to be as close to the real service as possible, that product calls of this kind do not need per-item approval, and that the frontend can be changed later. So the owner can adjust a quote before sending, requests have a lifecycle with a done state, and both parties are told by text message. The "faked versus real" framing from phase 1 is retired: a faked step is now a gap with a task, not a design choice. The one remaining fake, payment, is the first item of phase 5 because it needs a processor account the client has to open.

**Rejected:** Waiting on the owner for each question separately, which is what the phase 4 plan first proposed; the client's direction covers them. Also rejected: building notifications by email first because it needs no account. The customer is on a roadside and the owner texts today; SMS is the channel that matches the business, and the outbox fallback means the code does not wait on the account.

## 2026-09-05 — SMS through a provider's REST API behind a one-module seam with an outbox fallback, not an SDK
Texts are sent by one small server module that calls the provider's HTTP API with `fetch` and credentials from the environment. When no provider is configured, the same module writes each message to an outbox table that the owner screen shows, so every flow and every test runs without an account and a message can be read before a real one is ever sent. The provider is named in configuration, and swapping it is a change to that module alone.

**Rejected:** The provider's SDK, which is a dependency for one HTTP call and a credential-handling surface the project does not need. Also rejected: sending from the browser, which would put the credential in the frontend. Also rejected: a queue or worker for sending; at this volume a synchronous send with the failure recorded in the outbox is enough, and a queue is infrastructure to add when a message is actually lost.

## 2026-09-05 — A phone number is contact, not identity
Collecting a mobile number does not create an account or a login. Access to a request stays by its unguessable id or the per-browser key from m9. The number is used to reach the customer and for nothing else, the customer agrees to that on the form, and it is never shown to another customer.

**Rejected:** Looking requests up by phone number, which turns the number into a password and would need verification by code to be safe. Deferred, not rejected: a one-time code sent to the number to recover a request from a different phone, if customers turn out to need it.

## 2026-09-05 — m10 notifies by email, not text message; the SMS decision above is superseded
While preparing for live service the client asked for email: the customer leaves a name and an email address, gets an email acknowledging the request, gets the quote itself by email as an itemised invoice with a link to view and pay, and the owner gets an email when a request arrives. Email fits what is being sent better than a text did: a quote is a document with line items, and a receipt is one too, and both should sit in the customer's inbox rather than be a link in a text. It also removes the opt-in checkbox: transactional email about the customer's own request needs no separate consent, so the form gets one plain sentence instead. The mobile number stays as an optional field, because the owner may still want to call.

Everything structural from the SMS decision carries over unchanged: one server module behind a seam, the provider's REST API called with `fetch` and no SDK, an outbox that records every message and stands in for the provider when none is configured, and credentials only in the server environment. The one new dependency on the client is a sending domain with SPF and DKIM at the provider; without it, mail from the app is spam.

**Rejected:** Doing both SMS and email in this milestone, which doubles the integration surface and the account setup for a second channel nobody has asked for. SMS can be added behind the same seam later if customers on a roadside turn out to need it. Also rejected: sending mail through a personal Gmail account by SMTP, which is fragile, rate-limited, and not the client's business identity.

## 2026-09-06 — The post-deploy run proves the deploy, not the flow; the flow is proved before merge
Once the browser audits started driving the interface instead of seeding `localStorage`, they began performing the journey for real: submit a request, approve it, pay it. Against the temporary database the pre-merge gate builds, that is exactly what is wanted, and it is where the flow is now proved -- against `backend/server.mjs` with the built `dist/`, which is the thing that gets deployed. Against the deployed site the same scripts write real rows into the real database, so every deploy would leave a fabricated request in the owner's quote list, marked paid. The owner's screen is a record of what customers actually asked for, and a record filling up with our own test data is not one. The post-deploy run therefore becomes a read-only check: the site answers, the catalog is the shape the customer flow is built on and carries none of the supplier's fields, hard navigation to each route returns the app rather than a 404 (server configuration, which has broken production before and cannot be checked anywhere else), the owner API still refuses without a session, and nothing scrolls sideways at 375px or 1280px. It signs into nothing, so no production password goes into CI.

**Rejected:** Putting the production owner password in the workflow as a secret and accepting the fabricated requests. It makes the owner's list untrustworthy as a record, and it puts a credential that can read every customer's address into a job that does not need it. Also rejected: the same, plus having the audit tag what it creates and delete it afterwards -- that needs a delete path on production that does not exist, and a scheduled job whose normal operation is destroying rows in the customer database is a worse thing to own than the problem it solves.

## 2026-09-06 — A job is quoted for the number of tires asked for, default four
Every quote the system produced priced one tire plus one service fee, while a real tire job is two or four tires and the client's own mockup prices a set of four. The user decided the form asks how many, with four as the default, and the tire line multiplies by it; the mobile-service fee stays a single line because it is charged per visit, not per tire. Found by the scrutiny agent's second pass; until it ships, every quote is under-quoted and the owner's approval is the only thing standing between a wrong number and a customer.

**Rejected:** Leaving quantity to t35's owner adjustment, which would make the owner correct every single quote by hand. Also rejected: inferring quantity from the vehicle, which the flow does not know well enough to do.

## 2026-09-06 — The static fallback catalog carries no supplier rows, and a non-supplier tire is an owner-review exception
The tracked snapshot was compiled into the client bundle for the static fallback, so every visitor's browser received the supplier's SKU, stock, list price and URL for every scraped tire, and with the markup settings beside them, KMT's margin on each. The fallback now holds seed tires plus generated coverage only; the backend alone reads the snapshot, which also keeps the bundle from growing with the all-sizes walk; and a build check fails the gate if supplier fields appear in `dist/`. Separately, generated placeholder tires were orderable and auto-quoted for 906 of 910 sizes; a tire whose id is not a supplier id now adds an exception reason, so the owner's approval gate catches it. Both decided by the user on the scrutiny agent's findings #61 and #62.

**Rejected:** Building a customer-safe public JSON for the fallback, which would still ship a growing file to every phone and keep two copies of the catalog in step by hand. Also rejected: removing the seed and generated tires outright, which would dead-end every size the walk has not reached; the walk is the real fix and the guard is the bridge.

