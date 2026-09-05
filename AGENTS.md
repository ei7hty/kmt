# Agents: read `.forge/AGENTS.md` first

Several agents share this repository and cannot message each other. The
protocol for claiming work, staying out of each other's commits, which files
belong to which lane, and what has to pass before anything is done lives in
[`.forge/AGENTS.md`](.forge/AGENTS.md). Read it top to bottom, then
`.forge/project.md`, `.forge/requirements.md` and `.forge/state.json`.

The short version, because it has already cost real work here:

- Never `git add -A` or `git add .`. Stage explicit paths; commit only files
  you changed.
- Check `git branch --show-current` before committing. Do not assume `main`.
- Need another branch while someone else is editing? `git worktree add`, not
  `git switch`.
- Nothing is done until the tests, lint, build and browser audits in
  `README.md` pass. Run them; do not assume them.

`README.md` explains what the project is and how to run it.
