---
name: free-disk
description: Free disk space on this Windows PC, carefully. A read-only scan (about 15 seconds) shows what takes space and what can go - build output in the ITP repos (bin, obj, .angular, node_modules), Temp, the Recycle Bin, NuGet and npm caches, Playwright browsers, the hibernate file, Docker, Orchestra's run folders and app slots - with what each costs you. You pick; it frees only what you picked, with a safety check before each and the free space before and after. Use when someone says "/free-disk", "free up disk space", "my C: drive is full", "clean up space on my PC", "what takes my disk", or "disk is low".
---

# Free disk space

Two rules above all: **measure first, change nothing until the user picks**, and **only the items they picked**.
Say each action before you do it. Never use admin rights yourself: when something needs them, give the user the
exact command to run in an administrator PowerShell.

## 1. Scan (read only)

Run these at once:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "{{ORCHESTRA}}/packs/itp/skills/free-disk/scan.ps1" -Solution "{{SOLUTION}}"
node {{ORCHESTRA}}/bin/orch.mjs disk
node {{ORCHESTRA}}/bin/orch.mjs app slots
```

(The scan script sits next to this file; if that path is missing, use `scan.ps1` in this skill's own folder.)

- `scan.ps1`: one table - Key, Size, What, Safe, Cost - biggest first, and about how much could be freed.
- `orch disk`: Orchestra's run folders (each run's worktrees). `orch app slots`: each run's own app and its data, and
  the master copy, all inside Docker's disk.

## 2. Show it and ask

Show one short table, biggest first: what it is, its size, and what freeing it costs, in plain words. Then ask with
**AskUserQuestion, multiSelect**: the safe ones first, marked (Recommended) - usually the Recycle Bin, Temp, build
output, the caches. Put costly ones (node_modules, the hibernate file, Playwright browsers) in a second question.
At most 4 options per question.

Not offered to delete here (say so if the user asks):

| Never here | Why, and the right way |
|---|---|
| Your local Mongo data (`C:\Program Files\MongoDB\...\data`) | It is your Local DB |
| `pagefile.sys`, `C:\Windows\Installer`, anything in `C:\Windows` | Windows needs them |
| Any `.git` folder, any tracked file, the ITP folder's own repo (itp-workspace) | Your work and history |
| `C:\LocalStore` data folders (FileStore, Spreadsheet, …) | The app's own files |
| `C:\LocalStore\instances` (itp-stacks' copies) | Only through itp-stacks (`stacks.ps1 destroy` / `prune`) or Orchestra |
| Orchestra's run folders (`C:/o/…`) | `/orch` Clean up (`orch clean <run>`, `orch clean done`), or the run's Wrap up |
| App slots and their data, the master copy, Docker volumes | `orch app slot <run> drop` (ask first); the master copy only through `orch app master refresh` |

## 3. Free what was picked

Before the first item and after each one, print C:'s free space
(`'{0:N0} GB' -f ((Get-PSDrive C).Free/1GB)`).

**Build output of a repo** (`build:<repo>`):
1. Check, and stop if any fails: no process runs from that repo (its path in a process's command line or program),
   no `dotnet`, `MSBuild` or `VBCSCompiler` runs, Visual Studio (`devenv`) is closed; `git -C <repo> ls-files` lists
   **no** file inside a `bin`, `obj` or `.angular` folder.
2. Dry run: list the folders (outermost only; never inside `.git` or `node_modules`; never a link or junction), how
   many, and their total size. Show it.
3. Delete exactly those folders. Then `git -C <repo> status --short` must show the same as before, and every listed
   folder must be gone. Say how much was freed.

**node_modules of a repo**: the same checks (no `node` / `ng serve` / dev server from that repo), then delete it.
Say that `npm install` (or `npm ci`) brings it back.

**Temp**: delete files in `%TEMP%` older than 2 days, skip `%TEMP%\claude` (Claude Code uses it now) and any file in
use (count them as skipped), then remove empty folders. Never delete a newer file.

**Recycle Bin**: empty it with Windows' own function:
```powershell
Add-Type -Namespace Win -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHEmptyRecycleBin(System.IntPtr hwnd, string root, uint flags);'
[Win.Shell]::SHEmptyRecycleBin([IntPtr]::Zero, 'C:\', 7)
```
(`Clear-RecycleBin` fails on Windows PowerShell 5.1 with "path not found".) If space is still taken after that, the
bin holds leftovers Windows cannot see (`$R…` items with no `$I…` file). They need admin: give the user the command
for their own bin folder only - `Remove-Item 'C:\$Recycle.Bin\<their SID>\$R*' -Recurse -Force` - and say what it is.

**NuGet cache**: only when no `dotnet` / `MSBuild` runs. `dotnet nuget locals all --clear`. **npm cache**:
`npm cache clean --force`. Say the next restore or install downloads again.

**Playwright browsers**: delete `%LOCALAPPDATA%\ms-playwright`; say `npx playwright install chromium` brings them back.

**Hibernate file**: needs admin. Give the user `powercfg /h off` for an administrator PowerShell; the file goes at
once, no restart. Say: no hibernate and no fast startup; sleep still works.

**Docker**: `docker system df` shows images, volumes and build cache. Offer only `docker image prune -f` (images no
container uses) and `docker builder prune -f`. Never `docker volume rm` or `prune` volumes: the volumes are the app
slots' data and the master copy. A run's slot goes with `orch app slot <run> drop` or the run's clean-up.

## 4. Report

A short table: each item, freed GB, and what it costs from now on (a full build next time, a download, no hibernate).
Then C: free before and after, and anything left for the user (an admin command).
