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
  locator. The directory is not served by the backend and must not be
  configured beneath a public static or production data root. Missing or
  corrupt objects fail closed; an interrupted blob-only publication can be
  recovered only when its bytes still verify exactly.

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

An allowed hostname still needs provider-side DNS resolution and pinning in a
future transport adapter: every resolved address must pass the same public-IP
check immediately before connection, and the adapter must not reuse a DNS
answer across a redirect or beyond its freshness window.

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
