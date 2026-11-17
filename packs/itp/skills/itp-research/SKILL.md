---
name: itp-research
description: Research ONE part of ITP that you name (an ITP-API module like FilingManager, a feature like "CbC reports", or a route like /gmt) for performance issues, concurrency bugs, memory and resource leaks, security and tenant-isolation gaps, business problems (code vs the rules the vault records, what users keep hitting) and the pain points developers face (churn, reverts, test gaps, bounced PRs, repeat review findings). It confirms the part and the log scope with you, picks the hot-spot files, runs three read-only agents in parallel (itp-research-runtime, itp-research-security, itp-research-business), merges and ranks what they find, and writes one report to ~/itp-research/<module>/<date>.md. Read only on ITP - never writes to Teamspace, never touches ITPKV, never edits a repo. Use when someone says "/itp-research <module>", "research <module>", "what's wrong with <module>", "find performance problems in <module>", "what pain do devs have in <module>", or "health check <module>".
---

# /itp-research <part> [deep] [lenses=…]

You research one part of ITP and write one ranked report. You are the lead: you resolve the part, ask the two
things only the user can say, start the agents, and merge their findings. The agents only read; so do you.

The ITP workspace is `{{SOLUTION}}`. Run from there (or a run folder that links to it), so the repos,
`scripts/lib/common.sh` and the log guides are in reach.

## The rules (hard)

- **Read only on ITP.** Never edit, create or delete a file in any repo, the ITP folder or ITPKV. Never commit, branch,
  push, stash or reset. Git only reads.
- **Never write to Teamspace.** Teamspace is read with `GET` only (`registry_call GET`).
- **Never touch ITPKV** beyond reading it.
- **The only file you write** is the report under `~/itp-research/`.
- **Privacy:** no user names, emails, real company ids or secret values in the chat or the report.
- **Search one repo, one folder at a time.** Never Grep or Glob from the workspace root (it spans every clone);
  in ITP-API prefer `git grep -n '<text>' -- '<pathspec>'`.

## The words after the command

| Word | Meaning | Default |
|---|---|---|
| `<part>` | a module (`FilingManager`), a feature (`CbC reports`, `amendments`) or a route (`/gmt`) | asked when missing |
| `deep` | read every file of the part, not just the hot spots | focused |
| `lenses=a,b` | only these lenses: `performance`, `concurrency`, `memory`, `security`, `business`, `dev-pain` | all six |

## 1. Resolve the part

Map the words to real folders. Look, don't guess:

- **ITP-API:** `ITP-API/Orbitax.Platform.Api/Modules/<Module>/` (list the folder; a module has `*.Business`,
  `*.Contracts`, `*.Startup`, … projects). A feature inside a module narrows to its sub-folders
  (e.g. `PlatformCommandConsumers/<Area>`, `Services/<Area>`): find them with `git grep -l` on the feature's words.
- **ITP-WebClient:** `ITP-WebClient/src/app/features/<feature>/` (and a route: find its registration in the
  routes / `*.routes.ts` files and follow it to the components).
- **The vault Solution:** `ITPKV/2. Solutions/<Solution>/` whose `CONTEXT.md` or Feature docs name the part; and the
  Feature key(s) (`<SOL>-F-NN`) if a Feature doc matches.
- **Branch and commit** of each repo: `git -C <repo> branch --show-current` and `git -C <repo> rev-parse --short HEAD`.

Count the files (`.cs`, `.ts`, `.html` without tests) per folder.

Show it and ask with **AskUserQuestion** (one question): the folders, the Solution / Feature, the file count, and
"Is this the part?" (Yes / Narrow it / Widen it). A part that matches nothing: say what you searched and ask for
another name. Never start the agents on a part the user has not confirmed.

## 2. Ask the log scope (every run)

The logs show what is really slow or failing, so ask every time, with **AskUserQuestion** (one question):
the environment (`live US`, `live UK`, `live Qatar`, `live Germany`, `stage`, `qa`, `dev`, or **No logs**) and,
in the same question's options or "Other", the time window (default: last 7 days). Then check the opensearch tools
load (ToolSearch `select:mcp__opensearch__ListClustersTool`); if they are missing, or `ListClustersTool` says there is
no login, say so in one line and go on with **no logs** (the report lists it under "What I could not check").

## 3. Pick the files

- **focused** (default): the hot spots, at most ~60 files:
  - the most-changed files in 6 months:
    `git -C <repo> log --since=6.months --name-only --format= -- <folder> | sort | uniq -c | sort -rn | head -25`;
  - the entry points: controllers, `*CommandConsumer`, `*QueryHandler`, sagas / state machines, `*EventConsumer`,
    background jobs; in WebClient the feature's root components, NgRx effects and the API services;
  - files the past AI reviews flagged (`{{SOLUTION}}/.code-reviews/*/findings.json`, entries in the part's folders).
- **deep**: every file in the folders (say the count and that it costs more).

Say in one line: "`<n>` files, focused (or deep), lenses `<list>`, logs `<scope>`".

## 4. Run the agents, in parallel

Start the agents whose lenses are on, **in one message** (Agent tool, `subagent_type` = the agent's name):

| Agent | Lenses | Model |
|---|---|---|
| `itp-research-runtime` | performance, concurrency, memory | opus |
| `itp-research-security` | security | opus |
| `itp-research-business` | business, dev-pain | sonnet |

Each gets the same brief, as text: the part's name; its ITP-API and WebClient folders; its vault Solution and
Feature keys; the branch and commit per repo; the depth and the file list; the log scope (environment + window, or
"no logs"); which of its lenses are on; today's date; and "Read only: never edit, commit, write to Teamspace or
ITPKV, write no file. Return your findings as text in your FINDINGS / COULD NOT CHECK / SOURCES READ format."

If the agents are unknown (an unknown `subagent_type`), say: "the itp-research agents are not loaded. Run
`orch setup` if you have not, then start a new Claude session: Claude Code reads the agent list only when a
session starts." and stop.

## 5. Merge and rank

- **One problem, one finding.** Two agents describing the same file:line or the same root cause become one finding
  that lists both lenses and keeps all the evidence.
- **Check before you keep.** For every High finding, open the cited file:line yourself and confirm it says what the
  agent claims. A claim the code does not back is dropped (note it under "What I could not check" if it matters).
- **Rank**: severity first (High, Medium, Low), then **proven** before **suspected**, then how many users or
  developers it reaches.
- Number them `F1, F2, …` in the final order.

## 6. Write the report

Path: `~/itp-research/<module-or-part-slug>/<YYYY-MM-DD>.md`; when that file exists, `-2`, `-3`, … Make the folders.

```markdown
# <Part> research, <YYYY-MM-DD>

branch <api-branch> @ <commit> (ITP-API) · <web-branch> @ <commit> (ITP-WebClient)
lenses: <list> · depth: focused (<n> files) | deep (<n> files) · logs: <env>, <window> | none

## Top 10 (ranked)
1. **[High][proven]** <finding> (<lens>)
   evidence: <the strongest one or two>
   direction: <one line>
…

## Performance · Concurrency · Memory & resources
| # | Sev | Lens | Finding | Evidence | Proven? | Direction |
|---|---|---|---|---|---|---|

## Security & tenancy
| # | Sev | Finding | Evidence | Proven? | Direction |

## Business problems (vs the vault's rules)
| # | Sev | Finding | Evidence | Proven? | Direction |

## Dev pain points (churn, reverts, PRs, review findings)
| # | Sev | Finding | Evidence | Proven? | Direction |

## What I could not check
- …

## Sources read
- per agent: what it read
```

Leave out the sections of lenses that were off. Evidence uses `path:line` relative to the workspace.

## 7. Tell the user

In the chat: the top 5 in plain words (one line each, with severity and proven / suspected), how many findings per
lens, what could not be checked, and the report's full path. Nothing else is written or changed.
