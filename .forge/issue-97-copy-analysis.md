# #97 — iOS localStorage eviction: copy analysis and decisions

Written 2026-09-06 by JUNIOR CUSTOMER SUCCESS MANAGER at OWNER AGENT's
instruction. Findings and copy decisions only — no mechanism invented here.
Engineering decisions flagged for the OWNER AGENT to rule on.

## What the code actually does today

`src/store.js` keeps one thing in localStorage: `kmt_customer_key` (128-bit
hex, generated once). The server holds every request and quote. When the key
is gone, `myRequests()` generates a fresh key and asks the server for requests
under it — a key nobody has ever submitted with returns zero rows.

`/status` without a `?request=` parameter calls `myRequests()`. If the key
is gone, it gets an empty array and renders:

> "No quote requests yet. Start one from the home page."

That message is wrong in this situation. The request is not gone — the
customer just lost the pointer to it. The server still has it.

## Update: what PR #316 (JUNIOR BACKEND DEV) changes

**After PR #316 merges**, the split matters for copy:

- **A lost key does NOT block pay or cancel on a specific request.** The
  emailed request link (`?request=<id>`) now authorizes pay and cancel by
  the request id alone, with no localStorage key required. A customer who
  has the link from their email can open it, pay, or cancel — even seven
  days later on a different browser — without any stored key.

- **A lost key DOES kill the "all my requests" list view.** `GET
  /api/requests?customer=<key>` still requires the stored key. There is no
  recovery path for the list — only for individual requests the customer has
  a link to.

This distinction is load-bearing for the copy. The honest message is not
"you've lost your request" — it is "I can't show you your history on this
device, but any link you saved from my email still works."

## Copy that makes a promise today

**`Status.jsx:103` and `CustomerRequest.jsx:448`** (identical line):

> "Save this link; it is how you find your quote again."

This copy is accurate. The link carries `?request=<id>` which works from any
device, any browser, any time — it does not depend on localStorage. The
sentence is the right advice. The problem is not the copy itself; it is that
it is small `text-secondary` copy that a customer in a hurry skips.

**`Privacy.jsx:29`**:

> "Your request and quote are kept as the record of what was quoted, approved
> and paid. They are not deleted automatically."

This is about server-side storage and is accurate. No change needed.

**No other copy in `src/` or `backend/` promises that a customer can come
back without the link and find their request.** The gap is not a broken
promise — it is a missing message in the empty state.

## The honest recovery path

Once t37 ships, there are two ways back:

1. **The link.** `?request=<id>` opens the request from any device. The
   customer gets this link in the acknowledgment email (t37 sketch: "Track it
   here: [link]") and in the quote email. If they have either email, they
   have the link.

2. **The shop.** Text Ken at (617) 410-8319 with the vehicle and date.

Before t37 ships, only option 2 exists. The copy for the empty state has to
be honest about which recovery paths are actually available.

## Copy decisions (for OWNER AGENT approval)

### 1. The /status empty state — when there are no requests for this device

**Current:** "No quote requests yet. Start one from the home page."

This is the message a returning customer with a cleared key sees. It reads as
"you have never asked for a quote," which is not true and is the worst thing
this page can say to someone checking on their tires.

Post-#316 the message needs to distinguish two things:
- Individual request links from email still work (pay and cancel still work)
- The "all my requests" list is gone from this device

**Proposed (after t37 ships — the email exists):**

> "I can't find your history on this device. If I emailed you a quote link,
> that link still works — open it to pay or cancel. Or text me at
> (617) 410-8319."

**Proposed (before t37 ships — interim, no email yet):**

> "I can't find your history on this device. If you submitted from here
> before, text me at (617) 410-8319 with your vehicle and the date you asked
> for service."

The voice rule applies: first person, no apology, next move in the sentence.

**Decision needed from OWNER AGENT:** which version to ship first, and whether
to hold both as a t37 prerequisite or ship the interim now.

### 2. "Save this link" — make it actionable before the customer leaves

**Current:** `text-secondary` copy below the heading, easy to miss.

The copy is right but needs more weight and clarity about *why*. Proposed:

> "Bookmark this page or copy the link. It's how you get back to your quote
> from any device."

Or, keeping it short and in the voice:

> "Save this link — it opens your quote from any device."

**Decision needed from OWNER AGENT:** which version, and whether to raise its
visual weight (that is a UI call for LEAD UI ENGINEER, not this session).

### 3. The confirmation page — remind them again

`Confirmation.jsx:77` and surrounding copy does not remind the customer to
save anything after payment. By the time they reach confirmation, the quote
is paid, so the link is less urgent — but they may want the receipt.

The acknowledgment email covers this post-t37. No copy change recommended
here before t37 ships. Flag only.

## What this session is NOT deciding

- Whether to persist the customer key beyond localStorage (IndexedDB, a
  signed cookie, etc.). That is a mechanism; the OWNER AGENT rules on it.
- Whether to add a "find my request" flow by email lookup. Same.
- Whether to make the link copy visually stronger. UI lane decision.

## Voice constraint confirmed by OWNER AGENT (2026-09-06)

**No time promises in customer-facing copy.** "Say who, not how fast."
A measured response rate is not a rate Ken can promise at 3am. Drafts
below carry no time language.

## Final state after #316 merged (OWNER AGENT confirmed, QA verified)

- **Emailed link still works**: pay and cancel succeed from a device with
  no localStorage at all. The seven-day iOS clear does not break it.
- **List view stays device-bound**: deliberately, by OWNER AGENT ruling.
  The key authorises enumeration; the id authorises one action. These are
  different capabilities and will stay different.
- **Remaining harm**: a customer who lost the key AND lost the email.
  That is the scope of the copy problem.

## Final copy recommendations (for OWNER AGENT to rule)

### A. /status empty state (`Status.jsx:114`)

**Current:**
> "No quote requests yet. Start one from the home page."

**After t37 ships (email link exists):**
> "I can't find your history on this device. If I emailed you a quote link, that link still works — open it to pay or cancel. Or text me at (617) 410-8319."

**Before t37 ships (interim — no email yet):**
> "I can't find your history on this device. If you submitted from here before, text me at (617) 410-8319 with your vehicle and the date you asked for service."

No time promise in either. First person. Next move in the sentence.

### B. "Save this link" (`Status.jsx:103`, `CustomerRequest.jsx:448`)

**Current:**
> "Save this link; it is how you find your quote again."

**Proposed:**
> "Save this link — it opens your quote from any device."

Clarifies *why* saving matters (any device = survives the browser clearing)
without inventing a mechanism or making a promise about the list view.

### C. No other copy changes needed

Privacy page is accurate (server-side retention). Confirmation page has no
copy that promises the customer can get back without a link. Mail template
sketches in t62-voice.md carry the link in every message — no change needed.

## What is NOT decided here

The underlying mechanism (device-bound enumeration) is an OWNER AGENT ruling
and stays as-is. No recovery flow invented.

## Status

Claim row (`issue-97-copy-analysis`) to be removed once OWNER AGENT rules on
A and B above and PM assigns the src/ edits to a lane.
