---
name: app-test
description: Orchestra step "Test in the app" (human in the loop). Builds this run's code, starts the ITP app from this run's workspace (waiting in line, because only one copy can run), hands the app to the user with an exact click path, and fixes what the user reports (2 rounds at most). The user tests; the AI does not drive the browser unless asked. Stops the app when the step ends. Use as an Orchestra template step after the build, or at any later step to start the app again for QA ("preqa").
---

# Test in the app

You are a step in an Orchestra run. Only one copy of the ITP app can run on this PC, so runs take turns.
`app` below means this command, run from the current folder (this run's workspace) with the **Bash** tool:

```
node {{ORCHESTRA}}/bin/app.mjs <command>
```

Commands that wait (`take`, `start`, `wait`) take `--minutes 9`: give the Bash tool a timeout of 600000 ms.
When one ends with "Still waiting" or "Not up yet", just run it again, but see 3.5 first: that message can be wrong.

**The user tests, you build and start.** The user clicks through the app in their own browser. You do not drive
a browser, unless the user asks you to. Your jobs: a correct build, an app that is really up with every service the test
needs, an exact click path, the logs read when something fails, and fixes.

## 1. Plan the test (no app needed)

- Read the ticket (or, for a run started from a job text, that text), this run's plan and the epic briefs (the
  Verification / Done-when parts). Use what earlier steps of this run found; ask the user only for what is missing.
- Write a short test plan in plain words, the way the user tests:
  - **Screens**: which page, what to click or change, what must show after saving.
  - **Templates**: which template or sheet to fill or upload, and what the result must be.
  - **Downloads**: which XML / Excel / PDF to download, and what must be inside.
- Work out the **exact data** for the user: which project, which dialog values (form type, country, version, entity,
  year, file). Look at the file or ticket for the values instead of making the user guess. Say which ones you could not
  check yourself.

## 2. Ask the user (AskUserQuestion, in one go)

- Show the test plan so the user can correct it. Never guess a login (there is none on localhost) or a company.
- **Which services to start.** `app start` alone starts the usual set, and prints it. With the AppHost launcher
  (the default, `orch settings` shows it) that is the **web app, Platform API, Primary, Secondary, the Spreadsheet Job,
  the Scheduler, the MCP consumer, the dev IdP**, and the **Mission consumer** when the branch has it (unless
  `MissionApis=","` keeps XatBot on Primary). The user usually does **not** need **Outsider**: always ask about it,
  with "no" as the expected answer. Only start it when the user says yes (`--with outsider`).
- **The Mission consumer**, when the workspace has it (`ITP-API/Orbitax.Platform.Api/Applications/Orbitax.MissionPlatform.Consumer`
  exists): ask too. The usual answer is **no**; say **yes** first only when the ticket touches XatBot or Mission.
  No adds `--without mission`: XatBot commands then go to Primary for this start (`ITP_MissionApis=","`), so they
  do not hang; the user's Debug.json is not changed.
- **Which database: Global DB or Local DB.** Read which one is active now (see "Switching the database" below) and say
  it in the question. The user may need one for one check and the other for the next (for example the data of one
  project lives only on the Local DB). Projects, entities and forms differ between the two: tell the user that.
- If the question dialog shows no text step for "Other", ask the open questions in plain chat instead and wait.

## Switching the database (Global DB / Local DB)

The choice lives in the user's `Debug.json`: `ITP_DebugJsonPath` if set, else `C:\LocalStore\Debug.json`. It has two
blocks of keys marked `// Global DB` and `// Local DB`; exactly one is active and the other is commented out with `//`.
The keys are `MongodbConnection`, `MongodbDemoConnection`, `MongodbGlobalConnection`, `MongodbAppConnection` (Global block
only), `DevPrefix` and `GlobalPrefix`. The services read the file **only when they start**, so every switch needs a
restart of the .NET services (the web app does not read it).

- **Read the active DB without printing secrets:** show only the block heading that has uncommented keys and the host
  and prefix values of its connection lines. Never print other keys of the file (it holds tokens and keys).
- **Switch only when the user says yes**, each time. It is their personal file outside the repo and the Global DB is a
  shared server. Show the exact lines you will comment and uncomment first.
- **Back up first:** copy it to `Debug.json.bak-before-<db>-switch-<date>` in the same folder.
- **Edit only the two blocks:** comment the keys of the active block, uncomment the keys of the other block. Touch no
  other line. Keep the tabs.
- **Restart:** `app restart --minutes 9` (the services this run started). With the AppHost it stops and starts the
  whole app (one service alone needs the aspire CLI, not set up yet); the relaunch rebuilds what changed. With
  run-stack it restarts only the .NET services you name: `app restart api,primary,secondary,spreadsheet --minutes 9`.
  Then do the up-check of 3.5 again; a cold start took about 10 minutes. Tell the user to reload the page (Ctrl+F5)
  and check the project picker.
- **Say in the handover and the report which DB the test ran on, and whether it is still switched.** Offer to put it
  back (the backup file); never switch back by yourself.

## 3. Get the app

1. `app build`: builds this run's code while you wait (no turn needed). Fix build errors before you go on.
2. `app take --minutes 9`: waits in line. It prints your place ("2nd in line, ITP2-… has it").
3. If the user wants the other database than the active one, switch it **before** you start (see "Switching the
   database"), so the app starts once on the right one.
4. Start the app with the services from step 2: `app start --minutes 9`, plus `--with outsider` only if the user said
   yes, and `--without mission` if they said no to Mission. `--services webclient,api,…` sets the whole list instead (names: `webclient, api, primary, secondary,
   spreadsheet, mission, scheduler, mcp, idp, outsider`). Do not set `ORCHESTRA_APP_START` and do not call
   `run-stack.ps1` or `dotnet run` on the AppHost yourself: `app start` picks the launcher from Orchestra's setting.
   - **AppHost launcher**: it writes this run's resource list to the AppHost's gitignored `appsettings.local.json`
     in this worktree (keeping your own settings in it, like the webclient's `scriptName`), with Redis and RabbitMQ off
     when they already run on this PC (Windows services, no Docker). Then it runs the AppHost with the http profile.
     It prints the **Aspire dashboard** login line once it is up (also in `app status`).
   - A branch with no AppHost (old branches) fails with a plain message. Then the user can run
     `orch settings launcher=runstack` (run-stack.ps1 has no Mission consumer and no Scheduler).

   A cold start takes many minutes (the .NET services compile). Without Primary and Secondary, anything that saves,
   uploads, imports or generates spins for ever: the api queues the command and nothing picks it up (the api log keeps
   polling `CommandResponseById`). On a Mission branch the same happens to XatBot commands without the Mission
   consumer. Screens that only read data work without them.
   - Exit code 5, "Orchestra did not start it": the app runs from somewhere Orchestra did not start (the user's own
     checkout or their own AppHost, or an earlier start of this run). Ask the user. Only after they say ok, run
     `app start --force`.
   - "Note: the dev IdP … cannot start": the web login (:10203) will not work. Tell the user what is missing (it names
     the file); they make `teamspace-agent/debug.json` from `debug.json.example`. Never copy keys into it yourself.
5. **Check it is really up.** `app wait` checks 127.0.0.1 and localhost. To be sure: `curl http://127.0.0.1:50544/health` returns 200 and `Healthy`,
   `curl http://localhost:9000/` returns 200, and the ports of the services you started listen on 127.0.0.1
   (Platform API 50544, Outsider 50545, Primary 50546, Secondary 50547, MCP 50548, Scheduler 50549, Mission 50550;
   the Spreadsheet Job has no port). With the AppHost, the dashboard shows each service's state too.
6. **If it does not start.** Read `.run-logs\orchestra-start.log` (the launcher's console: the AppHost's build and
   start lines, or run-stack's) and `app logs`. Fix what you can (a build error, `npm install` in ITP-WebClient when
   :9000 never answers after a branch switch), then `app start` again. Do not start the app by hand.

The app is at http://localhost:9000 (api http://localhost:50544).

## 4. Hand over

- **No live log watcher.** Do not start a Monitor or `tail -F` on the logs while the user tests: the user watches
  each service's console in the **Aspire dashboard** (its login line is in `app status`; give it to the user). Note the
  time the user starts testing, for step 7.
- **The log files stay, for you.** With the AppHost, Orchestra copies each service's console into
  `.run-logs/<service>.log` while the app runs, as plain text (`app logs` lists them: `api.log`, `primary.log`,
  `secondary.log`, `mission.log`, …). You read them when something fails (step 5) and once at the end (step 7).
- **"Live logs: none yet"** a minute after the app is up means Orchestra's log copier found no Aspire files. Tell the
  user plainly (Orchestra needs a fix): you cannot read the logs then, only the user can, in the dashboard.
- **Tell the user, in plain words:** the app is up (list each service and its state), **which DB it runs on (Global or
  Local)**, what state you changed in the app (for example the selected project), the **exact click path**, the **exact values** to pick in each dialog, and what
  they should see after each step. Leave out anything you did not check, and say that you did not check it.
- **Pin the test steps.** Write the click path, the values and what to see once, between a line
  `ORCHESTRA:PIN Test steps` and a line `ORCHESTRA:END` (numbered, short lines; the DB and the project at the top).
  Orchestra keeps a copy in the pane on the right, so the user can follow it while you talk. After a fix round that
  changes the steps, pin the new steps the same way (the newest pin shows first).
- Do not open a browser or touch the app while the user tests. Tell the user to press F12 and look at the Console and
  Network tabs for red lines the api logs cannot show.
- Wait for the user. They report pass or fail per check.

## 5. The user reports a failure

- Read the log files for that moment (the time they give you, or the last minutes), every service the action goes
  through (api, then primary / secondary / mission for saves, uploads and XatBot). Look for `^fail:`,
  `Unhandled exception`, `Exception:`, `ERROR` and HTTP 5xx lines. The user may paste lines from the Aspire dashboard
  instead: use those. Say whether it is an api error or a screen problem.
- Find the cause and fix the code (in this run's worktrees only), then restart what changed (`app start` again with the
  same services, or just the web app for a WebClient-only change) and ask the user to retry the failed checks, then the
  rest quickly. **At most 2 fix rounds.** Still failing: stop, say what fails and what you tried, and end with
  `ORCHESTRA:FAILED`.

- **The user needs the other DB for the next check** (for example CbC on Local, then GIR on Global): follow "Switching
  the database" (ask, back up, edit the two blocks, restart the .NET services, up-check, tell the user to reload).
  Switching is not a fix round and does not count toward the 2.

## 6. Optional: AI-driven browser tests

Only when the user asks for it. Then follow `{{SOLUTION}}/.claude/skills/run-playwright-automation/SKILL.md`
for this run's epic, with `--no-start`. Use **one** browser window for the whole test: start Chrome once (headed,
`--remote-debugging-port=9222`, its own `--user-data-dir` under `.orchestra-test/`), attach each script with Playwright
`connectOverCDP`, never close the browser from a script, never launch one browser per script. Screenshots go in
`.orchestra-test/`.

## 7. Report

**One log check first.** Search the `.run-logs/*.log` files once for error lines since the user started testing
(`^fail:`, `Unhandled exception`, `Exception:`, `ERROR`, HTTP 5xx), so an error in a service the user did not look at
is not missed. One search, not a watcher. Leave out what is plainly noise (say so), list the rest with service and time.

A short table: each check, passed or failed (as the user told you), plus the errors that log check found. Then the fixes
you made (with the commit, if you committed), the state you changed in the app and did not put back (the selected
project, the forms the test created and on which DB, and **whether `Debug.json` is still switched, with the backup
path**), and which repos were served from the user's own checkout (not a worktree of this run).

## 8. Stop the app before the step ends

**Never leave the app running into the next step.** The run lets go of the lock when the step ends, but nothing stops
the app until the run is cleaned up, so it would keep running with this run's code.

1. After the report, ask the user if they are done with the app (they may want one more look). Wait for the answer.
2. Run `app stop`. It stops the launcher's tree, everything on the app's ports, and the hosts with no port that run
   from this workspace (the Spreadsheet Job, the AppHost's resources). Exit code 5 ("not started by Orchestra"): a
   process on the ports is not from a run folder. Ask the user before `app stop --force`.
3. Check that the app is really down: `http://localhost:9000/`, `http://127.0.0.1:50544/health` and the dashboard
   (:15200) no longer answer, and no `Orbitax.*` process from this workspace is left (the Mission consumer, the
   Scheduler, the Spreadsheet Job). If one is, stop its tree (`taskkill /PID <pid> /T /F`) and tell the user, so
   Orchestra can be fixed.
4. Run `app release`.
5. Say that the app is stopped and that `Debug.json` is still switched, if it is. Then end as every Orchestra step does:
   WHAT I DID AND WHY, then `ORCHESTRA:DONE`.

## Start the app again at a later step ("preqa")

After the user's own test, QA often comes and tests on the user's PC ("preqa"). This can happen at any later step of
the run. The user then calls this skill again, or says "start the app for preqa".

- **Do only the app part:** step 2's questions about the services and the DB, then step 3 (build, take, start, up-check),
  and step 4's dashboard line. Skip the test plan and the click path: QA has its own. No live log watcher.
- **Do not end the current step.** The run is on another step, so end those replies with neither `ORCHESTRA:DONE` nor
  `ORCHESTRA:FAILED`. Writing `ORCHESTRA:DONE` here would close the step the run is on, and the run would skip it.
- **What QA finds is tracked work.** Before you fix it, add it as a task on this run's epic. Do not fix it off the books.
  Do not count it as a fix round.
- **When QA is done**, do step 8's stop (ask, `app stop`, check the ports, `app release`). Then go
  back to the step the run is on.
