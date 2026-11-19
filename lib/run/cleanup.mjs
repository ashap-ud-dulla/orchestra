// Clean-up (only when you say so) and delete.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import * as workspace from '../workspace.mjs';
import { runDir, saveRun, archiveRun } from '../store.mjs';
import { processesIn, killTree, killRecorded } from '../app.mjs';
import { PROCS_FILE } from '../store.mjs';
import { pack } from '../pack.mjs';
import { AUTO_CLEAN_RETRY_MS } from '../limits.mjs';
import { httpError } from '../util.mjs';
import { sessionOpen } from './steps.mjs';
import { partialWorkspace, startMark, busy, spawnJob } from './session.mjs';

export class CleanupPart {
  // The run's own copy of the app (a pack that gives each run one, pack.app.dropFor): deleted with the run, with the
  // lock let go (it stops processes and deletes data). Whether or not the run still has its folder.
  async dropOwnApp(run) {
    if (!pack.app?.dropFor) return;
    const note = await this.outside(() => pack.app.dropFor(run.workspace?.dir || null, run.id)).catch((err) => `could not delete its own app copy: ${err.message}`);
    if (note) this.log(run, String(note));
  }

  // Frees everything the run takes that is not needed any more: the processes running from its folder (the app
  // too), the folder (worktrees and links), git's worktree records, and its Claude conversation files.
  // Keeps the run (notes, log, stats) and its branches; merged: also deletes its branches git sees as merged.
  // auto: after the Wrap up step, when its tab closed; uncommitted work is then kept, not refused.
  async cleanUp(id, { force = false, auto = false, merged = false } = {}) {
    const run = this.mustGet(id);
    if (sessionOpen(run)) throw httpError(409, 'its terminal tab is open. Close it (or stop the run) first.');
    if (['running', 'queued'].includes(run.status)) throw httpError(409, 'the run is still working');
    if (busy(run.cleaning)) throw httpError(409, 'it is being cleaned up right now');
    if (!(run.workspace?.ready && workspace.uncommitted(run.workspace).length && !force)) await this.dropOwnApp(run);
    if (!run.workspace?.ready) {
      // A workspace that was never finished (its build was cut off): its folder goes too.
      if (partialWorkspace(run)) {
        const ws = run.workspace;
        const procsFile = path.join(runDir(run.id), PROCS_FILE);
        await this.outside(() => {
          stopRunProcesses(ws.dir, procsFile);
          return workspace.remove(ws, { onBusy: busyHelper(ws.dir, procsFile).onBusy });
        });
        this.log(run, `removed the unfinished workspace ${ws.dir}`);
      }
      if (run.sessionId && !run.cleanedAt) {
        await this.outside(() => forgetConversation(allSessions(run)));
        Object.assign(run, { cleanedAt: new Date().toISOString(), freed: 0 });
        await saveRun(run);
        await archiveRun(run.id);
      }
      return run;
    }
    for (const note of workspace.followBranches(run)) this.log(run, note);
    const dirty = workspace.uncommitted(run.workspace);
    if (dirty.length && !force) {
      if (!auto) throw Object.assign(httpError(409, `uncommitted work in ${dirty.join(', ')}. Clean up anyway (--force) to lose it.`), { uncommitted: dirty });
      run.cleanupKept = true; // asked once; you clean it up yourself
      this.log(run, `kept the workspace: uncommitted work in ${dirty.join(', ')}. Clean it up yourself to remove it.`);
      await saveRun(run);
      return run;
    }
    const ws = run.workspace;
    run.cleaning = { pid: process.pid, at: Date.now() };
    await saveRun(run);
    let swept;
    try {
      swept = await this.outside(() => sweep(ws, allSessions(run), { merged, procsFile: path.join(runDir(run.id), PROCS_FILE) }));
    } catch (err) {
      // A clean-up by itself that failed waits a while before it tries again (afterClose).
      if (auto && this.runs.has(id)) run.autoCleanFailedAt = Date.now();
      throw err;
    } finally {
      if (this.runs.has(id)) {
        delete run.cleaning;
        await saveRun(run);
      }
    }
    if (!this.runs.has(id)) return { ok: true };
    delete run.autoCleanFailedAt;
    run.workspace.ready = false;
    run.cleanedAt = new Date().toISOString();
    run.freed = swept.bytes;
    run.cleanWhenClosed = false;
    await saveRun(run);
    this.emitRun(run);
    for (const note of swept.notes) this.log(run, note);
    const kept = run.workspace.repos.filter((r) => r.branch).map((r) => r.branch);
    this.log(run, `cleaned up${auto ? ' by itself' : ''}: ${gb(swept.bytes)} freed${kept.length ? ` · branches: ${kept.join(', ')}` : ''}`);
    await archiveRun(run.id);
    return run;
  }

  // After the Wrap up step (you said "clean"), closing its tab cleans the run up: the folder could not go while
  // the tab's Claude ran inside it. Nothing else is cleaned by itself: clean-up happens when you say so.
  afterClose(run) {
    if (!run.cleanWhenClosed || run.status !== 'done' || sessionOpen(run) || !run.workspace?.ready || run.cleanupKept || busy(run.cleaning)) return;
    // It failed a short while ago: every orch command would try again (and log it again). `orch clean` still can.
    if (Date.now() - (run.autoCleanFailedAt || 0) < AUTO_CLEAN_RETRY_MS) return;
    // A hook (the tab closing) has little time: a separate process cleans up.
    if (this.detach) return spawnJob(['clean', run.id, '--auto', '--merged']);
    run.cleaning = { pid: process.pid, at: Date.now() }; // so it is cleaned up once, here
    this.later(async () => {
      if (!this.runs.has(run.id)) return;
      delete run.cleaning;
      await this.cleanUp(run.id, { auto: true, merged: true }).catch((err) => this.log(run, `could not clean up: ${err.message}`));
    });
  }

  // Runs left alone: not finished, tab closed, folder still there, no change for `days` days.
  staleRuns(days = 7) {
    const before = Date.now() - days * 86400000;
    return this.list().filter((r) => !['done', 'running', 'queued'].includes(r.status) && !sessionOpen(r) && r.workspace?.ready && !r.cleanedAt && Date.parse(r.updatedAt || r.createdAt) < before);
  }

  // Finished runs whose tab is closed and whose folder is still there.
  finishedUncleaned() {
    return this.list().filter((r) => r.status === 'done' && !sessionOpen(r) && r.workspace?.ready && !r.cleanedAt);
  }

  // Removes a run without an open session: its workspace (links first, then worktrees) and its folder.
  // Branches stay. Work that is not committed is lost, so that needs force.
  async deleteRun(id, { force = false } = {}) {
    const run = this.mustGet(id);
    if (sessionOpen(run)) throw httpError(409, 'its terminal tab is open. Stop the run (or close the tab) first.');
    if (run.status === 'running' && busy(startMark(run))) throw httpError(409, 'the run is starting; wait a moment');
    if (busy(run.cleaning)) throw httpError(409, 'it is being cleaned up right now; try again in a moment');
    // Commits made with no branch would be lost with the worktree: save them on a branch first.
    for (const note of workspace.followBranches(run)) this.log(run, note);
    const dirty = workspace.uncommitted(run.workspace);
    if (dirty.length && !force) {
      throw Object.assign(httpError(409, `uncommitted work in ${dirty.join(', ')}. Delete anyway to lose it.`), { uncommitted: dirty });
    }
    await this.dropOwnApp(run);
    // The workspace goes first: if that fails, the run stays (and the same delete again finishes the job). What still
    // runs for it is stopped first: a program holding a file there would keep the folder.
    if (run.workspace?.ready || partialWorkspace(run)) {
      const ws = run.workspace;
      const procsFile = path.join(runDir(run.id), PROCS_FILE);
      run.cleaning = { pid: process.pid, at: Date.now() };
      await saveRun(run);
      try {
        await this.outside(async () => {
          if (pack.app?.stopFor) await pack.app.stopFor(ws.dir);
          stopRunProcesses(ws.dir, procsFile);
          await workspace.remove(ws, { onBusy: busyHelper(ws.dir, procsFile).onBusy });
        });
      } catch (err) {
        if (this.runs.has(id)) {
          delete run.cleaning;
          await saveRun(run);
        }
        throw err;
      }
    }
    this.runs.delete(id);
    this.lastStatus.delete(id);
    await fs.rm(runDir(id), { recursive: true, force: true, maxRetries: 5 });
    return { ok: true };
  }
}

// Every conversation this run has had (fresh steps start new ones), so clean-up forgets them all.
export function allSessions(run) {
  return [...new Set([...(run.sessionIds || []), run.sessionId].filter(Boolean))];
}

// Stops what the run left running: the processes its claude started that still run (the launcher's record, even
// those with no parent left), and every process whose program or command line is inside its folder. Returns how many.
export function stopRunProcesses(dir, procsFile) {
  let n = procsFile ? killRecorded(procsFile) : 0;
  for (const p of processesIn(dir)) {
    killTree(p.pid);
    n++;
  }
  return n;
}

// While a folder will not go: stop the run's processes again, and once ask the pack to free what holds files from
// outside the folder (its build servers). freed: the pack's note, if it did.
function busyHelper(dir, procsFile) {
  const h = {
    freed: null,
    onBusy: () => {
      stopRunProcesses(dir, procsFile);
      if (!h.asked && pack.freeFiles) h.freed = pack.freeFiles(dir) || null;
      h.asked = true;
    },
  };
  return h;
}

// The clean-up work, done with the lock let go: stop what runs from the folder, measure it, remove it, tidy git,
// forget the conversations. Returns { bytes, notes }.
export async function sweep(ws, sessions, { merged, procsFile }) {
  const notes = [];
  const stopped = pack.app?.stopFor ? await pack.app.stopFor(ws.dir) : null;
  if (stopped) notes.push(stopped);
  const n = stopRunProcesses(ws.dir, procsFile);
  if (n) notes.push(`stopped ${n} process${n > 1 ? 'es' : ''} the run left running`);
  const bytes = await workspace.size(ws.dir);
  const busy = busyHelper(ws.dir, procsFile);
  await workspace.remove(ws, { onBusy: busy.onBusy });
  if (busy.freed) notes.push(busy.freed);
  notes.push(...(await workspace.tidyRepos(ws, { deleteMerged: merged })));
  const forgot = forgetConversation(sessions);
  if (forgot) notes.push(`removed its Claude conversation files (${gb(forgot)})`);
  return { bytes: bytes + forgot, notes };
}

// Deletes sessions' Claude conversation files (<projects>/<folder>/<sessionId>.jsonl and its folder).
// A cleaned run cannot be reopened, so they only take space. Returns the bytes freed.
export function forgetConversation(sessions) {
  const ids = [sessions].flat().filter((id) => id && /^[\w-]+$/.test(id));
  if (!ids.length) return 0;
  let freed = 0;
  let folders = [];
  try {
    folders = fsSync.readdirSync(config.claudeProjectsDir);
  } catch {
    return 0;
  }
  for (const f of folders) for (const sessionId of ids) {
    const file = path.join(config.claudeProjectsDir, f, `${sessionId}.jsonl`);
    const dir = path.join(config.claudeProjectsDir, f, sessionId);
    try {
      freed += fsSync.statSync(file).size;
      fsSync.rmSync(file, { force: true });
    } catch {}
    if (fsSync.existsSync(dir)) fsSync.rmSync(dir, { recursive: true, force: true });
  }
  return freed;
}

export function gb(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
