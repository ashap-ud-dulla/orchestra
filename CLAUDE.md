# Orchestra — personal tool

Personal tool. Never call Teamspace. Never touch ITPKV.
Never edit the itp-workspace repo or anything under `.claude/users/`.

Orchestra only touches ITP in three ways:
1. Reads the skill list from `<ITP>/.claude/skills` (and your user skills folder).
2. Creates git worktrees of ITP repos for runs (build step 4).
3. Runs do their own work inside those worktrees. This includes starting the app from their workspace
   (`bin/app.mjs`, called by the `orchestra-app-test` step): one run at a time, in line. It stops only an app
   Orchestra started; the user's own app is stopped only after they say ok (`--force`).

- Node 22, no npm packages. Terminal only: no server, no web page. Windows only (Windows Terminal, PowerShell).
- **Any Windows PC**: no path, email or data of one PC in the code. `orch setup --itp <folder>` saves this PC's ITP
  folder and email (from git) in `data/settings.json`; `data/` is not in git (`defaults/` holds the starter templates).
  Tests make their own ITP folder and never read this PC's.
- **Skills live in the repo** (`skills/`, with `{{ORCHESTRA}}` / `{{ITP}}` placeholders). `orch setup` installs them
  into `~/.claude/skills` with the paths filled in: edit `skills/`, then run `orch setup`, never the installed copies.
- `/orchestra` (installed from `skills/orchestra`) is the front door: a menu plus shortcuts. It only calls
  `node bin/orch.mjs <command>` (`orch help` lists them). Each run is an interactive `claude` in its own Windows
  Terminal tab (`bin/launch.mjs`), driven by Claude hooks (`bin/hook.mjs`). A step may name its model and effort;
  when the next step wants others, the launcher restarts claude in the same tab on the same conversation
  (`runs/<id>/restart.ok`), because no hook can switch a running claude's model. A `fresh` step starts a new
  conversation there instead (a handoff prompt tells it the earlier steps); clean-up forgets every conversation.
  Cost: claude reports a conversation's running total (a resumed one goes on from its saved total), so the run's
  cost is `costPast` (conversations that are over) + that total.
- State is plain files (`data/`, `runs/<id>/state.json`), shared by many short processes under one lock
  (`lib/lock.mjs`). Slow work (worktrees, waiting for the app, lessons) runs with the lock let go (`Runner.outside`).
- Clean-up happens only when the user says so: it stops what runs from the run folder, removes the folder, prunes
  git's worktree records and removes the run's Claude conversation files. Branches, notes and stats stay.
  The usual way is the last template step `orchestra-wrap-up` (personal skill), in the run's own tab: the user picks
  the jobs (push the vault, close the epic, commit + push the run's own `ITP/Execution/` files) and clean or keep; with
  clean, closing the tab cleans up. Only while that step works (flag `runs/<id>/wrap-up.ok`) may the vault and the ITP
  folder push to `main`, after the user's Allow; in the ITP folder only `Execution/` files may be committed. This is
  the one exception to "never edit the itp-workspace repo". `orch clean` cleans runs without the step.
- `node test/smoke.mjs` runs the tests with a fake `claude` (no tokens spent).
- Plans: `~/.claude/plans/you-know-my-workflow-floofy-lemon.md` (the 8 build steps),
  `~/.claude/plans/joyful-doodling-allen.md` (now: the "Test in the app" step and the app queue).
