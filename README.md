# Orchestra

Orchestra runs your tickets with Claude Code, one ticket per terminal tab, step by step, while you do other work.

**Before:** you open Claude Code, paste the ticket, ask for a plan, wait, say "go", wait, ask for a review, push,
open the PR, clean up the branch folders, and keep all of it in your head for every ticket at once.

**With Orchestra:** you type `/orch start plan-build-review ABC-123 ABC-124`. Each ticket gets its own Windows
Terminal tab and its own git worktree (a separate copy of your code). The steps run one after another (plan, build,
review, wrap up). Orchestra stops where you asked it to, and notifies you only when it needs you: an "Allow?"
prompt, a question, a "type next" gate, or a failure. You talk to each run in its tab like a normal Claude chat.

```
your Claude tab:  /orch start …  ──►  "orchestra" window: one tab per ticket
                  /orch runs           left: the run's Claude · right: its steps, live
```

## First run in 3 steps

Needs: Windows, [Node 22+](https://nodejs.org), Git, Windows Terminal (`wt`), Claude Code (`claude`, logged in).

1. Clone this repo anywhere.
2. Run setup, naming your solution folder (the folder with your repos, or a single repo). The folder is optional:
   ```
   node bin/orch.mjs setup solution=C:/code/my-app
   ```
3. In Claude Code, type `/orch`. To check that it works for almost no cost: `/orch start hello "world"`.

After a `git pull`, run setup again (`/orch status` reminds you when the skills changed).

## What setup changes on your PC

| What | Where | Undo |
|---|---|---|
| Orchestra's skills (`orch`, `orch-plan`, `orch-build`, `orch-review`, `wrap-up`, `orch-hello`) | `~/.claude/skills` | `orch setup uninstall=yes` |
| Your settings, templates, rules, lessons | `data/` in this folder (not in git) | delete the folder |
| Run records | `runs/` in this folder (not in git) | `orch delete <run>` |
| Run workspaces (git worktrees) | `C:/o` (or `worktrees=<folder>`) | `orch clean done` |
| A link for clicking notifications | your Windows user's registry (no admin) | `orch setup uninstall=yes` |

Your own checkout is never changed: every run works in its own worktree, and Orchestra's git hooks (set through
environment variables only) refuse any commit or push to `main` or `master` (with no pack, also the remote's default branch).

## Commands

`/orch help` lists them all (built from one list in `lib/cli/spec.mjs`). The ones you use most are in
[CHEATSHEET.md](CHEATSHEET.md). Options are always `key=value`, and a typo is answered with the right word.

## Packs: Orchestra for your kind of solution

The core knows no solution. A pack (`packs/<name>/`) teaches Orchestra about one: where its repos are, extra rules for
runs, the MCP servers runs use, folders that may be committed on main, its own skills and templates, a part for the
`/orch` skill (`orch.md`), and optionally an app that a step can start and hand to you. Setup picks the pack whose
`detect(folder)` knows your solution folder; with none, repos are found by themselves and there is no app.

To make one: copy `packs/itp/pack.mjs` as a starting point, keep the keys you need (every key is optional; see
`lib/pack.mjs` for the defaults and what each one does), and add `skills/` and `templates/` next to it.
The ITP pack's own notes: [packs/itp/README.md](packs/itp/README.md).

## Tests

`node test/smoke.mjs` runs every test with a fake `claude` (no tokens spent, nothing of your PC is read).
`node test/smoke.mjs <words>` runs only the tests whose name has one of the words.
