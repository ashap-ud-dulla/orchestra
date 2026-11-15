---
name: wrap-up
description: Orchestra step "Wrap up", the last step of a run. Shows what is still waiting (uncommitted work, branches not pushed, PR links), lets the user pick which jobs to do (push a branch, open a pull request), does them, and asks whether to clean up the run when its tab closes. Never assumes a PR. Use as the last Orchestra template step.
---

# Wrap up

You are the last step of an Orchestra run, in the run's own terminal tab. The user decides everything here: look,
show, ask, then do only what they pick.

## 0. Handing over?

If Orchestra's prompt says the user went straight to this step to hand the work over (a reason like "handing over
to Samiul"), first write `.orchestra/handover.md` and show it, so the user can paste it to that person:
- **The task**: its key and title, in one line (from `.orchestra/task.md` when it is there).
- **What was found**: the cause, the trace, the decisions so far (from the steps' notes and the files on disk).
- **What is done**: the steps that finished, and what each left (plan, code on which branch, tests).
- **What is left**: the steps that were skipped, and anything open.
- **Where things are**: branches and PR links, notes and trace files.

Never post it anywhere by yourself (no ticket or tracker comment). Then go on with the usual jobs below.

## 1. Look

In each repo of the run (the worktrees in the current folder):
- `git status --porcelain`: uncommitted work;
- `git branch --show-current` and `git log --oneline @{u}..` (or, with no upstream, the commits on the branch):
  what is not pushed;
- the PR links Orchestra gave you (in the step's message), if any.
- **Merged?** For each repo with a branch: `git fetch origin <base>`, then `git merge-base --is-ancestor HEAD origin/<base>`
  (exit 0: merged). Else `git cherry origin/<base> HEAD`: when every line starts with `-`, merged (rebased). Else "not
  yet" when there is a PR link, "no PR opened" when there is none. A squash merge looks like "not yet": when the PR may be
  merged, ask the user (Merged · Not yet) instead of guessing. Say the answer in the table; it is a fact for the user, never
  a gate on the jobs.
- **PR links**: only this run's. A link whose branch is not one of this run's branches belongs to another run: leave it out.

## 2. Show and ask

Show a short table: repo, branch, not pushed, uncommitted, merged. Then ask which jobs to do (AskUserQuestion, multiSelect),
only the ones that make sense: **Push <branch>** · **Open a pull request** (with `gh pr create` when it is there, or
the link the push prints) · **Nothing**. Never assume a PR.

## 3. Do the picked jobs

One at a time. Pushing shows the user an Allow prompt: say what you push (repo, branch, commits) just before. A job
that fails: show the reason in one line, and ask whether to go on.

## 4. Uncommitted work

If a worktree has uncommitted files: show them and ask **Keep them (no clean)** · **Throw them away**. Keep: the
folder must stay, so in step 5 only **Keep the folder** and **Not yet** make sense.

## 4b. Save the steps as a template?

Only for a run that picked its steps one at a time (`orch run this` shows a **Guide:** line), and only when the steps it
picked differ from the guide's. Show the run's steps next to the guide's, with what was added, dropped or moved, then ask
once with AskUserQuestion: **Save as a new template** · **Update <guide>** · **No**. New: `orch template from this
<short-id> name="<name>"`. Update: `orch template from this <guide id> replace=yes` (it replaces that template; say so in the
option). Next runs that fit use it as their guide.

## 5. Ask about the clean-up

Ask "Clean up this run when you close the tab?":
- **Yes, clean**: the run's folder, its processes, git's records, merged branches and the conversation files go
  when the tab closes. Branches with work, notes and stats stay.
- **Keep the folder**: nothing is removed. It can be cleaned later from `/orch`.
- **Not yet**: the user comes back later.

## 6. End

Show a short table of what you did (job, result). Then:
- **Yes, clean**: say "All done. Close this tab to finish: Orchestra then cleans up the run." End with the WHAT I
  DID AND WHY section and the line `ORCHESTRA:DONE`.
- **Keep the folder**: say the folder stays. End with the WHAT I DID AND WHY section, then a line `ORCHESTRA:KEEP`,
  then the line `ORCHESTRA:DONE`.
- **Not yet**: say "Type next when you are ready, and I run the wrap-up again." End with neither line.

Rules: never push or commit anything the user did not pick; push to main only when the user asked
for it (it shows an Allow prompt); never delete branches yourself
(Orchestra deletes the ones git sees as merged when it cleans up).
