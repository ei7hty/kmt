# Private product-image operator workflow

This change supplies a local-file ingestion and owner-approval path. It does
not authorize or execute provider image acquisition. `IMAGE_EXECUTION_ENABLED`
remains false, the provider approval registry remains empty, and the image
mirror CLI still refuses execution. No pilot has been run by this change.

The committed catalog currently has 1,083 rows, no image URLs and no valid
product-page source URLs. Its source URLs are listing pages. The original
seed-only validation command therefore cannot produce the required packet.
Do not invent product URLs from IDs, change seeds to work around refusals, or
substitute whichever products happen to succeed.

## 1. Prepare an owner-reviewed exact-five mapping, locally

The owner must supply five real, distinct Giga product URLs and identify the
existing supplier row each belongs to. Obtain these through the owner's
authorized supplier access; this implementation does not discover them.
Keep the mapping, baseline snapshot, logs, returned product metadata and image
files in a private directory outside Git checkouts, static roots and build
contexts. On Windows, use an owner-only ACL; POSIX outputs use modes 0700/0600.

The UTF-8 mapping JSON has this shape (placeholders are deliberately unusable):

```json
{
  "version": 1,
  "inputDigest": "SHA256_OF_EXACT_SRC_DATA_SCRAPED_TIRES_JSON_BYTES",
  "candidates": [
    {
      "supplierId": "EXISTING_ID",
      "supplierSku": "EXISTING_SKU",
      "revision": "supplier-payload-v1:EXPECTED_CANONICAL_PAYLOAD_SHA256",
      "productUrl": "OWNER_SUPPLIED_REAL_PRODUCT_URL"
    }
  ]
}
```

Supply exactly five entries. `supplierImageRevision(tire)`, exported by
`backend/image-manifest.mjs`, calculates the revision. Representation v1 first
normalizes description with `cleanCatalogDescription`, then recursively sorts
object keys, preserves array order and JSON-serializes the entire supplier
payload. This matches the inventory ingress normalization while avoiding
source-file formatting/object-key-order differences. The expected revision
must be prepared **before** the pilot/import, not recomputed to bless changed
inventory during ingestion. Existing inventory must match the baseline; a
price, stock, description or other payload change deliberately invalidates the
image. Refresh the private baseline and obtain a new packet/approval then.
The default baseline is the committed `src/data/scraped-tires.json`. Supply
`--validation-snapshot ABS_PRIVATE_BASELINE_JSON` with both mapping/output
flags when using a separately owner-exported `{ "tires": [...] }` supplier
snapshot. That file's exact bytes become `inputDigest`; the importer still
compares each expected revision to the existing database, so a stale export
cannot silently replace current source data.

The mapping's raw byte digest, baseline raw byte digest, seed and code SHA are
retained in the resulting activation snapshot. Selection algorithm
`owner-mapped-five-seeded-v1` applies the existing seeded shuffle to the frozen
five explicit mappings; all five are requested in that recorded order. This
is a versioned mapping-based workflow, not selection from the old listing URLs.

Run local preflight first from the reviewed checkout:

```text
node scripts/scrape-tires.mjs --validate-products --validation-seed 20260907 --validation-input ABS_PRIVATE_MAPPING_JSON --validation-output ABS_NEW_PRIVATE_DIRECTORY --dry-run
```

This validates locally, opens no browser and writes no packet. The output's
parent must already exist; output must be new and outside this repository.

Only after owner authorization for these exact five pages, the owner can run:

```text
node scripts/scrape-tires.mjs --validate-products --validation-seed 20260907 --validation-input ABS_PRIVATE_MAPPING_JSON --validation-output ABS_NEW_PRIVATE_DIRECTORY --validation-jitter-min 2000 --validation-jitter-max 5000
```

Execution requires a clean reviewed checkout and a visible browser. There is
one main-document request per product, serial, randomized 2–5-second spacing
between starts, the existing identifiable KMT User-Agent, no retry and no
redirect following. JavaScript and service workers are disabled; all image,
font, media, script, CSS, XHR, fetch, popup and frame subresources are blocked.
`route.fetch` explicitly uses zero redirects and retries (a plain
`route.continue` cannot provide that guarantee). Document responses are checked
against a 4 MiB acceptance limit and a 30-second fetch deadline. Playwright
buffers that document response before the body-size check; this is not a
streaming memory cap. No image bytes are acquired. Pages that need scripts,
redirects or blocked resources fail under this policy; do not relax it on a
refusal. Any missing SKU/MPN, size mismatch, identity mismatch, missing image,
refusal or incomplete outcome stops the whole run without a successful packet.

Product identity comes from JSON-LD SKU (or MPN if SKU is absent), never a
fallback inventory row. Size must match the baseline. An existing productId,
when present, must also match. A productId is not assumed to equal KMT's
internal supplier ID. The actual final URL is checked and preserved.

Outputs are `snapshot.json` (v2, ordered five candidates, enriched rows and
private provenance), `profile.json` (fixed reviewed budgets, derived exact
host union), and `pilot-summary.json` (digests, ordered IDs and separate
product/image host lists). Files are no-clobber and flushed. A crash can leave
an incomplete private directory: treat it as failed, never as approval.
Do not reserialize approved snapshot bytes. Review exact product/image hosts;
no wildcard or guessed CDN is used. Listing URLs remain in inventory and
private provenance; product URLs do not overwrite them.

## 2. Supply and seal local image files

The metadata pilot does not download images. Obtaining the selected original
image files requires its own owner-authorized acquisition step. This change
provides no network image downloader or execution bypass. Local files are an
owner attestation of source, not proof that an HTTP acquisition occurred.

Prepare a private bindings JSON array in exactly the snapshot candidate order:

```json
[{"supplierId":"EXISTING_ID","format":"png","path":"ABS_LOCAL_IMAGE_FILE"}]
```

Supply exactly five entries, with format `png` or `jpeg`. Then:

```text
node scripts/seal-image-packet.mjs ABS_PRIVATE_PACKET_DIRECTORY ABS_PRIVATE_BINDINGS_JSON
```

This hashes bounded local files, copies them to `<sha256>.<format>` in the
private packet and writes `manifest.json` last. It never overwrites differing
bytes. The manifest binds the exact snapshot digest, canonical profile digest,
ordered supplier IDs and five file hashes/formats. Save its printed SHA-256 for
the import and owner review. Sealing does not decode or approve the images.

## 3. Import locally into the existing owner database, pending only

The container provisions Python 3.12 with the pinned Pillow/simplejpeg/NumPy
environment and `KMT_IMAGE_DECODER_PYTHON`. Local operators need the same pinned
environment from `scripts/image-decoder-requirements.txt`, with that variable
set to its absolute Python executable. Decoder versions are verified at run
time and executed in an isolated child with time/pixel/frame/memory limits.
Only complete JPEG/PNG payloads are accepted; GIF/WebP/SVG are refused.

With owner authorization to import the reviewed private packet:

```text
node scripts/import-images.mjs ABS_EXISTING_OWNER_SQLITE ABS_PRIVATE_PACKET_DIRECTORY MANIFEST_SHA256
```

The importer does not create/seed inventory or mutate supplier, offer,
pricing, request or customer records. It checks all five identities, expected
payload revisions and byte hashes before publication, fully decodes all files,
stores immutable objects, then commits all five pending references and an
import event in one SQLite transaction. It rechecks supplier revisions at
commit. Failed work can leave unreferenced private objects, never partial
public approval. Reimporting the same digest returns its current state and
does not restore revoked approval.

Storage is `<directory-containing-owner.sqlite>/catalog-images-private`.
On the existing Fly mount that is `/data/catalog-images-private`, alongside
`/data/owner.sqlite`; no new volume or Fly configuration command is needed.
The original staging factory still refuses `/data`. The separate persistent
factory requires the private directory name, rejects public/dist roots and
symlink/junction components, pins store/root identity and verifies immutable
metadata and SHA-256 on every read. Only verified image payload bytes can be
served, never the private container header or storage locator. POSIX files and
directory entries are fsynced. Windows guarantees process-crash recovery, not
power-loss durability of directory entries. This assumes an operator-controlled
filesystem; it is not protection from a privileged process replacing the DB.

Back up the SQLite database and the private image directory together while
quiescent. Restoring a DB without its matching store fails image reads closed.
There is no automatic orphan deletion or garbage collection in this slice.

## 4. Review and explicitly approve through the authenticated same-origin API

Use `backend/server.mjs` and a real owner session. Local `dev.mjs` deliberately
does not grant image approval through its unauthenticated development shortcut.
`GET /api/owner/images` lists the latest 100 private packets;
`GET /api/owner/images/<manifestDigest>` returns exact ordered candidates,
hashes, profile/snapshot digests, current action, version, actor and time.
The response is authenticated and `no-store`; it contains private supplier
URLs and must not be pasted into public issues or logs.

After reviewing the packet and local-file source attestation, approve from
the signed-in owner's same-origin browser console (substitute the reviewed
digest and version):

```js
await fetch('/api/owner/images/MANIFEST_SHA256', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'approved', expectedVersion: 1 })
}).then(r => r.json())
```

The browser supplies the same-origin `Origin` and session cookie. Missing or
foreign origins are refused, as are stale versions. Approval verifies all five
stored files and current source revisions in the same transaction, records
the authenticated actor in an append-only hash-chained decision log, and
publishes all five mappings atomically. Import is version 1, approval version
2. To revoke that packet, POST `{action:'revoked', expectedVersion:2}` to the
same digest route. Revoked packets are terminal; changed data needs a new
manifest and new approval. A later approved packet may supersede an earlier
supplier mapping; revoking the older packet cannot erase the newer mapping.

Customer `/api/catalog` adds only optional relative
`/api/images/<64 lowercase hex>.(jpeg|png)` URLs. No candidate, source URL,
SKU, private path or storage locator is projected. Once any packet is imported,
catalog responses stay `no-store`, including after revocation. A catalog with
no packets keeps its existing five-minute cache (it contains no image URL).
Public GET/HEAD checks current approval, supplier activity, expected revision
and offer eligibility before verifying the stored bytes. Responses use fixed
JPEG/PNG MIME, `nosniff`, same-origin resource policy and `no-store`; no 304
shortcut bypasses approval. Revocation blocks future serving, but cannot
recall bytes already delivered. Identical hashes shared by multiple suppliers
remain readable while any eligible approved supplier still uses those bytes.

## Verification and release boundary

All implementation verification uses synthetic image/HTML fixtures and
throwaway local databases. The five-page provider pilot, image acquisition,
production import and owner approval remain separate explicit owner actions.
Opening a ready PR does not authorize any of them or waive independent review.
