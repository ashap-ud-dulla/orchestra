---
name: intake
description: Orchestra step "Pick the task and the steps", the first step of an ITP run. Finds the task (a Teamspace Work Order the user holds, a Jira ticket, or a job in plain words; nothing given: lists the Work Orders the user holds and their open Jira tickets), reads it into .orchestra/task.md, then picks one of the user's templates as the guide (quietly), estimates the cost, and asks the user to pick the first step with a click; each step then asks for the next. Read only on Teamspace and Jira. Use as a run's first step.
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

**Say it early.** The user tells the tabs apart by the task's title. So the first reply after you have read the task ends
with these two lines, each on its own line, even when it asks something (say them once; the end repeats them):
- `ORCHESTRA:TASK <KEY> | <title>`
- `ORCHESTRA:ABOUT: <title> — <one short, plain sentence on what has to change>`

## 2. The steps: one at a time

The run picks its steps one at a time with the user: you pick only the **first** one. Each step then asks for the next.
A template is only a **guide**: it says the usual next step, so no one plans from scratch.

1. **The guide**: `orch templates`, then `orch template show <id>` for the ones that may fit (a bug: `bug-template`;
   a feature or a change: `feature-template`). Pick the one that fits best, without asking (the pane shows it; the
   user may say another). Set it: `orch use this <template> guide=yes`. `orch run this` then shows **Likely next**.
2. **Heavy steps** (they build, run the app, or run big tests: disk, memory, CPU): `orch skills` shows a Heavy mark
   per skill. For a guide skill with no mark, read its SKILL.md, decide, and keep it: `orch skill-mark <skill> heavy`
   or `light`. Only heavy steps wait for a free slot when several runs work.
3. **New skills**: `orch skills new --json` lists the team's skills that came since the user last looked (name,
   description). Read only those descriptions; open a skill's SKILL.md only when its description fits this task. One
   that fits is offered, marked **new skill**, in the pick where it belongs (now, or say in one line which later step it
   could replace or help; say if it reads as an early version, like a v2 or v3 still being tried). Say nothing about
   the ones that do not fit. Never mark them seen (`orch skills seen` is the user's).
4. **Estimate**, one line: `orch stats --json` → `skills[]` has `avgCost` and `avgMs` per skill. Add them up for the
   guide's steps: "the usual steps: about $X and Y hours". Name the steps with no history yet. Say in one line what
   this task likely will not need later (no screen change: no "Test in the app"; a log-only question: no build).
5. **Pick the first step** with AskUserQuestion (one question, a click): the guide's first step (Recommended), and one
   or two others that fit this task better if any (a later guide step when the first does not apply, a new skill, a
   skill found with `orch skills <words>`). Each option: label, one plain reason, model and effort. After the click:
   `orch steps this add <guide step id or skill>` (a guide step keeps its settings). Check with `orch run this`.

## 3. End

End with, each on its own line:
- `ORCHESTRA:TASK <KEY> | <title>` (the run takes the key as its name);
- `ORCHESTRA:PLAN suggested: <labels of the guide's steps, joined with >> | chosen: <label of the first step picked>`;
- the `ORCHESTRA:ABOUT:` line;
- the WHAT I DID AND WHY section and `ORCHESTRA:DONE`.
