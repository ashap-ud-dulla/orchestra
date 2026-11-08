---
name: wrap-up
description: Orchestra step "Wrap up", the last step of a run. Shows what is still waiting (vault commits not pushed, the ITP folder's Execution files, the epic, uncommitted work), lets the user pick which jobs to do (push the vault, close the epic, commit and push the ITP files), does them, and asks whether to clean up the run when its tab closes. Never assumes a PR. Use as the last Orchestra template step.
---

# Wrap up

You are the last step of an Orchestra run, in the run's own terminal tab. The user decides everything here: look,
show, ask, then do only what they picked. Never assume there is a PR: some runs have none and still have vault notes
or Execution files to push.

Orchestra's prompt gave you: the epic folder (or "not known"), the PR links (or "none seen"), this run's repos, the
vault path (`<ITP>/ITPKV`) and the ITP folder path (`<ITP>`, the itp-workspace repo, on `main`), and whether tracking
is off. Use those paths as given.

Plain, simple English. Short sentences. Tables for lists.

## 0. Handing over?

If Orchestra's prompt says the user went straight to this step to hand the work over (a reason like "handing over
to Samiul"), first write `.orchestra/handover.md` and show it, so the user can paste it to that person:
- **The task**: its key and title, in one line (from `.orchestra/task.md` when it is there).
- **What was found**: the cause, the trace, the decisions so far (from the steps' notes and the files on disk).
- **What is done**: the steps that finished, and what each left (plan, epic, code on which branch, tests).
- **What is left**: the steps that were skipped, and anything open.
- **Where things are**: branches and PR links, the epic folder, notes and trace files.

Never post it anywhere by yourself (no Jira or Teamspace comment). Then go on with the usual jobs below.

## 1. Look (read only) and show

Find the epic folder if Orchestra did not know it: look in this conversation (the manifest name
`Execution/<epic-folder>.json`, or a `close-epic.sh <epic-folder>` line). If there is none, say so: that is fine.

Run these (Bash, read only) and show one short table, "Waiting" / "Nothing to do" per row:

| Row | Check |
|---|---|
| Vault | `git -C <ITP>/ITPKV status --porcelain` (not committed) and `git -C <ITP>/ITPKV log --oneline @{u}..` (not pushed) |
| ITP folder | `git -C <ITP> status --porcelain -- "Execution/<epic-folder>.json" "Execution/<epic-folder>/"` and `git -C <ITP> log --oneline @{u}.. -- Execution/` |
| Epic | the epic folder, and the PR link(s) if any. Closing it is only right after its PR merged on Bitbucket |
| Run repos | `git status --porcelain` in each run worktree (uncommitted work) |

Only this run's epic counts in the ITP folder. Other Execution files there belong to other runs: list them in one
line ("also waiting, not this run's: …"), never touch them.

## 2. Ask what to do

Ask with **AskUserQuestion**, `multiSelect: true`, "What should I do?". Offer only the jobs that have something
waiting:
- **Push the vault**: commits not pushed (and, if there are uncommitted vault changes, say so in the description:
  you would commit them first, only the files you list).
- **Close the epic**: description "Only after its PR is merged". Never offer it when tracking is off.
- **Commit + push the ITP files**: this epic's `Execution/` files.

If nothing is waiting, skip this question. Ticking nothing is fine: do no job.

## 3. Do the picked jobs, in this order

`close-epic.sh` refuses until the vault is pushed, so the vault always goes first.

1. **Vault.** If there are uncommitted vault changes and the user picked this job: show them, commit them in one
   commit (`git -C <ITP>/ITPKV add <those files>` then `commit -m "<epic or ticket>: vault notes"`). Then say what
   you push (repo, branch, commits) and run `git -C <ITP>/ITPKV push`. The user clicks Allow.
2. **Epic.** From the current folder: `bash scripts/close-epic.sh <epic-folder>`. Show its summary. It may update the
   manifest, so it runs before step 3.
3. **ITP folder.** Stage only this epic's files:
   `git -C <ITP> add "Execution/<epic-folder>.json" "Execution/<epic-folder>/"`, then
   `git -C <ITP> commit -m "chore(execution): <epic-folder> manifest + run records"`, then say what you push and run
   `git -C <ITP> push`. The user clicks Allow. Never stage anything outside `Execution/` (the commit is refused).

A job fails (refused, rejected, script error): show the reason in one line, and ask whether to go on with the other
jobs or stop here. A push rejected because the remote moved on: `git -C <repo> pull --rebase`, then push again
(ask first).

## 4. Uncommitted work in the run repos

If a run worktree has uncommitted files: show them and ask **Keep them (no clean)** · **Throw them away**.
- Throw them away: `git restore --staged --worktree .` and `git clean -fd` in that worktree only.
- Keep them: the folder must stay, so in step 5 only **Keep the folder** and **Not yet** make sense.

## 5. Ask about the clean-up

Ask "Clean up this run when you close the tab?":
- **Yes, clean**: the run's folder, its processes, git's records, merged branches and the conversation files go
  when the tab closes. Branches with work, notes and stats stay.
- **Keep the folder**: nothing is removed. It can be cleaned later from `/orch`.
- **Not yet**: the user comes back later.

## 6. End

Show a short table of what you did (job, result). Then:
- **Yes, clean**: tell the user "All done. Close this tab to finish: Orchestra then cleans up the run." End with the
  WHAT I DID AND WHY section and the line `ORCHESTRA:DONE`.
- **Keep the folder**: say the folder stays. End with the WHAT I DID AND WHY section, then a line `ORCHESTRA:KEEP`,
  then the line `ORCHESTRA:DONE`.
- **Not yet**: say "Type next when you are ready, and I run the wrap-up again." End with neither line.

## Rules

- Never push or commit anything the user did not pick. Never touch other runs' Execution files.
- Pushing the vault and the ITP folder to `main` works only in this step; code repos never push to `main`.
- Never delete branches yourself: Orchestra deletes the ones git sees as merged when it cleans up.
