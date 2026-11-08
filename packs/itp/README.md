# The ITP pack

Orchestra for the ITP workspace (itp-workspace and its repos). Setup picks it by itself when the solution folder
has `scripts/lib/common.sh`:

```
node bin/orch.mjs setup solution=C:/path/to/your/ITP
```

What it adds to the core:

| Part | What |
|---|---|
| Repos | From ITP's own `repo_dir_for` (`scripts/lib/common.sh`); the itp-workspace repo itself is never a run repo. New runs start from the development branch your checkout is on, else `origin/development/mission` |
| The vault | `ITPKV` may be committed locally on main (as the team skills do); it is never pushed, except in the Wrap up step after your Allow |
| Tracking | Templates can turn tracking off: Teamspace calls and vault writes are then refused, and skills that do them are refused at save and start (`orch skill-mark` corrects a wrong guess) |
| MCP servers | Runs start opensearch, jira, bitbucket and the mongodb servers, and never FM-MCP, aspire or mongodb-cluster |
| Skills | `app-test` (test in the app, one run at a time), `bug-logs` (find a client bug in the logs), `wrap-up` (push the vault, close the epic, commit the run's `Execution/` files, clean up) |
| Templates | `feature-template`, `bug-template` |
| The app | `orch app start` runs the ITP app from your checkout (AppHost or run-stack, Debug.json Global/Local DB, Mission, Outsider); runs take it in line in their "Test in the app" step |
| `/orch` | its ITP part (`orch.md`): your open Jira tickets, the app and its database, the ITP templates |

The core starter skills (`orch-plan`, `orch-build`, …) are not installed with this pack: ITP has its own.
