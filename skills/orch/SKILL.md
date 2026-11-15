---
name: orch
description: Orchestra, the user's personal workflow runner, from the terminal. Start tickets or jobs as runs (one terminal tab each), see the runs board, build templates from skills, find skills, lessons, stats and settings. Use when the user types /orch (with or without words after it) or asks to start tickets with a template, see their runs, reopen runs, or build a workflow template.
argument-hint: "[ticket keys to start | or anything in plain words]"
allowed-tools: Bash(node {{ORCHESTRA}}/bin/orch.mjs *), AskUserQuestion, mcp__claude_ai_Atlassian__getAccessibleAtlassianResources, mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql
---

# /orch

Orchestra lives in `{{ORCHESTRA}}`. There is no server and no web page: everything goes
through one command, run with the **Bash** tool:

```
node {{ORCHESTRA}}/bin/orch.mjs <command> [args]
```

Below, `orch <command>` means that full line. `orch help` lists every command. Options are always `key=value`
(`wait=on`, `model=opus`, `force=yes`); a wrong word or option is refused with the right ones ("did you mean …?").

## Rules

- **Plain words are fine** everywhere: turn what the user says into the `orch` commands below ("hand ABC-1 over to
  Sam" is `orch go ABC-1 wrap-up handing over to Sam`; "what is ABC-1 doing" is `orch run ABC-1`). In a run's
  tab they can talk in plain words too: the run's Claude passes moves on to Orchestra.
- Do all Orchestra work through `orch`. Never edit files under `orchestra/runs` or `orchestra/data` by hand, and never
  start `claude` yourself: `orch start` / `orch reopen` open the run tabs.
- The runs do their own work in their own tabs.
- Show `orch` output as it comes (tables in a code block). Then add one or two plain, short sentences: what it means and
  what the user can do next. Simple words, short sentences.
- Ask with **AskUserQuestion** (at most 4 options; the user can always type something else). Do not ask what the
  user already said.
- If `orch` prints `Error: …`, say it plainly, and suggest the fix it names.
- **First time on a PC**: `Error: Orchestra is not set up on this PC yet`. Ask the user for their solution folder (the
  folder with their repos; it may also be one repo), or none. Then run `orch setup solution=<folder>` (or `orch setup`
  with no folder: runs then work in your own skills only) and show what it prints: what it set up, what it changed on
  the PC, missing tools. After a `git pull` of Orchestra, `orch setup` again refreshes the skills.
- Each run opens its own tab in the **"orchestra"** Windows Terminal window (Alt+Tab). The user talks to the run there:
  `next` to go on (after a "wait for me" step, or with a step that was cut off), `redo` to run a step again,
  `skip` to move past an unfinished step on purpose, `/orch model opus effort=high` (or
  `/orch effort max`, `/orch model` to show) to switch the model of the step it is on: Orchestra catches it
  before this skill loads, and claude restarts in the same tab, on the same conversation, going on where it was (no redo).
  **Go to any step**, back or forward: `/orch go build fix the review findings` (also `back`, `jump`, `from`; the step
  by number or name, then why). Back: that step and every step after it run again (no copies); what they did before
  stays as history ("try 1"), and the step is told why and what the later steps found. Forward: the steps between are
  marked skipped (not done) and the step is told so: a handover is `/orch go wrap-up handing over to <name>` (the Wrap up
  step's jobs, like pushing notes the pack keeps on main, work only inside it). The step starts at once. The tab is split: the pane on the right shows the
  run's steps live (done / working now / to come). To see them in another terminal: `orch watch <ticket>` (Ctrl+C ends it).
- **Pins**: below the steps, the pane keeps instructions the user follows by hand (test steps, values to pick), so
  they stay in sight while the user chats. The run's Claude pins steps by itself (an `ORCHESTRA:PIN` block). In the
  run's tab the user types `pin` (Claude's last answer), `pin 2` (the one before), `pin: a note`, `unpin`
  (the pin shown), `unpin 2`, `unpin all`. Click the pane: ↑ ↓ PgUp PgDn / mouse wheel scroll, ← → other pins,
  drag selects text. From here: `orch pin <ticket>` (shows the pins in full), `orch pin <ticket> "text"
  [title="…"]`, `orch unpin <ticket> [N|all]`.

## No words after /orch

1. Run `orch status` and show it, then say in one or two lines what needs the user (a question, a `next`, an Allow).
   If it has a "Left alone 7+ days" or "Finished, folder still there" line, offer **Clean up** once (see **Clean up**).
2. Run `orch skills new --json`. When it lists any, say it in one line ("3 new team skills since you last looked:
   build-v2, test-stacks, …"); runs weigh them for their task by themselves. If the user wants to look: show
   them (`orch skills new`), say for each which of their templates it could fit, and mark them seen when the user says
   so (`orch skills seen`, or `orch skills seen <names>`). Do not ask about them every time: one line.
3. Ask **Work on something new?** with **Yes** · **No**. Yes: **Pick work** below.

## Pick work

The user picks here, in this tab; each pick then opens its own run, which plans itself in its tab.

1. Get what the user holds, both at once:
   - `orch mine --json`: the work they hold in their solution's own tracker, from its pack (read only). `problem` set:
     say it in one line and go on with the rest.
   - Their open Jira tickets, if the Atlassian tools are connected: `searchJiraIssuesUsingJql` with jql
     `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, maxResults 30, fields
     `summary,status`, the cloudId from `getAccessibleAtlassianResources` (once). Not connected: skip it silently.
     Read only: never change a ticket.
2. Mark the ones that have a run already: `orch mine` gives `run`; for the tickets, `orch runs all --json` (the run's
   key is its tab name).
3. Show **one numbered table**, `orch mine`'s items first, then the tickets: #, Key, Title, State, Kind (its `kind`, or
   "Jira"), Run. Then ask in plain text (not AskUserQuestion: it shows only 4): **Which ones? Type numbers or keys
   ("1, 3, 4", "all without a run"), or a job in words.**
4. Start them all at once: **Start run(s)** below, with the keys picked (a picked one with a run: ask first, then
   `again=yes`). Nothing held and nothing typed: ask what to work on.
5. Right after the start, give each picked run its title from the table, so its tab says what it is at once (the run
   replaces it with its own summary once it reads the task): one `orch about <key> "<title>" soft=yes` per run.

## Words after /orch: plain words

The user remembers nothing but `/orch`. Read what they wrote and do it with `orch`:

| They say | Do |
|---|---|
| Keys or links, pasted (`ABC-12, ABC-15, XYZ-3`), or jobs in words | **Start run(s)** below |
| "what do I have", "my tickets", "pick work" | **Pick work** |
| "what's running", "what needs me", "board" | `orch status` / `orch runs` |
| "how is ABC-1", "what did XYZ-9 find" | `orch run <ticket>` (`full=yes` for every note) |
| "go back to build on ABC-1", "start again from step 5", "skip to wrap up", "hand ABC-1 to Sam", "wrap up XYZ-9" | `orch go <ticket> <step> [why]` (a hand-over or a wrap-up is `go <ticket> wrap-up <why>`). Going forward skips the steps between, and going back runs them again: say which in one line and ask first. It starts at once when Claude in that tab is idle; while it works, say to type it in the tab |
| "next / skip / redo on ABC-1" | `orch next|skip|redo <ticket>` |
| "use opus for ABC-1" | `orch model <ticket> opus [effort=…]` |
| "change the steps of …", "add a code review to …" | `orch steps <ticket or template> add|remove|set|move …` (show the result) |
| "reopen", "after a restart" | `orch reopen all` / `orch reopen <ticket>` |
| "stop", "delete" | the same `orch` command (ask before `delete`) |
| "clean", "free space", "disk" | **Clean up** |
| templates, skills | **Templates & skills** |
| lessons, stats, settings ("run up to 5 at once" = `orch settings max=5`) | **More** |
| the app | **The app for you** |
| "help" | `orch help` |

When unsure what they mean, ask one short question with options.

## Start run(s)

1. **Each key or quoted job makes one run** (split pasted lists on commas, spaces or lines). Keys: any tracker's key
   (`ABC-123`), or a link to it. A job in words is quoted: `"Add a Sweden row"`. A text that only mentions a ticket
   ("same fix as ABC-1, but for Sweden") is a job, not that ticket.
2. **No template needed**: `orch start <keys…>`. Each run's first step, **Pick the task and the steps**, reads its
   task, takes one of the user's templates as a **guide** (with a cost and time estimate) and asks for the first step,
   in the run's tab. Then the steps are **picked one at a time**: when a step is done, its Claude asks which step comes
   next (open items like review findings first, the guide's usual next step, others that fit, Done) and the user
   clicks; the pane shows the picked steps and, grey, what is likely next. At Wrap up it offers to save the picked steps
   as a template. Only when the user names a template: `orch start <template> <keys…>` (all its steps at once).
3. A ticket that has a run already is refused: ask, then add `again=yes`.
4. Show the result in one or two lines: every run opens its tab now in the "orchestra" window; heavy steps (builds,
   the app) work a few at a time (`orch settings` shows how many) and the others wait and start by themselves.

## My runs

1. `orch runs` (add `all` for old finished runs). Runs that need the user come first.
2. Ask what next, with options like: **Open a run** (`orch run <ticket>`) · **Reopen stopped runs** (`orch reopen all`)
   · **Clean up** (see **Clean up**) · **Stop a run** (`orch stop <ticket>`).
3. For one run, `orch run <ticket>` shows its steps, notes ("what I did and why"), recent activity and the
   PR links and what else it shipped ("Shipped"). Explain the "Now:" line in plain words.
4. Each run says in one line what its ticket is about (the "About" column, the top of its steps pane). The run's
   Claude writes it once it reads the ticket. To set or fix it by hand: `orch about <ticket> "the summary"`.
5. `delete` removes the run from Stats too: ask first, and suggest `clean` instead when they only want the space back.
   With uncommitted work, `clean` and `delete` refuse; add `force=yes` only after the user says so.

## Clean up

Nothing is cleaned by itself: only when the user says so. A clean frees everything the run takes that is not needed
any more: it stops what still runs from the run's folder (the app too), removes the run folder, tidies git's
worktree records, and removes the run's Claude conversation files. It keeps the run's notes, log and stats, and its
branches. A cleaned run leaves the board (`orch runs all` still shows it) and cannot be reopened.

- **The usual way: the Wrap up step.** A template whose last step is `wrap-up` wraps up in the run's own
  tab: the user types `next` when ready; the step shows what is waiting (uncommitted work, branches not pushed, PR
  links, and what the solution's pack adds), the user ticks the jobs (a PR is never assumed), then picks
  **Yes, clean** · **Keep the folder** · **Not yet**. With Yes, closing the tab cleans the run up by itself (and
  deletes branches git sees as merged).
  To add it: `orch steps <template> add wrap-up label="Wrap up"`, with `wait=on` for the step before it.
  A run started before the step was added: `orch steps <run> add wrap-up label="Wrap up"`.
- **What takes space**: `orch disk` (each run folder and the total).
- **One run** with no Wrap up step, or kept (its tab must be closed): `orch clean <ticket>`. It does none of the Wrap up
  jobs; for those, the run's own tab (Wrap up) is the place.
- **Every finished run** (tabs closed): show `orch disk`, ask, then `orch clean done`.
- **Runs left alone 7+ days** (listed by `orch status`): ask, then `orch clean stale`.
- Uncommitted work: it refuses and names the files. Show them; add `force=yes` only after the user says so.

## Templates & skills

Ask: **New template** · **Change a template** · **Find skills** · **List templates**.

- **Find skills**: `orch skills <words>`.
- **New template**: ask for a short id (like `jira-to-pr`), a name, and the steps in plain words
  ("orch-plan and wait for me, then orch-build, then orch-review"). Then:
  `orch template new <id> <first-skill> name="Name" [tracking=off] [repos=a,b]`
  and one `orch steps <id> add <skill> [wait=on] [app=on] [explain=on] [label="…"] [args="…"]` per further step.
  Find skill names with `orch skills <words>` when unsure. Show the result with `orch template show <id>`.
- **Change a template**: turn their words into commands, one change at a time, and show the template after:
  `steps <id> add <skill>` (`after=<step>` or `at=N` for a place), `steps <id> remove <step>`, `steps <id> move <step> to=N`,
  `steps <id> set <step> wait=on|off app=on|off explain=on|off label="…" args="…"`,
  `template set <id> name="…" tracking=on|off repos=a,b`, `template copy <id> <new-id>`, `template delete <id>` (ask first).
- Step options in plain words: **wait** = stop after this step until the user types `next`; **app** = this step starts
  the app (one run at a time); **explain** = after this step, walk the user through the code changes.
- **Tool servers (MCP) per step**: the solution's pack starts its heavy servers only in the steps
  that use them, so runs stay light. A step that needs them all anyway: `steps <id> set <step> mcp=on`.
- **Tab marks**: a run tab's name starts with 🔴 when it needs the user (a question, an Allow, `next`, a failure),
  ⏳ while it waits in line (the app, a slot), ✅ when done; no mark while it works. Tabs opened before this
  change show it after `orch reopen`.
- **New conversation per step** (`fresh=on`): the step starts a new conversation instead of carrying the whole
  history (the biggest cost: every request re-reads it). It gets a short story of the earlier steps; plans
  and code are on disk. Good for steps that read from disk (Build, code review, Wrap up); not for a step that needs
  the talk before it (a plan right after its grill). `steps <id> set <step> fresh=on|off`.
- **Model and effort per step**: `steps <id> set <step> model=opus|sonnet|haiku|fable|none effort=low|medium|high|xhigh|max|ultracode|none`
  (`template set <id> model=… effort=…` sets the template's default; `steps <id> add … model=… effort=…`).
  A step with none keeps the one before. When the next step wants another model or effort, Orchestra restarts the
  run's claude in the same tab, on the same conversation (a few seconds; changing the model re-reads the chat once at
  full price). Usual split: opus for thinking steps (grill, plan, review), sonnet for code (build, app test).
  **The step a run is on, now** ("use opus for this step"): `orch model <ticket> <model> [effort]` changes only that
  run. A step working now switches when the user types `/orch model` in the run's tab (Orchestra never restarts
  it from outside: that could cut claude off mid-work); tell them so. Typing `/orch model opus effort=ultracode`
  there does both at once.
  **Ultracode** = many helper agents for one step: deep but costly (one small job used ~400k tokens). Turn it on only
  for the step the user names, and say the cost in one line.
## More

Ask: **Lessons** · **Stats** · **Settings**.

- **Lessons**: `orch suggestions`. Ask about them all at once (one AskUserQuestion with one question per lesson, up to 4).
  - A **rule**: **Accept** · **Edit then accept** · **Reject**, then `orch suggestion <id> accept|reject [text="edited"]`.
    Accepted rules join the user's rules (`orch rules`), which every later run follows.
  - A **workflow change** shows its `change:` line (the exact template command). Ask **Accept + change the template** ·
    **Accept, change later** · **Reject**. The first is `orch suggestion <id> accept apply=yes`; accepting alone changes
    nothing in the template. If the template it came from is gone (renamed), add `template=<id>` (ask which).
  - A workflow change with no saved change (`(none saved…)`): turn its text into a change and show it before applying:
    `orch suggestion <id> apply change='{"op":"step","step":"<step id>","args":"…"}'` (ops: step with wait/app/explain
    on|off, args, label · add with skill, at, label, wait · remove · move with to).
  - `orch suggestions` also lists "Accepted, not in the template yet": offer to apply those (`orch suggestion <id> apply`).
  To look for lessons in one run now: `orch lessons <ticket>`.
- **Stats**: `orch stats`. Costs are estimates at API prices; on the Team plan they show usage, not a bill.
- **Settings**: `orch settings` shows them. Change with `orch settings max=3 learn=on|off pane=on|off panesize=30`
  (max = heavy steps (builds, the app) working at once; every run opens and talks at once; learn = look for lessons after each run; pane = show the steps pane on the right of
  each new run tab; panesize = its width in % of the tab, 15 to 70, for new tabs). Clean-up has no setting: it happens only when the user says so (**Clean up**).

## After a PC restart

Run tabs close with the PC. `orch status` shows "N stopped (reopen all)". Offer `orch reopen all`: each tab opens again
on its own conversation, and its Claude asks with a click: **Go on where it stopped** · **Start the step again** · **Put
the run on hold** (after a finished step: **Start <next step>**). Typing still works: `next`, `redo`, `skip`.
`/orch hold [why]` in a run tab parks the run (frees its heavy slot and the app); `next` or a reopen goes on.

<!-- The solution's pack adds its own part below (orch setup). -->
