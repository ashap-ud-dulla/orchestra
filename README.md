# Orchestra

Orchestra runs your tickets with Claude Code: one ticket per terminal tab, step by step, several at once, while you
do other work. You remember one command, `/orch`, and talk in plain words.

**Before:** you open Claude Code, paste the ticket, ask for a plan, wait, say "go", wait, ask for a review, start the
app to test, push, open the PR, clean up the branch folders, and keep all of it in your head for every ticket at once.
Two tickets in parallel step on each other's branch and app.

**With Orchestra:** you type `/orch`, pick your tickets from a numbered list (`1, 3, 4`), and walk away. Each ticket
gets its own Windows Terminal tab and its own git worktree (a separate copy of your code, so runs never step on each
other or on your checkout). Each run reads its ticket, suggests the steps that fit (your template, changed for this
ticket, with a cost and time estimate) and asks you. Then the steps run one after another. Orchestra notifies you only
when it needs you: an "Allow?" prompt, a question, a "type next" gate, or a failure.

```
your Claude tab:  /orch …        ──►  "orchestra" window (Alt+Tab): one tab per ticket
                  /orch status         left: the run's Claude · right: its steps, live
```

## Set it up (10 minutes)

### 1. What you need

| Tool | Check it | Get it |
|---|---|---|
| Windows 10/11 with Windows Terminal | `wt -v` | Microsoft Store: "Windows Terminal" |
| Node 22 or newer | `node -v` | [nodejs.org](https://nodejs.org) |
| Git (with Git Bash) | `git --version` | [git-scm.com](https://git-scm.com) |
| Claude Code, logged in | `claude --version` | [Claude Code](https://docs.claude.com/en/docs/claude-code) |

No npm install: Orchestra has no packages.

### 2. Get the code

```
git clone https://github.com/ashap-ud-dulla/orchestra.git
cd orchestra
```

Put it anywhere. (The repo is private: ask the owner for access.)

### 3. Run setup

Name your **solution folder**: the folder with your repos, or a single repo. It is optional.

```
node bin/orch.mjs setup solution=C:/code/my-app
```

Setup prints what it did: the pack it picked for your solution (if any), the skills it installed into
`~/.claude/skills`, where run folders go (`C:/o`), your email (from git), and any tool that is missing.

> **ITP developers:** use your ITP workspace folder, for example
> `node bin/orch.mjs setup solution=C:/Workstation/Workspace/ITP`. Setup sees ITP's `scripts/lib/common.sh` and turns
> on the ITP pack: work orders, the vault, the ITP app, the ITP templates. See [packs/itp/README.md](packs/itp/README.md).

### 4. Try it

Open Claude Code (any folder) and type:

```
/orch
```

You get the status of your runs and "Work on something new?". Say yes: you see a numbered list of what you hold
(your Jira tickets if the Atlassian tools are connected; your solution's own list when its pack has one, like ITP
work orders). Type the numbers, or paste keys (`/orch ABC-12, ABC-15`), or a job in words (`/orch "add a Sweden row"`).

A cheap first test with no pack: `/orch start hello "world"`.

### 5. After a `git pull`

Run `node bin/orch.mjs setup` again. It refreshes the skills (`/orch status` reminds you when they changed).

## Using it every day

The [cheat sheet](CHEATSHEET.md) has it all on one page. The short version:

| Want | Say |
|---|---|
| Start work | `/orch` → yes → `1, 3` · or `/orch ABC-12, ABC-15` |
| What's going on | `/orch` · `/orch what needs me?` · `/orch how is ABC-12?` |
| Move a run | `/orch go back to build on ABC-12, the review found a null check` |
| Hand a ticket over | `/orch hand ABC-12 to Sam` (skips to Wrap up, which writes a handover note) |
| Free disk space | `/orch clean my finished runs` |

In a run's tab, just talk to it. `next`, `skip` and `redo` move it; `/orch model opus` changes the model of the step.

## What setup changes on your PC

| What | Where | Undo |
|---|---|---|
| Orchestra's skills (`orch`, `intake`, `wrap-up`, and the core starters or your pack's) | `~/.claude/skills` | `node bin/orch.mjs setup uninstall=yes` |
| Your settings, templates, rules, lessons | `data/` in this folder (not in git) | delete the folder |
| Run records | `runs/` in this folder (not in git) | `orch delete <run>` |
| Run workspaces (git worktrees) | `C:/o` (or `worktrees=<folder>`) | `orch clean done` |
| A link for clicking notifications | your Windows user's registry (no admin) | `setup uninstall=yes` |

## Safe by design

- **Your checkout is never touched.** Every run works in its own git worktree under `C:/o`. Edits to your own
  checkout from a run are refused.
- **Every push asks you.** Each push shows you an Allow prompt first, a push to `main`/`master` too (Orchestra's
  git hooks are set through environment variables only; nothing is written into your repos). A run works on its own
  branch and goes to main only when you ask.
- **Nothing is cleaned without you.** A run's folder goes only when you say so; branches, notes and stats stay.
- **One app at a time.** When a pack can start your app, runs wait in line for it; your own running app is never
  stopped without your OK.

## Make it fit your project: packs

The core knows no project. With no pack it still works: repos are found in your solution folder, runs use the core
starter skills and templates, and the pick list shows your Jira tickets. A **pack** (`packs/<name>/`) adds what only
your project knows. Every field is optional; `lib/pack.mjs` lists them all with their defaults.

| Field | What it adds |
|---|---|
| `detect(folder)` | Setup picks this pack when it returns true for the solution folder |
| `repoDirs(root, helpers)` | Where your repos are (else found in the folder) |
| `defaultBases` | The branch new runs start from, when your checkout is not on a development branch |
| `rules`, `mainRule` | Extra rules every run follows |
| `mine(root, helpers)` | `orch mine`: the work you hold in your own tracker, read only → `{ items: [{ key, title, state, kind }] }` |
| `tracking` | What "tracking off" keeps runs away from (your tracker's commands, your notes folder) |
| `mainOkDirs`, `wrapUpPushDirs`, `wrapUpCommitOnly` | Folders the team keeps on `main`, and what the Wrap up step may push there |
| `app: { script, stopFor }` | Your app: a script that starts, stops and checks it (`orch app …`, the "Test in the app" step) |
| `settings` | Your own `orch settings name=value` options |
| `skills/`, `templates/`, `orch.md` | Your steps, your workflows, and your part of `/orch` |

A small pack, `packs/acme/pack.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';

export default {
  about: 'the Acme monorepo',
  detect: (folder) => fs.existsSync(path.join(folder, 'acme.workspace.json')),
  defaultBases: ['origin/develop'],
  rules: ['Run `npm test` in the package you changed before you say a step is done.'],
  protectDefaultBranch: false, // our default branch is develop, where work branches start
};
```

Then `node bin/orch.mjs setup solution=C:/code/acme`. The ITP pack ([packs/itp](packs/itp)) is a full example: repos
from ITP's own script, work orders from Teamspace, the vault, and the ITP app.

**The rule:** nothing project-specific goes into the core (`lib/`, `bin/`, `skills/`, `defaults/`). A test fails if it
does. Project knowledge lives in its pack.

## Tests

`node test/smoke.mjs` runs every test with a fake `claude` (no tokens spent, nothing of your PC is read).
`node test/smoke.mjs <words>` runs only the tests whose name has one of the words.
