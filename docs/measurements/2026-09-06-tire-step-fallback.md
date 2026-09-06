# The tire step's fallback branch on the live build, 2026-09-06

Measured by LEAD FULL STACK against production `https://kmt.fly.dev` running
the deploy of `ed16fc3` (#183, the lead's ruling on the tire-list swap), after
confirming the served bundle carried `.tire-loading` and `.tire-refresh`.
Read-only GETs only: no submit, no sign-in. Standard Slow 3G over CDP unless
stated (400 ms round trip, 400 kbps each way), a fresh browser context per
run, times from `performance.now()` marks set inside the page, 375x812.
LEAD UI ENGINEER had already forced all four branches with a Playwright
route handler; this pass asks whether the sequence holds when the network
itself is what makes the answer late. A snapshot, not a live view.

## 1. On a real connection the fallback does not fire, and cannot be made to

The 8-second threshold is measured from the moment the per-size request
starts, not from page load, and the response is 5.2 KB. So the sequence is
the same at every throttle: the ring, then the live list, once.

| profile | ring appears | per-size fetch | live list | fallback |
| --- | --- | --- | --- | --- |
| Slow 3G, run 1 | 3.97 s | 0.61 s | 4.54 s | no |
| Slow 3G, run 2 | 3.92 s | 0.62 s | 4.51 s | no |
| Slow 3G, run 3 | 3.91 s | 0.62 s | 4.49 s | no |
| 1000 ms / 100 kbps | 11.21 s | 2.39 s | 13.58 s | no |
| 1500 ms / 32 kbps | 30.89 s | 5.90 s | 36.77 s | no |

The ring reads "Checking today's prices for 205/65R15…". Pressing Continue
while it shows answered, in every run, "We are still checking today's
prices for 205/65R15. One moment." Everything being slow together changed
nothing: bundle, CSS and images landing late only move when the tire step
begins, not what happens inside it. The standard list needs a single
stalled request of more than eight seconds, or a failure, which a slow
connection does not produce.

## 2. The branches forced at the network layer

CDP `Fetch` interception on the live build: the transport's equivalent of
the route handler, applied to the real deploy.

**Failure** (the per-size request reset): the standard list at 4.12 s, five
tires (Budget Economy and the four generated models), under the note
"Showing our standard list; today's stock and prices are confirmed when Ken
reviews your request." Tires selectable, Continue enabled.

**Late answer** (the response held for 12 s): ring at 3.89 s; the standard
list at 11.86 s, which is 8.0 s after the request started, exactly the
threshold; "Today's prices are in. Refresh the list" offered when the answer
landed; the list never changed until the refresh was pressed; on refresh the
live list, 178 tires for 205/65R15 and 283 for 215/60R16.

**Both refresh outcomes:**

| tire picked from the standard list | outcome | note shown | Continue |
| --- | --- | --- | --- |
| Budget Economy, 205/65R15 (a seed that also exists live) | re-found | "Budget Economy is in today's list at $59.99 per tire." | enabled, selection kept |
| All-Weather Standard, 215/60R16 (seed) | re-found | "All-Weather Standard is in today's list at $85.99 per tire." | enabled, selection kept |
| Touring Comfort, 205/65R15 (generated, no live counterpart) | cleared | "That tire is not in today's list; please choose again." | disabled |

The choice is re-found by size and name, as ruled.

## 3. Two notes, neither a defect in #183

- The standard list on production is five generic tires, because the
  supplier snapshot left the client bundle in t39. The fallback a customer
  sees is thin by construction; expected, worth knowing.
- CDP's "offline" emulation switched on at the tire step did not block the
  per-size fetch, which answered in 20 ms; the failure branch was therefore
  proven with `Fetch.failRequest` instead. An instrument limit, not app
  behaviour.

Scripts were temporary and are not in the repository; the selectors are
LEAD UI ENGINEER's (`.tire-loading`, `.tire-options[data-source]`,
`.tire-refresh`, `.tire-reselect-note[data-outcome]`,
`button.primary-action:disabled`).
