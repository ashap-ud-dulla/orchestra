
# The ITP part (the ITP pack)

- Never call Teamspace and never touch ITPKV from here. The runs do their own work in their own tabs.
- **Tracking off** = the run may not call Teamspace or write the vault; such a template refuses skills that do.
  `orch skills <words>` shows a "Writes to Teamspace/vault" column; to correct a wrong guess:
  `orch skill-mark <skill> writes|clean|auto`.
- `orch settings launcher=apphost|runstack` = how the "Test in the app" step starts the ITP app: the Aspire AppHost
  (default: every host, Mission consumer and Scheduler too) or run-stack.ps1 (old branches with no AppHost).

## Your open Jira tickets (for Start run(s))

Read only: never change a ticket from here.
1. `searchJiraIssuesUsingJql` with cloudId `orbitax.atlassian.net`, jql
   `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, maxResults 50, fields
   `summary,status,issuetype`, responseContentFormat `markdown`. (If the cloudId is refused, get it once with
   `getAccessibleAtlassianResources`.)
2. Run `orch runs all --json` and mark the tickets that already have a run (their tab name is the key).
3. Show a short table of the 10 most recently updated: key, title, status, "has a run". Then ask with
   AskUserQuestion (multiSelect): the 4 newest tickets without a run as options; the user types other keys, or a
   job in words, in "Other".
5. No Jira connection, or the call fails: say so in one line, and ask for the keys or jobs as text.

## ITP templates and steps

- **Bug template** (`bug-template`): step 1 `bug-logs` reads the ticket, asks for the environment and time if
  missing, searches the ITP logs (OpenSearch, read only, names and ids hidden) and traces the error into
  `.orchestra-bug/trace.md`; the user checks "Is this the bug?". Then the feature flow plans and builds the fix.
  Start: `orch start bug-template <ticket>`.
- **Testing in the app**: add the step `app-test` after the build, with wait on:
  `orch steps <id> add app-test wait=on label="Test in the app"` (only when the user asks for it).
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
  `without=mission`: Orchestra then sends XatBot commands to Primary for this start (`ITP_MissionApis=","` in the
  AppHost settings), so they do not hang; the user's Debug.json is not changed.
- Then `orch app start` (give the Bash tool a 600000 ms timeout; add `minutes=9`). It prints the services, then
  "The app is up …" with the Aspire dashboard line. Show it, and say which DB it runs on and whether Mission is on.
  `with=outsider` adds Outsider; `without=mission` leaves Mission off; `services=webclient,api,…` sets the
  whole list. `orch app restart` keeps the same services.
- While the user has it, runs that want the app wait in line. Say so in one line.
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
