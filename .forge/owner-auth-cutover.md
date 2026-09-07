# Cutting over to Google-only owner sign-in without losing the gate or the owner

Written by the TECHNICAL ARCHITECT on 2026-09-06 at `origin/main` `c68408c`,
on the PROJECT MANAGER's instruction. **This is the sequence, not the design.**
The design — the OIDC flow, the verification table, the token-info trade, why
this is worth doing — is [`owner-google-signin.md`](owner-google-signin.md) and
is not repeated here. Read that first; this says what has to happen, in what
order, so the change lands without locking the owner out of his own business or
quietly gutting the pre-merge gate.

Labelled as `NOTES.md` asks. **Intent** — why an order is the order, why a
mechanism is shaped the way it is — keeps. **State** — what is wired, what is
measured, what a file imports — is a measurement taken at `c68408c` on
2026-09-06 and should be re-measured before anyone acts on it.

## Provenance of the product ruling, stated because it is second-hand

Two rulings drive this and **the author did not hear either from the user**:

- **Domain-only.** Any verified Google account whose `hd` is
  `kensmobiletire.com`. No exact-address match, no allow-list.
- **Google sign-in only.** The owner password is removed.

Both reached this document as the PRODUCT MANAGER / OWNER AGENT's direct
quotation of the user (*"it should allow any email login from
@kensmobiletire.com within the organization/workspace"*, *"should be google
sign in only"*), relayed onward by the author to the PROJECT MANAGER. **A relay
is not the user's word**, and the PROJECT MANAGER correctly declined to
second-guess a ruling they did not hear. It does not matter for anything below:
**every engineering conclusion here is true under either ruling**, because all
of it is about what breaks when the password goes and what has to exist before
it does. If the ruling turns out to have been misheard, the sequence changes
scope, not shape.

---

## The blocking precondition: today's gate cannot survive change two

**Removing the password removes the only way the pre-merge gate can perform the
owner-approval step.** `.forge/AGENTS.md` says the gate exists to prove *"a
customer submits, the owner approves, the customer pays, and every click path
leads somewhere."* The middle one is the casualty.

Measured at `c68408c`, not inherited:

`.forge/audit-ui.mjs` exports `signInIfAsked(page)`, which reads
`KMT_OWNER_PASSWORD`, fills `#owner-password` and clicks Sign in.
`openOwnerQuotes()` calls it. **Five audits reach the owner screen through one
or both:**

| audit | reaches it via | in the gate? |
| --- | --- | --- |
| `dead-end-audit.mjs` | `openOwnerQuotes` | yes |
| `request-flow-check.mjs` | `openOwnerQuotes` | yes |
| `responsive-check.mjs` | `openOwnerQuotes`, `signInIfAsked` | yes |
| `a11y-85-measure.mjs` | `openOwnerQuotes`, `signInIfAsked` | yes (t107) |
| `owner-inventory-audit.mjs` | `signInIfAsked` | no — ungated, run by hand |

**Not affected:** `deployed-site-check.mjs`, which signs into nothing by
design and asserts the owner API *refuses* without a session — that assertion
must keep meaning what it means after the cutover, and is one of the checks
that proves the change did not open something.

**Three of the five are the gate's own flow audits.** The count in the
PROJECT MANAGER's report was three; re-measuring across every importer of
`audit-ui.mjs` found five, because `responsive-check.mjs` and the ungated
owner-inventory audit also sign in.

**Why this cannot be fixed by teaching the audits to do OAuth.** Google
refuses automated sign-in, the consent step needs a human, and putting a real
Workspace credential into CI would be a worse thing to own than the problem.
There is no version of this where Playwright drives a real Google login in the
gate.

**Why it would not announce itself.** The audits would fail at the owner step
— loudly, the first time. The danger is the repair someone reaches for under
time pressure: routing the audits around the owner screen. Then they still
report their `EXPECTED_CHECKS` counts, still go green, and no longer cover the
owner path at all. **A change that trades the owner's password for the gate
protecting every future merge is not a net improvement.**

---

## `scripts/mint-session.mjs`: what closes it

**A command that creates a row in the existing `owner_sessions` table and
prints the cookie. No route. Never a route.**

`createSessionStore` in `backend/auth.mjs` already owns that table and already
has a supported creation path; this calls it from a CLI instead of from a login
handler. The trust boundary is a human with `flyctl ssh` — **the same boundary
`scripts/redact.mjs` already sits on**, which makes this a precedent rather
than a new surface.

**It is not an authentication bypass, and the reason is worth stating rather
than asserting: it grants no capability to anyone who does not already have
it.** Whoever can run it can already read and write the database directly. A
mechanism that adds nothing to its holder's existing powers is not a way in;
it is a convenience for a power already held.

**Two things it does, and they are the same thing:**

1. **The gate.** CI boots the server, runs the command, sets the cookie on the
   Playwright context, and the audits drive the real owner screen — **with no
   password path existing in production at all.** That is strictly better than
   today, where the gate exercises a code path this change deletes.
2. **Recovery.** Google-only leaves no in-product answer when Google is down,
   the OAuth client is deleted, or the consent screen is misconfigured on a
   Saturday. This is the answer, and it is the honest kind: it requires machine
   access, so it is available to the user and to nobody else.

**On calling it break-glass.** The user closed break-glass when they ruled
Google-only, and this must not reopen that through a side door. The distinction
that makes it defensible: **there is no second way to *sign in*; there is a way
for the person who owns the machine to mint a session.** Those are different
claims. But once the script exists it functions as recovery whether or not any
document says so, and pretending otherwise would leave the user with a worse
picture of their own system than the truth. **The OWNER AGENT is putting that to
the user directly; whether it is written into the runbook as a recovery path is
the user's call, and the security property is identical either way.**

---

## The order, and why each step is where it is

### Change one — Google sign-in lands, password still works

Both paths live. `/owner` offers Google; the password field still works.
Verified end to end on the live site: a real sign-in, from Ken's own account,
on a phone. **Nothing is removed until a real login has actually happened
through the new path.**

`scripts/mint-session.mjs` and the audits' switch to it belong **here**, not in
change two. The gate should be running on the mechanism that will outlive the
password *before* the password is the only thing holding it up. It is also the
cheapest time to discover the mechanism is wrong.

### Change two — the password stops being accepted

Only after change one has carried a real login.

**Why not one change.** A single change means that if the OAuth client is
misconfigured, **nobody can sign in at all** — and there are real customers
submitting requests who need Ken to approve them. A lockout is not recoverable
from inside the product; it needs the user, Fly and a redeploy, at whatever
hour it happens. The two-change path reaches exactly the state the user asked
for and never passes through a state where the owner cannot work.

### The ordering hazard inside change two, which is the one that takes the site down

**`readAuthConfig` throws at boot on a missing `KMT_OWNER_PASSWORD`**
(`backend/auth.mjs`). So:

> **The code that tolerates its absence must be deployed before the secret is
> unset.**

Unset the secret first and the app does not start — **a lockout produced by
doing the safe-looking half of the change first**, which is exactly the order a
careful person would choose. `--stage` the unset so it applies with the deploy
that carries the tolerant code rather than ahead of it.

The boot guards move rather than disappear: with no password, **neither
OAuth variable set means the owner cannot sign in at all**, which is a
refuse-to-boot, not a silent degrade. The three-case behaviour designed for the
additive phase inverts here, and that inversion is part of change two rather
than something to notice afterwards.

---

## The claim checks: required equality, never conditional

This is one rule, and it is written as a rule because the wrong form is the one
a careful person reaches for when being defensive about `undefined`.

> **Every claim in the verification chain is a required equality on a present
> value. A missing claim is a rejection, not a skip.**

```js
// WRONG — a consumer Google account has no `hd`, so the guard never runs
if (payload.hd && payload.hd !== DOMAIN) reject()

// RIGHT
if (payload.hd !== DOMAIN) reject()
```

Under domain-only there is nothing behind `hd` — no allow-list, no
exact-address match. **That single line is the entire authorization decision**,
and in the conditional form it admits every Google account on earth. The same
shape applies to `aud`, `iss` and `email_verified`; **`aud` is the one that
would hurt most if missed**, because a token forged or minted for another
application is precisely the token most likely to be missing claims.

**`hd` is not redundant with the Internal consent screen.** They are redundant
only while Internal holds, and the named failure is Internal being switched to
External later, in a console nothing re-reads. In that state `hd` is the only
surviving control. Two checks that fail independently are defence in depth; the
judgement "this duplicates that" is only as good as the assumption that both
fail together.

**Tests, written before the happy path.** One per claim, each with the claim
**absent** rather than wrong — absent is the case the conditional form passes,
and a suite that has only ever seen well-formed Workspace tokens cannot fail
for this reason. That is the same defect as a fixture carrying a key production
never produces.

### And each test must exercise the verifier directly, never a real sign-in

**This requirement is SEO ANALYST's, found in a different subsystem, and it is
the one that makes the tests above worth writing.**

They wrote a gate check asserting GA does not load on `/status`, then broke the
frontend route gate to prove the check could fail. **It passed anyway**:
`backend/site.mjs`'s separate `ANALYTICS_PATHS` blocked the request by CSP
before their network interception saw an attempt. A network assertion aimed at
control A was silently satisfied by control B doing A's job.

**The general form: defence in depth defeats the testing of either layer,
unless the test observes that layer's own behaviour rather than the outcome
both layers produce.** Two independent controls are exactly what is wanted in
production and exactly what makes each one unverifiable from outside — the
outcome is identical whether one holds or both do.

**This design has that structure on purpose.** Google's `Internal` consent
screen and our `hd` check are two independent domain restrictions, and the
whole value is that they fail independently. So **a test that drives a real
sign-in and asserts a Gmail user cannot reach `/owner` is green whether or not
our `hd` check works** — Google refused them before our code ran. The check
could be absent, or written in the conditional form that admits every consumer
account, and that test would never say so.

> **Every test of the claim checks feeds constructed claims straight to the
> verification function and asserts the decision. No browser, no Google, no
> consent screen in the path.**

**This constrains the design, not only the tests.** Verification cannot be
inlined in the callback branch of `auth.handle`: it has to be a separate
function taking claims and returning a decision, or there is no seam to feed a
constructed token into and the requirement above is unsatisfiable. The
token-info route in [`owner-google-signin.md`](owner-google-signin.md) already
produces claims as data, which is exactly the shape this needs — **keep the
fetch and the judgement in separate functions.**

**So each control gets its own kind of evidence, and neither is proved by
outcome:** `hd` by a direct test against the verifier; `Internal` by a human
reading the consent screen in the console, which is why it appears in the
user's table below as something to verify rather than something to click.

### After this change, nothing in the browser audits tests authentication

Worth stating plainly for whoever picks up the audits, because it is a real
reduction in coverage and it should be a decision rather than a surprise.

Today the audits type a password into the real sign-in form, so they exercise
the actual login path in passing. **Once they hold a minted session cookie,
they bypass authentication entirely** — by design, since that is the whole
point of `mint-session.mjs`. What the audits prove afterwards is the *owner
flow*: that a request reaches the owner's screen, that Approve & Send works,
that no click path dead-ends. They no longer prove that anybody is stopped at
the door.

**That coverage has to exist somewhere, and after this change the only place it
can exist is the backend suite** — the direct verifier tests above, plus the
existing session and 401 assertions. That is not merely equivalent to what is
lost: per-layer tests can distinguish which control refused a request, and the
incidental browser coverage never could.

**Ruled by the PROJECT MANAGER, 2026-09-06: accept the reduction, with that
compensation, recorded as a decision made rather than a consequence
discovered.** Without this paragraph it would have surfaced months from now as
"why does nothing test login."

> **`deployed-site-check.mjs`'s "the owner API refuses without a session"
> assertion stops being a nice-to-have and becomes the only remaining
> end-to-end evidence that the owner API is gated at all.** Anyone who later
> proposes trimming it as redundant has to meet this sentence first: after the
> audits move to a minted session, there is nothing else watching that door
> from outside.

---

## Preconditions already true, verified at `c68408c`

Each of these is load-bearing and none of them is obvious from the code that
depends on it.

- **The callback must be implemented inside `auth.handle`.** `server.mjs`
  calls it **before** the `/api/` session gate; everything under `/api/owner/`
  not handled there answers 401 without a session. **A callback implemented in
  `api.mjs` answers 401 before it can create the session it exists to create**
  — failing at the last step, after the owner has already been sent to Google
  and back, and looking like Google's fault.
- **`SameSite=Lax` is required and is already live** (`backend/auth.mjs`, set
  by t47/#89 for the emailed quote link). An OAuth callback is a top-level
  cross-site GET navigation, which is exactly what `Strict` withholds the
  cookie on. **#89 bought this by accident; t47 is deferred, not settled, so
  anyone revisiting it must meet this dependency rather than discover it
  through a login that fails looking like a broken login.**
- **The redirect URI is entered in Google's console and must not drift:**
  `https://kensmobiletire.com/api/owner/session/google/callback` — `https`,
  canonical host, no trailing slash, no `www` variant. Measured: `kmt.fly.dev`
  answers `301` to the canonical host, so a URI registered against any other
  name would put a redirect inside the callback.
- **`Authorised JavaScript origins` is deliberately empty.** An entry
  appearing there later is the tell that someone has drifted toward a browser
  token flow, which would put a token in the page and make the domain check
  client-side and worthless.

## What only the user can do

| input | blocks | note |
| --- | --- | --- |
| The OAuth client secret, as a Fly secret | change one | Never passes through an agent. Staged already, with the client id. |
| Confirming the consent screen still reads **Internal** | change one | Google-enforced, independent of `hd`. If Internal is refused and they switch to External to get moving, **nothing in the code notices** — that is a condition to report, not a caution to heed. |
| A real sign-in from Ken's own account on a phone | change two | Change two does not start until change one has carried a real login. |
| Unsetting `KMT_OWNER_PASSWORD` | end of change two | After the tolerant code is live, not before. |
| Whether `mint-session.mjs` is documented as a recovery path | nothing | The security property is the same either way. |

## What must not change

- **The owner approval gate.** No step here may weaken it; a task that finds
  it in the way stops and asks.
- **`deployed-site-check.mjs` signs into nothing** and asserts the owner API
  refuses without a session. That assertion is one of the few things that would
  notice if this change opened something, and it must keep meaning what it
  means.
- **No route for `mint-session.mjs`. Ever.**
- **The Workspace-membership trade, recorded because the user accepted it:**
  anyone Ken adds to the Workspace can approve quotes and read every
  customer's name, address and phone number. That is fine for a one-owner
  business and stops being fine the first time he adds someone for email
  alone. **The allow-list is not built; its place is the `hd` check, and this
  paragraph is the marker so that day is a config change rather than a
  rediscovery.**
- **Do not authenticate against `KMT_OWNER_EMAIL`.** Its Fly digest is
  identical to `KMT_MAIL_FROM` and `KMT_MAIL_SMTP_USER`: it is the shop's role
  mailbox, chosen as a routing destination for customer replies. Using it as an
  identity would fuse Workspace *delegation* with Workspace *sign-in*, which
  are different grants, and would let a change to the From address silently
  change who can sign in. Moot under domain-only; recorded so nobody reaches
  for it when the allow-list day arrives.

## Placement, as the PROJECT MANAGER set it

Three lanes, and **nobody starts until this document is merged**:

- `scripts/mint-session.mjs`, `backend/auth.mjs` — JUNIOR BACKEND DEV, after
  #316 and the #285 shutdown bound.
- `.forge/audit-ui.mjs` and the five audits above — QA ENGINEER, with each
  script's `EXPECTED_CHECKS` moved in the same commit as any check that moves.
- `.github/workflows/` — the repo agent.

The author of this document holds none of it.
