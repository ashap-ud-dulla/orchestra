# Orchestra cheat sheet

Remember two things: **`/orch`** in your main tab, **`next`** in a run's tab.

```
Main tab: /orch  ──starts──►  "orchestra" window (Alt+Tab): one tab per ticket
gives orders, shows the board      each run works there; right pane = its steps live
```

Options are always `key=value` (`wait=on`, `model=opus`, `force=yes`). A typo is answered with the right word.
Everything: `/orch help`.

## Main tab (any Claude Code tab)

| Want | Type |
|---|---|
| Status + menu | `/orch` |
| Start tickets | `/orch start feature-template ITP2-15001 ITP2-15002` |
| Start a client bug | `/orch start bug-template ITP2-15003` (it searches the logs itself) |
| Start a job with no ticket | `/orch start feature-template "Add a Sweden row"` (quoted) |
| A ticket that has a run already | add `again=yes` |
| Board (who needs you first) | `/orch runs` (`/orch runs all`: cleaned runs too) |
| One run | `/orch run 14877` (short) · `/orch run 14877 full=yes` (notes, PR links, activity) |
| Go on / skip / redo from here | `/orch next 14877` · `/orch skip 14877` · `/orch redo 14877` |
| Its steps | `/orch steps 14877` · `… add app-test after=build wait=on` · `… set review model=opus` · `… remove 5` · `… move review to=3` |
| A template's steps | the same: `/orch steps feature-template …` |
| Go back to a step | `/orch back 14877 build fix the review findings` |
| Model of the step now | `/orch model 14877 opus effort=high` |
| Who has the app | `/orch app` |
| Reopen tabs (after a restart) | `/orch reopen all` · `/orch reopen 14929` |
| Stop a run | `/orch stop 14877` |
| Space used | `/orch disk` |
| Clean one run (tab closed) | `/orch clean 14929` |
| Clean all finished runs | `/orch clean done` |
| Find skills | `/orch skills review` |
| Lessons to say yes/no to | `/orch suggestions` |
| Spend and stats | `/orch stats` |

Three runs work at once (`/orch settings max=2` to change). The rest wait in line and start by themselves.

## Run tab

| Type | What happens |
|---|---|
| `next` | Go on: after a step that waits for you, or with a step that was cut off |
| `skip` | Mark the step done and move past it (on purpose) |
| `redo` | Run the step again from the start |
| `/orch back build fix the tests` | Go back to a finished step, and start it again at once |
| `/orch model opus effort=high` | This step's model and effort (claude restarts on the same conversation) |
| `pin` · `pin 2` · `pin: your note` | Keep Claude's last answer (or the one before, or your note) in the right pane |
| `unpin` · `unpin 2` · `unpin all` | Remove pins |
| `/orch help` | What you can type now |
| `/orch steps` · `/orch runs` | Show them, without asking Claude (free) |
| anything else | Normal chat with that run's Claude |

**Right pane:** steps on top, pins below. Claude pins test steps by itself. Click the pane, then
↑ ↓ PgUp PgDn or the mouse wheel scroll the pin; ← → show other pins. Select text there with a plain drag.
Wider pane: `/orch settings panesize=40` (new tabs).

**Waiting for the app:** when another run has it, the tab stays free and the step starts by itself once the app is
free. Notifications come only when you are needed: an Allow prompt, a question, a `next` gate, a failure.

## Wrap up (last step): type `next` when the ticket is fully done

1. It shows what waits: vault commits, ITP `Execution/` files, the epic, uncommitted work.
2. You tick jobs (any or none): **Push the vault** · **Close the epic** · **Commit + push the ITP files**.
3. You click **Allow** on each push.
4. You pick: **Yes, clean** (close the tab, it cleans by itself) · **Keep the folder** · **Not yet** (`next` later).

No PR is assumed. Pushes to `main` (vault, ITP folder) work only inside this step.

## Step options

| Option | Means |
|---|---|
| `wait=on` | Stops after the step until you type `next` |
| `app=on` | The step needs the app (one run at a time; it waits in line with its tab free) |
| `explain=on` | After the step, it walks you through the code changes |
| `fresh=on` | The step starts a new conversation: much cheaper, it gets a summary of the steps before |
| `model=…` | `opus` (thinking) or `sonnet` (code). A step with none keeps the one before |
| `effort=…` | `low` … `max`; `ultracode` = many helper AIs, deep but costly |
| `tracking=off` (template) | The run may not call Teamspace or write the vault |

## Good habits

- Start tickets in a batch, then walk away. The queue handles the order.
- Back at your desk: `/orch runs`. What needs you is on top.
- Put `wait=on` before risky steps (push, PR).
- End every template with **Wrap up**.
- Cleaning keeps branches, notes and stats. It never drops uncommitted work unless you say so.
