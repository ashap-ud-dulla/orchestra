# Flow — personal tool

Personal tool. Never call Teamspace. Never touch ITPKV.
Never edit the itp-workspace repo or anything under `.claude/users/`.

Flow only touches ITP in three ways:
1. Reads the skill list from `<ITP>/.claude/skills` (and your user skills folder).
2. Creates git worktrees of ITP repos for runs (build step 4).
3. Runs do their own work inside those worktrees.

- Node 22, no npm packages.
- `node server.mjs` starts the server on http://localhost:7077.
- `node test/smoke.mjs` runs the tests with a fake `claude` (no tokens spent).
- Plan: `~/.claude/plans/you-know-my-workflow-floofy-lemon.md`.
