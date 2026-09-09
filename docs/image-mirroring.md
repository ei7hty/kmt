# Catalog image mirroring (offline design)

This phase defines the storage contract for a future catalog-image mirror. It
does not contact a supplier, download a real image, write production storage,
or change customer rendering. The catalog continues to use its generic tire
art fallback until an owner deliberately approves an asset.

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

The CLI remains offline/dry-run only. `--execute` exits with a wiring error
until application code supplies the provider transport, image decoder,
repository, and staging adapter together. No provider credentials belong in
these modules or in a fixture; customer rendering and approval/import remain
separate owner-controlled steps.

## Offline activation prerequisites (execution remains disabled)

The new coordinator is deliberately an offline fixture harness. It imports no
HTTP provider and accepts no transport callback, existing database handle, or
database filename. `prepareApprovedImageStagingRun()` refuses every profile
until the PROJECT MANAGER supplies an exact approved plan and a separately
reviewed activation change installs it. `IMAGE_EXECUTION_ENABLED` is false;
the source-controlled approval registry is empty. No real provider profile or
host is invented here. Neither environment variables nor JSON approval flags
grant authority. The existing CLI still refuses `--execute`.

`compileImageProviderProfile()` validates exact hostnames and the complete,
fixed pilot policy, copies and deeply freezes it, and computes a canonical
SHA-256 digest. HTTPS/443 only, exactly five candidates, serial requests,
1.5-second delay, three redirects, 5 MiB encoded bytes, 16 million pixels, one
frame, 5-second decode deadline, 256 MiB native memory, and 30-second candidate
deadline are bound into that digest. The offline harness alone uses zero delay
because no request is sent. Approval must bind the profile digest, exact source
snapshot digest and ordered five supplier IDs. Changing any of those requires
new approval. Limits cannot be relaxed by a profile.

The authoritative local snapshot is UTF-8 JSON with this exact shape, containing
five unique supplier IDs and one image per supplier:

```json
{"version":1,"candidates":[{"supplierId":"fixture-0","supplierSku":"sku-0","productUrl":"https://cdn.example.test/product/0","originalUrl":"https://cdn.example.test/image/0","revision":"revision-1"}]}
```

The abbreviated example has one row; execution requires five. The coordinator
copies and hashes the raw snapshot bytes before parsing, compares the expected
digest, rejects extra fields and invalid identities/URLs, and creates a new
private UUID-named SQLite database. It never opens an owner/production database.
The original bytes and digest are immutable staging records. Candidate rows are
reconciled from that snapshot and committed through the existing identity-bound
repository. A staging trigger additionally refuses approval. Source changes
require a new plan; there is no silent refresh from another snapshot.

The only runnable entry point, `runOfflineImageStagingFixtures()`, accepts an
in-memory `Map` of bounded fixture bytes and metadata, and requires all profile
hosts to end in the reserved `.test` suffix. It simulates redirects and public
DNS assertions without opening sockets or resolving names. It uses the real
isolated decoder, real private object storage and real staging SQLite. Real
profiles cannot enter this harness. A future live coordinator needs separate
exact-head security review of its transport/event wiring and activation; these
offline tests are not permission to contact a provider.

### Real decoder runtime

`createIsolatedImageDecoder({ python })` requires an absolute path to a trusted,
dedicated Python interpreter with `scripts/image-decoder-requirements.txt`
installed. Pillow 12.3.0 is pinned and checked inside the worker. This dependency
is justified because a header parser cannot validate real compressed image
content. Install into a private virtual environment, never the shared runtime:

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
The worker restricts formats to PNG/JPEG/GIF/WebP, treats decompression warnings
as errors, verifies then reopens and fully loads pixels, rejects extra frames,
and checks terminal container markers to reject tolerated truncation.

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
commit intent/result, failures and a terminal reconciliation of actual SQL
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
