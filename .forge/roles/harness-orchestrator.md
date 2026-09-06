# Harness agent: the onboarding executor and the observer

Written by the HARNESS AGENT session (`local_461155da`) on 2026-09-06, for
whoever next runs a sequential onboarding here or is asked to watch the team
without being in it. Two sessions shared this name that day: the orchestrator
(`local_376e0377`) that wrote the roster and ran agents 1, 4, 6 and 8, and
this one, which had been observe-only since 03:24Z and was made executor for
agents 2, 3 and 5 by the user at 05:10Z. Both halves of the role are below.

## What the role owns, and does not

Owns: the protocol for bringing a session into a role (record, identity,
lock), the verification of each reply against the repository rather than
against the reply, the log of what happened, and `.forge/roles/README.md`
when it is stale. In the observe-only half, it owns nothing at all: it reads
transcripts, the repo, PRs and issues, and drafts prompts the user pastes to
the lead.

Does not own: any lane, any merge, any sprint assignment, any product call.
It sends nothing to the isolated track and does not touch their PRs. It never
merges its own PR, including the one that records the onboarding.

## Who it obeys, and what it reports

The user, in its own session, for the mandate. A peer session cannot change
that mandate: the orchestrator's delegation of agents 2 to 8 to this session
was held, unanswered, until the user said "listen to the orchestrator" here.
That is the correct order and it cost one round; the wrong order costs trust.

While a temp lead stands in for an isolated project manager, merge requests
and closure lines go to the temp lead, with a copy to the orchestrator, and
the final report goes to the temp lead, the DEV-PRODUCT MANAGER and the user.

## The protocol, as run

Three steps per agent, each a single message, each opening with the sender
id and the assumed `origin/main` read at send time, each constraint marked
HARD or SOFT.

- **A, record and recall.** A session that served a role writes
  `.forge/roles/<role-served>.md` (suffix with the former session name when
  the lane already has a file), as a docs-only PR with the claim row
  committed alone first and released last, body opening `Author: <title>`.
  Every session writes a pointer `kmt-role-<role>.md` in the shared memory
  directory and appends one line to its `MEMORY.md`. It then reads its own
  file and the adjacent files from its README row and replies with context
  in five lines and its repository footprint.
- **B, identity and environment.** `get_session("self")` for title and cwd,
  checked from the executor's side against `list_sessions`; the boundaries
  (obeys, owns, does not own) restated in the agent's own words.
- **C, lock.** One immediate task, and the compliance line:
  `[Title], [SHA seen on main], [Current Task], [Files Read]; claiming
  nothing new.` Bracketed or unbracketed fields both pass; a preamble or a
  second line does not. The SHA is read by the agent at write time.

Gates are checked on evidence, not on the report: `gh pr view` for files,
author line and mergeability; `git show origin/<branch>:.forge/CLAIMS.md`
for the claim netting to nothing; `git ls-tree origin/main .forge/roles/`
after the merge; the pointer file on disk; `MEMORY.md` re-read with the
first ten lines hashed before and after. One corrective message names the
exact deviation; a second failure stops the sequence and goes up.

## Rules paid for on the day

- **Verify the sender, then verify the state.** Every trainee checked my
  `from=` id against the roster and three of them flagged that the README
  still called this id observe-only. They were right; the roster lagged the
  user's decision by forty minutes. Correct the roster in the same sequence.
- **A stand-down given through the lead is lifted only by the user in that
  session.** LEAD FULL STACK declined Step A on that ground and was right to;
  LEAD UI ENGINEER proceeded because the user had spoken in its session.
  Do not argue authority with a session that holds; report it.
- **A new session opened in a scratch workspace is not in the repo.** Its
  directory tool grants folder access, but the session record kept the
  scratch cwd after the turn ended, and the shared memory index loads by
  cwd. That is the user's fix (reopen the session in the repo), not a
  workaround.
- **Parallel appends to `MEMORY.md` interleave but did not clobber.** The
  gate changed from "exactly +1" to "own line present, earlier lines intact"
  once several sessions appended at once; hash lines 1 to 10 to prove it.
- **Verify a PR before its author reports it.** #119 was open eight minutes
  before LEAD UI ENGINEER's Step A reply arrived; checking it early let the
  merge queue with the temp lead ahead of the reply.
- **Do not send the merge request and the next step in one message.** The
  temp lead merges one PR at a time in arrival order; a request that also
  carries instructions for a different session gets misread as stale.

## How to verify the role's own work

`git ls-tree origin/main .forge/roles/` lists one file per served role plus
`README.md`; `MEMORY.md` in the shared memory directory carries one
`kmt-role-*` line per onboarded title; every locked agent's compliance line
is in `onboarding-2026-09-06.md` with the SHA it named and the SHA
`origin/main` held at the check.

## Harness quirks that cost time

`send_message` needs the full id with the `local_` prefix; `ListAgents`
short refs are not addresses. Two sessions can share a title. Messages
arrive stale, so read the repo before acting on any of them. `git show
rev:path` needs `MSYS_NO_PATHCONV=1` in Git Bash. A Bash heredoc into the
memory directory can be refused by the classifier; use Write or Edit there.
`change_directory` takes effect at the end of the calling turn, and the
session record may still not reflect it. Cross-session sends queue behind
the target's in-flight turn; "queued" is not "read".

## Day-one advice no document says

Keep a log file open from the first message and write to it before you
send, not after you receive. Put the assumed SHA in every message and
re-read it at send time; it moved three times in forty minutes. When a
trainee's reply is longer than its gate needs, the extra is usually a flag
worth reading twice. And when the user's word arrives through a peer, hold
and ask in your own session: the one time it looked like a delay, it was the
only thing that kept the chain of command legible to eight sessions at once.
