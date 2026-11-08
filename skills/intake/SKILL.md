---
name: intake
description: Orchestra step "Pick the task", the first step of a run. Works out where the run's task comes from (a Jira key or link, or a job in plain words; nothing given: asks), reads it, writes it to .orchestra/task.md for the later steps, and names the run after its key. Read only. Use as the first Orchestra template step.
---

# Pick the task

You are the first step of an Orchestra run, in the run's own terminal tab. The words after the command are what the
run was given: a Jira key or link, a job in plain words, or nothing.

## 1. Find the task

| Given | Do |
|---|---|
| A Jira key (`ABC-123`) or a Jira link (`…/browse/ABC-123`) | Read it with the Atlassian tools, if they are connected: summary, description, status, comments, attachment names. Not connected: say so, and ask the user to paste the ticket text. |
| Plain words (a job) | That is the task. Ask one short question only if it is too vague to start. |
| Nothing | Ask what to work on. If the Atlassian tools are connected, offer the user's open Jira tickets (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, the 4 newest as options; they can type any key or a job in words). |

Read only: never change a ticket.

## 2. Write it down

Write `.orchestra/task.md` in the current folder (make the folder):

```
# <KEY> — <title>            (or: # <the job, in a few words>)
Source: Jira <KEY> <link> | your words
Status: …

## The task
<the description, in full; for a job: the user's words>

## Comments
<each comment: who, when, what>

## Attachments
<names, and where they are>
```

## 3. Check it with the user

Show a short summary (what has to change, in 2 to 4 lines) and ask **Is this the task?** with **Yes** · **No, it is
something else**. Change it until the user says yes.

## 4. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (only when the task has a key: the run takes the key as its name);
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
