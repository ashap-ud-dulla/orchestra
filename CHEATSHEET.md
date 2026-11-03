# Orchestra cheat sheet

Remember two things: **`/orchestra`** in your main tab, **`next`** in a run's tab.

```
Main tab: /orchestra  ──starts──►  "orchestra" window (Alt+Tab): one tab per ticket
gives orders, shows the board      each run works there; right pane = its steps live
```

## Main tab (any Claude Code tab)

| Want | Type |
|---|---|
| Status + menu | `/orchestra` |
| Start feature tickets | `/orchestra start feature-template ITP2-15001 ITP2-15002` |
| Start a client bug | `/orchestra start bug-template ITP2-15003` (it searches the logs itself) |
| Start a job with no ticket | `/orchestra start feature-template "Add a Sweden row"` |
| Board (needs-you first) | `/orchestra runs` |
| One run in detail | `/orchestra run 14877` (part of a key or name works) |
| Who has the app | `/orchestra app` |
| Reopen tabs (after a restart) | `/orchestra reopen all` · `/orchestra reopen ITP2-14929` |
| Stop a run | `/orchestra stop 14877` |
| Space used | `/orchestra disk` |
| Clean one run (tab closed) | `/orchestra clean 14929` |
| Clean all finished runs | `/orchestra clean --done` |
| Change a template | `/orchestra templates`, then say it in plain words |
| Find skills | `/orchestra skills review` |
| Lessons to say yes/no to | `/orchestra learn` |
| Spend and stats | `/orchestra stats` |

Two runs work at once (`/orchestra settings max=3` to change). The rest wait in line.

## Run tab

| Type | What happens |
|---|---|
| `next` | Go on after a step that waits for you |
| `redo` | Run the current step again |
| `pin` | Keep Claude's last answer in the right pane (`pin 2` = the answer before) |
| `pin: your note` | Keep your own note there |
| `unpin` | Remove the pin the pane shows (`unpin 2`, `unpin all`) |
| anything else | Normal chat with that run's Claude |

**Right pane:** steps on top, pins below. Claude pins test steps by itself. Click the pane, then
↑ ↓ PgUp PgDn or the mouse wheel scroll the pin; ← → show other pins. Select text there with **Shift + drag**.
Wider pane: `/orchestra settings panesize=40` (new tabs).

## Wrap up (last step): type `next` when the ticket is fully done

1. It shows what waits: vault commits, ITP `Execution/` files, the epic, uncommitted work.
2. You tick jobs (any or none): **Push the vault** · **Close the epic** · **Commit + push the ITP files**.
3. You click **Allow** on each push.
4. You pick: **Yes, clean** (close the tab, it cleans by itself) · **Keep the folder** · **Not yet** (`next` later).

No PR is assumed. Pushes to `main` (vault, ITP folder) work only inside this step.

## Step options (in templates)

| Option | Means |
|---|---|
| wait | Stops after the step until you type `next` |
| app | The step starts the app (one run at a time) |
| explain | After the step, it walks you through the code changes |
| fresh | The step starts a new conversation: much cheaper, it gets a summary of the steps before |
| model | `opus` (thinking) or `sonnet` (code). A step with none keeps the one before |
| effort | `low` … `max`; `ultracode` = many helper AIs, deep but costly |
| tracking off | The run may not call Teamspace or write the vault |

## Good habits

- Start tickets in a batch, then walk away. The queue handles the order.
- Back at your desk: `/orchestra runs`. What needs you is on top.
- Put **wait** before risky steps (push, PR).
- End every template with **Wrap up**.
- Cleaning keeps branches, notes and stats. It never drops uncommitted work unless you say so.
