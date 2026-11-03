---
name: orchestra-bug-logs
description: Orchestra step "Find it in the logs", the first step of a bug run. Reads the bug ticket, finds the environment, client and time, searches the ITP logs (OpenSearch) with the team's read-only opensearch tools, traces the error the way the log-trace skill does, and shows the user what it found before the fix is planned. Replaces opening Kibana and pasting logs by hand. Use as an Orchestra template step.
---

# Find it in the logs

You are a step in an Orchestra run. Today the user does this by hand: read the ticket, open Kibana for the right
environment, filter the logs, paste them into Claude. You do it instead, read only, and the user checks your result.

The tools: the **opensearch** MCP server (read only; it hides user names, emails and company ids: you see
`user_<hash>` and `co_<hash>`, and a `co_<hash>` in a query is turned back into the real id). Load its tools once
with ToolSearch (`select:mcp__opensearch__ListClustersTool,mcp__opensearch__SearchIndexTool,mcp__opensearch__CountLogs,mcp__opensearch__MultiSearch`).
The team's guides are in the api worktree of this workspace (the `ITP-API` folder):
- `ITP-API/.claude/skills/log-search/SKILL.md` (+ `references/`): clusters, index patterns, field rules. Read it first.
- `ITP-API/.claude/skills/log-trace/SKILL.md` (+ `references/`): how to trace one error. Follow its method.

If the opensearch tools are missing or every cluster says it has no login: say so in one line, and go to step 5 with
**Paste logs myself** as the way on. Never ask for, read or print a password.

## 1. The bug card

Read the ticket (Jira, read only; for a run started from a job text, that text). Pull out:

| Field | Notes |
|---|---|
| Environment | qa · dev · stage · live US · live UK · live Qatar · live Germany. Jira has no field for it: read the text, links (e.g. `qa-itp…`), the reporter's words. |
| Client | company name or id, if any |
| User | only to narrow the search; never write it in a file |
| When | the time it happened, or when it was reported |
| What | the error text, screen, action and steps |

Ask with **AskUserQuestion**, in one go, only for what is missing. The environment and a time window are required.
**Never guess the environment.** Show the bug card in the question so the user can correct it.

## 2. Find the error

Map the environment to its cluster and index with log-search (for example QA → `dev_qa` / `lion-qa*`,
live US → `us-prod` / `prod-l2-*`). Then, following log-search's field rules:
1. **Count first** (`CountLogs`) in a narrow window around the time (start with ±2 hours), errors first
   (`log_processed.LogLevel` 3). Widen step by step only if nothing comes back.
2. Narrow with the client (`CompanyId`), the error text (`match_phrase` on `log_processed.Message`) and the
   application. Use `match_phrase` for ids, never `match`.
3. Pick the entry that matches the ticket best (time, client, action). Keep 1 to 3 candidates if unsure.

Keep result sizes small. Never copy raw personal data into the chat or a file.

## 3. Trace it

Follow log-trace's method on the best entry: how often it recurs (urgency), the session timeline (SessionId,
30 min before to 5 min after), the pod, the parent command just before the error, and the code entry point
(`{CommandName}Consumer.cs` or the API controller), read in the api worktree.

Write the report to `.orchestra-bug/trace.md` in this workspace (make the folder), using log-trace's report
template. **Not** to `docs/log-traces/`: that is inside the repo and would land in a commit. Use only the hashed ids.

## 4. Show it

In the chat, short and plain:
- **The error**: the message, in one or two lines.
- **How often**: count in the window, first and last time seen.
- **Timeline**: the 5 to 10 lines that matter, before → error.
- **Suspect code**: file:line in the worktree, and why.
- **Not sure about**: anything that does not fit the ticket.

## 5. Ask

AskUserQuestion: "Is this the bug?"
- **Yes**: go on.
- **No: search differently**: the user types what to change (time, env, client, text); go back to step 2.
- **Paste logs myself**: the user pastes; build the trace from the paste (step 3 and 4), same report file.

## 6. End

The plan step reads `.orchestra-bug/trace.md`. End as every Orchestra step does: WHAT I DID AND WHY, then
`ORCHESTRA:DONE`.

## Rules

- Read only: no writes to OpenSearch, Jira or any repo file. The only file you write is `.orchestra-bug/trace.md`.
- Live clusters hold client data: search narrowly, show little, and never put names, emails or raw ids in text.
- Do not fix anything in this step. Finding and showing is the whole job; the plan comes next.
