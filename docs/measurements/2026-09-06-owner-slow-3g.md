# Ken's side under Slow 3G, 2026-09-06

Measured by LEAD FULL STACK for the PROJECT MANAGER's follow-up to the t61
record: the owner screens' time, not their layout, on the connection a
driveway has. Same harness as t61: standard Slow 3G over CDP (400 ms round
trip, 400 kbps each way), a fresh browser context per run, three runs per
cell, times from `performance.now()` marks set inside the page. 375x812.
A snapshot, not a live view.

## What was measured against

The owner screens only show data behind the sign-in, and production is never
signed into by a script, so the signed-in measurements are against a local
build of main `3c6b71f` served by `backend/server.mjs` on a throwaway
database. The repository's snapshot holds 1,083 rows across 4 sizes, and the
6,169-row walk file is deliberately not in the repository, so the database
was seeded from a **synthetic snapshot of production's shape**: the real
1,083 rows kept as they are (215/60R16 with its real 281 tires), plus
invented rows for 507 more supported sizes, 6,153 rows across 511 sizes with
a coverage row for each. Every row passes `validateTire`. Five requests were
submitted through the public API so `/owner/quotes` had something to show.
The snapshot file was overwritten in a worktree, never committed, and
restored afterwards.

One thing the synthetic data understates: the coverage rows are uniform, so
they compress far better than 511 real rows with differing timestamps and
error text would. The raw sizes are right; the brotli figure below is a floor.

## The numbers

| step | local build, uncompressed | production, read-only |
| --- | --- | --- |
| cold `/owner` to the password field usable | 7.8 / 7.7 / 7.8 s, 310 KB, 4 requests | **3.7 / 3.7 / 3.6 s, 111 KB, 4 requests** |
| sign-in click to the form gone | 3.4 / 3.5 / 3.4 s | not measured (no production sign-in) |
| of which the login round trip | 0.46 / 0.44 / 0.44 s | |
| sign-in click to the first tire card | 3.0 / 2.9 / 2.9 s | |
| the inventory response | 98 KB raw in 2.4 s; **3 KB brotli** | |
| commit a size (`215/60R16`, 281 tires, 12 pages) to its first card | 2.7 / 2.7 / 2.7 s, 98 KB raw response | |
| `/owner/quotes` with 5 requests, to the first request card | 1.0 / 1.0 / 1.0 s, 5 KB response | |

The local first-paint number is the uncompressed 259 KB JavaScript bundle at
50 KB/s, as in t61; production sends it as 89 KB brotli, which is why the
cold `/owner` load is 3.7 s there. Read the production column for what Ken
feels before sign-in, and the local column for the shape of what happens
after it.

### What the inventory response is made of

Every page of `/api/owner/inventory` carries the same summary, and the
summary is most of it:

| part | raw |
| --- | --- |
| 24 tire cards | 10 KB |
| `summary.sizes`, the 910 supported sizes | 11 KB |
| `summary.coverage`, 511 rows | 72 KB |
| whole response | 98 KB, 3 KB brotli (synthetic floor) |

So committing a size, turning a page and reloading the list each re-send
the 910 sizes and the 511 coverage rows. Brotli hides most of that today;
the page count and the coverage list are still resent on every interaction,
and the raw size will grow with every size the supplier walk adds.

### What this means for a phone in a driveway, estimated

Sign-in cannot be measured on production by rule, so the production figure
for it is an estimate from the measured parts: the login round trip is one
request (0.45 s measured locally with the same throttle), and the inventory
response at a brotli size between 3 KB (synthetic floor) and perhaps 20 KB
(real coverage rows) takes 0.5 to 0.8 s on this connection. **Sign-in to the
first tire card on production should be about 1 to 1.5 seconds**, after the
3.7 s cold load. Committing a size should be under a second. `/owner/quotes`
is the lightest screen: a 5 KB response and a second to the first request.

None of this is the 30 seconds of staring the PM was worried about. The cost
that is real is the cold load before sign-in: 3.7 s on production, all of it
the bundle and the brand image, none of it the data.

## What did not go to plan

- The first run reported the inventory response as 0 KB: the page requests
  `/api/owner/inventory` once before sign-in and gets a 401, and the script
  had taken the first response instead of the last.
- A "first usable control after sign-in" mark on the metrics tiles fired
  before the click: the tiles render with placeholders behind the sign-in
  form. Dropped as meaningless.
- `/owner/quotes` page weight read as 315 KB because `encodedBodySize` counts
  a cached bundle at full size; the transfer was the 5 KB response plus
  cache hits. Reported as such.

Scripts were temporary and are not in the repository. Nothing was written to
production; the only sign-in was against the local server.
