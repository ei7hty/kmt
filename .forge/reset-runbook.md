# Running forge on KMT

What forge is for here, what state it is actually in, and the commands that do
something useful today. Rewritten 2026-09-05 after the morning's merges and a
round of forge changes; the earlier version described a project that no longer
exists.

## Where things stand

`main` has absorbed everything that was in flight: the scraped catalog and
markup seam, the owner inventory backend, the refined order flow, the owner page
import, and — since this runbook was first written — the phase 3 plan itself and
t25's split of `App.jsx` into `src/routes/`.

That last merge dated the paragraph this replaces. It said the phase 3 plan
lived on `forge/phase-3` and not on `main`; both are now the same thing, the
branch is deleted, and `forge status --project .` on `main` reports the phase 3
plan rather than a finished one.

The point underneath it still holds and is the thing to remember before merging:
`.forge/state.json` is versioned, so **each branch carries its own plan**. Two
branches that both planned work conflict in a JSON file, and resolving that by
hand is worse than deciding up front which branch owns the plan.

Check the claims table in `.forge/AGENTS.md` for what is reserved right now
rather than trusting this file.

## Give forge its own worktree

Forge writes files and runs commands wherever `--project` points, and other
agents hold worktrees off this repository. It already has one:

```bash
git -C C:/Users/anune/code/kmt worktree list
```

`.worktrees/forge` exists for this. Run everything there — check what branch it
is on before you start, since `forge/phase-3` has been merged and deleted. A
fresh worktree also starts forge with no memory at all, because `conversations/` and
`transcripts/` are git-ignored and so are not in the checkout — `forge reset` is
only needed when you are working in a checkout that already has them.

Run `npm install` in the worktree once, or verification fails on a missing
`node_modules` and burns a cycle discovering it.

## Before a run

```bash
forge doctor --project C:/Users/anune/code/kmt/.worktrees/forge
```

Checks the setup — documents present, documents small enough to fit in a prompt,
a key, a readable `.env` — and then reads the last ten transcripts back, which
is the only way to see that a previous run explored for twenty turns and wrote
nothing. Exit code 1 means something is wrong, 0 means at most a note.

## Running the plan

One task, watched, with the guard rails on:

```bash
forge work --project C:/Users/anune/code/kmt/.worktrees/forge --max-tasks 1 --max-cost 6 --checkpoint
```

- `--max-cost` is the budget for the whole cycle, not per phase, and 40% of it
  is held back so verification can still run after implementation has spent
  what it wants.
- `--checkpoint` commits each verified task and writes the sha onto the task. It
  only stages paths that task changed, so anything already dirty in the tree
  stays out of the commit.
- `--unattended` refuses destructive actions rather than asking a human who is
  not there, and reports every refusal on the task afterwards. Use it when you
  are not watching; leave it off when you are.
- `--milestone m8` confines a run to phase 3.

`forge work` stops for one of five reasons and says which: nothing ready, the
task limit, the budget, a task that did not pass, or no progress — that last one
meaning a task reported success and the plan did not move.

## What a task costs here

Measured across 16 real runs on this project:

| phase | median | max |
| --- | --- | --- |
| implement | $1.01 | $1.98 |
| verify | $2.60 | $3.81 |

Verification is the expensive phase on this project, because verifying it means
driving a browser through every click path rather than reading a diff. Budget
about $4-6 for one task, and do not leave `--max-cost` off.

## When the threads go stale

Forge remembers a conversation per phase between runs. When a phase is finished
with — a plan that is now written, an intake that is answered — the next run
continues a thread that has ended:

```bash
forge reset --project <path>            # every phase
forge reset --phase plan --project <path>
forge reset --all --dry-run --project <path>
```

It never touches the plan, the tasks or the project documents, and prints the
task count afterwards to prove it.

## Phase 3, if you are starting there

`m8` is *customer quotes are priced from the owner's real inventory, not the
static demo catalog* — the gap the backend work deliberately stopped short of.
Four tasks: split `App.jsx` per route, add a customer-safe `/api/catalog`
endpoint, wire the customer flow to it with a fallback, then verify both
environments. `roadmap.md` records four questions that were left for Ken rather
than guessed into tasks.
