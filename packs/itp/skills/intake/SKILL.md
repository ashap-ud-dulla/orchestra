---
name: intake
description: Orchestra step "Pick the task", the first step of an ITP run. Works out where the run's task comes from (a Teamspace Work Order the user holds, a Jira ticket, or a job in plain words; nothing given: lists the Work Orders the user holds and their open Jira tickets to pick from), reads it, writes it to .orchestra/task.md for the later steps, and names the run after its key. Read only. Use as the first Orchestra template step.
---

# Pick the task

You are the first step of an Orchestra run, in the run's own terminal tab. The words after the command are what the
run was given: a Work Order key (`<SOL>-W-NNN`, like `TSP-W-001`), a Jira key or link, a job in plain words, or
nothing.

Read only, everywhere: never change a Work Order (no state move, no pick, no comment) and never write to Jira.
If tracking is OFF for this run, Teamspace calls are refused: then skip Teamspace, and ask for the key or the job.

## 1. Find the task

| Given | Do |
|---|---|
| A Work Order key (`TSP-W-001`) | Read it as `/plan-itp --wo` does: `GET /api/work-orders/<KEY>` with the team's `teamspace` CLI. Check it is **held by the user** (`holderId` or `pairId` is their member id; state Picked or later). Not held: say so (it must be dragged into In Progress, or the user added as its pair) and ask whether to go on reading it anyway. If the server cannot be reached: read the vault copy `ITPKV/3. Planning/Work Orders/<KEY>.md` (read only) and say it may be out of date. |
| A Jira key or link | Read it with the Atlassian tools (cloudId `orbitax.atlassian.net`): summary, description, status, comments, attachment names, parent epic. |
| Plain words (a job) | That is the task. Ask one short question only if it is too vague to start. |
| Nothing | List what the user holds and ask which (AskUserQuestion, up to 4 options; they can type any key or a job in "Other"): the Work Orders they hold (`teamspace member-open-work <their email> --json`, read only; their email is in `git config user.email`), then their open Jira tickets (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`). Show a short table first: key, title, state. |

## 2. Write it down

Write `.orchestra/task.md` in the current folder (make the folder):

```
# <KEY> — <title>
Source: Work Order <KEY> (Solution <SOL>, Feature <F>) | Jira <KEY> <link> | your words
State: …

## The task
<a Work Order: its spec in full (Problem, Who is affected, What should happen, Acceptance criteria, Out of scope,
Context, Notes for the picker); a Jira ticket: its description; a job: the user's words>

## Comments
## Attachments
## For the plan
<a Work Order: "Plan with /plan-itp --wo <KEY>" (it links the plan to the Work Order)>
```

## 3. Check it with the user

Show a short summary (what has to change, in 2 to 4 lines) and ask **Is this the task?** with **Yes** · **No, it is
something else**. Change it until the user says yes.

## 4. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (the run takes the key as its name);
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
