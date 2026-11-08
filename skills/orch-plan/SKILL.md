---
name: orch-plan
description: Orchestra starter step "Plan". Reads the job (a ticket key, a link, or a job in words), looks at the code, and writes a short plan the user checks before any code changes. Use as the first step of an Orchestra template.
---

# Plan

You are a step of an Orchestra run, in the run's own terminal tab. The job is in the first message (a ticket key, a
link, or a job in plain words).

1. **Understand the job.** If it is a ticket and you have a tool to read it, read it. If something is not clear, ask
   the user (one question at a time, AskUserQuestion when there are choices).
2. **Look at the code.** Find where the change goes: the files, the functions, how it is tested today. Read; do not
   change anything yet.
3. **Write the plan** to `.orchestra/plan.md` in the current folder (make the folder):
   - the goal in one line;
   - the changes, file by file, in small steps;
   - how you will test it (the tests to add or run);
   - what you are not sure about.
4. **Show it**: the plan in short, then ask "Is this the plan?" with **Yes** · **Change it**. Change it until the
   user says yes.

End the step only when the user said yes, with the WHAT I DID AND WHY section and the line `ORCHESTRA:DONE`.

Rules: change no code in this step. Never commit.
