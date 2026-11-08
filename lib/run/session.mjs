// The terminal session: start queued runs, make the workspace, launch and restart claude, notice a closed tab.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import * as workspace from '../workspace.mjs';
import { claudeCommand } from '../claude-cmd.mjs';
import { TAB_ALIVE, runDir, saveRun } from '../store.mjs';
import { openTab, tabTitle } from '../terminal.mjs';
import { childEnv, guardEnv } from '../env.mjs';
import { killTree } from '../app.mjs';
import { TAB_FRESH_MS, TAB_GONE_MS, TAB_NO_PID_MS, START_STUCK_MS, BUSY_MS } from '../limits.mjs';
import { httpError, alive } from '../util.mjs';
import { nextStep, sessionOpen, queueTime } from './steps.mjs';
import { handoffPrompt, runRules, sessionSettings } from './prompts.mjs';
import { allSessions } from './cleanup.mjs';
import { vaultDirs } from './ship.mjs';

export class SessionPart {
  // ---- the terminal session ----

  // Starts queued runs, oldest first, while fewer than the limit are working.
  // Only working runs use a slot: runs that wait for you do not.
  schedule() {
    const all = [...this.runs.values()];
    let working = all.filter((r) => r.status === 'running').length;
    const queue = all.filter((r) => r.status === 'queued').sort((a, b) => queueTime(a).localeCompare(queueTime(b)));
    for (const run of queue) {
      if (working >= this.settings.maxRunning) break;
      // A run whose first step starts the app waits until the app is free.
      const step = nextStep(run);
      if (!run.sessionId && step?.app && this.appHolder && this.appHolder !== run.id) continue;
      working++;
      run.status = 'running';
      run.starting = { pid: process.pid, at: Date.now() };
      this.emitRun(run);
      // Each run starts in its own process (orch tick <id>), so workspaces build side by side and this one
      // returns at once. That process (orch tick <id>) is the starter: if it ends before the tab opens, the next one sees it (init).
      const pid = spawnJob(['tick', run.id]);
      if (pid) run.starting = { pid, at: Date.now() };
      saveRun(run);
      if (!pid) this.later(() => this.openRun(run));
    }
  }

  // In the starter process: the workspace, then the tab. A failure fails the run, with the reason.
  async openRun(run) {
    try {
      await this.startSession(run);
    } catch (err) {
      if (!this.runs.has(run.id)) return;
      delete run.starting;
      run.status = 'failed';
      run.error = `could not open the terminal: ${err.message}`;
      this.log(run, run.error);
      await saveRun(run).catch(() => {});
      this.emitRun(run);
    }
  }

  // Makes the workspace if needed, then opens the run's terminal tab. A run that had a session
  // before is reopened on the same conversation, and waits for you there.
  async startSession(run) {
    this.log(run, 'got a free slot');
    if (run.repoPlan?.length && !run.workspace?.ready && !(await this.prepareWorkspace(run))) return;
    const fresh = !run.sessionSeen;
    run.sessionId ||= crypto.randomUUID();
    run.launchPrompt = null;
    run.note = null;
    if (fresh) {
      const step = nextStep(run);
      if (step) {
        const problem = await this.trackingProblem(run, step);
        if (problem) return this.finishStep(run, step, { ok: false, error: problem });
        this.startStep(run, step);
        run.launchPrompt = this.firstPrompt(run, step);
      }
    } else {
      run.status = 'needs-you';
      run.note = run.steps.some((b) => b.status === 'running')
        ? 'Reopened on the same conversation. Type next to go on with the step, redo to start it again, skip to move past it, or just talk.'
        : 'Reopened on the same conversation. Type next to go on, or just talk.';
    }
    run.session = { open: true, pid: null, openedAt: new Date().toISOString() };
    const cwd = run.workspace?.ready ? run.workspace.dir : run.cwd;
    run.session.command = openTab(run, cwd, { pane: this.settings.pane !== false, paneSize: this.settings.paneSize });
    delete run.starting;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, fresh ? 'terminal tab opened' : 'terminal tab reopened (same session)');
  }

  // Makes the run's workspace: worktrees of its repos. Returns false when it failed.
  async prepareWorkspace(run) {
    this.log(run, 'making the workspace (worktrees of the run repos)');
    try {
      // The folder is chosen and saved first: if this process ends while it builds, clean-up still finds it.
      if (!run.workspace?.dir) run.workspace = { dir: workspace.reserve(), repos: run.repoPlan.map((p) => ({ ...p })), ready: false };
      // Making worktrees takes a while: other runs' hooks go on meanwhile (the lock is let go).
      await saveRun(run);
      const plan = structuredClone({ id: run.id, repoPlan: run.repoPlan, workspace: run.workspace });
      const ws = await this.outside(() => workspace.prepare(plan, (m) => this.log(run, m)));
      if (!this.runs.has(run.id)) return false;
      run.workspace = ws;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `workspace ready at ${run.workspace.dir}`);
      return true;
    } catch (err) {
      delete run.starting;
      run.status = 'failed';
      run.error = `workspace: ${err.message}`;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, run.error);
      return false;
    }
  }

  // What the launcher in the tab starts: claude, attached to the terminal, with Orchestra's hooks.
  async launchSpec(id, token, pid) {
    const run = this.mustToken(id, token);
    if (!sessionOpen(run)) throw httpError(409, 'this run has no open session. Reopen it with /orchestra reopen.');
    run.session.pid = Number(pid) || null;
    // The model and effort of the step it starts with; a step that names none keeps the run's current ones.
    const step = run.steps.find((b) => b.status === 'running') || nextStep(run);
    if (step?.model) run.model = step.model;
    if (step?.effort) run.effort = step.effort;
    // The run repos' own skills (in <repo>/.claude/skills) load only from an added folder.
    const repoDirs = (run.workspace?.ready ? run.workspace.repos : []).map((r) => r.dir).filter(Boolean);
    // --add-dir takes several folders, so it must not sit just before the prompt (it would eat it as a folder).
    const args = ['--add-dir', config.itpRoot, ...repoDirs, run.sessionSeen ? '--resume' : '--session-id', run.sessionId,
      '--name', tabTitle(run), '--settings', sessionSettings(), '--append-system-prompt', runRules(run)];
    if (run.model) args.push('--model', run.model);
    if (run.effort) args.push('--effort', run.effort);
    if (run.launchPrompt) args.push(run.launchPrompt);
    run.launchPrompt = null; // given once; `redo` starts the step again if the launch failed
    await saveRun(run);
    const claude = claudeCommand(args);
    return {
      title: tabTitle(run),
      cmd: claude.cmd,
      args: claude.args,
      cwd: run.workspace?.ready ? run.workspace.dir : run.cwd,
      keepApiKey: config.keepApiKey,
      env: {
        ...guardEnv(runDir(run.id), true, run.tracking !== false),
        ...workspace.workspaceEnv(run.workspace),
        ORCHESTRA_MAIN_OK: vaultDirs(run).join('\n'),
        // The ITP folder itself: the Wrap up step may commit its Execution files there and push them.
        ORCHESTRA_ITP_ROOT: config.itpRoot.replace(/\\/g, '/'),
        ORCHESTRA_RUN_ID: run.id,
        ORCHESTRA_HOOK_TOKEN: run.hookToken,
        // Tools runs never use. Workflows (many helper agents) only for an ultracode step: a change of effort
        // restarts claude, so this follows the step.
        CLAUDE_CODE_DISABLE_CRON: '1',
        ...(run.effort === 'ultracode' ? {} : { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' }),
      },
    };
  }

  // The launcher stopped claude for a restart (restart.ok): start it again with the step's model and effort and its
  // prompt. Usually on the same conversation; for a fresh step on a new one (the old one's cost moves to costPast,
  // and its id is kept so clean-up removes its files too).
  async relaunchSpec(id, token, pid) {
    const run = this.mustToken(id, token);
    if (!run.restart) throw httpError(409, 'no restart was asked for');
    const { model, effort, fresh } = run.restart;
    run.restart = null;
    if (fresh) {
      run.sessionIds = allSessions(run);
      run.costPast = run.sessionCost || 0;
      run.sessionId = crypto.randomUUID();
      run.sessionSeen = false;
    }
    const what = [model && `with ${model}`, effort && `effort ${effort}`].filter(Boolean).join(' · ');
    this.log(run, fresh ? `started a new conversation${what ? ` · ${what}` : ''}` : `restarted claude${what ? ` ${what}` : ''}`);
    return this.launchSpec(id, token, pid);
  }

  // Does this step want a new conversation, or another model or effort than the claude running now?
  wantsRestart(run, step) {
    return sessionOpen(run) && !!(step.fresh || (step.model && step.model !== run.model) || (step.effort && step.effort !== run.effort));
  }

  // The step is started; the claude running now ends its turn, and the launcher starts a new one with the step's
  // model and effort (restart.ok). The prompt reaches the new claude; a fresh step gets the story so far with it.
  async restartFor(run, step, prompt) {
    run.restart = { stepId: step.id, model: step.model || run.model || null, effort: step.effort || run.effort || null, fresh: !!step.fresh, at: new Date().toISOString() };
    run.launchPrompt = step.fresh ? handoffPrompt(run, step, prompt) : prompt;
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `step ${step.id} wants ${[step.fresh && 'a new conversation', step.model, step.effort && `effort ${step.effort}`].filter(Boolean).join(' · ')}: restarting claude`);
    return { restart: true };
  }

  // What the old claude is told when you typed next or redo and a restart takes over (your prompt is not sent).
  restartBlock(run, step) {
    const what = [step.model, step.effort && `effort ${step.effort}`].filter(Boolean).join(', ');
    const how = step.fresh ? `starts a new conversation${what ? ` (${what})` : ''}` : `restarts this tab with ${what}`;
    return { output: { decision: 'block', reason: `Orchestra ${how} for "${step.label}". It goes on by itself in a few seconds.` } };
  }

  // The tab closed, or claude ended. Called by SessionEnd and by the launcher; the second call does nothing.
  // While a restart is on, claude ending is the launcher's doing: the session stays open (force: the restart failed).
  // error: claude could not be started at all (the launcher says why): the run fails with that reason.
  async onClosed(id, token, { force = false, error = null } = {}) {
    const run = this.mustToken(id, token);
    if (!sessionOpen(run)) return {};
    if (run.restart && !force && !error) return {};
    this.closeSession(run, error ? `claude could not start: ${error}` : 'the terminal session ended');
    if (error) {
      run.status = 'failed';
      run.error = `claude could not start: ${error}`;
    }
    await saveRun(run);
    this.emitRun(run);
    this.afterClose(run);
    return {};
  }

  closeSession(run, why) {
    run.session.open = false;
    run.session.closedAt = new Date().toISOString();
    run.session.pid = null;
    run.restart = null;
    try {
      workspace.saveLocalSettings(run.workspace);
    } catch (err) {
      this.log(run, `could not keep this run's "don't ask again" answers: ${err.message}`);
    }
    const step = run.steps.find((b) => b.status === 'running');
    if (step) step.note = 'Cut off: the tab closed while this step worked. Reopen the run, then type next to go on with it, or redo to start it again.';
    if (run.status !== 'done') run.status = 'stopped';
    this.log(run, `session closed: ${why}`);
  }

  // Puts a draft, stopped or failed run without an open session in the queue. A session that was
  // open before is reopened (same conversation). With an open session, you answer in its terminal.
  async resume(id) {
    const run = this.mustGet(id);
    if (sessionOpen(run)) {
      if (run.status === 'waiting') throw httpError(409, 'type next in its terminal tab to go on');
      throw httpError(409, 'its terminal tab is open: talk to it there (redo runs the step again)');
    }
    if (!['draft', 'stopped', 'failed', 'waiting', 'needs-you'].includes(run.status)) return run;
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone). Start a new run; its branches are still there.');
    await this.checkTracking(run, run.steps.filter((b) => b.status !== 'done'));
    const was = run.status;
    run.status = 'queued';
    run.queuedAt = new Date().toISOString();
    run.error = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, was === 'draft' ? 'started by you' : 'resumed by you');
    this.schedule();
    return run;
  }

  // A queued run leaves the queue. An open session is ended (its claude is closed); Resume reopens it.
  async stop(id) {
    const run = this.mustGet(id);
    if (run.status === 'queued') {
      run.status = 'stopped';
      await saveRun(run);
      this.emitRun(run);
      this.log(run, 'taken out of the queue by you');
      return run;
    }
    if (!sessionOpen(run)) {
      // Stuck in "running" with no tab (it never finished starting): stop it all the same.
      if (run.status === 'running' && !busy(startMark(run))) {
        delete run.starting;
        run.status = 'stopped';
        await saveRun(run);
        this.emitRun(run);
        this.log(run, 'stopped by you (it had not finished starting)');
      }
      return run;
    }
    // Only a tab that is still alive is closed by its pid (a gone tab's pid may be another program's now).
    if (run.session.pid && !tabGone(run)) killTree(run.session.pid);
    this.closeSession(run, 'stopped by you');
    await saveRun(run);
    this.emitRun(run);
    this.afterClose(run);
    return run;
  }
}

// A tab is gone when its launcher process ended, or when it never started after a few minutes.
// The launcher's alive file decides: older than a minute means gone, once its pid is dead too (a PC that just woke
// up has not written it yet), or after 10 minutes in any case (the pid may belong to another program now).
// Launchers from before the file: the pid alone.
export function tabGone(run) {
  let age = null;
  try {
    age = Date.now() - fsSync.statSync(path.join(runDir(run.id), TAB_ALIVE)).mtimeMs;
  } catch {}
  if (age !== null && Date.parse(run.session.openedAt || 0) <= Date.now() - age + 1000) {
    // The launcher writes the alive file every 10 s. Its X kills the launcher, which then cannot say so: a dead
    // launcher whose file missed a beat is a closed tab (seen in seconds, not after a minute).
    if (age > 15000 && run.session.pid && !alive(run.session.pid)) return true;
    if (age < TAB_FRESH_MS) return false;
    return age > TAB_GONE_MS || !run.session.pid || !alive(run.session.pid);
  }
  if (run.session.pid) return !alive(run.session.pid);
  return Date.now() - Date.parse(run.session.openedAt || 0) > TAB_NO_PID_MS;
}

// A workspace whose build was cut off: its folder exists, it was never ready, and it was not cleaned.
export function partialWorkspace(run) {
  return !!run.workspace?.dir && !run.workspace.ready && !run.cleanedAt && fsSync.existsSync(run.workspace.dir);
}

// A run that says it is running, has no tab, and whose start is not going on any more (its starter ended, or it
// took far too long). Old runs with no start mark and no tab are stuck too.
export function startStuck(run) {
  if (run.status !== 'running' || sessionOpen(run)) return false;
  return !busy(startMark(run), START_STUCK_MS);
}

export const startMark = (run) => run.starting && { pid: run.starting.pid, at: run.starting.at };

// Work marked by a process that is still alive (a clean-up going on).
export function busy(mark, ms = BUSY_MS) {
  return !!mark && alive(mark.pid) && Date.now() - mark.at < ms;
}

// Starts `orch <args>` in its own process, which outlives this one (a hook or a closing tab).
export function spawnJob(args) {
  const env = childEnv();
  for (const k of ['ORCHESTRA_RUN_ID', 'ORCHESTRA_HOOK_TOKEN', 'ORCHESTRA_ALLOW_PUSH']) delete env[k];
  const child = spawn(process.execPath, [path.join(config.root, 'bin', 'orch.mjs'), ...args], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on('error', () => {});
  child.unref();
  return child.pid || null;
}

// A tick (start queued runs) from a hook. One that waits for the lock already sees every change made before it gets
// it, so while one is pending no other is started (no storm of node processes). The tick removes the mark first.
export const TICK_MARK = '.tick-pending';
export function spawnTick() {
  const mark = path.join(config.runsDir, TICK_MARK);
  try {
    if (Date.now() - fsSync.statSync(mark).mtimeMs < 60000) return;
  } catch {}
  try {
    fsSync.writeFileSync(mark, String(process.pid));
  } catch {}
  spawnJob(['tick']);
}
