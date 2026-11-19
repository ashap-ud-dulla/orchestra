---
name: app-test
description: Orchestra step "Test in the app". Builds this run's code and starts this run's OWN copy of the ITP app (its app slot - own ports, own copy of your Local DB - so runs test side by side, no line), runs AI browser checks with Playwright first, then hands the app to the user with an exact click path, and fixes what fails (after 2 rounds it asks before another). Global DB tests use the one shared app (in line). The slot stays with the run (stopped between steps, data kept) for later rounds and for QA. Use as an Orchestra template step after the build, or at any later step to start the app again for QA ("preqa").
---

# Test in the app

You are a step in an Orchestra run. `app` below means this command, run from the current folder (this run's
workspace) with the **Bash** tool:

```
node {{ORCHESTRA}}/bin/app.mjs <command>
```

Commands that wait (`slot up`, `take`, `start`, `wait`) take `--minutes 9`: give the Bash tool a timeout of
600000 ms. Exit code 3 ("Still waiting … run it again") means: run the same command again; it keeps its place.

## Two ways to get the app

| | **This run's own app (its slot)** - the usual way | **The one shared app** |
|---|---|---|
| What | An itp-stacks stack: its own ports (web `900n`), RabbitMQ vhost, Redis, and its own copy of the user's **Local DB** (made from a "master" copy) | The user's main app (web 9000), with their `Debug.json` |
| Waits for | Nothing, unless N slots already run (`orch settings stacks=N`) | Every other run that has it (first come, first served) |
| Data | Its own: what you or the user set up stays for the next round and for QA. "Fresh data" resets it. | The real Local DB or Global DB, shared with the user |
| Use it for | Every test on the **Local DB** | Tests that need the **Global DB** (shared server; slots copy only the Local DB), or when slots are off or Docker is not on this PC |

`app slot status` says whether slots are on and what this run's slot is doing.

## 1. Plan the test (no app needed)

- Read the ticket (or, for a run started from a job text, that text), this run's plan and the epic briefs (the
  Verification / Done-when parts). Use what earlier steps of this run found; ask the user only for what is missing.
- Write a short test plan in plain words, the way the user tests:
  - **Screens**: which page, what to click or change, what must show after saving.
  - **Templates**: which template or sheet to fill or upload, and what the result must be.
  - **Downloads**: which XML / Excel / PDF to download, and what must be inside.
- Work out the **exact data**: which project, which dialog values (form type, country, version, entity, year, file).
  Look at the file or ticket for the values instead of making the user guess. Say which ones you could not check.
- Mark each check **AI can check** (a click path with a visible result: a value on screen, a saved row, a downloaded
  file's content) or **needs the user's eyes** (looks right, a judgement, an outside system).

## 2. Ask the user (AskUserQuestion, in one go)

- Show the test plan so the user can correct it.
- **Where and what to start, in one click.** One option names the whole start, for example
  **"Own app · Local DB copy · api, primary, secondary, web (Recommended)"**. Add an option for the shared app with the
  Global DB only when a check needs Global data, and one with Mission on for a XatBot ticket. Each option lists what it
  starts, so the user sees what they get.
- **Services** (names: `api, primary, secondary, webclient, mission, outsider, spreadsheet`). The usual set is
  api, primary, secondary and the web page. Without Primary and Secondary anything that saves, uploads, imports or
  generates spins for ever. Mission only for XatBot / Mission work (`--with mission`); Outsider only when the user says
  yes (`--with outsider`). A service the run never built is left out with a note; one you ask for by name must be built
  (it prints the build line).
- **Data in the slot**: say it is the run's own copy of the Local DB, made on the date `app slot up` prints. If the
  test needs data the copy does not have (made after the master copy), say so: the user can set it up in the slot
  (it stays), or refresh the master copy (`orch app master refresh`, ~30 min) and then `app slot fresh`.

## 3. Get the app

### 3a. This run's own app (the usual way)

1. `app build`: builds this run's code (no turn needed). Fix build errors before you go on.
2. `app slot up --minutes 9` (add `--with …` / `--without …` / `--services …` as picked). The first time it copies the
   master copy into the run's own data (~1 min) and makes the stack (~2-5 min); later times it just starts it (~2
   min), taking the newest build and rebuilding the web page only when the web code changed. It prints the link
   (`http://localhost:900n`) and the api. **The page signs in by itself** as the user's usual user: no login, no IdP.
   - "Waiting for a slot: … in line": N slots run already. Run the same command again (exit 3) and tell the user
     who has the slots; they may stop one (`orch app slot <run> stop`) or allow more (`orch settings stacks=N`).
   - "no master copy": tell the user `orch app master refresh` (in the background, ~30 min, reads their Local DB
     only). Meanwhile you may use the shared app (3b) if they agree.
   - "Docker is not running" / "not installed": tell the user (start Docker Desktop). Meanwhile 3b.
   - Any other error: show its last lines; `app slot logs <service>` reads a service's log.
3. Check it is up: `curl http://localhost:<api port>/api/...` answers (401 without a token is fine: the page adds it),
   and the web link answers 200.

### 3b. The one shared app (Global DB, or no slots)

1. `app build`.
2. `app take --minutes 9`: waits in line for the shared app. It prints your place.
3. The database: the choice lives in the user's `Debug.json` (see "Switching the database" below). Switch **before**
   you start, so the app starts once on the right one.
4. `app start --minutes 9` (plus `--with outsider`, `--without mission` as picked). It picks the launcher from
   Orchestra's setting (the AppHost by default; it prints the Aspire dashboard login). Do not run `run-stack.ps1` or
   `dotnet run` yourself. Exit code 5 ("Orchestra did not start it"): the user's own app runs; ask before
   `app start --force`.
5. Check: `curl http://127.0.0.1:50544/health` returns 200 and `http://localhost:9000/` returns 200.
6. It does not start: read `.run-logs\orchestra-start.log` and `app logs`, fix what you can, `app start` again.

### Switching the database (shared app only)

The choice lives in the user's `Debug.json`: `ITP_DebugJsonPath` if set, else `C:\LocalStore\Debug.json`. It has two
blocks of keys marked `// Global DB` and `// Local DB`; exactly one is active and the other is commented out with `//`.
The services read it only when they start, so every switch needs `app restart --minutes 9`.

- **Never print secrets:** show only which block is active and the host and prefix values of its connection lines.
- **Switch only when the user says yes**, each time; the Global DB is a shared server. Show the exact lines first.
- **Back up first** (`Debug.json.bak-before-<db>-switch-<date>`), **edit only the two blocks**, keep the tabs.
- Say in the handover and the report which DB the test ran on and whether it is still switched. Never switch back by
  yourself; offer it.

## 4. AI checks first, then the user

**AI checks (Playwright), for every check marked "AI can check".** Follow
`{{SOLUTION}}/.claude/skills/run-playwright-automation/SKILL.md` for this run's epic, with `--no-start` and
`--url <the app's web link>` (the slot's `http://localhost:900n`, or `http://localhost:9000` for the shared app).
Use **one** browser window for the whole test: start Chrome once (headed, `--remote-debugging-port=9222`, its own
`--user-data-dir` under `.orchestra-test/`), attach each script with Playwright `connectOverCDP`, never close the
browser from a script, never launch one browser per script. Screenshots go in `.orchestra-test/`.

- A check that fails: read the logs for that moment (below), fix, rebuild, `app slot up` again (it takes the new
  build), and run the failed checks again. This counts toward the fix rounds (section 5).
- Then show a short table: each AI check, passed or failed, with its screenshot path.

**Then hand over to the user**, for the checks that need their eyes (and anything they want to see themselves):

- Tell them, in plain words: the link, which services run, **which data** (the slot's Local DB copy and its date, or
  the shared app's DB), what state you changed (the selected project, records the AI checks made), the **exact click
  path**, the **exact values**, and what they should see. Leave out what you did not check, and say so.
- **Pin the steps**: the click path, values and what to see, between a line `ORCHESTRA:PIN Test steps` and a line
  `ORCHESTRA:END` (numbered, short lines; the link and the data at the top). After a fix round that changes them, pin
  the new steps the same way.
- Do not drive the browser while the user tests. Tell them to press F12 and look at Console and Network for red lines.
- **No live log watcher** (no Monitor, no `tail -F`). Note the time the user starts, for the log check in section 7.
- Wait for the user. They report pass or fail per check.

**Logs.** Slot: `app slot logs <service>` (`api`, `primary`, `secondary`, `mission`, `webclient`; `--lines 200` for
more). Shared app: `app logs [service]` (`.run-logs/<service>.log`; with the AppHost also the Aspire dashboard).
Look for `^fail:`, `Unhandled exception`, `Exception:`, `ERROR` and HTTP 5xx lines.

## 5. A check fails

- Read the logs for that moment, every service the action goes through (api, then primary / secondary / mission for
  saves, uploads and XatBot). Say whether it is an api error or a screen problem.
- Find the cause and fix the code (in this run's worktrees only), `app build`, then `app slot up` again (it restarts
  with the new build; `app slot restart` forces a restart) - or `app start` again for the shared app. Run the failed
  checks again (AI checks yourself; the user's checks: ask them), then the rest quickly.
- **After 2 fix rounds**, ask with a click: **Another round** (say what you would try next) · **Stop and report** (say
  what fails and what you tried, then end with `ORCHESTRA:FAILED`). Ask again after each further round.
- The data in the slot looks wrong or used up: offer **Fresh data** (`app slot fresh`: the master copy again, ~1 min;
  what was set up in the slot is lost). Not a fix round.
- A check needs the Global DB: test it on the shared app (3b). Not a fix round.

## 6. Report

**One log check first**: search the logs once for error lines since the tests began (slot: `app slot logs <service>
--lines 400` for each service that ran; shared app: `.run-logs/*.log`). Leave out what is plainly noise (say so),
list the rest with service and time.

A short table: each check, AI or user, passed or failed, plus the errors that log check found. Then the fixes you made
(with the commit, if you committed), the state you changed and did not put back (the selected project, the records the
test created and in which data: the slot's copy or which DB), **whether `Debug.json` is still switched, with the backup
path** (shared app only), and which repos were served from the user's own checkout (not this run's).

## 7. Before the step ends

**Slot (the usual way).** Ask with a click: **Stop the app (Recommended)** - its RAM is freed, its data stays for the
next round and for QA · **Keep it running** - for QA soon (it keeps one of the N slots busy; `orch app slot <run>
stop` stops it later). Then `app slot stop` if they chose so. The slot itself (and its data) is deleted only when the
run is cleaned up.

**Shared app.** Never leave it running into the next step: ask if they are done, then `app stop` (exit code 5: ask
before `app stop --force`), check that `http://localhost:9000/` and `http://127.0.0.1:50544/health` no longer answer
and no `Orbitax.*` process from this workspace is left, then `app release`. Say if `Debug.json` is still switched.

Then end as every Orchestra step does: WHAT I DID AND WHY, then `ORCHESTRA:DONE`.

## Start the app again at a later step ("preqa")

QA often comes later and tests on the user's PC, at any later step of the run, until the run is cleaned up. The user
calls this skill again, says "start the app for preqa", or runs `orch app slot <run> up` themselves.

- **Do only the app part:** `app build` if the code changed, then `app slot up --minutes 9` (the slot keeps its data
  and its services; it takes the newest build). Give the user the link to hand over. The page signs in as the user's
  usual user. Skip the test plan and the click path: QA has its own. No live log watcher.
- **Do not end the current step.** The run is on another step, so end those replies with neither `ORCHESTRA:DONE` nor
  `ORCHESTRA:FAILED`.
- **What QA finds is tracked work.** Before you fix it, add it as a task on this run's epic. Not a fix round.
- **When QA is done**, ask, then `app slot stop` (data kept). Then go back to the step the run is on.
