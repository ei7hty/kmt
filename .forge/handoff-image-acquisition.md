# Handoff: production image acquisition

Written 2026-09-09 by the PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`) for
whoever picks this up. **Read this top to bottom before touching the code — it
records three wrong estimates of this feature's size, and the reason each was
wrong is more useful than the conclusion.**

Protocol first: `.forge/AGENTS.md`, then `.forge/NOTES.md`. Claim a row before
starting. Claim commits go through a disposable worktree off `origin/main`.
**You do not merge your own PR.**

---

## The goal, in the owner's words

> *"I want to work on the product catalog having photos and the front end
> capability to display them"* … *"unhardcode the stuff holding the code back
> from presenting product images if they're available. then we'll push the
> scraper to be gentle and courteous to get it started"* … *"remove both gates,
> approval lives in the owner screen"*

---

## What the catalog actually looks like (measured, 2026-09-09)

| | |
| --- | --- |
| supplier rows | **6,169** |
| distinct brand+model | **1,248** |
| distinct brands | 165 |
| published images | **0** |

**Per-SKU photography is not reachable; per-model is 1,248.** Every supplier row
already carries `source.url`, a product page, and `parseProductPage`
(`scripts/giga-tires.mjs:370`) already extracts `imageUrls` from it. So the
mechanical path to coverage exists.

---

## Three wrong estimates, mine, each smaller than the last

**1. "It needs a fetcher."** It does not. `mirrorRemoteImages`
(`scripts/image-mirror.mjs`) is the fetcher, backed by `createHttpsImageTransport`
(`scripts/image-provider.mjs`). It already has SSRF protection via
`assertSafeResolvedAddress`, redirect budgets with loop detection, byte caps,
host/port allowlists, serial pacing, and challenge detection — `REFUSAL_MARKERS`
already matches `captcha`, `request could not be satisfied`, `access denied`,
`robots.txt`, `challenge`. It has ~10 test scenarios.

**2. "The two gates are the blocker."** `IMAGE_EXECUTION_ENABLED = false` and
`PM_APPROVALS = Object.freeze([])` do block — **and there is a third,
unconditional `throw` after them**, and `prepareApprovedImageStagingRun` has no
callers at all. Removing the gates alone changes nothing.

**3. "It needs production wiring."** Closer, but still too big. The fixture
harness builds a *synthetic* transport and hands it to the same
`mirrorRemoteImages` a real run would use. **The difference between the test
harness and a production run is which transport goes in.**

**The lesson worth carrying: each estimate was a correct observation about the
wrong object.** Check what calls a thing before concluding it is the blocker.

---

## What is already done

**PR #450** (`image-packet-unhardcode-count`) — the packet size five, removed.
Twelve refusals across six files. **Three separate hardcoded fives**, the last
two found after I claimed the first sweep was complete:

- the twelve `!== 5` guards
- `seal-image-packet.mjs` returning `count: 5`
- the run result returning `selected: 5`

`IMAGE_PILOT_POLICY.candidateLimit` is now **250**, not 5. `MAX_IMAGE_PACKET_ASSETS`
is 500 as a sanity ceiling. The selection tag is `IMAGE_SELECTION_TAG`.

**Branch `image-fetcher`** (on top of #450, pushed, no PR yet) — one commit
making the transport injectable, **behaviour unchanged**:

- `offlineFixtureTransport(fixtures)` extracted
- the candidate cursor is now an `advance()` the transport calls
- `runStaging(input, mode)` takes a mode supplying the transport builder, the
  pacing and the refusal message
- `FIXTURE_MODE` carries what was fixture-specific: `.test` hosts only, bounded
  byte Map, zero delay

616/616 backend tests, eslint clean, no production path yet.

---

## What is left, and it is small

### 1. The production mode

```js
const PROVIDER_MODE = {
  delayMs: plan => plan.profile.policy.delayMs,
  failureMessage: 'Image candidate refused',
  prepare(input, plan) {
    return ({ advance, append }) => provenanceTransport(
      createHttpsImageTransport({
        maxRedirects: plan.profile.policy.maxRedirects,
        timeoutMs: plan.profile.policy.timeoutMs,
      }),
      { advance, append },
    )
  },
}
```

### 2. A provenance decorator, because this is the one thing that does not carry over

`createSafeImageFetcher` already wraps the transport and enforces hosts, ports,
redirect budgets and resolved addresses — **that works for the real transport
with no change**, because `createHttpsImageTransport` already calls
`options.onConnect?.()` and `options.onRedirect?.()` (`image-provider.mjs:120-123`).

What does **not** carry over is the run's own provenance log. The fixture
transport emits `candidate-start`, `connect`, `response` and `redirect` by hand
because it *is* the transport layer. A real transport must be wrapped so the
same events reach `append`:

```js
function provenanceTransport(inner, { advance, append }) {
  return { fetch: async (originalUrl, options) => {
    const current = advance()
    append('candidate-start', { supplierId: current.supplierId, supplierSku: current.supplierSku,
      revision: current.candidateRevision, sourceUrl: current.productUrl, originalUrl })
    const response = await inner.fetch(originalUrl, { ...options,
      onConnect: details => { append('connect', { finalUrl: details.url, address: details.address }); return options.onConnect?.(details) },
      onRedirect: next => { append('redirect', { redirectUrl: next }); return options.onRedirect?.(next) },
    })
    append('response', { finalUrl: response.finalUrl, status: response.status,
      sha256: sha256Bytes(response.bytes), bytes: response.bytes.length })
    return response
  } }
}
```

**Verify this against `verifyImageRunProvenance`** — a production run should
produce the same event shape a fixture run does, and `integrity.complete` must
stay true. A fixture run currently emits 26 events for five candidates.

### 3. Remove both gates — the owner decided this

> *"remove both gates, approval lives in the owner screen"*

Delete `IMAGE_EXECUTION_ENABLED`, `PM_APPROVALS` and `assertApprovedImagePlan`
from `backend/image-provider-profile.mjs`, their imports in the coordinator, and
the unconditional `throw` in `prepareApprovedImageStagingRun`. Two tests assert
the switch is `false` (`image-provider-profile.test.mjs:28`,
`image-publication.test.mjs:67`) and one asserts the `/PROJECT MANAGER/` refusal
(`image-staging-coordinator.test.mjs`, "approval entry point stays blocked") —
those change shape, not expected value.

**What must NOT be removed, because it is the gate that remains:** the owner
approve/revoke decision on *publication*. Staging stores candidates; nothing
reaches a customer until the owner approves. `image-publication.mjs` enforces
it and the `staging_no_approval` trigger makes staging structurally unable to
approve. **That is the gate the owner asked for and it already exists.**

### 4. What is still genuinely missing after that

**An owner screen.** The approve/revoke *route* exists (`backend/image-api.mjs`).
There is **no UI and no `src/store.js` helper** — `grep -i image src/owner/`
returns nothing. Until that exists the owner cannot approve anything, so
acquisition alone does not put a photo on the site.

**Customer rendering is done** — `src/components/TireProductImage.jsx` and
`src/catalog-image.js` shipped in #444, with fixed-aspect slots and a generic
fallback, so a mostly-photoless catalog still renders as a clean grid.

---

## Product rulings that constrain this — do not relitigate without the owner

**Politeness is a budget, not a sentiment.** `delayMs: 1500`, serial, one at a
time. `candidateLimit: 250` means a run is about six minutes of traffic against
somebody else's server. **Raising `candidateLimit` changes the profile digest on
purpose** — the digest pins the policy a run was approved under, so a wider
batch is a different policy.

**No guessed CDN.** `docs/approved-product-images.md`: *"Review exact
product/image hosts; no wildcard or guessed CDN is used."* The image host is
discovered from a parsed product page and then explicitly reviewed into
`allowedHosts`. The fetcher validates against the reviewed profile; it must not
infer hosts.

**A real browser may be required.** `scripts/browser-fetch.mjs` exists because
*"giga-tires.com sits behind AWS WAF and CloudFront. A plain HTTP fetch gets a
challenge page, and a headless browser gets refused outright."* That is about
**product pages**. Whether the **image CDN** challenges a plain HTTPS fetch is
**unknown and unmeasured**. If the first real run returns a challenge, the
`REFUSAL_MARKERS` detection will catch it — **report that as the finding rather
than reaching for a browser transport or a spoofed user agent.** The existing
scraper deliberately has no stealth: *"if the site decides to turn this away, it
should be able to."*

**`sent`-style honesty applies here too.** An image that stored is not an image
that is approved, and an image approved is not an image a customer saw.

---

## Environment gotchas that cost me real time

**Each worktree needs its own `node_modules`.** The main checkout's was **empty**
— `npm install` fixed it, then junction it per worktree:

```
New-Item -ItemType Junction -Path <worktree>\node_modules -Target C:\Users\anune\code\kmt\node_modules
```

**Never `rm -rf` a worktree with that junction in place** — `NOTES.md` records it
following the junction into the shared install.

**The image tests cannot run without a Python decoder, and they fail at import.**
`realImageFixtures()` runs at module scope, so *every* test in
`image-publication.test.mjs` and `image-staging-coordinator.test.mjs` is skipped
as one failure without it. CI installs it (`fly-deploy.yml:93-98`). Locally:

```
python -m venv <dir>/kmt-decoder
<dir>/kmt-decoder/Scripts/python.exe -m pip install --only-binary=:all: -r scripts/image-decoder-requirements.txt
export KMT_IMAGE_DECODER_PYTHON=<dir>/kmt-decoder/Scripts/python.exe
```

**Without it you will "pass" 572/576 and believe you verified the image
pipeline. You did not run any of it.** This is how I found a real regression in
my own change.

**A filtered grep under-reported.** My sweep for remaining fives excluded lines
containing 3+ digit numbers to skip byte sizes, and silently dropped
`selected: 5`. **Confirm per file with a direct grep rather than one clever
pass.**

**`flyctl -C` word-splits and strips quotes.** For read-only production queries:
`/**/` for whitespace, `[table]` for identifiers, and **no string literals at
all** — `pragma/**/table_list` and `pragma/**/table_info(offers)` work;
`where/**/status='x'` does not. Select unfiltered and filter locally.

---

## Verification bar

- `node --test backend/*.test.mjs` **with the decoder set** — 616/616 today
- `npx eslint .` — exit 0
- `npm run build`
- **Mutation-test every new guard.** Delete it, watch its own test go red, and
  nothing else. Three of my tests tonight passed for reasons unrelated to their
  names until I did this.
- **A test whose expected value the broken code also produces is not a test.**

---

## Who to talk to

**PROJECT MANAGER (`local_5b6d8402`)** — placement, sequencing, readers. Ranking
is the owner agent's; placement is theirs.

**PRODUCT MANAGER / OWNER AGENT (`local_44d1e1f9`)** — product rulings only:
what the product promises a customer, where approval lives, what the politeness
budget is. **Not** placement.

**The user** is the only one who can create credentials, set Fly secrets, or run
a production write.
