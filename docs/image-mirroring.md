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
provenance, usage status, and failure state/message. Reconciliation updates
source metadata only; it never clears storage fields or replaces an approved
asset.

## Future provider wiring

`mirrorRemoteImages()` is intentionally adapter-only. A caller must inject an
explicit exact-host `allowedHosts` list as well as:

- a `fetcher(url, { maxBytes })` that performs one request and returns a status,
  headers, final URL, and either a capped byte array or an incremental stream;
- an `inspectImage(bytes, context)` implementation that returns positive
  `width`, `height`, and `format` values;
- a repository with `recordStored(id, asset)` and `recordFailure(id, failure)`;
  `recordStored` must return `stored` or `approved-conflict` and commit only
  while the row is still unapproved;
- durable storage with `findByHash(sha256)` and `put({ bytes, contentType,
  sha256, width, height, format, storageKey })` returning that same
  content-addressed `storageKey` and a `storageUrl`.

The authoritative key is `images/<sha256>.<canonical-format>`, where the only
canonical formats are `gif`, `jpeg`, `png`, and `webp`. The repository owns the
cross-run `sha256` lookup and transactionally maps each key to one hash; a
conflicting key/hash association fails without changing either asset row.

The engine validates the original and adapter-reported final URL before reading
the body, rejects credentials, non-HTTPS, private/local, and non-allowlisted
destinations, and treats a refused redirect as a global stop. Declared
`Content-Length` is checked before reading; streams are capped incrementally,
and byte-array adapters receive the cap before allocation. It is serial and
has no retries. It rejects non-image content, MIME/decoded-format mismatches,
oversize bytes, invalid dimensions, and missing storage metadata. A 403, 429,
robots refusal, challenge, or denial page stops the whole run. Stored records
remain `candidate` until a separate owner-controlled approval step changes
their `usage_status` to `approved`; an approved record is never fetched or
overwritten automatically.

The command seam is safe by default:

```text
node scripts/image-mirror.mjs
node scripts/image-mirror.mjs --input path/to/local-candidates.json
```

Both commands are offline/dry-run only. `--execute` exits with a wiring error
until a provider-specific fetcher and a durable storage adapter are supplied
by application code. No provider credentials belong in this module or in a
fixture.
