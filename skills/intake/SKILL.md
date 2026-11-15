---
name: intake
description: Orchestra step "Pick the task and the steps", the first step of a run. Finds the task (a Jira key or link, a job in plain words; nothing given: asks or lists your Jira tickets), reads it into .orchestra/task.md, then picks one of your templates as the guide (quietly), estimates the cost, and asks you to pick the first step with a click; each step then asks for the next. Use as a run's first step.
---

# Pick the task and the steps

You are the first step of an Orchestra run, in the run's own terminal tab. The words after the command are what the
run was given: a Jira key or link, a job in plain words, or nothing. Orchestra's command here is
`node {{ORCHESTRA}}/bin/orch.mjs` (below: `orch`); `this` means this run. These run with no Allow prompt.

## 1. The task

| Given | Do |
|---|---|
| A Jira key (`ABC-123`) or link | Read it with the Atlassian tools if connected (summary, description, status, comments, attachment names). Not connected: ask the user to paste it. |
| Plain words | That is the task. Ask one short question only if it is too vague to start. |
| Nothing | Ask what to work on; with the Atlassian tools, offer the user's open Jira tickets (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, the 4 newest as options). |

Read only: never change a ticket. Write `.orchestra/task.md` (make the folder): `# <KEY> — <title>`, `Source:`,
`## The task` (in full), `## Comments`, `## Attachments`.

**Overlap**: run `orch runs all --json`. If another open run (not cleaned) works on the same feature or the same code,
say so in one line and suggest an order ("do this after ABC-12's build") or doing them as one. The user decides;
never change another run.

**Say it early.** The user tells the tabs apart by the task's title. So the first reply after you have read the task ends
with these two lines, each on its own line, even when it asks something (say them once; the end repeats them):
- `ORCHESTRA:TASK <KEY> | <title>` (only when the task has a key)
- `ORCHESTRA:ABOUT: <title> — <one short, plain sentence on what has to change>`

## 2. The steps: one at a time

The run picks its steps one at a time with the user: you pick only the **first** one. Each step then asks for the next.
A template is only a **guide**: it says the usual next step, so no one plans from scratch.

1. **The guide**: `orch templates`, then `orch template show <id>` for the ones that may fit. Pick the one that fits
   the task best, without asking (the pane shows it; the user may say another). Set it: `orch use this <template>
   guide=yes`. `orch run this` then shows **Likely next**.
2. **Heavy steps** (they build, run the app, or run big tests: they use disk, memory and CPU): `orch skills` shows a
   Heavy mark per skill. For a guide skill with no mark, read its SKILL.md, decide, and keep it: `orch skill-mark
   <skill> heavy` or `light`. Only heavy steps wait for a free slot when several runs work.
3. **New skills**: `orch skills new --json` lists the team's skills that came since the user last looked (name,
   description). Read only those descriptions; open a skill's SKILL.md only when its description fits this task. One
   that fits is offered, marked **new skill**, in the pick where it belongs (now, or say in one line which later step it
   could replace or help). Say nothing about the ones that do not fit. Never mark them seen (`orch skills seen` is the
   user's).
4. **Estimate**, one line: `orch stats --json` → `skills[]` has `avgCost` and `avgMs` per skill. Add them up for the
   guide's steps: "the usual steps: about $X and Y hours". Name the steps with no history yet.
5. **Pick the first step** with AskUserQuestion (one question, a click): the guide's first step (Recommended), and one
   or two others that fit this task better if any (a later guide step when the first does not apply, a new skill, a
   skill found with `orch skills <words>`). Each option: label, one plain reason, model and effort. After the click:
   `orch steps this add <guide step id or skill>` (a guide step keeps its settings). Check with `orch run this`.

## 3. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (only when the task has a key: the run takes it as its name);
- `ORCHESTRA:PLAN suggested: <labels of the guide's steps, joined with >> | chosen: <label of the first step picked>`;
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
