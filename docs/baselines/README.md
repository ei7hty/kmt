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

- The three client hostnames and `kmt.fly.dev` all answer `200` today with
  no canonical redirect. After t46 and t52, every non-canonical host answers
  a `301` to the canonical one, except `/api/health`, which the Host guard and
  the redirect both exempt so Fly's checker keeps passing.
- Every security header on `/` reads `ABSENT` today. After t46 the expected
  set is present, with `Strict-Transport-Security` only over TLS.
- `HEAD /api/health` is `401` (the allow-list is GET-only); monitors use GET.
- `/api/catalog` was 173,723 bytes brotli and `no-store` (6,169 tires, 511
  sizes, exactly the seven customer fields). #154 changes its caching; the
  size and the field list should not change without a reason.
- The SPA fallback answers `200 text/html` for every unknown path, including
  `/robots.txt`, `/.env` and `/brand/SOURCES.md`; a real `robots.txt` and a
  method restriction on static paths are pre-launch items.
- Everything else (the `401`s on the owner API without a session, the `404`
  shape for an unknown request id, the CORS answers on the import route,
  `/assets/*` immutable, `/brand/*` `no-cache` with no validators) is expected
  to read the same.

A line that moved and is not in this list is the thing to look at first.
