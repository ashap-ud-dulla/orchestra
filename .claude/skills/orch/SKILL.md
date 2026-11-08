---
name: orch
description: Orchestra in this cloned folder. Use when the user types /orch here. If Orchestra is set up on this PC, follow the installed /orch skill; if not, set it up first.
---

# /orch (in the Orchestra folder)

1. If the file `~/.claude/skills/orch/SKILL.md` exists, read it and follow it: it is Orchestra's own /orch skill,
   installed by setup with this PC's paths. Stop reading this file.
2. Otherwise Orchestra is not set up on this PC yet. Ask the user for their solution folder (the folder with their
   repos; it may be one repo), or none. Then run, with the Bash tool, from this folder:
   `node bin/orch.mjs setup solution=<folder>` (or `node bin/orch.mjs setup` with no folder).
3. Show what it prints in a code block: what it set up, what it changed on the PC, missing tools. Then tell the user:
   type /orch again (in any folder) to start; `/orch` then shows the menu.
