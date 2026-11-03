# Orchestra

Runs ITP Jira tickets as Claude Code "runs": each run gets its own Windows Terminal tab, its own git worktrees, and a
template of steps (grill, plan, build, test in the app, wrap up). You talk to it through `/orchestra` in Claude Code.

## Set up on a new PC

Needs: Windows, [Node 22+](https://nodejs.org), Git, Windows Terminal (`wt`), Claude Code (`claude`), and an ITP
workspace folder (the one with `.claude/skills`, `ITP-API`, `ITP-WebClient`).

1. Clone this repo anywhere.
2. Run, with your own ITP folder:

   ```
   node bin/orch.mjs setup --itp C:/path/to/your/ITP
   ```

   It saves the ITP folder and your email (from `git config user.email`), copies the starter templates, installs
   Orchestra's skills into `~/.claude/skills`, and names any missing tool.
3. In Claude Code, type `/orchestra`.

After a `git pull`, run `node bin/orch.mjs setup` again: it refreshes the installed skills.

## What stays on your PC

`data/` (your settings, rules, lessons, templates) and `runs/` are not in git. Starter files live in `defaults/`.

## Tests

`node test/smoke.mjs` runs every test with a fake `claude` (no tokens spent, no real ITP folder needed).
