# The next sprint: four items from the user

Written by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) on 2026-09-07,
on the user's instruction. **The what and the why.** The PROJECT MANAGER turns
it into briefs and places them; the REPO AGENT owns the gate.

The four, as given:

1. **A health check for the email service**
2. **A tire installation service fee**
3. **All pricing modifiable in the owner portal, with owner-defined lines that
   are optional or automatic**
4. **OAuth in the owner portal**

## The ruling that changes the shape of the sprint

**Item 2 is the first entry in item 3, not a feature of its own.**

There are already four hard-coded fees — mobile service, disposal, tax and
shipping — **each with its own metadata key, its own validation, its own
placeholder flag and its own branch in `calculateDraftQuote`.** Adding
installation the same way means **writing a fifth and deleting it when the
catalogue lands.**

**Build the catalogue. Installation is its first row, entered as data.**

**And if installation must be charged before the catalogue is ready, the
stopgap is not code.** Ken already controls the mobile service fee and changed
it tonight, $75 to $120. **Raising it covers installation for the length of the
sprint at the cost of nothing.**

---

## 1. The email health check

**Highest priority, and the scope is wider than the name suggests.**

### What happened, because the requirement comes directly from it

**Email was down for two hours and three minutes on 2026-09-06/07** — 23:49 to
01:52. **The user found it in a Gmail interface. Nothing in this system said a
word.**

The cause is confirmed and it is recurrent: **the Google App Password
disappeared.** Any account security change revokes them — **silently, with no
warning, no notification and no log entry.** It will happen again.

**No customer was harmed, and that was luck rather than design.** The seven
failed messages were test traffic and Ken's own notifications; the eight
`queued` rows predate SMTP being configured. **Two hours of real traffic in that
window would have been silently lost customers, because there is no retry path
(#285).**

### Two detectors, and they answer different questions

**A. Any failed row, surfaced immediately.** `failed` is **never a legitimate
resting state**, so this needs **no age threshold and no configuration
precondition** — unlike the `queued` case, which is the normal steady state
under NullAdapter and needs all three parts of DEV OPS's predicate. **This is
the cheap half and it would have caught tonight within a minute.**

**B. An active probe of the seam, and this is the half the name implies.**

**Detection of failures is not detection of a broken seam.** The credential was
dead for somewhere inside a 2h23m window in which **nothing was sent** — and a
watcher of failed rows sees nothing while nothing is being attempted.

**So overnight, a dead credential is invisible until the first customer of the
morning triggers it.** The failure we actually had is **silence that looks like
calm**, and only something that exercises the seam distinguishes those.

**The probe must not send mail to a person, and it does not have to.**

`SmtpAdapter.transport()` (`mail.mjs:129`) already builds a nodemailer
transporter lazily, and **`transporter.verify()` opens the connection, performs
`AUTH`, and disconnects — no message, no recipient, no quota consumed.**

**That is exactly the failure tonight had: the credential was dead and the
transport was fine.** So the probe is *get the transporter, verify, report* —
cheap enough to run on a timer, and it distinguishes **"nothing is being
attempted"** from **"attempts would fail."**

**A probe that sent real mail would raise two problems it does not need to
have** — where the message goes, and quota consumed against limits sized for a
one-man business.

### What must not be built

**No automatic credential rotation and no retry-with-fallback.** The credential
boundary holds: **secrets are set by the user's own hands.** A health check
reports; it does not repair.

---

## 2 and 3. Owner-defined pricing lines

**One feature. Installation is its first row.**

### What exists, and why the generalisation is the right move

`.forge/pricing-settings.md` established the shape: **one `metadata` key holding
JSON, integer cents in storage, `isPlaceholder` per field, and `quotes.payload`
free-form so new lines cost nothing at the schema level.**

**That design already anticipated growth and hard-coded four fees anyway.** The
user is now asking for the general case, and **the general case is cheaper than
a fifth special case.**

### The shape

**A catalogue of lines the owner defines**, each carrying:

- **a customer-facing label** — see the risk below; this is copy, not an
  internal note
- **an amount**, integer cents
- **per tire or per visit** — the mobile fee is per visit and the code comment
  says why; shipping and disposal are per tire
- **automatic or optional** — automatic lines always appear; optional lines the
  customer chooses

### Optional lines already have a working pattern

**Disposal is exactly this**: `disposeOldTires` on the request, a control on the
service step of the wizard, **defaulted off**, a conditional line on the quote,
and visible on the owner card because Ken has to physically take the tires.

**The catalogue generalises that pattern rather than inventing one.** The
control on the wizard becomes **generated from the catalogue** instead of
hard-coded, and **default off is not a preference**: an opt-in that is on by
default is not an opt-in, and a fee that appears without the customer choosing
it is what #94 was opened about.

### `isPlaceholder` mostly stops applying, and someone will carry it over anyway

**The flag exists to mark numbers we invented so they are visibly not Ken's.**
**A line Ken created is his by construction** — there is nothing to disclaim.

**It still applies to what remains built in**: tax is not a catalogue line (see
below), and the markup rate and shipping remain settings rather than quote
lines.

### The risk, and it is not a reason to refuse

**A free-form fee list can produce a quote a customer cannot read.**

R25 wants an itemised invoice, and **an invoice with six owner-named lines is
only better than one opaque total if the labels mean something to the person
paying.** *Misc*, *Shop fee* and *Svc chg* are worse than no itemisation,
because they look like padding.

**So the label field is customer-facing copy.** It belongs to the same voice
rule as everything else the customer reads, and **the owner screen should say so
at the point of entry** rather than leaving it to be discovered.

### Tax stays out of the catalogue

**Tax is not a line item. It is a rate applied to a taxable subtotal**, with
`appliesTo` deciding which lines are taxable — **a question for Ken's
accountant, not for us.**

**And a catalogue makes that question harder, not easier**: every new
owner-defined line is a new thing that is or is not taxable. **The catalogue
entry therefore needs a taxable flag**, and its default should be **whatever
`appliesTo` already implies**, not a guess.

---

## 4. OAuth in the owner portal

**Specced in `.forge/owner-google-signin.md` and #330. Unblocked.** Workspace
admin is obtained, the OAuth client exists, and the redirect URI is pinned:

```
https://kensmobiletire.com/api/owner/session/google/callback
```

### The precondition, which is not optional

**Removing the password breaks the pre-merge gate's ability to prove the owner
half of the flow.** `signInIfAsked` is imported by **five audit scripts**,
measured rather than recalled:

```
a11y-85-measure.mjs   dead-end-audit.mjs   owner-inventory-audit.mjs
request-flow-check.mjs   responsive-check.mjs
```

**The number was wrong at source, corrected once, and propagated anyway.**

The PROJECT MANAGER's original grep swept for `openOwnerQuotes` importers and
missed the two files that import `signInIfAsked` directly. **The architect swept
every importer, found five, and corrected them. That correction reached one
holder and stopped** — so *three* survived into `.forge/owner-auth-cutover.md`,
into this document, and through two rewrites, until it was re-measured by
accident during a review.

**That is the record-then-grep rule (`NOTES.md`) failing in the direction nobody
watches**: not a record going stale, but **a correction that was delivered
accurately to one person while every other holder kept the old value.** Nothing
in this repository makes a stale number announce itself.

**The precondition argument rests entirely on the size of what breaks.** *Three
audits* invites someone to reroute them; **five, spanning the responsive and
owner-inventory checks as well, makes it plain that password auth is
load-bearing across the whole gate.**

**`AGENTS.md` says the gate exists to prove that a customer submits, the owner
approves and the customer pays.** Removing password auth deletes the only way it
performs the middle one, **and it would not announce itself: the audits would
keep reporting counts while covering less.**

**`scripts/mint-session.mjs`** — a CLI that creates a session row and prints the
cookie, **no HTTP route, same trust boundary as `scripts/redact.mjs`** — covers
it. **It grants nothing to anyone who cannot already read the database.**

**Whether it is documented as a break-glass recovery path is the user's call.**
It gets built either way, because the gate needs it.

### Two requirements on how it is proven

**Every claim is a required equality on a present value; a missing claim is a
rejection.** The conditional form admits **every consumer Google account on
earth**, because a consumer account carries no `hd` and the guard never runs.

**And every such test feeds a constructed token straight to the verifier** — not
a real sign-in. **Google's Internal consent screen and our `hd` check are two
independent controls, so a real flow cannot tell you which one refused
someone**, and a test of ours can pass because theirs refused first.

### Sequencing

**Two changes, not one.** Google sign-in lands with the password still working;
the password is removed only after a real sign-in has actually carried a login.
**A single change means a misconfiguration locks the owner out with no recovery
from inside the product**, while real customers wait.

**And inside change two the order is load-bearing**: `readAuthConfig` throws at
boot on a missing `KMT_OWNER_PASSWORD`, so **the code that tolerates its absence
deploys before the secret is unset.**

---

## Ranking, by harm

**1 first.** It is the only item whose failure mode is **a customer who hears
nothing and an owner who does not know.** Tonight that cost nothing by luck.

**3 second, with 2 folded in.**

**4 last of the four** — the highest security value, no live harm while it
waits, and the largest surface.

**Nothing here displaces open work without the PROJECT MANAGER re-ranking.**

## What this document does not decide

**Whether installation is per tire or per visit.** Fitting four tires is not
four times the work of fitting one, and **it is Ken's price, not ours.** The
catalogue supports either; **he chooses.**

**Whether the taxable default is on or off.** That is the accountant's question,
and it does not become ours by being asked in a new place.
