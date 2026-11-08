---
name: intake
description: Orchestra step "Pick the task and the steps", the first step of a run. Finds the task (a Jira key or link, a job in plain words; nothing given: asks or lists your Jira tickets), reads it into .orchestra/task.md, then suggests the steps that fit (one of your templates, changed for this task, heavy steps marked, with a cost and time estimate), asks, and puts the agreed steps into the run. Use as a run's first step.
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
say so in one line and suggest an order ("do this after ITP2-15005's build") or doing them as one. The user decides;
never change another run.

## 2. The steps

1. `orch templates`, then `orch template show <id>` for the ones that may fit. Pick the one that fits the task best.
2. Suggest changes for this task, each with a one-line reason (a step that does not apply, one that is missing:
   find skills with `orch skills <words>`).
3. **Heavy steps** (they build, run the app, or run big tests: they use disk, memory and CPU): `orch skills` shows a
   Heavy mark per skill. For a skill with no mark, read its SKILL.md, decide, and keep it: `orch skill-mark <skill>
   heavy` or `light`. Only heavy steps wait for a free slot when several runs work.
4. **Estimate**: `orch stats --json` → `skills[]` has `avgCost` and `avgMs` per skill. Add them up for the steps you
   suggest: "about $X and Y hours". Name the steps with no history yet.
5. **Show and ask**: a numbered list (label, skill, heavy, wait, model), the changes with their reasons, the estimate.
   Ask **Go with these steps?** with **Yes** · **Change them**. The user changes them in plain words; show the list again
   until yes.
6. **Put them in**: `orch use this <template>`, then one `orch steps this add|remove|set|move …` per change (`set
   <step> heavy=on`, `add <skill> after=<step> label="…"`, …). Check with `orch run this`.
7. If the steps changed a lot from the template, ask once: **Save these steps as a new template?** Yes: `orch template
   from this <short-id> name="<name>"`.

## 3. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (only when the task has a key: the run takes it as its name);
- `ORCHESTRA:PLAN suggested: <labels of the template's steps, joined with >> | chosen: <labels of the steps put in>`;
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
