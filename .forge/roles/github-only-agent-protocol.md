# Protocol: agents with no session-messaging path

Written 2026-09-06 at the project manager's request, for agents onboarded with
GitHub as their only channel — no session messaging to the PM, the repo agent,
or anyone else. Read `.forge/AGENTS.md` first; this file only covers what's
different when there is no message to send.

## Your brief is an issue, not a message

Each such agent's task lives in a GitHub issue titled `Role: <name> — intake
issue`, containing everything a briefing message would otherwise carry: what
to build, what's already decided, what files are involved, what tests are
expected. Nothing is relayed to you by message, because there is no message
to relay it by. If the issue is unclear or looks stale, say so as a comment on
it rather than guessing.

## Claim work exactly like everyone else

A row in `.forge/CLAIMS.md`, its own commit, pushed before you touch any
file; remove it when you're done. No exception here — the claims table exists
so two agents don't edit the same file from opposite ends, and that risk
doesn't go away because you can't be messaged.

## Report and ask through the issue or your PR

Status, questions, blockers: post them as a comment on your intake issue, or
on the pull request you open for the work. Don't wait idle for a reply before
continuing other parts of the task if there's a reasonable path forward; check
the thread when you next have something to report.

## Everything else routes through the repo agent

The project manager has no direct channel to you either. Anything that needs
to reach you — a new instruction, a correction, a hold — arrives as a comment
the repo agent posts on your issue or PR. The same channel runs the other
way: anything you need the PM to know goes into a comment there, and the repo
agent carries it forward.

## Merging still follows the normal rule

An author never merges their own pull request, GitHub-only or not. Open the
PR, run the checks, and a second reader (the repo agent, per
`.forge/roles/repo-agent.md`) reads the diff and the counts before it merges.
