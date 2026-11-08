---
name: orchestra
description: Orchestra, the user's personal workflow runner, from the terminal. Start Jira tickets as runs (one terminal tab each), see the runs board, build templates from skills, find skills, lessons, stats and settings. Use when the user types /orchestra (with or without words after it) or asks to start tickets with a template, see their runs, reopen runs, or build a workflow template.
argument-hint: "[start <template> <tickets…> | runs | run <ticket> | reopen all | templates | template new | skills <words> | learn | stats | settings]"
allowed-tools: Bash(node {{ORCHESTRA}}/bin/orch.mjs *), AskUserQuestion, mcp__claude_ai_Atlassian__getAccessibleAtlassianResources, mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql
---

# /orchestra

Orchestra lives in `{{ORCHESTRA}}`. There is no server and no web page: everything goes
through one command, run with the **Bash** tool:

```
node {{ORCHESTRA}}/bin/orch.mjs <command> [args]
```

Below, `orch <command>` means that full line. `orch help` lists every command.

## Rules

- Do all Orchestra work through `orch`. Never edit files under `orchestra/runs` or `orchestra/data` by hand, and never
  start `claude` yourself: `orch start` / `orch reopen` open the run tabs.
- Never call Teamspace and never touch ITPKV from here. The runs do their own work in their own tabs.
- Show `orch` output as it comes (tables in a code block). Then add one or two plain, short sentences: what it means and
  what the user can do next. Simple words, short sentences.
- Ask with **AskUserQuestion** (at most 4 options; the user can always type something else). Do not ask what the
  user already said.
- If `orch` prints `Error: …`, say it plainly, and suggest the fix it names.
- **First time on a PC**: `Error: Orchestra does not know your ITP folder yet`. Ask the user for their ITP workspace
  folder (the one with `.claude/skills`, `ITP-API`, `ITP-WebClient`), then run `orch setup --itp <folder>` and show
  what it prints (missing tools included). After a `git pull` of Orchestra, `orch setup` again refreshes the skills.
- Each run opens its own tab in the **"orchestra"** Windows Terminal window (Alt+Tab). The user talks to the run there:
  `next` to go on (after a "wait for me" step, or with a step that was cut off), `redo` to run a step again,
  `skip` to move past an unfinished step on purpose, `/orchestra model opus effort high` (or
  `/orchestra effort max`, `/orchestra model` to show) to switch the model of the step it is on: Orchestra catches it
  before this skill loads, and claude restarts in the same tab, on the same conversation, going on where it was (no redo).
  **Go back** to a finished step (a code review found problems, say): `/orchestra back build fix the review findings`
  (also `/orchestra from 5 …`; the step by number or name, then why). Copies of that step and the steps after it go
  in as new steps ("Build (2)", …), the old ones stay as history, and the first copy starts at once, told why and
  what the later steps found. The tab is split: the pane on the right shows the
  run's steps live (done / working now / to come). To see them in another terminal: `orch watch <ticket>` (Ctrl+C ends it).
- **Pins**: below the steps, the pane keeps instructions the user follows by hand (test steps, values to pick), so
  they stay in sight while the user chats. The run's Claude pins steps by itself (an `ORCHESTRA:PIN` block). In the
  run's tab the user types `pin` (Claude's last answer), `pin 2` (the one before), `pin: a note`, `unpin`
  (the pin shown), `unpin 2`, `unpin all`. Click the pane: ↑ ↓ PgUp PgDn / mouse wheel scroll, ← → other pins,
  drag selects text. From here: `orch pin <ticket>` (shows the pins in full), `orch pin <ticket> "text"
  [--title "…"]`, `orch unpin <ticket> [N|all]`.

## No words after /orchestra: the menu

1. Run `orch status` and show it. If it has a "Left alone 7+ days" or "Finished, folder still there" line, offer
   **Clean up** once in a short sentence (see **Clean up**); never clean without a yes.
2. Ask "What do you want to do?" with these 4 options:
   - **Start run(s)**: one or more tickets with a template
   - **My runs**: the board, open a run, reopen, stop, clean up and free space
   - **Templates & skills**: build or change a template, find skills
   - **More**: lessons, stats, settings
3. Go on with the matching section below.

## Words after /orchestra: shortcuts

Match what the user typed and skip the menu:

| They typed | Do |
|---|---|
| `start …`, or ticket keys / Jira links | **Start run(s)**, with what they gave |
| `runs`, `board` | `orch runs` |
| `run <ticket or words>` | `orch run <ticket or words>` (a run is found by its Jira key, words from its name, or its id end) |
| `reopen all`, `reopen <ticket>` | `orch reopen …` |
| `stop / delete <ticket>` | the same `orch` command (ask before `delete`) |
| `clean …`, `disk`, "free space" | **Clean up** |
| `templates`, `template …` | **Templates & skills** |
| `skills <words>` | `orch skills <words>` |
| `learn`, `lessons` | **Lessons** |
| `stats` | `orch stats` |
| `back <ticket> <step> …`, "go back to build", "start again from step 5" | `orch back <ticket> <step> [why]`, then tell them to type `next` in its tab (or, quicker, `/orchestra back <step> why` in the tab itself: it starts at once). No ticket: ask which run. |
| `model <ticket> …`, "use opus for this step" | `orch model <ticket> <model> [effort]` (see **Templates & skills**). No ticket: ask which run (`orch runs`). |
| `app`, "start / stop / restart the app", "app logs" | **The app for you** |
| `settings …` | `orch settings …` |
| anything else | read it as a plain request and pick the closest section |

## Start run(s)

1. **Template.** If they did not name one: run `orch templates` and ask which one (up to 4 as options).
2. **Tickets or jobs.** If they gave none, offer their open Jira tickets (below). They can also type keys, links,
   or a job in plain words instead. Each ticket or job makes one run.
   - A job with no ticket: quote it, one quoted text per run: `orch start <template> "Add a Sweden row" "Fix the legend"`
     (or `--text "the job"` for one). Its tab is named after its first words; find it later by words (`orch run sweden`).
   - A text that only mentions a ticket ("same fix as ITP2-1, but for Sweden") is a job, not that ticket.
3. **Check, then start.** Show `orch template show <template>` (the steps), say which repos it uses, and ask
   "Start N run(s)?" with options **Start** · **Change the steps first** · **Cancel**.
   - **Start**: `orch start <template> <ticket> <ticket> …` (add `--repos …` or `--base repo=branch` only if they asked).
   - **Change the steps first**: `orch start … --draft`, then edit with `orch steps <run> --set '<json list>'`
     (keep finished steps first), then `orch reopen <run>` to start it.
4. Tickets picked from Jira: set each run's About line from its Jira title right away:
   `orch about <key> "<title>"`.
5. Show the result. Tell them the tabs open in the "orchestra" window, and how many work at once (the rest wait).

### Your open Jira tickets

Read only: never change a ticket from here.
1. `searchJiraIssuesUsingJql` with cloudId `orbitax.atlassian.net`, jql
   `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, maxResults 50, fields
   `summary,status,issuetype`, responseContentFormat `markdown`. (If the cloudId is refused, get it once with
   `getAccessibleAtlassianResources`.)
2. Run `orch runs --all --json` and mark the tickets that already have a run (their tab name is the key).
3. Show a short table of the 10 most recently updated: key, title, status, "has a run". Then ask with
   AskUserQuestion (multiSelect): the 4 newest tickets without a run as options; the user types other keys, or a
   job in words, in "Other".
5. No Jira connection, or the call fails: say so in one line, and ask for the keys or jobs as text.

## My runs

1. `orch runs` (add `--all` for old finished runs). Runs that need the user come first.
2. Ask what next, with options like: **Open a run** (`orch run <ticket>`) · **Reopen stopped runs** (`orch reopen all`)
   · **Clean up** (see **Clean up**) · **Stop a run** (`orch stop <ticket>`).
3. For one run, `orch run <ticket>` shows its steps, notes ("what I did and why"), recent activity and the
   PR links and epic ("Shipped"). Explain the "Now:" line in plain words.
4. Each run says in one line what its ticket is about (the "About" column, the top of its steps pane). The run's
   Claude writes it once it reads the ticket. To set or fix it by hand: `orch about <ticket> "the summary"`.
5. `delete` removes the run from Stats too: ask first, and suggest `clean` instead when they only want the space back.
   With uncommitted work, `clean` and `delete` refuse; add `--force` only after the user says so.

## Clean up

Nothing is cleaned by itself: only when the user says so. A clean frees everything the run takes that is not needed
any more: it stops what still runs from the run's folder (the app too), removes the folder (`C:/o/<n>`), tidies git's
worktree records, and removes the run's Claude conversation files. It keeps the run's notes, log and stats, and its
branches. A cleaned run leaves the board (`orch runs --all` still shows it) and cannot be reopened.

- **The usual way: the Wrap up step.** A template whose last step is `wrap-up` wraps up in the run's own
  tab: the user types `next` when ready; the step shows what is waiting (vault commits, the ITP folder's
  `Execution/` files, the epic, uncommitted work), the user ticks the jobs (push the vault, close the epic, commit +
  push the ITP files; a PR is never assumed), then picks **Yes, clean** · **Keep the folder** · **Not yet**. With
  Yes, closing the tab cleans the run up by itself (and deletes branches git sees as merged). Pushing the vault and
  the ITP folder to `main` works only inside that step, after the user's Allow.
  To add it: `orch template add <id> wrap-up --label "Wrap up"`, with wait on for the step before it.
  A run started before the step was added: `orch steps <run> --set '<json list>'` can add it (keep finished steps).
- **What takes space**: `orch disk` (each run folder and the total).
- **One run** with no Wrap up step, or kept (its tab must be closed): `orch clean <ticket>`. It does no vault, epic or
  ITP job; for those, the run's own tab (Wrap up) is the place.
- **Every finished run** (tabs closed): show `orch disk`, ask, then `orch clean --done`.
- **Runs left alone 7+ days** (listed by `orch status`): ask, then `orch clean --stale`.
- Uncommitted work: it refuses and names the files. Show them; add `--force` only after the user says so.

## Templates & skills

Ask: **New template** · **Change a template** · **Find skills** · **List templates**.

- **Find skills**: `orch skills <words>`. The "Writes to Teamspace/vault" column matters for templates with tracking off.
  To correct a wrong guess: `orch skill-mark <skill> writes|clean|auto`.
- **New template**: ask for a short id (like `jira-to-pr`), a name, and the steps in plain words
  ("grill-itp, then plan-itp and wait for me, then execute-epics, it uses the app"). Then:
  `orch template new <id> <first-skill> --name "Name" [--tracking off] [--repos api,webclient]`
  and one `orch template add <id> <skill> [--wait] [--app] [--explain] [--label "…"] [--args "…"]` per further step.
  Find skill names with `orch skills <words>` when unsure. Show the result with `orch template show <id>`.
- **Change a template**: turn their words into commands, one change at a time, and show the template after:
  `template add` (`--at N` for a place), `template remove <id> <step>`, `template move <id> <step> <position>`,
  `template step <id> <step> wait=on|off app=on|off explain=on|off label="…" args="…"`,
  `template set <id> name="…" tracking=on|off repos=api,webclient`, `template copy <id> <new-id>`, `template delete <id>` (ask first).
- Step options in plain words: **wait** = stop after this step until the user types `next`; **app** = this step starts
  the app (one run at a time); **explain** = after this step, walk the user through the code changes.
- **New conversation per step** (`fresh=on`): the step starts a new conversation instead of carrying the whole
  history (the biggest cost: every request re-reads it). It gets a short story of the earlier steps; plans, epics
  and code are on disk. Good for steps that read from disk (Build, code review, Wrap up); not for a step that needs
  the talk before it (a plan right after its grill). `template step <id> <step> fresh=on|off`.
- **Model and effort per step**: `template step <id> <step> model=opus|sonnet|haiku|fable|none effort=low|medium|high|xhigh|max|ultracode|none`
  (`template set <id> model=… effort=…` sets the template's default; `template add … --model … --effort …`).
  A step with none keeps the one before. When the next step wants another model or effort, Orchestra restarts the
  run's claude in the same tab, on the same conversation (a few seconds; changing the model re-reads the chat once at
  full price). Usual split: opus for thinking steps (grill, plan, epic, review), sonnet for code (build, app test).
  **The step a run is on, now** ("use opus for this step"): `orch model <ticket> <model> [effort]` changes only that
  run. A step working now switches when the user types `/orchestra model` in the run's tab (Orchestra never restarts
  it from outside: that could cut claude off mid-work); tell them so. Typing `/orchestra model opus effort ultracode`
  there does both at once.
  **Ultracode** = many helper agents for one step: deep but costly (one small job used ~400k tokens). Turn it on only
  for the step the user names, and say the cost in one line.
- **Bug template** (`bug-template`): step 1 `bug-logs` reads the ticket, asks for the environment and time if
  missing, searches the ITP logs (OpenSearch, read only, names and ids hidden) and traces the error into
  `.orchestra-bug/trace.md`; the user checks "Is this the bug?". Then the feature flow plans and builds the fix.
  Start: `orch start bug-template <ticket>`.
- **Tracking off** = the run may not call Teamspace or write the vault; such a template refuses skills that do.
- **Testing in the app**: add the step `app-test` after the build, with wait on:
  `orch template add <id> app-test --wait --label "Test in the app"` (only when the user asks for it).
  Do not mark it `app`: the step takes the app itself, only when it is ready to start it, and runs wait in line
  (first come, first served). It asks the user for the test data, tests the ticket, fixes up to 2 rounds, and keeps
  the app until the user types `next`. Suggest turning `app` off on build steps (`execute-epics` never starts the app),
  so builds stop waiting for each other; change it only if the user says yes.
- `orch app`: who has the app, who waits, whose code it serves. `orch app release <ticket>` takes it from a run
  that is stuck. `orch status` shows an `App:` line when someone has it or waits for it.

## The app for you

The user can run the ITP app outside any run, from their own ITP checkout (the setup's ITP folder), with the same
launcher as runs (AppHost by default, per-service logs in `<checkout>/.run-logs/`).

- `orch app` first: who has it now (if a run has it, see below before asking anything).
- **Ask which database, before every start: Global DB or Local DB.** Read which one is active now (see "The
  database" below) and say it in the question, with the active one first. Ask also whether to add Outsider (usually no).
  If the user picks the other DB, switch it before the start, so the app starts once on the right one.
- **Ask about the Mission consumer too, in the same AskUserQuestion**, when the checkout has it (the folder
  `{{ITP}}/ITP-API/Orbitax.Platform.Api/Applications/Orbitax.MissionPlatform.Consumer` exists; if not, do not ask).
  Options: **No (usually)**, first · **Yes**: it is needed only to test XatBot / Mission work. No adds
  `--without mission`: Orchestra then sends XatBot commands to Primary for this start (`ITP_MissionApis=","` in the
  AppHost settings), so they do not hang; the user's Debug.json is not changed.
- Then `orch app start` (give the Bash tool a 600000 ms timeout; add `--minutes 9`). It prints the services, then
  "The app is up …" with the Aspire dashboard line. Show it, and say which DB it runs on and whether Mission is on.
  `--with outsider` adds Outsider; `--without mission` leaves Mission off; `--services webclient,api,…` sets the
  whole list. `orch app restart` keeps the same services.
- While the user has it, runs that want the app wait in line. Say so in one line.
- **A run has the app**: the start is refused and names the run and what it does. Do not take it by yourself: offer
  to wait, or `orch app release <ticket>` (it takes the app from that run, mid-step) only after the user says so.
- "Not up yet": `orch app wait --minutes 9`. Exit code 5 ("not started by Orchestra"): something else holds the ports
  (the user's own app from Visual Studio, say). Show the processes and ask; `orch app start --force` only after yes.
- `orch app logs [service]`, `orch app restart` (after a code change or a Debug.json switch), `orch app stop` (frees
  it for runs). The first start in a checkout keeps the user's own AppHost settings in Orchestra's
  `data/apphost-backups/` (never inside the ITP repo; its `appsettings.local.json` is gitignored there).
- **Switching while the app runs** ("now Local DB"): switch as below, then `orch app restart --minutes 9`, then tell
  the user to reload the page (Ctrl+F5) and check the project picker.

### The database (Global DB / Local DB)

The same rules as the "Test in the app" step. The choice lives in the user's `Debug.json`: `ITP_DebugJsonPath` if set,
else `C:\LocalStore\Debug.json` (ITP's default). It has two blocks of keys marked `// Global DB` and `// Local DB`;
exactly one is active, the other is commented out with `//`. The keys are `MongodbConnection`, `MongodbDemoConnection`,
`MongodbGlobalConnection`, `MongodbAppConnection` (Global block only), `DevPrefix` and `GlobalPrefix`. The .NET services
read the file only when they start (the web app does not read it).

- **Read the active DB without printing secrets:** say only which block has uncommented keys, and the host and prefix
  values of its connection lines. Never show any other key of the file: it holds tokens and keys.
- **Switch only after the user's yes**, each time: it is their own file, and the Global DB is a shared server. Show
  the exact lines you will comment and uncomment first.
- **Back up first:** copy it to `Debug.json.bak-before-<db>-switch-<date>` in the same folder.
- **Edit only the two blocks:** comment the keys of the active block, uncomment the keys of the other one. Touch no
  other line; keep the tabs.
- Say afterwards which DB is active and where the backup is. Never switch back by yourself; offer it.
- If the file has no `// Global DB` / `// Local DB` blocks, say so and do not edit it.

## More

Ask: **Lessons** · **Stats** · **Settings**.

- **Lessons**: `orch suggestions`. Ask about them all at once (one AskUserQuestion with one question per lesson, up to 4).
  - A **rule**: **Accept** · **Edit then accept** · **Reject**, then `orch suggestion <id> accept|reject [--text "edited"]`.
    Accepted rules join the user's rules (`orch rules`), which every later run follows.
  - A **workflow change** shows its `change:` line (the exact template command). Ask **Accept + change the template** ·
    **Accept, change later** · **Reject**. The first is `orch suggestion <id> accept --apply`; accepting alone changes
    nothing in the template. If the template it came from is gone (renamed), add `--template <id>` (ask which).
  - A workflow change with no saved change (`(none saved…)`): turn its text into a change and show it before applying:
    `orch suggestion <id> apply --change '{"op":"step","step":"<step id>","args":"…"}'` (ops: step with wait/app/explain
    on|off, args, label · add with skill, at, label, wait · remove · move with to).
  - `orch suggestions` also lists "Accepted, not in the template yet": offer to apply those (`orch suggestion <id> apply`).
  To look for lessons in one run now: `orch lessons <ticket>`.
- **Stats**: `orch stats`. Costs are estimates at API prices; on the Team plan they show usage, not a bill.
- **Settings**: `orch settings` shows them. Change with `orch settings max=3 learn=on|off pane=on|off panesize=30`
  (max = runs working at once; learn = look for lessons after each run; pane = show the steps pane on the right of
  each new run tab; panesize = its width in % of the tab, 15 to 70, for new tabs). `launcher=apphost|runstack` = how
  the "Test in the app" step starts the ITP app: the Aspire AppHost (default: every host, Mission consumer and
  Scheduler too) or run-stack.ps1 (old branches with no AppHost). Clean-up has no setting: it happens only when the user says so (**Clean up**).

## After a PC restart

Run tabs close with the PC. `orch status` shows "N stopped (reopen all)". Offer `orch reopen all`: each tab opens again
on its own conversation. In each tab the user types `next`: a step that was cut off halfway (like a build) goes on
from where it stopped; after a finished step, the next one starts. `redo` runs the step again from the start, and
`skip` marks it done and moves past it (on purpose only).
