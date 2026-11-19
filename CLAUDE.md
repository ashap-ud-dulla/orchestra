# Orchestra — personal tool

Personal tool. Never write to Teamspace: Orchestra only reads it, only through the ITP pack (`orch mine`, the
`intake` step), with ITP's own `registry_call GET`. Never touch ITPKV. In this repo's own sessions, never call
Teamspace yourself (tests fake it).
**The core knows nothing of ITP**: `lib/`, `bin/`, `skills/`, `defaults/` hold mechanisms only; everything ITP
(Teamspace, work orders, the vault, the ITP app, epics, ITP keys) lives in `packs/itp`. Nothing is ever pushed to
the ITP repo for Orchestra.
Never edit the itp-workspace repo or anything under `.claude/users/`.

Orchestra only touches ITP in four ways (all through `packs/itp`):
1. Reads the skill list from `<ITP>/.claude/skills` (and your user skills folder).
2. Creates git worktrees of ITP repos for runs (build step 4).
3. Runs do their own work inside those worktrees. This includes starting the app from their workspace
   (`bin/app.mjs` passes it to `packs/itp/app/app.mjs`; called by the `app-test` step). Usually each run's own app,
   its **slot** (`packs/itp/app/slots.mjs`): a stack of ITP's `itp-stacks` skill (Orchestra only calls its
   `stacks.ps1`) on a Docker Mongo copied from a "master" copy of the user's Local DB; `stacks=N` run at once (0 = off),
   kept stopped between steps, deleted at clean-up (`pack.app.ownCopies`/`dropFor`). The one shared app (the user's
   main stack, Global DB tests) goes one run at a time, in line. It stops only an app Orchestra started; the user's own
   app is stopped only after they say ok (`--force`).
4. Reads the Work Orders you hold (`orch mine`: `GET /api/me`, `GET /api/members/<id>/working-on` through ITP's
   own `registry_call`).

- Node 22, no npm packages. Terminal only: no server, no web page. Windows only (Windows Terminal, PowerShell).
- **Any Windows PC**: no path, email or data of one PC in the code. `orch setup solution=<folder>` saves this PC's solution
  folder and email (from git) in `data/settings.json`; `data/` is not in git (`defaults/` holds the starter templates).
  Tests make their own ITP folder and never read this PC's.
- **Core + packs**: the core knows no solution. `packs/<name>/pack.mjs` adds one (repos, run rules, MCP lists,
  vault folders, tracking, the app) plus its `skills/`, `templates/` and its part of `/orch` (`orch.md`). ITP is
  `packs/itp`. The active pack: `ORCHESTRA_PACK`, else settings `pack` (setup saves it), else detected from the
  solution folder. No pack: repos are found in the folder (the folder itself or its child repos), no app, no
  tracking; the core starter skills (`orch-plan`, `orch-build`, `orch-review`, `wrap-up`, `orch-hello`) and
  templates (`defaults/templates`). A test (`core: no ITP word…`) fails when an ITP word shows up in lib/, bin/,
  skills/ or defaults/. Pack fields: `lib/pack.mjs` (NONE lists each with its default).
  `orch setup [solution=<folder>|none]`: the folder is optional. Tests run with `ORCHESTRA_PACK=itp`.
- **Skills live in the repo** (`skills/`, with `{{ORCHESTRA}}` / `{{SOLUTION}}` placeholders). `orch setup` installs them
  into `~/.claude/skills` with the paths filled in: edit `skills/`, then run `orch setup`, never the installed copies.
  Agents the same way: `agents/*.md` and `packs/<name>/agents/*.md` go into `~/.claude/agents` (`config.homeAgentsDir`;
  one list of what setup wrote, `.orchestra-installed.json`, so a hand edit is kept as `.bak-<date>` and only
  Orchestra's own agents are ever removed). A test that sets `ORCHESTRA_HOME_SKILLS` gets the agents beside it.
- `/orch` (installed from `skills/orch`) is the front door: a menu plus shortcuts. It only calls
  `node bin/orch.mjs <command>` (`orch help` lists them; every command, its options and its help line live in one list, `lib/cli/spec.mjs`;
  options are `key=value`, old `--flags` still work; in a run tab `/orch <word>` is always handled by the hook). Each run is an interactive `claude` in its own Windows
  Terminal tab (`bin/launch.mjs`), driven by Claude hooks (`bin/hook.mjs`). A step may name its model and effort;
  when the next step wants others, the launcher restarts claude in the same tab on the same conversation
  (`runs/<id>/restart.ok`), because no hook can switch a running claude's model. A `fresh` step starts a new
  conversation there instead (a handoff prompt tells it the earlier steps); clean-up forgets every conversation.
  Cost: claude reports a conversation's running total (a resumed one goes on from its saved total), so the run's
  cost is `costPast` (conversations that are over) + that total.
- State is plain files (`data/`, `runs/<id>/state.json`), shared by many short processes under one lock
  (`lib/lock.mjs`). Files say "step" (version 2); older files ("box", `orchestra-*` skill names) are upgraded when read
  (`lib/upgrade.mjs`). Chat and Claude's last replies sit next to the run file (`chat.jsonl`, `replies.json`). A
  cleaned run moves to `runs/archive/<id>` (`runDir` finds it there; hooks never load the archive).
- Speed: the tool-call and status-line hooks are answered from the run file with no lock (`lib/hook-fast.mjs`) unless
  the run must change. Commands that only show things (and `start`) never do slow work: queued runs start in their own
  process each (`orch tick <id>`, the run's "starter"), so workspaces build side by side. A hook starts at most one
  pending `orch tick` (`runs/.tick-pending`).
- `go` (also back, jump): moves a run to any step on its own steps (no copies). Back resets that step and the ones
  after it to pending, keeping each one's earlier results in `step.tries`; forward marks the steps between `skipped`
  (status; `PASSED` = done or skipped in `lib/run/steps.mjs`) and tells the step (`jumpedOver`, `why`).
- One `/orch` + plain words. `orch start <keys…>` with no template makes runs whose only step is `intake` ("Pick the
  task and the steps"; the ITP pack's reads Teamspace Work Orders, read only): it reads the task into
  `.orchestra/task.md`, takes a template as the run's **guide** (`orch use this <template> guide=yes`: `run.guide`, no
  steps go in; cost/time from `orch stats`, overlap with other runs) and asks for the first step (`this` = the tab's
  run, checked by its token; these and read-only commands are pre-allowed in run sessions, `RUN_ORCH`). It ends with
  `ORCHESTRA:TASK <KEY> | title` (`run.task`; `ticketKey` prefers it) and `ORCHESTRA:PLAN suggested | chosen`
  (`run.plan`, lesson material). `/orch` itself never calls Teamspace.
- **Steps picked one at a time** (a run with `run.guide`): when a step's work is done, its Claude asks the next step with
  AskUserQuestion *before* DONE (`pickRule` in `lib/run/prompts.mjs`: open items first, then the guide's usual next,
  others, Done), adds the click with `orch steps this add <guide step|skill>` (a guide step keeps its settings, no wait
  gate: the pick is the gate), then DONE moves into it; nothing added, DONE ends the run. A claude started before the
  guide gets the rule in the step instruction (`pickText`). The pane shows the guide's `likelyNext` grey and, while a
  pin shows, always folds the steps so the pin keeps the room. Wrap up offers to save the picked steps as a template
  (`template from this <id> [replace=yes]`). Runs with a full step list (a named template) work as before.
- Main branch: every push asks (the guard's Allow prompt), a push to `main` and switching to it too; a run
  works on main only when the user asked (`mainRule`). The one refusal: the pack's main folders (`mainOkDirs`,
  `wrapUpPushDirs`) push only in Wrap up, and its own folder takes commits only there (`lib/git-hooks`).
- Heavy steps: every run opens its tab at once; only heavy steps (`step.heavy`, or the skill marked heavy in
  `data/heavy-marks.json`, `isHeavy`) wait for one of `maxRunning` slots (`slotNext`, `startSlotWaiters`, like the app
  queue).
- Plain words in a run tab: the run's Claude ends its reply with `ORCHESTRA:DO <command>` (what follows `/orch`);
  the Stop hook runs it as if typed (`doAsked`).
- Clicks, not typing: a failed step gets one more turn to ask Run again · Skip · Go to another step (`failAsk`); a
  reopened tab asks Go on · Start again · Hold (`reopenPrompt` as the launch prompt); `redo` while the app or every
  slot is taken goes in line and starts by itself (as `go`). `/orch hold [why]` parks a run: a working step goes back
  to pending (its try kept), the app and the slot are freed (`pack.app.stopFor` when it had the app), `run.hold`;
  next or a reopen goes on. The pick's "Put the run on hold" is `ORCHESTRA:DO hold` before DONE (the step ends, then the run parks).
- Honest costs: a resumed claude whose total goes down (it counts from 0 again) moves what it said to `costPast`
  (`sessionRaw`), so the run's cost never drops and steps add up to it (the rest: "Between steps"). Go back starts a
  step at $0 (the old cost stays in `tries`). `step.youMs` is the time a step waited for you (`youSince`,
  `youBack`); stats show AI time without it. A guided run's Likely next shows each step's usual cost and AI time.
- App queue: a step that needs the app while another run has it never blocks a hook: the run waits (`appNext`), its
  tab stays free, its slot is freed, and once the app is free its idle claude is restarted on the same conversation
  with the step (`startAppWaiters`, via `restart.ok`). Notifications only for an Allow prompt, a question, a next
  gate, a failure. Slow work (worktrees, waiting for the app, lessons) runs with the lock let go (`Runner.outside`).
- New skills: `orch skills new` lists the solution's skills (not ~/.claude/skills) since you last looked
  (`data/skills-seen.json`; the first look counts skills under 30 days old as new); `orch skills seen [names]` marks
  them. `intake` weighs the new ones for its task (descriptions first) and `/orch` says them in one line.
- Tabs open one at a time (`bin/open-tab.mjs`, the `runs/.tab-lock` folder): a tab is "new-tab ; split-pane", and wt
  splits the tab in focus, so two at once put one run's steps pane in another run's tab.
- Processes a run leaves: helpers claude starts can lose their parent and need not name the run folder. The launcher
  writes claude's tree down (`runs/<id>/procs.json`, pid + start time; `recordTree` in `lib/app.mjs`) soon after
  each start, every 2 minutes and before a restart; clean and delete stop what of it still runs (`stopRunProcesses`),
  and a folder that stays busy is retried for 15 s, then refused with a plain error (the same command again finishes).
- Clean-up happens only when the user says so: it stops what runs from the run folder, removes the folder, prunes
  git's worktree records and removes the run's Claude conversation files. Branches, notes and stats stay.
  The usual way is the last template step `wrap-up` (personal skill), in the run's own tab: the user picks
  the jobs (ITP: push the vault, close the epic, commit + push the run's own `Execution/` files) and clean or keep;
  with clean, closing the tab cleans up. Only while that step works (flag `runs/<id>/wrap-up.ok`) may the folders
  the pack names (`mainOkDirs`, `wrapUpPushDirs` → env `ORCHESTRA_MAIN_OK`, `ORCHESTRA_WRAPUP_DIRS`) push to `main`,
  after the user's Allow; there only the files `wrapUpCommitOnly` names may be committed (ITP: `Execution/`). This is
  the one exception to "never edit the itp-workspace repo". `orch clean` cleans runs without the step.
- Code layout: `lib/runner.mjs` is the run state machine (hooks, steps moving on); its other jobs are part classes in
  `lib/run/` (session, tab-commands, app-queue, cleanup, lessons) whose methods become Runner's own, plus helpers
  (steps, prompts, pins, ship). `bin/orch.mjs` only dispatches: commands live in `lib/cli/` (runs, templates,
  lessons, more), text in `lib/format.mjs`, the steps pane in `lib/pane.mjs`. Shared: `lib/util.mjs` (small
  helpers), `lib/limits.mjs` (timings and caps), `lib/model.mjs` (model and effort words).
- `node test/smoke.mjs` runs the tests with a fake `claude` (no tokens spent); `node test/smoke.mjs <words>` runs
  only the tests whose name has one of the words.
- Plans: `~/.claude/plans/orchestra-rebuild.md` (the 9-phase rebuild, done 2026-11-08: safety, split files, state v2,
  speed, app queue, /orch, core + packs, generic setup, docs). Older: `you-know-my-workflow-floofy-lemon.md` (the build).
