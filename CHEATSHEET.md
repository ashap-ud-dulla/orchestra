# Orchestra cheat sheet

Remember one thing: **`/orch`**, then say what you want in plain words. In a run's tab, just talk.

```
Main tab: /orch …  ──opens──►  "orchestra" window (Alt+Tab): one tab per ticket
                                  each run plans itself there; right pane = its steps live
```

## Main tab (any Claude Code tab)

| Want | Say |
|---|---|
| Start work | `/orch ABC-12, ABC-15, XYZ-3` (paste keys, links, or "a job in words") |
| Pick from what you hold | `/orch` → "Work on something new?" → yes: a numbered list of what you hold (your tracker's list from the pack, Jira tickets); type "1, 3, 4" |
| What's going on | `/orch` · `/orch what needs me?` · `/orch how is ABC-12?` |
| Move a run | `/orch go back to build on ABC-12, the review found a null check` · `/orch skip to wrap up on XYZ-3` |
| Hand over | `/orch hand XYZ-3 to Sam` (it skips to Wrap up, which writes a handover note) |
| More at once | `/orch run up to 5 heavy steps at once` |
| Clean up | `/orch free some space` · `/orch clean my finished runs` |

**Each run plans itself.** Its first step reads the task (a ticket, your tracker's item, or your words), suggests the steps (your
template that fits, changed for this task, heavy steps marked, about $ and hours), and asks. Change them in plain
words. Every run opens at once; only heavy steps (builds, the app) wait for a free slot.

## Run tab

| Type | What happens |
|---|---|
| `next` | Go on: after a step that waits for you, or with a step that was cut off |
| `skip` | Mark the step done and move past it (on purpose) |
| `redo` | Run the step again from the start |
| `/orch go build fix the tests` | Go to any step at once. Back: it and the steps after run again. Forward: the steps between are skipped |
| `/orch model opus effort=high` | This step's model and effort (claude restarts on the same conversation) |
| `pin` · `pin 2` · `pin: your note` | Keep Claude's last answer (or the one before, or your note) in the right pane |
| `unpin` · `unpin 2` · `unpin all` | Remove pins |
| `/orch help` | What you can type now |
| `/orch steps` · `/orch runs` | Show them, without asking Claude (free) |
| Plain words ("go back to build", "hand this to Sam") | Claude says what will happen, asks yes/no for big moves, then Orchestra does it |
| anything else | Normal chat with that run's Claude |

**Right pane:** steps on top, pins below. Claude pins test steps by itself. Click the pane, then
↑ ↓ PgUp PgDn or the mouse wheel scroll the pin; ← → show other pins. Select text there with a plain drag.
Wider pane: `/orch settings panesize=40` (new tabs).

**Waiting for the app:** when another run has it, the tab stays free and the step starts by itself once the app is
free. Notifications come only when you are needed: an Allow prompt, a question, a `next` gate, a failure.

## Wrap up (last step): type `next` when the ticket is fully done

1. It shows what waits: uncommitted work, branches not pushed, PR links, and what your pack adds.
2. You tick jobs (any or none).
3. You click **Allow** on each push.
4. You pick: **Yes, clean** (close the tab, it cleans by itself) · **Keep the folder** · **Not yet** (`next` later).

No PR is assumed. Pushes to `main` (only folders your pack keeps on main) work only inside this step.

## Step options

| Option | Means |
|---|---|
| `wait=on` | Stops after the step until you type `next` |
| `app=on` | The step needs the app (one run at a time; it waits in line with its tab free) |
| `explain=on` | After the step, it walks you through the code changes |
| `fresh=on` | The step starts a new conversation: much cheaper, it gets a summary of the steps before |
| `model=…` | `opus` (thinking) or `sonnet` (code). A step with none keeps the one before |
| `effort=…` | `low` … `max`; `ultracode` = many helper AIs, deep but costly |
| `tracking=off` (template) | The run may not write to your tracker or its notes (when your pack has them) |

## Good habits

- Start tickets in a batch, then walk away. The queue handles the order.
- Back at your desk: `/orch runs`. What needs you is on top.
- Put `wait=on` before risky steps (push, PR).
- End every template with **Wrap up**.
- Cleaning keeps branches, notes and stats. It never drops uncommitted work unless you say so.

Your solution's pack adds its own part (ITP: [packs/itp/README.md](packs/itp/README.md)).
