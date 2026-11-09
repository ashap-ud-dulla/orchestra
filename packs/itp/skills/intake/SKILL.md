---
name: intake
description: Orchestra step "Pick the task and the steps", the first step of an ITP run. Finds the task (a Teamspace Work Order the user holds, a Jira ticket, or a job in plain words; nothing given: lists the Work Orders the user holds and their open Jira tickets), reads it into .orchestra/task.md, then suggests the steps that fit (one of the user's templates, changed for this task, heavy steps marked, with a cost and time estimate), asks, and puts the agreed steps into the run. Read only on Teamspace and Jira. Use as a run's first step.
---

# Pick the task and the steps

You are the first step of an Orchestra run, in the run's own terminal tab. The words after the command are what the
run was given: a Work Order key (`<SOL>-W-NNN`, like `TSP-W-001`), a Jira key or link, a job in plain words, or
nothing. Orchestra's command here is `node {{ORCHESTRA}}/bin/orch.mjs` (below: `orch`); `this` means this run. These
run with no Allow prompt.

Read only, everywhere: never change a Work Order (no state move, no pick, no comment) and never write to Jira. If
tracking is OFF for this run, Teamspace calls are refused: then skip Teamspace and ask for the key or the job.

**Reading Teamspace** (the way the team skills do; there is no `teamspace` command on the PATH): in Bash, from the run
folder, `source scripts/lib/common.sh`, then `registry_call GET <path>`. It prints the HTTP status; the answer is in
the file `$REGISTRY_BODY` (`cat "$REGISTRY_BODY"`). Only `GET`, never another method. Status `000` or no registry
configured: the server is not reachable from here; say so in one line.
- Who you are: `GET /api/me` → your member `id`.
- What you hold: `GET /api/members/<id>/working-on` → `items`: the Work Orders you hold or pair on, not Done or
  Cancelled.
- One Work Order: `GET /api/work-orders/<KEY>`, plus `/comments`, `/acceptance` and `/issues` under it.

## 1. The task

| Given | Do |
|---|---|
| A Work Order key | Read it (**Reading Teamspace** above): the Work Order, its comments, acceptance tests and issues. Check it is **held by the user** (`holderId` or `pairId` is their member id; state Picked or later). Not held: say so (drag it into In Progress, or be added as its pair) and ask whether to go on reading it anyway. Server not reachable: read the vault copy `ITPKV/3. Planning/Work Orders/<KEY>.md` (read only) and say it may be out of date. |
| A Jira key or link | The Atlassian tools (cloudId `orbitax.atlassian.net`): summary, description, status, comments, attachment names, parent epic. |
| Plain words | That is the task. Ask one short question only if it is too vague to start. |
| Nothing | Show a short table (key, title, state) of the Work Orders the user holds (`GET /api/me`, then `GET /api/members/<id>/working-on`) and their open Jira tickets (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`), then ask which (AskUserQuestion, up to 4; any key or a job in words in "Other"). |

Write `.orchestra/task.md` (make the folder): `# <KEY> — <title>`, `Source:` (Work Order with Solution and Feature /
Jira with link / your words), `State:`, `## The task` (a Work Order's spec in full: Problem, Who is affected, What
should happen, Acceptance criteria, Out of scope, Context, Notes for the picker; a ticket's description; the job),
`## Comments`, `## Attachments`, and for a Work Order `## For the plan`: "Plan with /plan-itp --wo <KEY>".

**Overlap**: run `orch runs all --json`. If another open run (not cleaned) works on the same feature or the same code
(the same form, screen, Solution or Feature), say so in one line and suggest an order ("do this after ITP2-15005's
build") or doing them as one. The user decides; never change another run.

## 2. The steps

1. `orch templates`, then `orch template show <id>` for the ones that may fit (a bug: `bug-template`, it starts by
   searching the logs; a feature or a change: `feature-template`). Pick the one that fits best.
2. Suggest changes for this task, each with a one-line reason (no screen change: no "Test in the app"; a log-only
   question: no build; a missing step: find it with `orch skills <words>`).
3. **Heavy steps** (they build, run the app, or run big tests: disk, memory, CPU): `orch skills` shows a Heavy mark
   per skill. For a skill with no mark, read its SKILL.md, decide, and keep it: `orch skill-mark <skill> heavy` or
   `light`. Only heavy steps wait for a free slot when several runs work.
4. **Estimate**: `orch stats --json` → `skills[]` has `avgCost` and `avgMs` per skill. Add them up for the steps you
   suggest: "about $X and Y hours". Name the steps with no history yet.
5. **Show and ask**: a numbered list (label, skill, heavy, wait, model), the changes with their reasons, the estimate.
   Ask **Go with these steps?** with **Yes** · **Change them**. The user changes them in plain words; show the list again
   until yes.
6. **Put them in**: `orch use this <template>`, then one `orch steps this add|remove|set|move …` per change (`set
   <step> heavy=on`, `remove <step>`, `add <skill> after=<step> label="…"`). Check with `orch run this`.
7. If the steps changed a lot from the template, ask once: **Save these steps as a new template?** Yes: `orch template
   from this <short-id> name="<name>"`.

## 3. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (the run takes the key as its name);
- `ORCHESTRA:PLAN suggested: <labels of the template's steps, joined with >> | chosen: <labels of the steps put in>`;
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
