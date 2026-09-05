# Resetting forge on KMT

`forge reset` clears the memory a finished plan leaves behind. It deliberately
does not touch the plan, the tasks or the project documents, so the rest of this
runbook is the re-baselining a full reset still needs around it.

Run everything from `C:\Users\anune\code\kmt` unless a step says otherwise.

## What is actually stale (checked 2026-09-05)

| | state | why it matters |
| --- | --- | --- |
| plan | 7/7 milestones, 24/24 tasks `done` | `forge task run` refuses: "Nothing is ready to start." |
| `conversations/intake.json`, `plan.json` | ~139 KB each, from the Phase 2 threads | loaded into context by default, so planning argues with a finished conversation |
| `transcripts/` | 3.1 MB | not read back, only disk |
| `conventions.md` | **missing** | every phase prompt drops its CONVENTIONS section; `forge init` will not recreate it (see step 3) |
| repository | `scraper-catalog-updater` + 3 sibling worktrees | forge writes files and runs shell wherever `--project` points |
| the scraper work | committed, not in `state.json` | intake/plan re-baseline it in step 4 |

## 0. Decide where forge is allowed to write

`implement` has `write_file` and `run_command`. The checkout is not on `main`
and three other agents hold worktrees (`catalog-wiring`, `order-flow`,
`owner-inventory-backend`). Give forge its own branch so its edits do not land
on top of theirs:

```bash
git -C /c/Users/anune/code/kmt worktree add .worktrees/forge -b forge/phase-3
```

Then point every command below at it with `--project .worktrees/forge`, or drop
the flag and accept that forge edits the branch you are standing on. `.forge/`
lives in the repository, so the worktree carries the same project state.

## 1. Clear the phase conversations

```bash
forge reset --project /c/Users/anune/code/kmt
```

Add `--dry-run` first if you want to see what goes; `--phase plan` forgets one
thread instead of all of them. The plan, the tasks and the documents are never
touched by this command, and it prints the task count afterwards to prove it.

The soft alternative is `--fresh`, which clears **only the phase being run**, at
the moment it runs. `forge intake --fresh` does not touch the plan thread.

`task run` neither reads nor writes these files — each phase inside the cycle
starts cold — so `--fresh` on `task run` changes nothing.

## 2. Prune transcripts (optional)

```bash
forge reset --all --project /c/Users/anune/code/kmt
```

Keep them if you still want the Phase 2 audit trail; they cost only disk.

## 3. Restore the missing conventions document

`forge init` on an initialised project returns early and writes nothing, so it
cannot bring back a document that was deleted. Write it by hand:

```bash
cat > /c/Users/anune/code/kmt/.forge/conventions.md <<'MD'
# Conventions

- React + Vite + Tailwind. `npm run dev`, `npm run build`, `npm run lint`.
- Verification scripts live in `.forge/`: `dead-end-audit.mjs` (no click path
  regresses), `responsive-check.mjs` (no overflow at phone or desktop width).
  Run both before calling a UI change sound.
- Shared Tailwind vocabulary is extracted, not re-invented per screen (t17).
- Deployment is part of done, not a follow-up: Vercel, checked on a real phone.
MD
```

`forge status` now warns about a missing document, so it will stop naming
`conventions.md` once the file is back. Confirm:

```bash
forge status --project /c/Users/anune/code/kmt
```

## 4. Re-baseline the documents against reality

Phase 2 finished and work landed afterwards that the plan never described. Let
intake read the repository as it stands now:

```bash
forge intake --fresh --project /c/Users/anune/code/kmt --max-cost 1.00 "Phase 2 is done and the catalog now comes from a real giga-tires.com snapshot. Re-read the repository, then update project.md and requirements.md to describe what exists today and what phase 3 has to be."
```

Read the diff to `project.md` and `requirements.md` before continuing. This is
the step where a wrong answer gets expensive, because everything below plans
against it.

## 5. Plan the next phase

```bash
forge plan --fresh --project /c/Users/anune/code/kmt --max-cost 1.00 "Plan phase 3 as a new milestone with tasks, against the updated requirements. Do not reopen the completed phase 1 and 2 tasks."
```

`plan` cannot touch source — `write_file` is absent from that phase — so the
worst case is a bad roadmap, not a bad repository.

## 6. Look before you spend

```bash
forge status --project /c/Users/anune/code/kmt
```

```bash
forge tasks --project /c/Users/anune/code/kmt
```

If the new tasks are wrong, fix them here by editing `roadmap.md` and re-running
step 5, not by letting `task run` discover it turn by turn.

## 7. Run the cycle

One task, watched, with the guard rails on:

```bash
forge task run --project /c/Users/anune/code/kmt --max-cost 2.00
```

`--max-cost` on `task run` is the budget for the whole cycle — implement,
verify, any retry, and review together — not a cap per phase.

Once a couple of tasks land the way you expect, let it go without prompting on
guarded actions (destructive ones still ask):

```bash
forge task run --project /c/Users/anune/code/kmt --auto-approve --max-cost 3.00 --max-attempts 2
```

`--max-cost` is not optional advice on this project. A six-turn loop on a small
repository cost $0.059; the kmt implement runs in `transcripts/` are far larger.

## 8. Commit the reset

`state.json`, `project.md`, `requirements.md`, `roadmap.md`, `decisions.md` and
`conventions.md` are versioned; conversations, transcripts and shots are not.

```bash
git -C /c/Users/anune/code/kmt add .forge && git -C /c/Users/anune/code/kmt commit -m "Re-baseline the forge plan for phase 3"
```

## The short version

```bash
forge reset --all --project /c/Users/anune/code/kmt && forge status --project /c/Users/anune/code/kmt
```

then `intake --fresh` → `plan --fresh` → `status` → `task run`.
