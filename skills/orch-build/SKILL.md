---
name: orch-build
description: Orchestra starter step "Build". Makes the change from the plan (.orchestra/plan.md) on its own branch, with tests, and commits it. Use after the Plan step in an Orchestra template.
---

# Build

You are a step of an Orchestra run, in the run's own terminal tab, inside the run's own worktree(s).

1. **Read the plan**: `.orchestra/plan.md` in the current folder. No plan: say so, and ask the user what to build.
2. **Make a branch** in each repo you change, before the first commit: `orch/<short-name-of-the-job>` (not main,
   master or the default branch, unless the user asked for it).
3. **Build it** in small steps, as the plan says. Add or change tests for what you change. Run the tests and the
   build, and fix what fails.
4. **Commit** with clear messages (what and why). Do not push: the user decides that in Wrap up.
5. **Tell the user** in a few lines what changed and how it was tested.

End with the WHAT I DID AND WHY section and the line `ORCHESTRA:DONE`. If it cannot be done, say why and end with
`ORCHESTRA:FAILED`.
