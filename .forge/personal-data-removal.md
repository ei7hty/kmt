# Is the removal set complete? — an inventory, three gaps, and a design for `redact()`

Written by the TECHNICAL ARCHITECT on 2026-09-06 against `origin/main`
`7f76e77`, on the PROJECT MANAGER's instruction, after the security reviewer
closed the drift class and named what they had not checked:

> *is there any table beyond these three holding personal data the procedure
> omits entirely?*

This document answers that question and designs the `redact()` that
`docs/data-policy.md` and `docs/operations.md` both anticipate and neither
implements. **It changes no code.** Every recommendation is for the PM to
schedule, refuse or reorder.

Written in two parts, as `NOTES.md` asks. **Intent** — why a boundary is where
it is, why a recommendation has the shape it does — keeps indefinitely.
**State** — what is wired, what is live, what a list contains — is a
measurement taken at `7f76e77` on 2026-09-06 and should be re-measured before
anyone acts on it. Each section says which it is.

---

## The short answer

**No. Three things hold personal data and are in no removal list**, and one of
them is served today on a link designed to be shared. None is a coding
mistake; all three are the same structural fact — **nine hand-maintained lists
describe the personal-data surface, and not one of them is derived from
another.** Pinning each list, which is what today's tests do, makes each list
hard to *change* by accident. It does nothing about the likelier mistake,
which is *forgetting* one when a column is added.

The fix is not a bigger list. It is to make an unclassified column fail a
test, which is exactly what PR #236 does for one table's intake fields, in
flight right now. The recommendation below generalises that pattern and then
derives `redact()` from the classifications rather than from hand-typed SQL.

---

## Method (state)

So this can be re-run rather than believed. Every claim below came from
reading the file named, at `7f76e77`:

- Every table: `grep -rn "CREATE TABLE" backend/*.mjs` → nine, in six modules.
- Every log call: `grep -rn "console\.(log|error|warn)" backend/*.mjs`, then
  each call site read.
- Every error message that interpolates a value:
  `grep -rn "InputError(\`|Error(\`" backend/*.mjs | grep '\${'` → 19, each read.
- Every write of a personal field, traced from `cleanRequest`,
  `Outbox.record`, `Outbox.updateStatus`, `Inquiries.create` and
  `Mailer.notify`.
- Every persistence location outside SQLite, by reading `store.js`,
  `limits.mjs`, `docs/operations.md` and `.github/workflows/`.

Not re-derived from any handoff, report or PR body.

---

## The inventory (state)

Nine tables exist in the code. One file on the volume holds all of them.

| table | module | holds personal data? | in the removal procedure? |
| --- | --- | --- | --- |
| `requests` | `quotes.mjs` | **yes** — six keys in `payload` | yes |
| `quotes` | `quotes.mjs` | **yes — `reason`** (finding 1) | **no** — "survives in full" |
| `outbox` | `outbox.mjs` | **yes** — 2 columns + 6 keys in `data`; **and `error`** (finding 2) | partly — `error` omitted |
| `inquiries` | `inquiries.mjs` | **yes** — `name`, `contact` | yes, but the table is not wired (finding 3) |
| `owner_sessions` | `auth.mjs` | no — `id` (random) and `expires_at`. Read the schema: there is no owner or customer identifier in it at all. | n/a, correctly |
| `supplier` | `inventory.mjs` | no — supplier listings | n/a |
| `offers` | `inventory.mjs` | no — `notes` is the owner's note about **a tire**, not a customer | n/a |
| `coverage` | `inventory.mjs` | no — sizes and scrape outcomes | n/a |
| `metadata` | `inventory.mjs` | no — key/value; the only writer is `Inventory` line 70 | n/a |

Outside SQLite:

| place | verdict |
| --- | --- |
| Browser `localStorage` | The per-browser customer key only (`store.js`). 128 random bits, not personal, and deliberately **not** cleared by a removal request — `docs/data-policy.md` argues this correctly and at length. Clean. |
| Process memory (`limits.mjs`) | Rate-limiter and login-throttle maps. Keys are HMAC'd per boot with a random key (`LABEL_KEY`, #166). Dies with the process, which is every deploy. Clean, and the reasoning in the header is right about *why* a bare digest would not have been. |
| Application logs | **Clean by design, and I checked rather than assumed.** No log line interpolates a name, email, phone, address or note; `mail.mjs` logs `addressLabel(to)`, the same keyed HMAC. Of the 19 error messages that interpolate anything, not one interpolates a customer field — they carry sizes, ports, ZIPs, status vocabularies and limits. The residual is `console.error(error)` on an unexpected throw, whose message is whatever threw; nothing I could find puts a customer value there. |
| Fly log retention | **Not documented anywhere** (finding 4, minor). |
| WAL, freelist pages, `VACUUM` | Covered, and covered well, in `docs/operations.md`'s "What 'removed' actually means here". No gap. |
| Fly volume snapshots (5 days), the monthly off-Fly copy | Covered in the same section. No gap. |
| The mail provider and the customer's own inbox | Partly covered (finding 5, minor). |
| Files on disk | Nothing writes request data to a file. The only `writeFileSync` in `backend/` or `scripts/` outside tests is `cut-zip-centroids.mjs`, which writes ZIP centroids. Clean. |

---

## Finding 1 — `quotes.reason` is free text from a human, in no list, on a shared link

**Severity: the highest of the three.** It is both a removal gap and a
disclosure question, and the second half is live today.

**What it is.** `quotes.reason TEXT` (`quotes.mjs`, `QUOTES_COLUMNS`), up to
500 characters of free text (`cleanReason`). Written by three paths:

- the owner rejecting a quote (`moveTo`, `reason`),
- the owner cancelling (`cancel(id, version, reason)`),
- **the customer cancelling their own request** (`cancelByCustomer(id, customerKey, reason)`),
  reached over the **public** endpoint `POST /api/requests/:id/cancel`
  (`api.mjs` line 312; named in the public allow-list at line 65).

**Why it is personal.** It is the same kind of field as `locationNotes` and
`customerNotes`, both of which are in the removal set *precisely because* free
text is where people write the thing they later want gone. `customerNotes`'s
own comment in `quotes.mjs` says so: *"the field most likely to hold something
a customer would want gone."* `reason` is that field one table over, and it is
the field a customer types into at the exact moment they are walking away. A
customer cancelling and typing *"moving, new number is 617-555-0134, reach me
there"* has just written contact details into a column that a removal request
does not touch.

**Why it is missed.** `docs/data-policy.md` and `docs/operations.md` both say
`quotes` survives **in full** — "status, version, total, line items, both
timestamps, all of it". That sentence is about the *ledger*, and as a statement
about the ledger it is right. `reason` is not ledger; it arrived with #55, after
the sentence's reasoning was formed, and "in full" quietly annexed it.

**The disclosure half.** `shapeRow` (`quotes.mjs` line 428) partitions the
**request** payload by audience through the `CUSTOMER_REQUEST_FIELDS`
allow-list, and its comment explains at length why: #65, where a spread passed
contact fields to anyone holding a shareable link. **The quote half of the same
return value is not partitioned at all.** It is
`...JSON.parse(quote.payload)` plus `reason`, identical for both audiences. So:

- `GET /api/requests/:id` — the link R19 designs to be shared — carries the
  owner's free-text rejection reason.
- `src/routes/Status.jsx` renders it to the customer, in both closed states
  ("This quote was declined.<reason>" and "This request was cancelled.<reason>").
  No line number: that file moved under me twice while this was being written.

For the owner's *reason for rejecting* that may be intended. Nothing I read
says it was decided. And the spread means **the next field added to the quote
payload reaches the customer automatically** — which is the exact failure the
comment six lines above says was fixed for requests. t35 (the owner adjusts a
quote and writes "a note to the customer", keeping the original draft
alongside) adds fields to that payload next.

**This half is not mine to rule on and not a removal question.** It belongs to
the PM to route, and DEVSCOPS/AUDITOR should read it as its own item.

**Recommendation.** Classify `reason` as personal-bearing free text and redact
it with the rest. Losing a rejection reason on a redacted row costs the ledger
nothing a removal request should protect. Separately, and not as part of this:
give the quote half of `shapeRow` the same audience treatment the request half
has.

---

## Finding 2 — `outbox.error` stores what the mail provider said, and no list covers it

**Severity: medium. Real mechanism, unmeasured magnitude — I say which is which.**

**What I verified.** `Mailer.notify`'s catch (`mail.mjs`) writes
`String(error?.message || error).slice(0, 500)` into `outbox.error` via
`updateStatus`. `error` is in neither `OUTBOX_REDACTED_COLUMNS`
(`['to_address','to_name']`) nor `OUTBOX_PERSONAL_DATA_KEYS` (the six keys
inside `data`), and the `UPDATE outbox` statement in `docs/operations.md` does
not mention it. So after a removal run that the procedure calls complete, the
column keeps whatever the provider put there.

**What I did not verify.** Whether Google Workspace's relay in particular
echoes the recipient address in a rejection. I have not produced a bounce
against the live configuration, and I am not claiming a measured leak.

**Why it still needs classifying.** SMTP replies to `RCPT TO` conventionally
name the mailbox — `550 5.1.1 <someone@example.com>: Recipient address
rejected` is the ordinary shape — and nodemailer surfaces the server's response
as the error message. More to the point, **the value is unbounded text from a
system we do not control**, written into a row a removal request is supposed to
clear. Its content is the provider's choice, not ours. That alone decides the
classification, whatever a particular bounce turns out to say.

There is a small irony worth recording: `docs/data-policy.md` justifies
storing `data` on the grounds that *"if a failed send needs debugging, the
row's `data` and the named template reproduce exactly what went out."* The
failure path is the one that also keeps the address.

**Recommendation.** Add `error` to `OUTBOX_REDACTED_COLUMNS`. It is one entry,
it is in a list already pinned by a test, and it makes the class of "whatever
the provider said" someone's problem exactly once. **Cheap enough to do before
launch, and the cheapest of the three.** If anyone wants the debugging value
kept, the answer is to store a provider status code rather than its prose — a
larger change, and not one I would make before the domain cutover.

---

## Finding 3 — `inquiries` is documented as live and is not wired

**Severity: low today, and the clearest illustration of the actual problem.**

`docs/operations.md` states: *"**`requests`, `quotes`, `outbox` and
`inquiries` are all live tables today** (#157 and #205 merged…)"*, and on the
strength of that removed its own "check which blocks apply" step.

Measured at `7f76e77`: `grep -n "Inquiries\|inquiries" backend/server.mjs
backend/dev.mjs backend/api.mjs` returns **nothing**. Nothing constructs
`Inquiries`, so its `CREATE TABLE IF NOT EXISTS` never runs and the table does
not exist in production. #205 landed the storage module, as #157 did for the
outbox — the outbox was then wired by #206; `inquiries` has not been.

**Consequence today: mild.** The operator's query fails with `no such table`,
which the procedure explicitly anticipates and calls correct.

**Consequence when t65 lands: the real one.** The moment something constructs
`Inquiries`, a table carrying names and contact details appears in production,
and **nothing notices it arrived.** `.forge/restore-integrity-check.mjs`'s
`EXPECTED_TABLES` — the one place in this repository that inventories every
table and every column, and the checker the removal procedure tells the
operator to run to confirm a redaction — lists **eight** tables and does not
include `inquiries` (`grep -c inquiries` on that file: **0**). It is
hand-maintained, and it is already one table behind the schema.

**Recommendation.** Correct the operations.md sentence to say what is true, and
put `inquiries` into `EXPECTED_TABLES` when t65 wires it — or better, stop
maintaining that inventory by hand (see below). No urgency beyond t65.

---

## Findings 4 and 5 — two documentation edges (minor)

**4. Log retention is a forward reference to nothing.**
`docs/data-policy.md` says: *"It says nothing about logs, backups, or anything
DEV OPS's document covers; ask there for how long an infrastructure copy of a
redacted row might still exist."* `grep -n "retention" docs/operations.md`
returns **no matches**. Snapshot ageing is documented (five days, in several
places); log retention is not. Since the logs are clean by design (inventory
above), this is a documentation gap, not exposure — but a policy that points at
an answer nobody wrote reads as authoritative and is not. DEV OPS's ground.

**5. Mail already sent names one boundary and not the other.**
The procedure says a sent message *"cannot [be] recall[ed]"* — true, and about
the customer's inbox. Sending through the owner's Google Workspace may also
leave a copy on KMT's own side (a Sent copy on submission through
`smtp.gmail.com`; the relay path behaves differently, and I have not tested
which). That is a second system of record this procedure cannot reach and does
not mention. One sentence, once someone establishes which path Ken's
configuration actually takes.

---

## The structural cause (intent)

This is the part worth keeping after the three findings are fixed.

**Nine places describe the personal-data surface. None is derived from another.**

| # | where | maintained by | pinned? |
| --- | --- | --- | --- |
| 1 | `REQUEST_PERSONAL_DATA_KEYS` | `quotes.mjs` | test, literal |
| 2 | `FORM_FIELDS` / `REQUEST_NON_PERSONAL_FIELDS` | `quotes.mjs` | **partition test — PR #236, in flight** |
| 3 | `OUTBOX_PERSONAL_DATA_KEYS` | `outbox.mjs` | test, literal |
| 4 | `OUTBOX_REDACTED_COLUMNS` | `outbox.mjs` | test, literal |
| 5 | `INQUIRY_PERSONAL_FIELDS` | `inquiries.mjs` | test, literal |
| 6 | `CUSTOMER_REQUEST_FIELDS` | `quotes.mjs` | — (a different question, the same fields) |
| 7 | three `UPDATE` statements | `docs/operations.md` | prose only |
| 8 | `EXPECTED_TABLES` | `.forge/restore-integrity-check.mjs` | — (already one table behind) |
| 9 | the prose lists | `docs/data-policy.md` | prose only |

Every one of #1, #3, #4, #5 is pinned by a test asserting a **literal array**.
That is a good pin and it is worth keeping: it makes the list hard to change
without meaning to, and each list sits beside the schema it describes, which is
the right place for it.

**But a literal pin cannot detect an omission.** Add a column, never touch the
list, and every test still passes. All three findings above are that same
shape: `reason` arrived with #55, `error` arrived with #157, `inquiries`
arrived with #205, and no test could have objected, because objecting requires
knowing what the full column set *is*.

The repository has already worked this out once. #236's description states it
exactly: *"`REQUEST_PERSONAL_DATA_KEYS` fires when someone changes the list. It
does not fire when someone forgets it… Forgetting is the likelier mistake —
nothing has to be touched for it to happen."* That PR is the right answer,
applied to one table's intake fields. **The recommendation is to finish the
thought.**

---

## Recommendation A — make an unclassified column a test failure (the actual fix)

Generalise #236's partition from `FORM_FIELDS` to **every table that can hold
personal data**, sourced from the live schema rather than a second hand-written
list:

For each of `requests` (payload keys), `quotes`, `outbox`, `inquiries`:

1. Read the real column set — `PRAGMA table_info(<table>)` against a
   freshly-built test database, which is what every backend test already has.
   For `requests`, the payload keys from `FORM_FIELDS` plus the separately
   cleaned `customerPhone`, as #236 already handles.
2. Assert it partitions **exhaustively and exactly** into `PERSONAL` and
   `NON_PERSONAL` — every column in exactly one list, nothing double-counted,
   nothing named that does not exist.
3. Fail with a message naming the new column and what to do about it.

**Why `PRAGMA table_info` and not the module's own column constant:** the
constant is the thing that might be wrong. Reading the built table is reading
the artifact, not the description of it — the habit `NOTES.md` records under
three separate lessons.

This is the check that would have caught all three findings, and it is the only
proposal here that catches the *fourth* one, which nobody has thought of yet.
It costs one test file and no production code.

**Prove it can fail before trusting that it can pass.** `NOTES.md` records the
bundle-leak check passing 3-of-3 on a genuinely leaking build. Whoever builds
this adds a column by hand, watches exactly this test fail and no other, and
quotes the failing output in the PR — the same negative test #236's author ran
and recorded.

---

## Recommendation B — the design for `redact()`

Derived from the constants, with hand-SQL demoted to a documented fallback,
as the PM asked.

### Where it lives

`docs/data-policy.md` proposes "a method on `Quotes`, next to `shapeRow`". I
recommend **against** that, for one reason: redaction spans three tables owned
by three modules, and a `Quotes` method reaching into `outbox` and `inquiries`
would couple `Quotes` to two schemas it does not own — undoing the property
those modules deliberately chose when they put each list *beside the schema it
describes*.

Instead, three owners and one coordinator:

- `Quotes.redactRequest(requestId)` — rewrites `requests.payload`, using
  `REQUEST_PERSONAL_DATA_KEYS`.
- `Outbox.redactForRequest(requestId)` — rewrites `OUTBOX_REDACTED_COLUMNS`
  and the keys in `OUTBOX_PERSONAL_DATA_KEYS` inside `data`, `WHERE
  request_id=?`.
- `Inquiries.redact(inquiryId)` — rewrites `INQUIRY_PERSONAL_FIELDS`.
- **`backend/redaction.mjs`** — owns the cross-table transaction and the
  "one person means these rows" mapping. Nothing else.

Each module keeps its list. The coordinator knows only that the three exist.

### The properties it must have

1. **Derived, never restated.** The SQL is built by mapping over the constant:
   `json_set(payload, ...KEYS.flatMap(k => [`$.${k}`, REDACTED]))`. Adding a key
   to a list changes the statement. This is the single property that makes the
   whole exercise worth doing — it is precisely what the three hand-copied
   `UPDATE`s in `operations.md` cannot do.
2. **One shared marker.** Export `REDACTED = '[redacted]'` from one module and
   import it everywhere, including into the doc's examples by reference. Today
   the literal is typed in `operations.md` three times and in no code.
   `operations.md` is right that a hand-fixed row and a code-fixed row must not
   be distinguishable; a shared constant is how that stays true.
3. **Atomic.** One transaction across all matched rows —
   `Inventory.transaction()` already exists (`BEGIN IMMEDIATE`/`COMMIT`) and is
   the right tool. `data-policy.md` already requires "redacted together or not
   at all"; this is where that becomes true rather than intended.
4. **Idempotent, readable off the row.** Writing the same literal twice is
   already a no-op. No separate "has this been handled" state, per the policy.
5. **Verified through the access path, not the table.** After the transaction,
   re-read via `quotes.get(id, 'owner')` and assert no personal field holds
   anything but the marker. `operations.md` already tells the *operator* to
   check the API rather than the table; code should hold itself to the check we
   already ask a human to run.
6. **Explicitly does not touch:** `requests.customer_key`, the quote ledger
   (status, version, total, line items, timestamps), `vehicleInfo`,
   `tireSelection`, `quantity`, `date`, `locationType`, `serviceZip`,
   `inquiries.vehicle_info` and `.message`. Each of these has a reason in
   `data-policy.md`; none is re-litigated here.

### How it is invoked — and my recommendation

Three options, and they are not equal:

| | surface | verdict |
| --- | --- | --- |
| a | An owner-authenticated `POST /api/owner/requests/:id/redact` | **Not before launch.** It puts an irreversible, destructive capability on the network behind a single password, days before a cutover. If it is ever built, DEVSCOPS/AUDITOR reads it first. |
| b | A CLI: `node scripts/redact.mjs <request-id>`, run on the machine via `flyctl ssh console` | **Recommended.** Same code, same constants, same transaction, same verification — and no new network surface at all. It replaces the part of the procedure that is actually dangerous (hand-typed SQL with a hand-typed `WHERE`) while leaving the authorisation exactly where it is: a human with `flyctl` access. |
| c | Leave the hand-SQL as the mechanism | Honest, and what is written today. But the SQL is copied from lists it cannot stay in step with — the mechanism this whole document is about. |

**(b), with a `--dry-run` that prints the matched rows and writes nothing**,
mirroring `import-tires`, which this project already trusts for a
consequential write and which is the local precedent for "show me first".

The hand-SQL in `operations.md` stays as a documented fallback for the case
where the app will not start, marked as such rather than deleted — the PM's
instruction, and the right call: the day the database is damaged is exactly
when a `node` script may not run.

---

## What I recommend, in order

1. **`outbox.error` into `OUTBOX_REDACTED_COLUMNS`** (finding 2). One line,
   one already-pinned list, before launch.
2. **A ruling on `quotes.reason`** (finding 1). Product, not mine: it needs the
   PM or the lead. My recommendation is to redact it. The *disclosure* half —
   the unpartitioned quote shape on a shared link — should be routed to
   DEVSCOPS/AUDITOR as its own item, and it should not wait on the removal
   question.
3. **The partition test** (recommendation A). After the cutover unless the PM
   wants it sooner; it touches no production code, so it is safe to land any
   time, and it is what stops finding 4 existing.
4. **`redact()` as a CLI** (recommendation B). After launch. Nothing about the
   current hand procedure is unsafe *if followed*; it is fragile over time, not
   broken today, and that is a post-cutover shape of problem.
5. **The two documentation edges** (findings 4, 5) and the `inquiries` sentence
   (finding 3) — DEV OPS's and DB ADMIN's ground, whenever they are next in
   those files.

**If the answer preferred is "the set is complete and the hand-SQL is fine
until launch", the honest version is narrower than that:** the hand-SQL *is*
fine until launch, and item 1 is cheap enough that shipping without it is a
choice rather than a constraint. But the set is not complete, and the reason it
is not is that nothing can tell us when it stops being.

---

## What I did not check (state)

Said plainly, so nobody reads this as more than it is.

- **I ran no tests, no lint, no build and no audit.** This is a reading of the
  code at `7f76e77`, not a verification of the tree.
- **I did not produce a real SMTP bounce**, so finding 2's magnitude is
  reasoned from the SMTP convention and from the fact that the value is
  unbounded provider text, not measured against Google's relay.
- **I did not read production.** Everything about what exists in the live
  database is inferred from the code that creates it. Whether `inquiries`
  exists on the volume today should be confirmed by DEV OPS or DB ADMIN over
  `flyctl ssh` before anyone acts on finding 3 — this project has been wrong
  about production data from a document before (`HANDOFF.md`, "no owner prices";
  there were eight).
- **I did not check the frontend** for personal data in `localStorage` beyond
  `store.js`'s customer key, or for anything a browser extension or a crash
  reporter might see. No crash reporter is configured; I did not look further.
- **`quotes.reason`'s disclosure half is stated, not assessed.** Whether the
  owner's rejection reason *should* reach the shared link is a question for the
  auditor and the PM, and I have deliberately not answered it.
