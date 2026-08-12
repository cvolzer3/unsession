# Agent conventions

Multiple AI agent sessions (Claude, Codex) may work in this repo at the same
time, all directly on `main` — main is the single source of truth and must not
diverge. These rules keep concurrent work safe and commit history groupable.
(Ported from the mmasim project's working conventions.)

## Ship from main

- Default workflow is trunk-based: commit directly to `main`, push to `main`.
  Don't open a feature branch unless explicitly asked.
- Commit ≠ push ≠ deploy. Pushing to main is the normal end of a finished
  task; deploying is not — don't deploy unless asked.

## Commit your own finished work

- When your task is complete, commit it yourself with a descriptive message.
  Never end a session leaving finished work uncommitted — the feature boundary
  is only known for free at the moment you finish.
- Scope the commit to the files your task touched:
  `git commit -m "..." -- <paths>`. The git index is shared with other agents
  running in the same checkout; pathspec-scoped commits keep their files out of
  your commit.
- Re-check `git status` immediately before staging and leave unexpected files
  alone — another session owns them.
- One feature per commit, short imperative subject (match `git log` style).
- If a file needs edits for two different tasks, commit the first before
  starting the second — interleaved same-file edits can't be untangled later.
- Before committing, run `git log --stat -3` — a concurrent session may have
  already swept your files into its commit.

## Keep features groupable

- Name migrations (and similar per-feature files) after their feature.
- Use one consistent vocabulary per feature across all layers — shared names
  are how a change reads as one feature.

## Worktrees for major lines of work

- Use an ephemeral git worktree (under `.claude/worktrees/<task-name>`) for
  work that will hold many files in a half-edited state, is risky/large, or
  would conflict with other in-flight sessions.
- Merge back to `main` and push as soon as the task lands — a divergence
  window of minutes-to-hours, not days. Never leave work stranded on a side
  branch.
- Don't delete worktrees you didn't create — they may belong to a parallel
  session. When checking for stranded work, diff their files against main.
- Gotchas: the Bash shell cwd persists, so a `cd` into a worktree makes later
  relative-path commands silently run against its stale checkout. A deploy run
  from a worktree can ship a stale or detached-HEAD checkout — always redeploy
  from up-to-date main afterward.
