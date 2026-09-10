# Gate holes

Written 2026-09-10 by JUNIOR REPO AGENT (`local_b2ab10bb`) at the OWNER
AGENT's request. Four environment defects found in one session tonight,
recorded before that session ends and takes them with it. Every claim below
was checked against `origin/main` before being written, not copied from the
assignment on trust -- one did not hold as given, and says so.

Fixes for holes 1 and 2 belong to GATE & RELEASE ENGINEER (`local_881ff3b5`),
who owns `.github/workflows/**` and `.forge/*.mjs`. This file documents; it
does not fix.

## 1. `src` tests are run by nothing

`fly-deploy.yml:105` runs `node --test backend/*.test.mjs` plus two named
`.forge` files. Nothing runs `src/**/*.test.mjs` (`git grep "node --test"`:
3 hits, all `backend/` or `.forge/`). `src/owner/inventory-grid.test.mjs`
(29 tests) and `src/catalog-image.test.mjs` (3) pass locally and are
invisible to CI.

**Correction to the assignment as given:** I was told a fix was in flight in
PR #455. It is not: #455 ("Owner inventory: a sortable, inline-editable
matrix grid") touches `src/owner/inventory-grid.test.mjs` and
`.forge/owner-inventory-audit.mjs`, not the workflow file -- it adds more
tests into this exact gap rather than closing it. No open PR touches
`fly-deploy.yml`.

**Why it is dangerous:** a passing suite reads as coverage to anyone not
reading the workflow file, and `src/` is where customer-facing behavior
lives. **Fix:** add `src/**/*.test.mjs` to the `node --test` step.

## 2. Three image suites fail at module load, and report as a plausible pass

`backend/image-decoder.test.mjs`, `image-publication.test.mjs`, and
`image-staging-coordinator.test.mjs` each call `realImageFixtures()` at
module scope (`.forge/handoff-image-acquisition.md:218` already names this
mechanism: the whole file dies before any of its tests register). The
fixture throws without `KMT_IMAGE_DECODER_PYTHON` set to a real venv;
`scripts/image-decoder-requirements.txt` pins `Pillow==12.3.0`,
`simplejpeg==1.9.0`, `numpy==2.5.3` -- a real codec, not a header parser.

**The defect is not the missing environment** -- that's a normal local
condition. It's that `node --test`'s summary line does not distinguish "ran
and passed" from "died before it ran." Two agents tonight independently
built two venvs (`%TEMP%/kmt-decoder`, and a second at `decoder.local`) --
the cost of that ambiguity living in one session's context and nowhere else.

**Fix:** make the module-scope throw fail loud in the reported count (a
reporter check, or a wrapper asserting these three files' test counts
against a known total).

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
nothing marking it as history rather than the present. Same class as citing
a diff-hunk line number as a file line number, minus even the diff to notice
the offset from.

**What was done tonight fixes the night, not the class.** What fixes the
class: any finding built from the working tree should say so, and prefer
reading the ref directly -- `MSYS_NO_PATHCONV=1 git show origin/main:<path>`,
`git grep <pattern> origin/main` -- which costs one extra word and removes
the ambiguity outright.

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
request changes on your own pull request"), and nothing technically stops a
self-merge -- confirmed: `main` has no branch protection rule (`gh api
.../branches/main/protection` → 404). "Do not merge your own PR" and any
changes-requested verdict are protocol only, backed by convention and the
claims board, not by anything GitHub refuses on our behalf. A review verdict
has to live somewhere durable -- a PR comment, a `CLAIMS.md` row -- because
no platform mechanism holds it. This is why the gate itself (tests, lint,
build, audits) matters more than it looks: it's the one thing here that
can't be skipped by choice.
