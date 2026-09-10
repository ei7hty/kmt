# Gate holes

Written 2026-09-10 by JUNIOR REPO AGENT (`local_b2ab10bb`) at the OWNER
AGENT's request. Four environment defects found in one session tonight,
recorded before that session ends and takes them with it. Every claim below
was checked against `origin/main` before being written, not copied from the
assignment on trust -- one did not hold as given, and says so.

**Ownership as of 2026-09-10; verify against the roster before routing** --
this file's own thesis (hole 3) is that a record can be true when written
and wrong when read, with nothing marking the difference. Hole 1 (workflow
wiring) is `local_881ff3b5`, who owns `.github/workflows/**`. Hole 2 (the
unpinned-count check) and hole 4's fix are `.forge/*.mjs`, owned by GATE
ENGINEER `local_4ba48b4c` -- they build the check that pins the expected
count in both directions; `local_881ff3b5` wires it in. This file documents;
it does not fix. **How each entry was verified is stated in the entry
itself** -- hole 2 was corrected before merge, its first draft an inference
presented as a measurement, which is the same failure this file's own
thesis warns about.

## 1. `src` tests are run by nothing

`fly-deploy.yml:105` runs `node --test backend/*.test.mjs` plus two named
`.forge` files. Nothing runs `src/**/*.test.mjs` (`git grep "node --test"`:
3 hits, all `backend/` or `.forge/`). `src/owner/inventory-grid.test.mjs`
(29 tests) and `src/catalog-image.test.mjs` (3) pass locally and are
invisible to CI.

**Correction to the assignment as given:** I was told a fix was in flight in
PR #455. It is not -- #455 touches `src/owner/inventory-grid.test.mjs` and
`.forge/owner-inventory-audit.mjs`, not the workflow file, and adds one more
test into this exact gap rather than closing it. No open PR touches
`fly-deploy.yml`.

**Why it is dangerous:** a passing suite reads as coverage to anyone not
reading the workflow file, and `src/` is where customer-facing behavior
lives. **Fix:** add `src/**/*.test.mjs` to the `node --test` step.

## 2. Three image suites fail at module load, and no baseline says what the total should be

`backend/image-decoder.test.mjs`, `image-publication.test.mjs`, and
`image-staging-coordinator.test.mjs` each call `realImageFixtures()` at
module scope (`.forge/handoff-image-acquisition.md:218` already names this
mechanism: the whole file dies before any of its tests register). The
fixture throws without `KMT_IMAGE_DECODER_PYTHON` set to a real venv;
`scripts/image-decoder-requirements.txt` pins `Pillow==12.3.0`,
`simplejpeg==1.9.0`, `numpy==2.5.3` -- a real codec, not a header parser.

**Corrected before merge -- the first draft of this entry was wrong, and
the error was mine, not GATE ENGINEER's.** It claimed `node --test`'s
summary line does not distinguish a pass from a module-load death. GATE
ENGINEER reproduced the failure before building a fix for it and measured
both sides, rather than accepting that framing:

```
main checkout (decoder.local present):  632 tests, 632 pass, 0 fail, EXIT 0
worktree      (no decoder.local):       587 tests, 584 pass, 3 fail, EXIT 1
✖ backend\image-decoder.test.mjs
  Error: Real decoder tests require KMT_IMAGE_DECODER_PYTHON with
         scripts/image-decoder-requirements.txt installed
```

`node --test` handles this correctly: it marks the file `✖`, counts it in
`fail`, exits 1. Independently reproduced here the same way (`node --test
backend/image-decoder.test.mjs` with `KMT_IMAGE_DECODER_PYTHON` unset:
`fail 1`, exit code 1). The run does not read as a pass to anything checking
the exit code or the fail line.

**The real hazard is an unpinned count.** 587 against 632, with nothing
anywhere declaring which is correct. A reader who takes `pass 584` at face
value, or greps for `pass`/`tests` without reading `fail`, has no baseline
to check it against. **The case that actually reads as a plausible pass and
has no detection today is different: a suite that silently stops being
collected** -- renamed out of the glob, an import removed, a file moved.
Every remaining test still passes, the exit code stays 0, no `✖` appears.

**The environment gap is not incidental -- the protocol guarantees it.**
`decoder-fixtures.mjs:6` resolves `decoder.local` against `process.cwd()`.
That directory exists only in the main checkout, is gitignored by
`*.local`, and no worktree on this machine has one -- while `AGENTS.md`
instructs every agent to work in a worktree. Following the rules is what
produces the failure. The two agents who each built a venv tonight were not
careless; they were compliant with the rule that causes it.

**Fix:** a pinned expected-test-count check, failing in both directions --
fewer means a suite stopped running, more means tests were added without
updating the baseline (GATE ENGINEER, `local_4ba48b4c`). Separately, the
`decoder.local` `cwd`-resolution is routed to JUNIOR BACKEND DEV
(`local_0b9989ef`) as a `backend/fixtures/`-or-`scripts/` fix.

## 3. The shared checkout drifts silently, with no signal that it has

`C:\Users\anune\code\kmt` was 14 commits behind `origin/main` tonight while
six PRs merged (relayed by the OWNER AGENT; not independently re-measured,
since it was already fast-forwarded by the time I read this). Two agents
nearly filed false findings from the stale tree within 90 minutes:

- Grepped `src/App.jsx` there, found no `/owner/images` route, nearly
  reported #452 shipped an unreachable screen. **Checked against
  `origin/main`: the route exists**, `src/App.jsx:100`.
- Grepped `image-staging-coordinator.mjs`, found the hardcoded five #450
  removed, nearly reported #450 as a lie. **Checked against `origin/main`:
  no hardcoded five remains.**

**Why it is dangerous:** a stale file is syntactically perfect -- it
compiles, it greps, it reads exactly like the file it claims to be, with
nothing marking it as history rather than the present.

**What was done tonight fixes the night, not the class:** fast-forwarded.
**Fix for the class:** any finding built from the working tree should say
so, and prefer reading the ref directly -- `MSYS_NO_PATHCONV=1 git show
origin/main:<path>`, `git grep <pattern> origin/main` -- one extra word,
and the ambiguity is gone.

## 4. `EXPECTED_CHECKS` arithmetic in `owner-inventory-audit.mjs` is a trap

`EXPECTED_CHECKS = 6` (line 21). Verified: three `ok()` call sites (lines
115, 122, 127), all inside the `for (const viewport of [...])` loop (line
84), which iterates exactly two viewports. `3 x 2 = 6`.

**The invariant:**
```
EXPECTED_CHECKS === (ok() sites inside the viewport loop x 2)
                   + (ok() sites outside it)
```
Adding one check inside the loop moves the constant by **two**, not one.
The file's own failure message -- *"Update it in the same commit as the new
check"* -- says to change the number, not how to compute it, which is what
sends someone to the wrong one.

**Scope note:** this constant covers *only* size-filter checks by design. A
PR adding real coverage elsewhere in the file can correctly leave it at 6 --
an unchanged constant is not by itself evidence of missing coverage.

**Fix:** put the invariant above in a comment beside the constant.

---

## Governance fact

GitHub cannot enforce this repo's review rules. Every agent pushes under one
shared account, so `gh pr review --request-changes` is refused ("Can not
request changes on your own pull request"), and nothing stops a self-merge
technically -- confirmed: `main` has no branch protection rule (`gh api
.../branches/main/protection` → 404). "Do not merge your own PR" is
protocol only, backed by convention and the claims board, not by anything
GitHub refuses on our behalf. A review verdict has to live somewhere durable
-- a PR comment, a `CLAIMS.md` row. This is why the gate itself (tests,
lint, build, audits) matters more than it looks: it's the one thing here
that can't be skipped by choice.
