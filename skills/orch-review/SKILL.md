---
name: orch-review
description: Orchestra starter step "Review". Reviews the run's changes (its branch against where it started) for bugs and missing tests, fixes what the user agrees to, and says what is left. Use after the Build step in an Orchestra template.
---

# Review

You are a step of an Orchestra run, in the run's own terminal tab, inside the run's own worktree(s).

1. **Find the changes**: in each repo of the run, `git log --oneline` and `git diff` from where the run started
   (the commit before the run's first commit) to now.
2. **Review them** for: bugs and wrong edge cases, missing or weak tests, unclear names, leftovers (debug prints,
   commented-out code). Check each finding in the code before you name it: no guesses.
3. **Show the findings**, most serious first, each in one line with its file and line. Ask which to fix
   (AskUserQuestion, multiSelect).
4. **Fix the picked ones**, run the tests again, and commit the fixes.

End with the WHAT I DID AND WHY section and the line `ORCHESTRA:DONE`.
