# Catalog image mirroring (offline design)

This phase defines the storage contract for a future catalog-image mirror. It
does not contact a supplier, download a real image, write production storage,
or change customer rendering. The catalog continues to use its generic tire
art fallback until an owner deliberately approves an asset.

## Approved local-file publication

The persistent local-file serving path is documented in
[approved-product-images.md](approved-product-images.md). It accepts a private
local-file packet — **no longer exactly five**, see the note near the end of this
file — retains pending state until authenticated owner approval, and serves
approved same-origin URLs. It does not enable the provider
execution paths described below.

## What is durable

`backend/image-assets.mjs` adds an `image_assets` table beside the supplier
table. `reconcileImageCandidates()` links an enriched tire to the stable
supplier id, supplier SKU, and product URL, and records both
`remote_image_present` and `source_metadata_present`. Each remote URL has its
own identity key, so a supplier title change cannot make a different tire look
like the same asset. A no-image sentinel records the negative result too.

The table holds the future asset record: original URL, storage key and URL,
SHA-256, byte count, width, height, format, fetched/stored timestamps,
provenance, usage status, failure state/message, and whether the source URL is
current. Reconciliation updates source metadata and currentness only; it never
clears storage fields or replaces an approved asset.

Each row also carries a `source_current` marker. Reconciliation clears it
atomically for absent, unapproved URLs belonging to the supplier snapshot and
sets it for URLs present in the new snapshot. Selection, failure recording, and
storage commits require a current row; approved rows and their stored metadata
are preserved.

## Provider and staging wiring

`mirrorRemoteImages()` remains intentionally adapter-only. The repository now
ships two environment-driven building blocks, but no application route wires
them into customer serving:

- `scripts/image-provider.mjs` provides an HTTPS transport with per-hop DNS
  resolution, the existing safe connect/redirect hooks, a bounded response
  body, and a descriptive User-Agent. It has no credentials and does not pick
  hosts; the caller still supplies the exact allowlist through
  `createSafeImageFetcher()`.
- `backend/image-staging.mjs` provides durable filesystem staging under the
  absolute `KMT_IMAGE_STAGING_DIR` directory, bound to the explicit
  `KMT_IMAGE_STAGING_STORE_ID`. It writes only canonical content-addressed
  keys, conditionally and immutably, with flushed temporary files and
  no-clobber publication, and returns an opaque `kmt-staging://<store-id>/`
  locator containing the persistent random store identity as well as the
  configured store name. The directory is not served by the backend and must
  not be configured beneath a public static or production data root.

Staging v3 stores one private container per logical image key: a four-byte
metadata length, canonical JSON metadata, then the original image bytes. This
is not a publicly served image file. A same-directory temporary container is
written and flushed before an atomic, no-clobber hard-link publishes it. Blob
and metadata therefore become visible together. Existing containers are read
with a size cap and checked for regular-file identity, byte length, SHA-256,
all immutable metadata, and store locator before being reused. Missing or
corrupt objects referenced by SQL fail closed; SQL metadata alone never proves
that a blob exists. Previous staging formats are refused and require a fresh
private staging directory; they are not silently migrated or trusted.

Publication is the synchronous no-clobber link. Abort before it prevents any
later publication; once publication wins, the object is complete and can be
recovered even if acknowledgment or SQL fails. Abandoned temporary files from
a process crash are not readable objects and do not block a retry. Independent
writers converge by verifying the winner rather than overwriting it. A failure
after publication carries `published: true` and the recoverable asset metadata.
The engine waits for the storage cancellation outcome before reporting it and
checks the signal again before committing SQL. SQL rollback/acknowledgment
failure recovers by verifying the stored object on a subsequent explicit run.

File flushing is required on every platform; POSIX additionally flushes parent
directories. Windows Node does not expose directory fsync, so the Windows
contract covers process-crash recovery, not a guarantee of directory-entry
persistence after power loss. These offline tests do not simulate power loss.

The private root must be controlled by the staging operator, not a concurrently
hostile filesystem writer. Root and descendant real paths are checked at every
I/O boundary, symlink/junction components are refused before creating children,
and root device/inode and marker identity are pinned. The marker also binds the
canonical root path. No runtime route, image approval, or customer serving is
enabled by this adapter.

An execution caller must inject an
explicit exact-host `allowedHosts` list and an explicit `allowedPorts` policy
(the default is HTTPS port 443) as well as:

- a `fetcher(url, { maxBytes })` that performs one request and returns a status,
  headers, final URL, and either a capped byte array or an incremental stream.
  Its transport must invoke the supplied `onRedirect(nextUrl)` before each
  hop and `onConnect({ url, address })` after resolution but before opening a
  socket; `maxRedirects` is bounded. The injected fetcher must be the marked
  safe transport returned by `createSafeImageFetcher()`, or provide the same
  contract itself; an unmarked transport is rejected before any request;
- an `inspectImage(bytes, context)` implementation that returns positive
  `width`, `height`, and `format` values. The context carries an abort signal
  and `maxPixels`, `maxFrames`, and `maxDecodeMs` budgets; the decoder must
  enforce those budgets before allocating pixel/frame buffers and must reject
  truncated or malformed input;
- a repository with `recordStored(id, asset)` and `recordFailure(id, failure)`;
  `findByHash(sha256)`, and `recordStored` must return `stored` or
  `approved-conflict` and commit only while the row is still unapproved. The
  repository owns cross-run hash lookup;
- durable storage with `put({ bytes, contentType,
  sha256, width, height, format, storageKey, ifAbsent: true })` returning that
  same content-addressed `storageKey` and a `storageUrl`. The put must be
  immutable/conditional: it must never overwrite an existing key with other
  bytes or metadata.
  A repository hash hit additionally requires `verify({ storageKey, storageUrl,
  sha256, contentType, format, width, height, byteLength, signal })`, which checks
  the actual object in the bound store without repairing missing/corrupt data.
  Both operations honor the signal and settle only after they can report the
  publication outcome. The included adapter caps stored objects at 5 MiB.

The authoritative key is `images/<sha256>.<canonical-format>`, where the only
canonical formats are `gif`, `jpeg`, `png`, and `webp`. The repository owns the
cross-run `sha256` lookup and transactionally maps each key to one hash; a
conflicting key/hash association fails without changing either asset row.

The engine validates the original and adapter-reported final URL before reading
the body, rejects credentials, non-HTTPS, disallowed ports, private/local, and
non-allowlisted destinations, and treats a refused redirect as a global stop.
Declared
`Content-Length` is checked before reading; streams are capped incrementally,
and byte-array adapters receive the cap before allocation. It is serial and
has no retries. It rejects non-image content, MIME/decoded-format mismatches,
oversize bytes, invalid dimensions, and missing storage metadata. A 403, 429,
robots refusal, challenge, or denial page stops the whole run. Stored records
remain `candidate` until a separate owner-controlled approval step changes
their `usage_status` to `approved`; rejected records are not selected or
retried unless an explicit owner reset returns them to candidate. An approved
record is never fetched or overwritten automatically. Commits are bound
atomically to the authoritative supplier id + SKU, original URL, and
candidate revision captured at selection time, so stale supplier snapshots
cannot attach an image to a changed identity.

The included HTTPS adapter validates every DNS answer, copies the validated
addresses, and implements both Node lookup callback contracts (`all: true` and
scalar). Each hop uses a fresh connection and retains the original Host, TLS
certificate hostname and SNI. Constructor, wrapper and engine redirect budgets
compose by their minimum. Redirect bodies are destroyed, with bounded close
confirmation before another hop; a cleanup timeout stops the run. HTTP 403/429
refuse at headers without waiting for any body. Challenge scanning uses only a
bounded prefix and can refuse an unfinished response. Fixtures exercise real
HTTPS against loopback with a locally generated test-only certificate.

The command seam is safe by default:

```text
node scripts/image-mirror.mjs
node scripts/image-mirror.mjs --input path/to/local-candidates.json
```

**This** CLI remains offline/dry-run only: `scripts/image-mirror.mjs --execute`
exits with a wiring error and always will. Acquisition is a different command,
`scripts/import-product-images.mjs` -- see **Acquiring the images** below. The
distinction matters because the true sentence above, read alone, says the
pipeline cannot fetch anything, and that stopped being true in #468. No provider credentials belong in
these modules or in a fixture; customer rendering and approval/import remain
separate owner-controlled steps.

## Acquiring the images

This is the step that did not exist until #468. Everything else in this
document describes machinery that had never run, because nothing called it.

**It runs from the owner's machine and never from the server.** The ruling,
verbatim: *"its okAY if fetch happens from my local network i just dont want to
do it on the server."* There is no route and no server job. `backend/` does not
import `scripts/import-product-images.mjs`, and a test asserts that so a future
wiring cannot land quietly.

```text
node scripts/import-product-images.mjs ABS_PACKET_DIR ABS_STAGING_DIR --confirm-hosts cdn.example,shop.example
```

`ABS_PACKET_DIR` holds the pilot's `snapshot.json` and `profile.json` — see
**Where a packet comes from**, immediately below, because this command takes a
packet and does not make one.
`ABS_STAGING_DIR` is a private directory outside the repository: no symlink in
any ancestor, and no `public`, `dist`, `data`, `deploy` or `production` segment
in the path, or it is refused. The decoder comes from `--python` or
`KMT_IMAGE_DECODER_PYTHON` (see **Real decoder runtime** below).

### Where a packet comes from, and where this pipeline actually stops

The producing command exists and is wired:

```text
node scripts/scrape-tires.mjs --validate-products \
  --validation-input ABS_MAPPING.json --validation-output ABS_PACKET_DIR
```

It reads each product page through a **visible, non-headless, document-only
browser** at 2–5 second pacing, refuses to run against a dirty checkout, and
writes `snapshot.json` and `profile.json` into the output directory. `--dry-run`
validates the inputs and makes no provider requests. On any failure it stops
without retrying, substituting, downloading an image or activating anything.

**IT NEEDS A MAPPING FILE, AND NOTHING GENERATES ONE.** `--validation-input`
points at JSON an operator writes by hand: a digest of the tires snapshot plus,
for every tire that is to get a photo, its `supplierId`, `supplierSku`,
`productUrl` and `revision`. `prepareImagePilot` then checks it hard — each
`supplierId` must match exactly one row in the snapshot, each `supplierSku`
must equal that row's `source.sku`, each `revision` must equal
`supplierImageRevision(row)`, each `productUrl` must canonicalize to itself, and
no id or URL may repeat. Authored by a person, checked by machine.

**A packet is FIVE TIRES, still.** `selectValidationUrls(rows, seed, count = 5)`
in `scrape-tires.mjs` hard-caps the selection, and the packet path calls it
without overriding the count. The compiled-in five that #450 removed from
`image-manifest.mjs` is still live *here*, one layer out, in the command that
produces the packet. At 1,248 distinct brand+model rows that is 250 runs to
cover the catalogue, so anyone planning coverage should count runs rather than
tires.

**IT WAS MEASURABLE ALL ALONG, AND IT HAS NOW BEEN MEASURED.** The committed
catalogue is in this repository, so the claim that stopped this feature never
needed the owner, production access, or the supplier. Parsed from
`src/data/scraped-tires.json`:

| | |
| --- | --- |
| rows | 1,083 |
| rows carrying a `source.url` | 1,083 — all of them |
| URLs containing `/tirecode/` | 1,083 — all of them |
| **distinct** URLs | **1,083 — one per tire, none shared** |
| URLs beginning `/tires/` | **0** |
| path prefixes | the four scraped sizes |

Sample: `https://www.giga-tires.com/205-65-15/waterfall-tires/quattro/tirecode/WT25`

Two agents measured this independently, without having seen each other's
figures, and got the same numbers.

**The operator runbook says these are listing pages. They are not.** A listing
page is shared by every tire in a size; four sizes would give four URLs. There
are 1,083 distinct ones, each carrying its own `tirecode` with the brand and
model in the path. See [`approved-product-images.md`](approved-product-images.md),
which is corrected — and note that several of its other claims describe a system
that no longer exists.

**The single failing condition is the `/tires/` prefix, and it is a courtesy
guard rather than an oversight.** Origin matches and `/tirecode/` is present on
all 1,083; only the prefix fails. `scripts/giga-tires.mjs:14` records why:
*"Their robots.txt allows /tires/. It disallows /cart, /checkout, /my-account,
/price/calculate, the /tires/o/ deals pages, and any `?filtering=` faceted
URL."* **Do not relax it to make a mapping derivable** — that widens what this
project fetches on the strength of a convenience.

Three measured facts for whoever decides:

- The scraper already fetches **listing** pages at `${ORIGIN}/tires/{size}`
  (`giga-tires.mjs:431`), inside the allowed prefix.
- The product links **on those allowed pages** point outside it. That is the
  site's own structure rather than anything this project constructed — which is
  an argument about who chose the shape, **not** about what is permitted.
- The disallow list our own comment records does not mention size-prefixed
  paths, and robots.txt is deny-by-exception: a path absent from it is not
  implicitly forbidden.

None of that settles it. Whether those paths are crawlable is readable only from
giga-tires' live `robots.txt`, and that is a request to a real host — the owner's
call. **That question, not "can the mapping be derived", is what this feature is
waiting on.** If the site also serves a `/tires/...` form for the same product,
the cheapest answer is to canonicalize the stored URL into the permitted shape
rather than loosen the guard; nobody has checked.

**This is where the pipeline stops today**, and this section exists because that
was hard to see. Five times in one night this feature was described as one step
from finished, and each time the missing piece turned out to be one layer
further out than the layer being looked at. The chain, end to end:

| step | exists? |
| --- | --- |
| choose tires and write the mapping | **no — by hand, no command** |
| read product pages, write a packet | yes — `scrape-tires.mjs --validate-products` |
| fetch the images into staging | yes — `import-product-images.mjs` (#468) |
| seal a packet, import it | yes — `seal-image-packet.mjs`, `import-images.mjs` |
| owner approves, customer sees it | yes — the owner screen, and #444's rendering |

**Every host has to be typed out.** The confirmed list must equal the profile's
reviewed `allowedHosts` exactly -- not a subset, not a superset. The transport
already enforces the list, so this adds no security it lacks; what it adds is
that the review happened. A profile can be regenerated by a script, and a host
list nobody read is a wildcard with extra steps. If they do not match, the
command prints both lists and stops.

**The packet's snapshot is version 2 and staging takes version 1.** The command
derives one from the other, building each candidate from the five named fields
in a fixed order, so the result is a function of the packet's meaning rather
than its byte layout: two packets that say the same thing with their keys in a
different order derive identical bytes. Both digests are printed and the
original is recorded in the run's provenance as `sourceSnapshotDigest`, so an
audit reads approved -> converted -> staged without inferring the middle step.

**If the host turns the run away, that is the finding.** `REFUSAL_MARKERS` in
`scripts/image-provider.mjs` detects a challenge or CAPTCHA page and stops the
run. Report it. Do not retry in a loop, and do not reach for a browser
transport, a different user agent or a stealth plugin -- the scraper
deliberately has none: *"if the site decides to turn this away, it should be
able to."* Whether the image CDN challenges a plain HTTPS fetch is **unknown
and unmeasured**; the first real run is the first time anyone finds out.

**Nothing this command does reaches a customer.** Staging stores candidates and
a `staging_no_approval` trigger makes a staging database structurally unable to
approve anything. The owner approves in his own screen, and that gate is
unchanged.

## What no longer gates a run

Two gates named throughout the older parts of this document are **gone**,
removed by #450 and #451 on the owner's ruling that *"approval lives in the
owner screen"*:

- `IMAGE_EXECUTION_ENABLED` and the compiled-in `PM_APPROVALS` registry, with
  `assertApprovedImagePlan` and `prepareApprovedImageStagingRun`. On `main` the
  only remaining mentions are past-tense comments recording their removal.
- **The batch is no longer exactly five.** `IMAGE_PILOT_POLICY.candidateLimit`
  is **250**, and the coordinator enforces it as the politeness budget rather
  than as an approval detail: at `delayMs` 1500, serial, a full run is about six
  minutes of traffic against somebody else's server. Raising it changes the
  profile digest on purpose, because a wider batch is a different policy.

The gate that remains is the one that matters: publication. Staging can store,
and only the owner can approve.

`compileImageProviderProfile()` validates exact hostnames and the complete,
fixed pilot policy, copies and deeply freezes it, and computes a canonical
SHA-256 digest. JPEG/PNG only, HTTPS/443 only, serial requests, 1.5-second
delay, three redirects, 5 MiB encoded bytes, 16 million pixels, one frame,
5-second decode deadline, 256 MiB native memory, and 30-second candidate
deadline are bound into that digest. Limits cannot be relaxed by a profile.

The snapshot staging accepts is UTF-8 JSON with this exact shape -- the key set
is matched exactly, so a packet's version 2 snapshot is refused on its extra
keys before its version is read:

```json
{"version":1,"candidates":[{"supplierId":"fixture-0","supplierSku":"sku-0","productUrl":"https://cdn.example.test/product/0","originalUrl":"https://cdn.example.test/image/0","revision":"revision-1"}]}
```

The coordinator copies and hashes the raw snapshot bytes before parsing,
compares the expected digest, rejects extra fields and invalid identities or
URLs, and creates a new private UUID-named SQLite database. It never opens an
owner or production database. The original bytes and digest are immutable
staging records. Candidate rows are reconciled from that snapshot and committed
through the existing identity-bound repository. Source changes require a new
snapshot; there is no silent refresh from another one.

`runOfflineImageStagingFixtures()` remains the offline harness: it accepts an
in-memory `Map` of bounded fixture bytes and requires every profile host to end
in the reserved `.test` suffix, so a real profile cannot enter it. It simulates
redirects and public DNS assertions without opening sockets or resolving names,
while using the real isolated decoder, real private object storage and real
staging SQLite. Every test of the acquisition command runs through it.

### Real decoder runtime

`createIsolatedImageDecoder({ python })` requires an absolute path to a trusted,
dedicated Python interpreter with `scripts/image-decoder-requirements.txt`
installed. Pillow 12.3.0, simplejpeg 1.9.0 and its NumPy 2.5.3 dependency are
pinned. The worker checks the JPEG runtime versions before JPEG validation.
The additional JPEG codec interface is required to expose recoverable native
errors as failures; Pillow's strict truncation setting alone does not do that.
Install into a private virtual environment, never the shared runtime:

```text
python -m venv decoder.local
decoder.local/Scripts/python.exe -m pip install -r scripts/image-decoder-requirements.txt
```

On POSIX use `decoder.local/bin/python`. Set `KMT_IMAGE_DECODER_PYTHON` to its
absolute path when testing outside that default local environment. Missing or
wrong-version runtimes fail tests and decoding; there is no skipped decoder
test or fallback to metadata-only inspection. The dependency is not installed
in the deployed web application by this change.

Before importing Pillow or consuming image bytes, the worker sets Windows Job
Object native process-memory/CPU/active-process limits or POSIX `RLIMIT_AS` and
`RLIMIT_CPU`. Failure to establish those limits refuses decoding. The parent
spawns without a shell, uses Python isolated mode, omits inherited secrets,
bounds stdin/stdout/stderr, kills on abort/deadline and waits for process close.
The worker restricts formats to JPEG/PNG, treats decompression warnings as
errors, verifies then reopens and fully loads pixels, and rejects extra frames.
JPEG additionally goes through `simplejpeg.decode_jpeg_header(strict=True)` and
`decode_jpeg(strict=True)` inside the same process/resource limits, so recoverable
libturbojpeg errors refuse storage. NumPy's BLAS thread count is fixed to one.
PNG additionally streams IDAT through standard-library zlib with a 64 KiB output
buffer, requires complete EOF/checksum with no trailing stream, and checks exact
scanline byte counts for the declared color/depth and Adam7 passes. Native Pillow
still validates chunks and decodes pixels. Terminal marker checks supplement
these validators; they do not establish complete payload validation on their own.

GIF and WebP are conservatively refused by this pilot decoder, including valid
fixtures, until stricter payload validation is reviewed. Generic storage and
mirror metadata retain their existing four-format capability; that does not
authorize the pilot decoder to accept all four. The immutable profile's
`allowedFormats` binds the narrower JPEG/PNG policy. Supported valid progressive
JPEG and PNG color/bit-depth variants remain covered. Tests also remove payload
bytes while preserving container endings/lengths and verify that no object,
storage mapping or candidate hash is created.

This is process/resource isolation, **not** a filesystem/network sandbox against
arbitrary native code execution. The trusted runtime, operator-controlled
directory and Windows ACL are prerequisites. POSIX memory is address space;
Windows memory is committed process memory. The parent deadline includes worker
startup; OS CPU time has whole-second granularity. The limits do not claim that
every image within the pixel budget will fit in memory. See the primary
[Pillow security guidance](https://pillow.readthedocs.io/en/stable/handbook/security.html)
and [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

### Private append-only provenance

Each staging database contains an ordered hash-chained event log committed with
SQLite `synchronous=FULL`. It records run/profile/snapshot identity, exact policy,
source identity/revision/product and original URL, each attempted redirect and
connection assertion, response/final URL/hash, decoded dimensions/format/hash,
decoder/version/isolation/validation evidence, commit intent/result, failures and a terminal reconciliation of actual SQL
candidate states. Raw errors, object locators and filesystem paths are excluded
from events. Source URLs remain private because they may contain supplier query
data. The returned summary contains digests, counts and candidate outcomes only.

Triggers prohibit event updates/deletes; hash verification detects edited or
reordered records. This is application append-only storage, not WORM protection
against an operator who can rewrite the database and its chain. A process crash
leaves an incomplete prefix, possibly ending at commit intent. Missing `run-end`
means interrupted/unknown, never success; inspect both SQL truth and verified
private objects before an explicitly approved recovery. Provenance failure
aborts subsequent work. No automatic retry or catalog approval follows a crash.
The earlier Windows directory-entry power-loss limitation still applies.
