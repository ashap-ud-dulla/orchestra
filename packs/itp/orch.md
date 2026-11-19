
# The ITP part (the ITP pack)

- Teamspace from here: only `orch mine` (it reads, never writes). Never call Teamspace any other way and never touch
  ITPKV from here. The runs do their own work in their own tabs.
- **Tracking off** = the run may not call Teamspace or write the vault; such a template refuses skills that do.
  `orch skills <words>` shows a "Writes to Teamspace/vault" column; to correct a wrong guess:
  `orch skill-mark <skill> writes|clean|auto`.
- `orch settings launcher=apphost|runstack` = how the "Test in the app" step starts the ITP app: the Aspire AppHost
  (default: every host, Mission consumer and Scheduler too) or run-stack.ps1 (old branches with no AppHost).

## Picking the task

- In **Pick work**, `orch mine` lists the **Work Orders** the user holds or pairs on (Teamspace, read only, through
  ITP's own `registry_call GET`). Their Jira tickets come from the Atlassian tools (cloudId `orbitax.atlassian.net`).
- Each run's first step, **Pick the task and the steps** (`intake`), then reads its Work Order (spec, comments,
  acceptance tests, issues) or Jira ticket in its own tab, takes `feature-template` or `bug-template` as the guide,
  and asks for the first step; each step then asks for the next (after `ai-itp-code-reviewer`, fixing its findings
  comes first).

## ITP templates and steps

- **Bug template** (`bug-template`): step 1 `bug-logs` reads the ticket, asks for the environment and time if
  missing, searches the ITP logs (OpenSearch, read only, names and ids hidden) and traces the error into
  `.orchestra-bug/trace.md`; the user checks "Is this the bug?". Then the feature flow plans and builds the fix.
  Start: `orch start bug-template <ticket>`.
- **Testing in the app**: add the step `app-test` after the build, with the app on:
  `orch steps <id> add app-test app=on label="Test in the app"` (only when the user asks for it).
  It builds the run's code, starts **the run's own app (its slot)**, runs AI browser checks (Playwright) first, then
  hands the app to the user with a pinned click path, and fixes (after 2 rounds it asks before another). Global DB
  tests use the one shared app (in line). Suggest turning `app` off on build steps (`execute-epics` never starts
  the app); change it only if the user says yes.
- `orch app`: who has the shared app, who waits, whose code it serves. `orch app release <ticket>` takes it from a
  run that is stuck. `orch status` shows an `App:` line when someone has it or waits for it.

## App slots: each run its own app

Each run tests in its own copy of the ITP app (an itp-stacks stack): its own ports (`http://localhost:900n`), its
own RabbitMQ vhost and Redis, and **its own copy of the user's Local DB**, copied from a "master" copy in ~1 min. Runs
test side by side; only `stacks` of them run at once (`orch settings stacks=N`, 3 by default; 0 = off: every run
uses the one shared app, in line). Needs Docker Desktop running.

- A slot lives as long as its run: made at the first test, **stopped** between steps (no RAM, data kept), deleted when
  the run is cleaned up or deleted. Its data stays between test rounds and for QA.
- **Plain words work**; turn them into these commands. The run is named the way the user names it: its ticket or
  Work Order key (`SA-W-037`), words from its name (`public cbc`), or the end of its id (`abecb3`).
  | They say | Do |
  |---|---|
  | "what's the address of the CbC app", "where is my app for SA-W-037" | `orch app slots` (or `orch app slot <run> status`): give the link |
  | "QA is here for SA-W-037", "start the app of public cbc" | `orch app slot <run> up minutes=9`: give the link |
  | "stop the CbC app" / "clean data for …" / "delete its app" | `orch app slot <run> stop` / `fresh` / `drop` (ask first for fresh and drop) |
  | "refresh the master copy", "my Local DB changed" | `orch app master refresh` |
- `orch app slots`: every slot (run, running or stopped, link, data date), free disk, and the master copy.
- **Pre-QA hand-over** ("QA is here for ABC-1"): `orch app slot ABC-1 up` (give the Bash tool 600000 ms and add
  `minutes=9`). It wakes the run's slot with the run's newest build and prints the link to hand over; the page signs
  in by itself as the user's usual user. When QA is done: `orch app slot ABC-1 stop`.
- `orch app slot <ticket> fresh`: clean data (the master copy again; what was set up in the slot is lost: ask first).
  `drop`: deletes the slot and its data now (ask first). `logs [service]`: a service's log.
- **The master copy** every new slot starts from: `orch app master` (its date, size, a refresh in progress).
  `orch app master refresh` remakes it from the user's Local DB in the background (~30 min, reads it only). Offer it
  when `orch status` says it is old, or when a test needs data that is newer than the copy.
- "Waiting for a slot": N slots run. Say who has them; the user may stop one, or allow more (`stacks=N`; each running
  slot takes ~2 GB RAM; Docker's own memory is capped in `%USERPROFILE%\.wslconfig`).
- A slot refused for disk names the stopped slots of other runs: offer to clean those runs, or `drop` a slot.

## The app for you

The user can run the ITP app outside any run, from their own ITP checkout (the setup's ITP folder), with the same
launcher as runs (AppHost by default, per-service logs in `<checkout>/.run-logs/`).

- `orch app` first: who has it now (if a run has it, see below before asking anything).
- **Ask which database, before every start: Global DB or Local DB.** Read which one is active now (see "The
  database" below) and say it in the question, with the active one first. Ask also whether to add Outsider (usually no).
  If the user picks the other DB, switch it before the start, so the app starts once on the right one.
- **Ask about the Mission consumer too, in the same AskUserQuestion**, when the checkout has it (the folder
  `{{SOLUTION}}/ITP-API/Orbitax.Platform.Api/Applications/Orbitax.MissionPlatform.Consumer` exists; if not, do not ask).
  Options: **No (usually)**, first · **Yes**: it is needed only to test XatBot / Mission work. No adds
  `without=mission`: Orchestra then sends XatBot commands to Primary for this start (`ITP_MissionApis=","` in the
  AppHost settings), so they do not hang; the user's Debug.json is not changed.
- Then `orch app start` (give the Bash tool a 600000 ms timeout; add `minutes=9`). It prints the services, then
  "The app is up …" with the Aspire dashboard line. Show it, and say which DB it runs on and whether Mission is on.
  `with=outsider` adds Outsider; `without=mission` leaves Mission off; `services=webclient,api,…` sets the
  whole list. `orch app restart` keeps the same services.
- With app slots on, runs test in their own apps, so the user's app keeps nobody waiting; only a run that needs the
  Global DB waits for it (`app take`). With slots off, runs that want the app wait in line. Say so in one line.
- **A run has the app**: the start is refused and names the run and what it does. Do not take it by yourself: offer
  to wait, or `orch app release <ticket>` (it takes the app from that run, mid-step) only after the user says so.
- "Not up yet": `orch app wait minutes=9`. Exit code 5 ("not started by Orchestra"): something else holds the ports
  (the user's own app from Visual Studio, say). Show the processes and ask; `orch app start force=yes` only after yes.
- `orch app logs [service]`, `orch app restart` (after a code change or a Debug.json switch), `orch app stop` (frees
  it for runs). The first start in a checkout keeps the user's own AppHost settings in Orchestra's
  `data/apphost-backups/` (never inside the ITP repo; its `appsettings.local.json` is gitignored there).
- **Switching while the app runs** ("now Local DB"): switch as below, then `orch app restart minutes=9`, then tell
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
