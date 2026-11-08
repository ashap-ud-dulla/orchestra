---
name: orch
description: Orchestra, the user's personal workflow runner, from the terminal. Start tickets or jobs as runs (one terminal tab each), see the runs board, build templates from skills, find skills, lessons, stats and settings. Use when the user types /orch (with or without words after it) or asks to start tickets with a template, see their runs, reopen runs, or build a workflow template.
argument-hint: "[tickets or work orders to start | or anything in plain words]"
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

- **Plain words are fine** everywhere: turn what the user says into the `orch` commands below ("hand ITP2-1 over to
  Samiul" is `orch go ITP2-1 wrap-up handing over to Samiul`; "what is ITP2-1 doing" is `orch run ITP2-1`). In a run's
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
  marked skipped (not done) and the step is told so: a handover is `/orch go wrap-up handing over to <name>` (pushing
  the vault works only inside Wrap up). The step starts at once. The tab is split: the pane on the right shows the
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
2. Ask **Work on something new?** with **Yes** · **No**. Yes: `orch start` (no words): one run opens, and its first step
   lists the Work Orders and tickets the user holds, in its tab, where they pick. Say so in one line.

## Words after /orch: plain words

The user remembers nothing but `/orch`. Read what they wrote and do it with `orch`:

| They say | Do |
|---|---|
| Keys or links, pasted (`ITP2-15005, TSP-W-001, CLIS-688`), or jobs in words | **Start run(s)** below |
| "what's running", "what needs me", "board" | `orch status` / `orch runs` |
| "how is ITP2-1", "what did CLIS-688 find" | `orch run <ticket>` (`full=yes` for every note) |
| "go back to build on ITP2-1", "start again from step 5", "skip to wrap up", "hand ITP2-1 to Samiul", "wrap up CLIS-688" | `orch go <ticket> <step> [why]` (a hand-over or a wrap-up is `go <ticket> wrap-up <why>`). Going forward skips the steps between, and going back runs them again: say which in one line and ask first. It starts at once when Claude in that tab is idle; while it works, say to type it in the tab |
| "next / skip / redo on ITP2-1" | `orch next|skip|redo <ticket>` |
| "use opus for ITP2-1" | `orch model <ticket> opus [effort=…]` |
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

1. **Each key or quoted job makes one run** (split pasted lists on commas, spaces or lines). Keys: a Jira key, a Work
   Order key (`TSP-W-001`), a link. A job in words is quoted: `"Add a Sweden row"`. A text that only mentions a ticket
   ("same fix as ITP2-1, but for Sweden") is a job, not that ticket.
2. **No template needed**: `orch start <keys…>`. Each run's first step, **Pick the task and the steps**, reads its
   task, suggests the steps that fit (one of the user's templates, changed for it, with a cost and time estimate) and
   asks, in the run's tab. Only when the user names a template: `orch start <template> <keys…>`.
3. A ticket that has a run already is refused: ask, then add `again=yes`.
4. Show the result in one or two lines: every run opens its tab now in the "orchestra" window; heavy steps (builds,
   the app) work a few at a time (`orch settings` shows how many) and the others wait and start by themselves.

## My runs

1. `orch runs` (add `all` for old finished runs). Runs that need the user come first.
2. Ask what next, with options like: **Open a run** (`orch run <ticket>`) · **Reopen stopped runs** (`orch reopen all`)
   · **Clean up** (see **Clean up**) · **Stop a run** (`orch stop <ticket>`).
3. For one run, `orch run <ticket>` shows its steps, notes ("what I did and why"), recent activity and the
   PR links and epic ("Shipped"). Explain the "Now:" line in plain words.
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
  ("grill-itp, then plan-itp and wait for me, then execute-epics, it uses the app"). Then:
  `orch template new <id> <first-skill> name="Name" [tracking=off] [repos=api,webclient]`
  and one `orch steps <id> add <skill> [wait=on] [app=on] [explain=on] [label="…"] [args="…"]` per further step.
  Find skill names with `orch skills <words>` when unsure. Show the result with `orch template show <id>`.
- **Change a template**: turn their words into commands, one change at a time, and show the template after:
  `steps <id> add <skill>` (`after=<step>` or `at=N` for a place), `steps <id> remove <step>`, `steps <id> move <step> to=N`,
  `steps <id> set <step> wait=on|off app=on|off explain=on|off label="…" args="…"`,
  `template set <id> name="…" tracking=on|off repos=api,webclient`, `template copy <id> <new-id>`, `template delete <id>` (ask first).
- Step options in plain words: **wait** = stop after this step until the user types `next`; **app** = this step starts
  the app (one run at a time); **explain** = after this step, walk the user through the code changes.
- **New conversation per step** (`fresh=on`): the step starts a new conversation instead of carrying the whole
  history (the biggest cost: every request re-reads it). It gets a short story of the earlier steps; plans, epics
  and code are on disk. Good for steps that read from disk (Build, code review, Wrap up); not for a step that needs
  the talk before it (a plan right after its grill). `steps <id> set <step> fresh=on|off`.
- **Model and effort per step**: `steps <id> set <step> model=opus|sonnet|haiku|fable|none effort=low|medium|high|xhigh|max|ultracode|none`
  (`template set <id> model=… effort=…` sets the template's default; `steps <id> add … model=… effort=…`).
  A step with none keeps the one before. When the next step wants another model or effort, Orchestra restarts the
  run's claude in the same tab, on the same conversation (a few seconds; changing the model re-reads the chat once at
  full price). Usual split: opus for thinking steps (grill, plan, epic, review), sonnet for code (build, app test).
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
on its own conversation. In each tab the user types `next`: a step that was cut off halfway (like a build) goes on
from where it stopped; after a finished step, the next one starts. `redo` runs the step again from the start, and
`skip` marks it done and moves past it (on purpose only).

<!-- The solution's pack adds its own part below (orch setup). -->
