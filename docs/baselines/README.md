# Security baselines

Read-only captures of what a deployed KMT host answers, taken before a change
that is meant to move it, so the read after the change has something to diff
against rather than a memory of how it used to be. Written by the security
reviewer (DEVSCOPS/AUDITOR) on 2026-09-06.

## What is here

| file | what |
| --- | --- |
| `baseline.sh` | The capture script. GET, HEAD and OPTIONS only, plus a TLS handshake and read-only `flyctl` listings. It never signs in, submits, pays or cancels, so it is safe against production. |
| `2026-09-06-precutover-kmt-fly-dev.txt` | `kmt.fly.dev` at 07:41Z on 2026-09-06, before t46 (headers and the canonical redirect) and t52 (the cutover to the client's domain). Machine version 87. |
| `2026-09-06-precutover-kensmobiletire-com.txt` | `kensmobiletire.com` at the same time: the app was already answering on the apex, `www` and `order` with no canonical redirect and `KMT_ALLOWED_HOSTS` unset. |

## How to take one

From the repository root, on a machine with `curl`, `openssl` and `node`:

```bash
bash docs/baselines/baseline.sh kmt.fly.dev > docs/baselines/$(date -u +%F)-<label>-kmt-fly-dev.txt
```

Set `FLYCTL` to the path of `flyctl` if it is not at the default; the Fly
section is skipped with a note otherwise. Name the file for the date and the
moment it records (`precutover`, `postcutover`, `after-t46`), and commit it
as docs only. The capture contains no secrets: secret names, not values, a
machine id and an image tag, all of which the repository already records.

## How to read the diff

`diff` the two captures. What the pre-cutover files say, and what the
post-cutover read should expect to see move:

The captures predate #147 as well as the cutover, so the diff carries #147's
changes alongside the cutover's. Each line below says which change owns it.

- The three client hostnames and `kmt.fly.dev` all answer `200` today with
  no canonical redirect. After t46 (#167) and t52, every non-canonical host
  answers a `301` to the canonical one with the same path and query, except
  `/api/health`, which the Host guard and the redirect both exempt so Fly's
  checker keeps passing. The `301` carries `Cache-Control: no-store`, so
  unsetting `KMT_CANONICAL_HOST` rolls browsers back too.
- Every security header on `/` reads `ABSENT` today. After #167 six are
  present on every response, redirects and errors included:
  `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, plus
  `Strict-Transport-Security` only over TLS, with `includeSubDomains` and no
  `preload`.
- `/api/nope` reads `401` today. After #167 an `/api/` path no handler knows
  answers `404 {"error":"No such endpoint."}`; an unknown path under
  `/api/owner/` still answers `401` without a session. `GET //` and
  `/api//catalog` answer as their single-slash forms rather than `500`.
- `HEAD /api/health` is `401` (the allow-list is GET-only); monitors use GET.
- `/api/catalog` was 173,723 bytes brotli and `no-store` (6,169 tires, 511
  sizes, exactly the seven customer fields). #154 changes its caching; the
  size and the field list should not change without a reason.
- `/brand/*` read `no-cache` with no validators. After #147 (merged, live)
  the same paths read `public, max-age=86400, stale-while-revalidate=604800`
  with an `ETag` and a `Last-Modified`, and a conditional GET (`If-None-Match`)
  answers `304` with an empty body; `/assets/*` stays `immutable`.
- `/robots.txt` and `/sitemap.xml` read as the app shell (`200 text/html`).
  After #147 they are real files: `text/plain` disallowing everything but the
  customer flow, and `application/xml`. Every other unknown path, including
  `/.env` and `/brand/SOURCES.md`, still answers the app shell with `200`.
- `TRACE /` read `200`. After #147 anything but GET and HEAD on a static path
  answers `405` (`TRACE /` and `POST /status` both).
- Everything else (the `401`s on the owner API without a session, the `404`
  shape for an unknown request id, the CORS answers on the import route, the
  shapes of the public JSON answers) is expected to read the same.

A line that moved and is not in this list is the thing to look at first.
