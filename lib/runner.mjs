// Runs workflows. Each run is one interactive claude session in its own terminal tab (terminal.mjs,
// launch.mjs). You talk to it there: questions, "Allow?" prompts and gates happen in the terminal.
// Orchestra follows the session through Claude hooks (bin/hook.mjs) and moves it from box to box:
// when the AI ends a step with ORCHESTRA:DONE, the Stop hook hands it the next box. A "wait for me"
// box stops there, and you type `next` in the terminal to go on (`redo` runs a box again).
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { RUN_RULES, DONE_MARK, FAILED_MARK, ABOUT_RULE, readMark, readWhy, readAbout, readPins, firstWords } from './guard.mjs';
import * as workspace from './workspace.mjs';
import { notify, focusUrl } from './notify.mjs';
import { claudeCommand } from './claude-cmd.mjs';
import { scanSkills } from './skills-scan.mjs';
import { OFF_RULE, OFF_HELP, offProblems } from './tracking.mjs';
import { readInstructionsSync, material, buildPrompt, parseSuggestions, ask, addSuggestions } from './learn.mjs';
import { TAB_ALIVE, getTemplate, newId, runDir, saveRun, loadRuns, brokenRuns, appendLine, validateTemplate, getSettings, saveSettings, flushSaves, WRAP_UP_SKILL, EFFORTS } from './store.mjs';
import { withLock, without as withoutLock, held as lockHeld } from './lock.mjs';
import { openTab, tabTitle } from './terminal.mjs';
import { childEnv, guardEnv } from './env.mjs';
import { readServing, stopApp, processesIn, killTree, norm, readYourHold, YOU } from './app.mjs';

export { childEnv, guardEnv };

// Run states that need you. Entering one sends a Windows notification (stopped and draft are your own doing).
const NOTIFY = { 'needs-you': 'needs you in its terminal', waiting: 'is waiting for you: type next in its terminal', failed: 'failed a step' };
// Boxes that have started stay locked in place when you edit a run.
const STARTED = new Set(['done', 'running']);
// The prompt goes on the command line, and Windows caps that at 32767 chars.
const MAX_INPUT_CHARS = 8000;
// The story of earlier steps a fresh step gets on its command line.
const HANDOFF_STEPS_CHARS = 10000;
const MAX_BATCH = 20;
// How long a finished box may wait for the app before the run stops and waits for `next`.
const APP_WAIT_MS = 25 * 60 * 1000;
// How long a clean-up by itself waits after it failed before it tries again.
const AUTO_CLEAN_RETRY_MS = 30 * 60 * 1000;
// The PreToolUse guard sees these tools.
const GUARD_MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*[Tt]eamspace.*';
// The Wrap up step's line for "keep the folder, do not clean it when the tab closes".
const KEEP_LINE = /^[ \t*_`>-]*ORCHESTRA:KEEP[ \t*_`]*$\n?/m;
// The MCP servers a run starts (the user's pick) and the ones it never starts. Names as `claude mcp list` shows them.
// (claude.ai connectors stay: their tools are only listed by name until used, so they cost almost nothing.)
const RUN_MCP = ['opensearch', 'jira', 'bitbucket', 'mongodb', 'mongodb-app', 'mongodb-global'];
const RUN_MCP_OFF = ['FM-MCP', 'aspire', 'aspire-dashboard', 'mongodb-cluster'];
// Given after a box with "explain the code" ticked.
const WALKTHROUGH = `Before the next step: walk me through the code this run has changed so far, so I can learn from it. Look at the real changes (git diff against the base branch in each repo of this run). For each important change: name the file with path:line, the pattern or approach used, and why it fits here, plus the simpler or other option and why it was not used. Plain, simple English, short sentences. Do not change any files and do not commit. End with the line ${DONE_MARK} when you are done explaining.`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function newBox(b) {
  return {
    id: b.id,
    skill: b.skill,
    label: String(b.label || b.skill).slice(0, 80),
    args: String(b.args || '').slice(0, 2000),
    waitAfter: !!b.waitAfter,
    usesApp: !!b.usesApp,
    walkthrough: !!b.walkthrough,
    fresh: !!b.fresh, // start this step in a new conversation (a handoff tells it the story so far)
    // The model and effort this step runs with. None: it keeps what the step before used.
    model: b.model || null,
    effort: b.effort || null,
    status: 'pending',
    attempts: 0,
    cost: 0,
    summary: '',
    error: null,
  };
}

const nextBox = (run) => run.boxes.find((b) => b.status !== 'done');

// A finished step, by its number (as `orch run` shows it), id, skill or label (whole, or words from it).
// The newest match wins, so "build" after a go back means the latest Build.
function findDone(run, ref) {
  const r = String(ref || '').trim().toLowerCase().replace(/^\//, '').replace(/^step\s+/, '');
  if (!r) return null;
  if (/^\d+$/.test(r)) {
    const b = run.boxes[Number(r) - 1];
    return b?.status === 'done' ? b : null;
  }
  const done = run.boxes.filter((b) => b.status === 'done');
  const exact = done.filter((b) => [b.id, b.skill, b.label].some((v) => String(v).toLowerCase() === r));
  const near = r.length >= 3 ? done.filter((b) => [b.skill, b.label].some((v) => String(v).toLowerCase().includes(r))) : [];
  return (exact.length ? exact : near).at(-1) || null;
}

const doneList = (run) => `Finished steps: ${run.boxes.map((b, i) => (b.status === 'done' ? `${i + 1}. ${b.label}` : null)).filter(Boolean).join(' · ') || 'none yet'}.`;

// "build fix the review findings" → the step "build" and why. The longest start that names a finished step wins;
// "test in the app: the export is wrong" splits at the colon.
function splitStepRef(run, rest) {
  const s = String(rest).trim();
  const colon = /^([^:]+):\s*(.*)$/s.exec(s);
  if (colon && findDone(run, colon[1])) return { ref: colon[1].trim(), why: colon[2] };
  const words = s.split(/\s+/);
  for (let k = words.length; k > 0; k--) {
    const ref = words.slice(0, k).join(' ');
    if (findDone(run, ref)) return { ref, why: words.slice(k).join(' ').replace(/^[-–:,]\s*/, '') };
  }
  return { ref: colon ? colon[1].trim() : words[0], why: '' };
}

// Told to the first step of a go back: it runs again, why, and what the steps after it found.
function againText(run, box) {
  if (!box.againOf || !('why' in box)) return '';
  const cut = (v, n) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const later = (box.after || []).map((id) => run.boxes.find((b) => b.id === id)).filter(Boolean)
    .map((b) => `- ${b.label} (/${b.skill}): ${cut(b.didWhy || b.summary || 'done', 600)}`);
  return [
    ` The user went back to this step: it ran before, and its work is on disk and in git. Build on it; do not start over.`,
    box.why ? ` Why the user went back: ${box.why}` : ' The user did not say why: if it is not clear from the steps below, ask them in one short question first.',
    later.length ? ` What the steps after it did (read their results on disk, like review findings, before you change anything):\n${later.join('\n')}\n` : '',
  ].join('');
}
// The step `model` changes: the one working (or failed), else the next one to start.
const currentStep = (run) => run.boxes.find((b) => b.status === 'running' || b.status === 'failed') || nextBox(run);
// "opus, effort high" / "opus, ultracode"; '' when the step names neither (it keeps the one before).
const modelText = (b) => [b.model, b.effort && (b.effort === 'ultracode' ? 'ultracode' : `effort ${b.effort}`)].filter(Boolean).join(', ');
const sessionOpen = (run) => !!run.session?.open;

// There is no server: every hook call and every `orch` command is a short process that takes the
// lock, loads the runs from disk, does its work, saves, and lets go (withRunner).
// detach: a hook process. Queued runs are then started by a separate `orch tick`, so Claude never
// waits for a worktree to be made; and lessons are looked for by a separate `orch learn`.
export async function withRunner(fn, { detach = false, lockMs } = {}) {
  return withLock(async () => {
    const runner = new Runner({ detach });
    await runner.init();
    try {
      return await fn(runner);
    } finally {
      await runner.settle();
    }
  }, lockMs);
}

export class Runner extends EventEmitter {
  constructor({ detach = false } = {}) {
    super();
    this.runs = new Map(); // id -> run state (same object that is saved to state.json)
    this.shuttingDown = false;
    this.detach = detach;
    this.settings = { maxRunning: 2, learn: true };
    this.lastStatus = new Map(); // id -> status when loaded, to notice when a run starts to need you
    this.jobs = []; // work to do after the main work, one at a time (see later)
    this.wantSchedule = false;
  }

  // Loads saved runs. Sessions live in their own terminal tabs; a session whose tab is gone is
  // marked stopped (Reopen opens it again on the same conversation).
  async init() {
    this.settings = await getSettings();
    for (const run of await loadRuns()) {
      run.chat ??= [];
      const changedFormat = upgrade(run);
      this.runs.set(run.id, run);
      this.lastStatus.set(run.id, run.status);
      let changed = changedFormat;
      // Runs from before the PR links were kept: read the PR links from their saved box results.
      if (!run.ship && run.status === 'done') {
        run.ship = { prUrls: [], epicFolder: null };
        for (const b of run.boxes) if (b.summary) keepShipInfo(run, b.summary);
        changed = true;
      }
      // Its process ended, or it has gone on far longer than a lessons call may (5 min): the pid is not it any more.
      if (run.learn?.status === 'working' && (!alive(run.learn.pid) || Date.now() - Date.parse(run.learn.at) > 15 * 60 * 1000)) {
        Object.assign(run.learn, { status: 'failed', error: 'it stopped while it looked for lessons. Ask for lessons again.' });
        changed = true;
      }
      if (sessionOpen(run) && tabGone(run)) {
        this.closeSession(run, 'its terminal tab is gone');
        changed = true;
      }
      if (startStuck(run)) {
        delete run.starting;
        run.status = 'failed';
        run.error = 'it never finished starting: the process that made its workspace or opened its tab ended. Reopen it to try again.';
        this.log(run, run.error);
        changed = true;
      }
      if (forgetApp(run)) changed = true;
      if (changed) await saveRun(run);
    }
    for (const run of this.runs.values()) this.afterClose(run);
    this.wantSchedule = true;
  }

  // Loads the runs again after the lock was let go (other processes may have changed them).
  // Runs are updated in place, so references to them stay good; references to boxes do not.
  async reload() {
    const fresh = new Map((await loadRuns()).map((r) => [r.id, r]));
    const unreadable = new Set(brokenRuns().map((b) => b.id));
    for (const [id, run] of this.runs) {
      const f = fresh.get(id);
      if (!f) {
        // Deleted, or its file could not be read just now: only a deleted run leaves.
        if (!unreadable.has(id)) this.runs.delete(id);
        continue;
      }
      for (const k of Object.keys(run)) delete run[k];
      Object.assign(run, f, { chat: f.chat ?? [] });
    }
    for (const [id, f] of fresh) if (!this.runs.has(id)) this.runs.set(id, f);
    this.settings = await getSettings();
    for (const run of this.runs.values()) forgetApp(run);
  }

  // Runs slow work (worktrees, waiting, asking claude) with the lock let go, then loads the runs again.
  // Save what must be kept before calling this: unsaved changes are replaced by what is on disk.
  async outside(fn) {
    await flushSaves();
    if (!lockHeld()) return fn();
    try {
      return await withoutLock(fn);
    } finally {
      await this.reload();
    }
  }

  // Work that may let go of the lock (starting a session, cleaning up) runs after the main work, one job
  // at a time: two jobs must never be outside the lock at once.
  later(fn) {
    this.jobs.push(fn);
  }

  // Does the jobs, and starts queued runs when a slot may have freed up.
  async settle() {
    for (;;) {
      if (this.wantSchedule) {
        this.wantSchedule = false;
        if (this.detach) this.tickLater();
        else this.schedule();
      }
      const job = this.jobs.shift();
      if (!job) break;
      await job().catch(() => {});
    }
    await flushSaves();
  }

  // From a hook: start queued runs in a separate process, only when there is something to start.
  tickLater() {
    const all = [...this.runs.values()];
    const working = all.filter((r) => r.status === 'running').length;
    if (working < this.settings.maxRunning && all.some((r) => r.status === 'queued')) spawnJob(['tick']);
  }

  // The run that may use the app now: one whose "uses app" step works, or one that took the app
  // (bin/app.mjs take) and still keeps it. Worked out from the runs, so it is never out of date.
  get appHolder() {
    return findAppHolder(this.runs);
  }

  // The runs waiting for the app, first come first served.
  appLine() {
    return [...this.runs.values()].filter(wantsApp).sort((a, b) => a.appWant.at.localeCompare(b.appWant.at));
  }

  // Who has the app and who waits for it. With id: also whether that run has it, and its place in line.
  appState(id) {
    const holder = this.runs.get(this.appHolder);
    const line = this.appLine();
    const yours = this.appHolder === YOU ? readYourHold() : null;
    const out = {
      holder: holder
        ? { id: holder.id, title: tabTitle(holder), waitingForYou: holder.status === 'waiting', step: holder.boxes.find((b) => WORKING.has(b.status))?.label || null }
        : yours ? { id: YOU, title: 'you', you: true, since: yours.at } : null,
      line: line.map((r) => ({ id: r.id, title: tabTitle(r), since: r.appWant.at })),
    };
    if (id) Object.assign(out, { has: holder?.id === id, place: line.findIndex((r) => r.id === id) + 1 || null });
    return out;
  }

  // bin/app.mjs take: the run joins the line for the app. The first in line gets it once the app is free.
  // It keeps the app while that step works and while the run waits for you after it (see keepsApp).
  // A run that waits for you after a step may take it too (QA tests the run's code between steps, "preqa");
  // that hold ends on next.
  async appTake(id, token) {
    const run = this.mustToken(id, token);
    const working = run.boxes.find((b) => WORKING.has(b.status));
    const box = working || waitingAfterBox(run);
    if (!sessionOpen(run) || !box) throw httpError(409, 'only a working step, or a run waiting for you after a step, can take the app');
    if (this.appHolder === run.id) return this.appState(run.id);
    if (!wantsApp(run)) {
      run.appWant = { box: box.id, at: new Date().toISOString(), ...(working ? {} : { waiting: true }) };
      this.log(run, 'waits for the app');
    }
    if (!this.appHolder && this.appLine()[0] === run) {
      run.appHeld = { box: run.appWant.box, at: new Date().toISOString(), ...(run.appWant.waiting ? { waiting: true } : {}) };
      delete run.appWant;
      this.log(run, 'has the app');
    }
    await saveRun(run);
    this.emitRun(run);
    return this.appState(run.id);
  }

  // The run lets go of the app (or leaves the line). Without a token: you, from orch app release.
  async appRelease(id, token) {
    const run = token ? this.mustToken(id, token) : this.mustGet(id);
    if (run.appHeld || run.appWant) {
      delete run.appHeld;
      delete run.appWant;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, 'let go of the app');
    }
    return this.appState(run.id);
  }

  // The run holding the app, by its tab name (its Jira key when it has one).
  holderName() {
    const holder = this.runs.get(this.appHolder);
    if (holder) return `run ${tabTitle(holder)}`;
    return this.appHolder === YOU ? 'you (your own app: orch app stop frees it)' : this.appHolder;
  }

  getSettings() {
    return this.settings;
  }

  async setSettings(patch) {
    this.settings = await saveSettings({ ...this.settings, ...patch });
    this.wantSchedule = true; // a higher limit may start queued runs now
    return this.settings;
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  // start=false makes a draft: you can edit its boxes, then press Start.
  // repos: [{ token, base? }]. Left out: the template's repos. Each starts from its development
  // branch with no branch of its own; the skills make the branch.
  async createRun({ templateId, input, start = true, repos }) {
    const text = String(input?.text ?? input ?? '');
    if (text.length > MAX_INPUT_CHARS) {
      throw httpError(400, `input is too long (${text.length} chars, max ${MAX_INPUT_CHARS})`);
    }
    const template = await getTemplate(templateId);
    if (!template) throw httpError(404, `template not found: ${templateId}`);
    // A draft may hold such boxes, so you can remove them before you press Start.
    if (start) await this.checkTracking({ tracking: template.tracking !== false }, template.boxes);
    const id = newId('run');
    const repoPlan = workspace.checkPlan(repos ?? (template.repos || []).map((token) => ({ token })));
    // A run with repos works in its own workspace (made when it starts); one without, in an empty folder.
    const cwd = path.join(runDir(id), 'work');
    await fs.mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();
    const run = {
      id,
      templateId: template.id,
      templateName: template.name,
      tracking: template.tracking !== false,
      input: { text },
      status: start ? 'queued' : 'draft',
      queuedAt: start ? now : null,
      sessionId: null,
      session: null,
      hookToken: crypto.randomBytes(16).toString('hex'),
      cwd,
      repoPlan,
      workspace: null,
      // A copy: editing this run's boxes never changes the template.
      // The template's model and effort fill the steps that name none.
      boxes: template.boxes.map((b) => newBox({ ...b, model: b.model || template.model, effort: b.effort || template.effort })),
      chat: [], // what you typed in the terminal (lessons are found from it)
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, run);
    await saveRun(run);
    this.emitRun(run);
    this.log(run, start ? `started from template ${template.id}` : `draft made from template ${template.id}`);
    if (start) this.schedule();
    return run;
  }

  // One run per input, all from the same template and repos (several Jira tickets at once).
  // Everything is checked first, so a bad line makes no runs at all. They queue in the order given.
  async createRuns({ templateId, inputs, start = true, repos }) {
    if (!Array.isArray(inputs)) throw httpError(400, 'inputs must be a list');
    const list = inputs.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!list.length) throw httpError(400, 'give at least one input');
    if (list.length > MAX_BATCH) throw httpError(400, `at most ${MAX_BATCH} runs at once (got ${list.length})`);
    const twice = list.find((x, i) => list.indexOf(x) !== i);
    if (twice) throw httpError(400, `"${twice.slice(0, 60)}" is in the list twice`);
    const long = list.find((x) => x.length > MAX_INPUT_CHARS);
    if (long) throw httpError(400, `an input is too long (${long.length} chars, max ${MAX_INPUT_CHARS})`);
    const template = await getTemplate(templateId);
    if (!template) throw httpError(404, `template not found: ${templateId}`);
    if (start) await this.checkTracking({ tracking: template.tracking !== false }, template.boxes);
    workspace.checkPlan(repos ?? (template.repos || []).map((token) => ({ token })));
    const runs = [];
    for (const text of list) runs.push(await this.createRun({ templateId, input: { text }, start, repos }));
    return runs;
  }

  // With tracking OFF, refuses boxes whose skill writes to Teamspace or the vault.
  async checkTracking(run, boxes) {
    if (run.tracking !== false || !boxes.length) return;
    const problems = offProblems(boxes, await scanSkills());
    if (problems.length) throw httpError(409, `${problems.join('; ')}. ${OFF_HELP}`);
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

  // Frees everything the run takes that is not needed any more: the processes running from its folder (the app
  // too), the folder (worktrees and links), git's worktree records, and its Claude conversation files.
  // Keeps the run (notes, log, stats) and its branches; merged: also deletes its branches git sees as merged.
  // auto: after the Wrap up step, when its tab closed; uncommitted work is then kept, not refused.
  async cleanUp(id, { force = false, auto = false, merged = false } = {}) {
    const run = this.mustGet(id);
    if (sessionOpen(run)) throw httpError(409, 'its terminal tab is open. Close it (or stop the run) first.');
    if (['running', 'queued'].includes(run.status)) throw httpError(409, 'the run is still working');
    if (busy(run.cleaning)) throw httpError(409, 'it is being cleaned up right now');
    if (!run.workspace?.ready) {
      // A workspace that was never finished (its build was cut off): its folder goes too.
      if (partialWorkspace(run)) {
        const ws = run.workspace;
        await this.outside(() => workspace.remove(ws));
        this.log(run, `removed the unfinished workspace ${ws.dir}`);
      }
      if (run.sessionId && !run.cleanedAt) {
        await this.outside(() => forgetConversation(allSessions(run)));
        Object.assign(run, { cleanedAt: new Date().toISOString(), freed: 0 });
        await saveRun(run);
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
      swept = await this.outside(() => sweep(ws, allSessions(run), { merged }));
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

  // Puts a draft, stopped or failed run without an open session in the queue. A session that was
  // open before is reopened (same conversation). With an open session, you answer in its terminal.
  async resume(id) {
    const run = this.mustGet(id);
    if (sessionOpen(run)) {
      if (run.status === 'waiting') throw httpError(409, 'type next in its terminal tab to go on');
      throw httpError(409, 'its terminal tab is open: talk to it there (redo runs the box again)');
    }
    if (!['draft', 'stopped', 'failed', 'waiting', 'needs-you'].includes(run.status)) return run;
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone). Start a new run; its branches are still there.');
    await this.checkTracking(run, run.boxes.filter((b) => b.status !== 'done'));
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

  // The model and effort of the step the run is on (`orch model`, or `/orchestra model …` typed in the run's tab).
  // The step is the one working (or failed); before a step starts, the next one. Only this run changes, not its
  // template. Returns the step and whether the claude running now must restart to use it (`live`): the restart
  // itself happens from the tab (`/orchestra model` typed there), never from outside, because it would cut claude off mid-work.
  async setStepModel(id, { model, effort } = {}) {
    const run = this.mustGet(id);
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up');
    const box = currentStep(run);
    if (!box) throw httpError(409, 'this run has no step left');
    const errors = validateTemplate({ id: 'x', name: 'x', boxes: [{ id: 'x', skill: 'x', model: model || null, effort: effort || null }] });
    if (errors.length) throw httpError(400, errors.join('; ').replace(/box 0: /g, ''));
    if (model !== undefined) box.model = model || null;
    if (effort !== undefined) box.effort = effort || null;
    await saveRun(run);
    this.emitRun(run);
    if (model !== undefined || effort !== undefined) this.log(run, `step ${box.id} set to ${modelText(box) || 'the one before'} by you`);
    return { run, box, live: box.status === 'running' && this.wantsRestart(run, { ...box, fresh: false }) };
  }

  // `/orchestra model …` typed in the run's tab: `/orchestra model` shows the step's model and effort (and applies a
  // change made with `orch model`); `/orchestra model opus`, `… model opus ultracode`, `… model sonnet effort high`,
  // `/orchestra effort max` change them. A working step restarts claude at once on the same conversation and goes on
  // where it was (no redo). The hook sees the line before the skill loads, so it never reaches Claude (no cost).
  // Words that are not a model or effort (a ticket key, say): the /orchestra skill gets the line as usual.
  async onModelWord(run, text) {
    const m = /^\/orchestra\s+(model|effort)(?:\s+(.+))?$/i.exec(text);
    if (!m) return null;
    const words = (m[2] || '').toLowerCase().split(/[\s,]+/).filter((w) => w && w !== 'effort');
    let model;
    let effort;
    for (const w of words) {
      if (EFFORTS.includes(w) && effort === undefined) effort = w;
      else if (m[1].toLowerCase() === 'model' && model === undefined && /^(opus|sonnet|haiku|fable|claude-[a-z0-9.\-[\]]+)$/.test(w)) model = w;
      else return null;
    }
    const say = (reason) => ({ output: { decision: 'block', reason } });
    run.chat.pop(); // a tab command, not talk
    const box = currentStep(run);
    if (!box) return say('Orchestra: this run has no step left to change.');
    const before = modelText(box);
    if (model !== undefined) box.model = model;
    if (effort !== undefined) box.effort = effort;
    const after = modelText(box) || `${run.model || 'the default model'}${run.effort ? `, effort ${run.effort}` : ''}`;
    if (before !== modelText(box)) this.log(run, `step ${box.id} set to ${after} by you (in the tab)`);
    const cost = box.effort === 'ultracode' ? ' Ultracode starts many helper agents: deep, but it costs a lot.' : '';
    if (box.status !== 'running' || !this.wantsRestart(run, { ...box, fresh: false })) {
      await saveRun(run);
      this.emitRun(run);
      const how = 'Change it: /orchestra model opus|sonnet|haiku|fable [effort low|medium|high|xhigh|max|ultracode].';
      if (box.status === 'running') return say(`Orchestra: "${box.label}" already runs with ${after}. ${how}`);
      const when = box.status === 'failed' ? 'Type redo to run it again with it.' : 'It starts with it when you type next.';
      return say(`Orchestra: "${box.label}" (${box.status === 'failed' ? 'failed' : 'the next step'}) will run with ${after}. ${when}${cost}`);
    }
    // Same conversation, never a fresh one (that is for a step's start), and the step goes on: no redo.
    run.restart = { boxId: box.id, model: box.model || run.model || null, effort: box.effort || run.effort || null, fresh: false, at: new Date().toISOString() };
    run.launchPrompt = `Orchestra restarted you with ${after}, because the user asked for it. It is the same conversation: go on with `
      + `the step "${box.label}" from where you were. Do not start the step again. If you were waiting for the user, say in one line `
      + `that you now run with ${after}, and wait for them.`;
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `restarting claude with ${after} for step ${box.id} (asked in the tab)`);
    return say(`Orchestra restarts this tab with ${after} for "${box.label}". Same conversation: it goes on where it was in a few seconds.${cost}`);
  }

  // Go back to a finished step: copies of the steps from there up to where the run is go in right after it, as new
  // steps ("Build (2)", …), and the run goes on from the first copy. The old steps stay as history (notes, cost).
  // A step that is working (or failed) goes back to "to come": it runs again after the copies.
  // Returns { run, copies, reset } or throws. Starting the first copy is the caller's job.
  goBackTo(run, ref, why) {
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone)');
    if (run.status === 'draft' || run.status === 'queued') throw httpError(409, 'this run has not started yet');
    const target = findDone(run, ref);
    if (!target) throw httpError(400, `no finished step "${ref}". ${doneList(run)}`);
    const live = run.boxes.find((b) => b.status === 'running' || b.status === 'failed');
    const t = run.boxes.indexOf(target);
    const end = live ? run.boxes.indexOf(live) : run.boxes.reduce((last, b, i) => (b.status === 'done' ? i : last), -1) + 1;
    const ids = new Set(run.boxes.map((b) => b.id));
    const later = run.boxes.slice(t + 1, end).filter((b) => b.status === 'done');
    const copies = run.boxes.slice(t, end).map((b, i) => {
      const base = b.againOf || b.id;
      let n = 2;
      while (ids.has(`${base}-${n}`)) n++;
      ids.add(`${base}-${n}`);
      const copy = newBox({ ...b, id: `${base}-${n}`, label: `${String(b.label).replace(/\s\(\d+\)$/, '').slice(0, 72)} (${n})` });
      copy.againOf = base;
      if (i === 0) {
        copy.why = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 1500) || null;
        copy.after = later.map((b2) => b2.id);
      }
      return copy;
    });
    if (live) {
      Object.assign(live, { status: 'pending', note: 'Stopped when you went back; it runs again after the steps before it.', error: null });
      if (run.currentBox === live.id) run.currentBox = null;
    }
    run.boxes.splice(end, 0, ...copies);
    run.waitingAfter = null;
    run.walkthroughFor = null;
    run.finishedAt = null;
    run.cleanWhenClosed = false;
    run.status = 'waiting';
    run.note = `Went back to "${target.label}". Type next in its tab to start "${copies[0].label}".`;
    this.log(run, `went back to ${target.id}: added ${copies.map((b) => b.id).join(', ')}${live ? `; ${live.id} runs again after them` : ''}${copies[0].why ? ` (why: ${copies[0].why})` : ''}`);
    return { run, copies, reset: live || null };
  }

  // `orch back <run> <step> [why]`: adds the copies; the user types next in the run's tab to start them.
  // text: the step and why, as typed ("build fix the review findings").
  async goBack(id, text) {
    const run = this.mustGet(id);
    if (run.status === 'running' && sessionOpen(run)) throw httpError(409, 'it is working now: wait until it stops, or type "/orchestra back <step>" in its tab');
    const { ref, why } = splitStepRef(run, text);
    const out = this.goBackTo(run, ref, why);
    await saveRun(run);
    this.emitRun(run);
    return out;
  }

  // `/orchestra back <step> [why]` (also `from`, `back to`, `go back to`) typed in the run's tab: goes back and starts
  // the first copy at once. Claude restarts on the same conversation (a "new conversation" step starts a new one),
  // because a blocked prompt gives Claude no turn to start it in. Never reaches Claude or the skill (no cost).
  async onBackWord(run, text) {
    const m = /^\/orchestra\s+(?:go\s+back\s+to|back\s+to|back|from)\s+(.+)$/i.exec(text);
    if (!m) return null;
    const say = (reason) => ({ output: { decision: 'block', reason } });
    run.chat.pop(); // a tab command, not talk
    const { ref, why } = splitStepRef(run, m[1]);
    let out;
    try {
      out = this.goBackTo(run, ref, why);
    } catch (err) {
      await saveRun(run);
      return say(`Orchestra: ${err.message}`);
    }
    const first = out.copies[0];
    const added = `Added after "${out.run.boxes[out.run.boxes.indexOf(first) - 1]?.label}": ${out.copies.map((b) => b.label).join(' > ')}.`;
    const reset = out.reset ? ` "${out.reset.label}" runs again after them.` : '';
    if (first.usesApp && this.appHolder && this.appHolder !== run.id) {
      run.note = `The app is in use by ${this.holderName()}. Type next in the terminal when it is free.`;
      await saveRun(run);
      this.emitRun(run);
      return say(`Orchestra went back to "${out.run.boxes.find((b) => b.id === first.againOf)?.label || first.label}". ${added}${reset} "${first.label}" needs the app, and ${this.holderName()} has it: type next when it is free.`);
    }
    this.startBox(run, first);
    await this.restartFor(run, first, instruction(run, first));
    return say(`Orchestra went back. ${added}${reset} "${first.label}" starts ${first.fresh ? 'in a new conversation' : 'on this conversation'} in a few seconds.`);
  }

  // What the ticket is about, said by hand (the run's Claude says it by itself with an ORCHESTRA:ABOUT: line).
  async setAbout(id, text) {
    const run = this.mustGet(id);
    run.about = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null;
    await saveRun(run);
    return run;
  }

  // Pins: steps you follow by hand, kept in the steps pane (newest first there). Claude pins them with a PIN block;
  // you pin with `pin` in the run's tab or `orch pin`.
  async addPin(id, pin) {
    const run = this.mustGet(id);
    const added = pushPin(run, { ...pin, from: pin.from || 'you' });
    if (!added) throw httpError(400, 'nothing to pin: give the text');
    await saveRun(run);
    return run;
  }

  // which: a number as the pane shows it (1 = newest), 'all', or nothing for the one the pane shows now.
  async removePin(id, which) {
    const run = this.mustGet(id);
    const gone = dropPin(run, which);
    if (!gone.length) throw httpError(400, (run.pins || []).length ? `no pin ${which}: there are ${run.pins.length}` : 'this run has no pins');
    await saveRun(run);
    return { run, removed: gone };
  }

  // Replaces the run's box list. Finished and working boxes stay first and keep their place;
  // only their label and settings may change. The template never changes.
  async updateBoxes(id, list) {
    const run = this.mustGet(id);
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone); its boxes can no longer change');
    if (!Array.isArray(list)) throw httpError(400, 'boxes must be a list');
    // A finished run may get new steps at the end (like Wrap up); then it waits for next again.
    if (run.status === 'done' && list.length <= run.boxes.length) throw httpError(400, 'this run is finished; only new steps at the end can be added');
    const errors = validateTemplate({ id: 'x', name: 'x', boxes: list });
    if (errors.length) throw httpError(400, errors.join('; '));
    const locked = run.boxes.filter((b) => STARTED.has(b.status));
    for (const [i, b] of locked.entries()) {
      const n = list[i];
      if (n?.id !== b.id || n.skill !== b.skill) {
        throw httpError(409, `box ${b.id} has ${b.status === 'done' ? 'finished' : 'started'}; it must stay at place ${i + 1}`);
      }
    }
    const old = new Map(run.boxes.map((b) => [b.id, b]));
    // Only new skills are checked; a box that already ran is history.
    await this.checkTracking(run, list.slice(locked.length).filter((n) => old.get(n.id)?.skill !== n.skill));
    run.boxes = list.map((n, i) => {
      const b = i < locked.length ? old.get(n.id) : old.get(n.id)?.skill === n.skill ? old.get(n.id) : newBox(n);
      b.label = String(n.label || n.skill).slice(0, 80);
      b.waitAfter = !!n.waitAfter;
      b.usesApp = !!n.usesApp;
      b.walkthrough = !!n.walkthrough;
      b.fresh = !!n.fresh;
      b.model = n.model || null;
      b.effort = n.effort || null;
      if (i >= locked.length) b.args = String(n.args || '').slice(0, 2000);
      return b;
    });
    if (run.status === 'done' && nextBox(run)) {
      run.status = 'waiting';
      run.waitingAfter = locked.at(-1)?.id || null;
      run.finishedAt = null;
      run.note = 'New steps added. Type next in its tab to go on.';
    }
    await saveRun(run);
    this.emitRun(run);
    this.log(run, 'boxes changed by you');
    return run;
  }

  canLearn(run) {
    if (run.status === 'running' || run.status === 'queued') throw httpError(409, 'wait until the run stops working');
    if (run.learn?.status === 'working') throw httpError(409, 'already looking for lessons in this run');
  }

  // Asks a fresh claude what this run teaches: rules and workflow changes for you to accept or reject.
  // auto: after a finished run, only when there is something to learn from, and never twice.
  async learn(id, { auto = false } = {}) {
    const run = this.mustGet(id);
    this.canLearn(run);
    if (auto && (run.learn || !material(run))) return run;
    // A hook must not wait for claude: a separate process looks for the lessons.
    if (this.detach) {
      spawnJob(['learn', id, ...(auto ? ['--auto'] : [])]);
      return run;
    }
    run.learn = { status: 'working', at: new Date().toISOString(), auto, count: 0, cost: 0, error: null, pid: process.pid };
    await saveRun(run);
    this.emitRun(run);
    this.log(run, 'looking for lessons in this run');
    const dir = path.join(runDir(run.id), 'learn');
    try {
      await fs.mkdir(dir, { recursive: true });
      const prompt = buildPrompt(run, readInstructionsSync());
      const { text, cost } = await this.outside(() => ask(prompt, { cwd: dir, env: childEnv() }));
      if (!this.runs.has(id)) return { ok: true };
      run.learn.cost = round(cost);
      this.totalCost(run);
      const added = await addSuggestions(run, parseSuggestions(text));
      run.learn.count = added.length;
      run.learn.status = 'done';
      this.log(run, added.length ? `${added.length} lesson${added.length > 1 ? 's' : ''} suggested ($${run.learn.cost})` : `no lessons found ($${run.learn.cost})`);
      if (added.length) this.emit('suggestions');
    } catch (err) {
      run.learn.status = 'failed';
      run.learn.error = err.message;
      this.log(run, `looking for lessons failed: ${err.message}`);
    }
    run.learn.endedAt = new Date().toISOString();
    await saveRun(run);
    this.emitRun(run);
    return run;
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
    // The workspace goes first: if that fails, the run stays, so nothing is left half-deleted.
    if (run.workspace?.ready || partialWorkspace(run)) {
      const ws = run.workspace;
      run.cleaning = { pid: process.pid, at: Date.now() };
      await saveRun(run);
      try {
        await this.outside(() => workspace.remove(ws));
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
    this.emit('deleted', { id });
    return { ok: true };
  }

  // Last lines of the run's log and live activity, oldest first.
  async timeline(id, limit = 400) {
    this.mustGet(id);
    const read = async (name) => {
      try {
        return (await fs.readFile(path.join(runDir(id), name), 'utf8')).trim().split('\n').slice(-limit).flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    };
    const events = (await read('events.jsonl')).map((e) => ({ ...e, kind: 'log', text: e.message }));
    const activity = await read('activity.jsonl');
    return [...events, ...activity].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
  }

  // The terminal tabs are not Orchestra's children: they keep going, and report back when it is up again.
  shutdown() {
    this.shuttingDown = true;
  }

  // ---- the terminal session ----

  // Starts queued runs, oldest first, while fewer than the limit are working.
  // Only working runs use a slot: runs that wait for you do not.
  schedule() {
    if (this.shuttingDown) return;
    const all = [...this.runs.values()];
    let working = all.filter((r) => r.status === 'running').length;
    const queue = all.filter((r) => r.status === 'queued').sort((a, b) => queueTime(a).localeCompare(queueTime(b)));
    for (const run of queue) {
      if (working >= this.settings.maxRunning) break;
      // A run whose first step starts the app waits until the app is free.
      const box = nextBox(run);
      if (!run.sessionId && box?.usesApp && this.appHolder && this.appHolder !== run.id) continue;
      working++;
      run.status = 'running';
      // Who is starting it: if this process ends before the tab opens, the next one sees it (init).
      run.starting = { pid: process.pid, at: Date.now() };
      this.emitRun(run);
      saveRun(run);
      this.later(() => this.startSession(run).catch(async (err) => {
        if (!this.runs.has(run.id)) return;
        delete run.starting;
        run.status = 'failed';
        run.error = `could not open the terminal: ${err.message}`;
        this.log(run, run.error);
        await saveRun(run).catch(() => {});
        this.emitRun(run);
      }));
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
      const box = nextBox(run);
      if (box) {
        const problem = await this.trackingProblem(run, box);
        if (problem) return this.finishBox(run, box, { ok: false, error: problem });
        this.startBox(run, box);
        run.launchPrompt = this.firstPrompt(run, box);
      }
    } else {
      run.status = 'needs-you';
      run.note = run.boxes.some((b) => b.status === 'running')
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

  // What the launcher in the tab starts: claude, attached to the terminal, with Orchestra's hooks.
  async launchSpec(id, token, pid) {
    const run = this.mustToken(id, token);
    if (!sessionOpen(run)) throw httpError(409, 'this run has no open session. Reopen it with /orchestra reopen.');
    run.session.pid = Number(pid) || null;
    // The model and effort of the step it starts with; a step that names none keeps the run's current ones.
    const box = run.boxes.find((b) => b.status === 'running') || nextBox(run);
    if (box?.model) run.model = box.model;
    if (box?.effort) run.effort = box.effort;
    // The run repos' own skills (in <repo>/.claude/skills) load only from an added folder.
    const repoDirs = (run.workspace?.ready ? run.workspace.repos : []).map((r) => r.dir).filter(Boolean);
    // --add-dir takes several folders, so it must not sit just before the prompt (it would eat it as a folder).
    const args = ['--add-dir', config.itpRoot, ...repoDirs, run.sessionSeen ? '--resume' : '--session-id', run.sessionId,
      '--name', tabTitle(run), '--settings', sessionSettings(), '--append-system-prompt', runRules(run)];
    if (run.model) args.push('--model', run.model);
    if (run.effort) args.push('--effort', run.effort);
    if (run.launchPrompt) args.push(run.launchPrompt);
    run.launchPrompt = null; // given once; `redo` starts the box again if the launch failed
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
  wantsRestart(run, box) {
    return sessionOpen(run) && !!(box.fresh || (box.model && box.model !== run.model) || (box.effort && box.effort !== run.effort));
  }

  // The box is started; the claude running now ends its turn, and the launcher starts a new one with the box's
  // model and effort (restart.ok). The prompt reaches the new claude; a fresh step gets the story so far with it.
  async restartFor(run, box, prompt) {
    run.restart = { boxId: box.id, model: box.model || run.model || null, effort: box.effort || run.effort || null, fresh: !!box.fresh, at: new Date().toISOString() };
    run.launchPrompt = box.fresh ? handoffPrompt(run, box, prompt) : prompt;
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `box ${box.id} wants ${[box.fresh && 'a new conversation', box.model, box.effort && `effort ${box.effort}`].filter(Boolean).join(' · ')}: restarting claude`);
    return { restart: true };
  }

  // What the old claude is told when you typed next or redo and a restart takes over (your prompt is not sent).
  restartBlock(run, box) {
    const what = [box.model, box.effort && `effort ${box.effort}`].filter(Boolean).join(', ');
    const how = box.fresh ? `starts a new conversation${what ? ` (${what})` : ''}` : `restarts this tab with ${what}`;
    return { output: { decision: 'block', reason: `Orchestra ${how} for "${box.label}". It goes on by itself in a few seconds.` } };
  }

  // One Claude hook event from the run's session. Returns { output } for Claude, or { line } for the status line.
  async onHook(id, event, body = {}, token) {
    const run = this.mustToken(id, token);
    switch (event) {
      case 'SessionStart':
        return this.onSessionStart(run, body);
      case 'UserPromptSubmit':
        return this.onPrompt(run, body);
      case 'PostToolUse':
        return this.onTool(run, body);
      case 'Notification':
        return this.onNotification(run, body);
      case 'Stop':
        return this.onStop(run, body);
      case 'SessionEnd':
        return this.onClosed(id, token);
      case 'status':
        return this.onStatus(run, body);
      default:
        return {};
    }
  }

  async onSessionStart(run, body) {
    run.sessionSeen = true;
    if (body.session_id) run.sessionId = body.session_id;
    run.session ||= { open: true, openedAt: new Date().toISOString() };
    run.session.open = true;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `session ${body.source === 'resume' ? 'resumed' : 'started'}`);
    return {};
  }

  // Your message in the terminal. `next` and `redo` steer the run; anything else is plain talk.
  async onPrompt(run, body) {
    const text = String(body.prompt ?? '').trim();
    const cmd = text.toLowerCase().replace(/^\//, '');
    if (text) run.chat.push({ id: newId('msg'), kind: 'you', text: text.slice(0, 4000), at: new Date().toISOString() });
    const pinned = await this.onPinWord(run, text);
    if (pinned) return pinned;
    const modelSet = await this.onModelWord(run, text);
    if (modelSet) return modelSet;
    const back = await this.onBackWord(run, text);
    if (back) return back;
    // Until the run knows what its ticket is about, ask for the ABOUT line (3 times at most).
    // This also reaches tabs opened before the rule was in their system prompt.
    const ask = !run.about && (run.aboutAsked || 0) < 3;
    if (ask) run.aboutAsked = (run.aboutAsked || 0) + 1;
    const context = (c) => ({ output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: [c, ask && ABOUT_RULE].filter(Boolean).join('\n') } } });

    if ((cmd === 'next' || cmd === 'skip') && run.status === 'done') {
      await saveRun(run);
      return context('All steps of this Orchestra run are done. Tell the user the run is finished, in one short line.');
    }
    if (cmd === 'next') {
      run.walkthroughFor = null;
      const cur = run.boxes.find((b) => b.status === 'running' || b.status === 'failed');
      // Wrap up said "not yet": next runs it again (it is the last step; skipping it would end the run unwrapped).
      if (cur?.skill === WRAP_UP_SKILL) {
        this.startBox(run, cur);
        if (this.wantsRestart(run, cur)) {
          await this.restartFor(run, cur, `The user is ready to wrap up now. ${instruction(run, cur)}`);
          return this.restartBlock(run, cur);
        }
        run.status = 'running';
        await saveRun(run);
        this.emitRun(run);
        return context(`The user is ready to wrap up now. ${instruction(run, cur)}`);
      }
      // A step that has not said it is done (cut off, or Claude asks you something): next goes on with it.
      // Only skip moves past it.
      if (cur?.status === 'running') {
        run.status = 'running';
        run.note = null;
        await saveRun(run);
        this.emitRun(run);
        this.log(run, `next: go on with step ${cur.id}`);
        return context(`The user typed next: go on with the step "${cur.label}" from where you stopped (do not start it again). If you were waiting for an answer from the user, ask again in one short line. If the step is fully finished, end with the WHAT I DID AND WHY section and the line ${DONE_MARK}.`);
      }
      if (cur?.status === 'failed') {
        await saveRun(run);
        return context(`The step "${cur.label}" failed. Tell the user in one short line: type redo to run it again, or skip to go on without it.`);
      }
      return this.moveOn(run, null, context);
    }

    if (cmd === 'skip') {
      run.walkthroughFor = null;
      const cur = run.boxes.find((b) => b.status === 'running' || b.status === 'failed');
      if (cur) {
        await this.finishBox(run, cur, { ok: true, text: cur.lastReply || '', note: 'skipped by you' });
        this.log(run, `step ${cur.id} skipped by you`);
      }
      return this.moveOn(run, cur, context);
    }

    if (cmd === 'redo') {
      const box = run.boxes.find((b) => b.status === 'running' || b.status === 'failed') || [...run.boxes].reverse().find((b) => b.status === 'done');
      if (!box) return context('There is no step to run again yet. Tell the user to type next to start the first step.');
      const problem = await this.trackingProblem(run, box);
      if (problem) return context(`${problem}. Tell the user this.`);
      if (box.usesApp && this.appHolder && this.appHolder !== run.id) return context(`The app is in use by ${this.holderName()}. Tell the user to type redo again when it is free.`);
      run.walkthroughFor = null;
      run.waitingAfter = null;
      this.startBox(run, box);
      if (this.wantsRestart(run, box)) {
        await this.restartFor(run, box, `The user wants to run this step again. ${instruction(run, box)}`);
        return this.restartBlock(run, box);
      }
      run.status = 'running';
      await saveRun(run);
      this.emitRun(run);
      return context(`The user wants to run this step again. ${instruction(run, box)}`);
    }

    if (run.status === 'needs-you') {
      run.status = 'running';
      run.note = null;
    }
    await saveRun(run);
    this.emitRun(run);
    return ask ? context('') : {};
  }

  // `pin` (Claude's last answer), `pin 2` (the answer before), `pin: your note`, `unpin` (the pin the pane shows),
  // `unpin 2`, `unpin all`. The prompt is not sent to Claude (no cost); the user sees a one-line answer.
  async onPinWord(run, text) {
    const m = /^\/?(pin|unpin)(?:\s+(all|\d{1,2})|\s*:\s*([\s\S]+))?\s*$/i.exec(text);
    if (!m) return null;
    const word = m[1].toLowerCase();
    if (m[2]) m[2] = m[2].toLowerCase(); // "unpin ALL" too
    if (word === 'unpin' ? m[3] : m[2] === 'all') return null; // "unpin: …" and "pin all" are talk
    const say = (reason) => ({ output: { decision: 'block', reason } });
    run.chat.pop(); // a pane command, not talk
    if (word === 'unpin') {
      const gone = dropPin(run, m[2]);
      if (!gone.length) return say((run.pins || []).length ? `Orchestra: there is no pin ${m[2]} (there are ${run.pins.length}).` : 'Orchestra: this run has no pins.');
      await saveRun(run);
      return say(`Orchestra unpinned ${gone.length > 1 ? `all ${gone.length} pins` : `"${gone[0].title}"`}.`);
    }
    let pin;
    if (m[3]) pin = { text: m[3].trim(), from: 'you' };
    else {
      const n = Number(m[2] || 1);
      const reply = (run.replies || [])[n - 1];
      if (!reply) return say(n === 1 ? 'Orchestra: there is no answer from Claude to pin yet.' : `Orchestra: Claude has no answer ${n} back to pin (it keeps the last ${MAX_REPLIES}).`);
      pin = { text: reply, from: 'answer' };
    }
    const added = pushPin(run, pin);
    if (!added) return say('Orchestra: nothing to pin.');
    await saveRun(run);
    this.log(run, `pinned: ${added.title}`);
    return say(`Orchestra pinned "${added.title}" to the side pane (${run.pins.length} pin${run.pins.length > 1 ? 's' : ''}). Click the pane, then use the arrow keys or the mouse wheel to scroll.`);
  }

  async onTool(run, body) {
    this.activity(run, run.currentBox || null, 'tool', describeTool({ name: body.tool_name, input: body.tool_input }));
    // A tool ran, so an "Allow?" prompt was answered: the run works again.
    if (run.status === 'needs-you' && run.boxes.some((b) => b.status === 'running')) {
      run.status = 'running';
      run.note = null;
      await saveRun(run);
      this.emitRun(run);
    }
    return {};
  }

  // Claude waits for you: an "Allow?" prompt, or it has been idle.
  async onNotification(run, body) {
    if (run.status !== 'running') return {};
    run.status = 'needs-you';
    run.note = String(body.message || 'Claude is waiting for you').slice(0, 300);
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `needs you: ${run.note}`);
    return {};
  }

  // `next` (nothing unfinished) or `skip`: start the step after, past any gate, and tell Claude what happened.
  async moveOn(run, from, context) {
    run.waitingAfter = null;
    const r = await this.advance(run, from, { force: true, appWaitMs: 0 });
    if (r.restart) return this.restartBlock(run, run.boxes.find((b) => b.id === run.restart.boxId));
    if (r.output?.reason) return context(r.output.reason);
    if (run.status === 'done') return context('All steps of this Orchestra run are done. Tell the user the run is finished, in one short line.');
    return context(`Orchestra could not start the next step: ${run.note || run.error || 'unknown reason'}. Tell the user this in one short line.`);
  }

  // Claude ended its turn. A step marked done moves the run on; anything else waits for you.
  async onStop(run, body) {
    const said = readAbout(lastReply(body));
    if (said.about && !run.about) {
      run.about = said.about;
      this.log(run, `about: ${said.about}`);
    }
    const pinned = readPins(said.text);
    for (const p of pinned.pins) {
      if ((run.pins || []).some((old) => old.text === p.text)) continue; // said again: pinned already
      const added = pushPin(run, { ...p, from: 'claude' });
      if (added) this.log(run, `pinned: ${added.title}`);
    }
    const { mark, text } = readMark(pinned.text);
    keepReply(run, text);
    for (const note of safeFollow(run)) this.log(run, note);
    if (text.trim()) this.activity(run, run.currentBox || null, 'text', text.slice(-2000));

    // The walk-through after a box is over: go on as that box would have.
    if (run.walkthroughFor) {
      const done = run.boxes.find((b) => b.id === run.walkthroughFor);
      run.walkthroughFor = null;
      if (done) return this.advance(run, done);
    }
    const box = run.boxes.find((b) => b.status === 'running');
    if (!box) {
      if (run.status === 'running') run.status = 'needs-you';
      await saveRun(run);
      this.emitRun(run);
      return {};
    }
    box.lastReply = text.slice(-4000);
    if (mark === DONE_MARK && box.skill === WRAP_UP_SKILL) {
      // You chose in the step: clean up when the tab closes, or keep the folder (a KEEP line).
      const keep = KEEP_LINE.test(text);
      run.cleanWhenClosed = !keep;
      await this.finishBox(run, box, { ok: true, text: text.replace(KEEP_LINE, '') });
      const r = await this.advance(run, box);
      if (run.status === 'done') {
        run.note = keep ? 'Wrapped up. The folder stays (you chose Keep): clean it later from /orchestra.' : 'Wrapped up. Close this tab: Orchestra then cleans up the run.';
        await saveRun(run);
        this.emitRun(run);
      }
      return r;
    }
    if (mark === DONE_MARK) {
      await this.finishBox(run, box, { ok: true, text });
      if (box.walkthrough) {
        run.walkthroughFor = box.id;
        await saveRun(run);
        this.log(run, `explaining the code after box ${box.id}`);
        return { output: { decision: 'block', reason: WALKTHROUGH } };
      }
      return this.advance(run, box);
    }
    if (mark === FAILED_MARK) {
      await this.finishBox(run, box, { ok: false, error: text.trim().slice(-600) || 'the step could not be done' });
      return {};
    }
    // Still working with you: a question, or a talk.
    run.status = 'needs-you';
    run.note = null;
    run.asks = text.trim().slice(-600);
    await saveRun(run);
    this.emitRun(run);
    return {};
  }

  // After doneBox: the next box (Claude goes on by itself), a gate (you type next), or the end.
  // force: you typed next, so a gate does not stop it. appWaitMs: how long to wait for the app.
  async advance(run, doneBox, { force = false, appWaitMs = APP_WAIT_MS } = {}) {
    let next = nextBox(run);
    if (!next) {
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      run.note = null;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, 'finished');
      if (this.settings.learn !== false) this.later(() => this.learn(run.id, { auto: true }));
      return {};
    }
    if (doneBox?.waitAfter && !force) {
      run.status = 'waiting';
      run.waitingAfter = doneBox.id;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `waiting for you after box ${doneBox.id}`);
      return {};
    }
    const problem = await this.trackingProblem(run, next);
    if (problem) {
      await this.finishBox(run, next, { ok: false, error: problem });
      return {};
    }
    const nextId = next.id;
    const free = !next.usesApp || (await this.waitForApp(run, nextId, appWaitMs));
    // Waiting reloads the run from disk: find the box again.
    next = run.boxes.find((b) => b.id === nextId);
    if (!next || !this.runs.has(run.id)) return {};
    // The tab closed while it waited: it stays "stopped" (reopen it), not "type next".
    if (!free && !sessionOpen(run)) return {};
    if (!free) {
      run.status = 'waiting';
      run.note = `The app is in use by ${this.holderName()}. Type next in the terminal when it is free.`;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `box ${next.id} waits for the app`);
      return {};
    }
    this.startBox(run, next);
    // Another model or effort: no block, so this claude ends its turn and the launcher starts the new one.
    if (this.wantsRestart(run, next)) return this.restartFor(run, next, instruction(run, next));
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    return { output: { decision: 'block', reason: instruction(run, next) } };
  }

  // One run at a time may start the app to test it. Waits up to ms for it (the Stop hook waits with us).
  // The lock is let go while waiting, so the run holding the app can finish its box.
  async waitForApp(run, boxId, ms) {
    const end = Date.now() + ms;
    let told = false;
    const box = () => run.boxes.find((b) => b.id === boxId) || {};
    while (this.appHolder && this.appHolder !== run.id) {
      if (Date.now() >= end || !sessionOpen(run) || this.shuttingDown || !this.runs.has(run.id)) return false;
      if (!told) {
        box().note = `Waiting for the app: ${this.holderName()} is using it.`;
        await saveRun(run);
        this.emitRun(run);
        this.log(run, `box ${boxId} waits for the app (${this.holderName()} has it)`);
        told = true;
      }
      await this.outside(() => new Promise((r) => setTimeout(r, 500)));
    }
    box().note = null;
    return true;
  }

  // The status line: shows the box and keeps the run's cost. Claude reports its conversation's running total, and a
  // resumed conversation goes on from its saved total; so the run's cost is the conversations that are over
  // (costPast, see fresh steps) plus this one's total. A 0 before claude has restored its total is skipped.
  async onStatus(run, body) {
    const cost = Number(body?.cost?.total_cost_usd);
    if (Number.isFinite(cost) && run.session) {
      const base = run.costPast || 0;
      const total = round(base + cost);
      if (total !== run.sessionCost && !(cost === 0 && (run.sessionCost || 0) > base)) {
        run.sessionCost = total;
        this.totalCost(run);
        await saveRun(run);
        this.emitRun(run);
      }
    }
    const box = run.boxes.find((b) => b.status === 'running');
    const model = body?.model?.display_name || body?.model?.id;
    return { line: `Orchestra · ${box ? box.label : run.status}${model ? ` · ${model}` : ''} · $${(run.cost || 0).toFixed(2)}` };
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
    const box = run.boxes.find((b) => b.status === 'running');
    if (box) box.note = 'Cut off: the tab closed while this step worked. Reopen the run, then type next to go on with it, or redo to start it again.';
    if (run.status !== 'done') run.status = 'stopped';
    this.log(run, `session closed: ${why}`);
  }

  // ---- boxes ----

  startBox(run, box) {
    box.status = 'running';
    box.attempts = (box.attempts || 0) + 1;
    box.startedAt = new Date().toISOString();
    box.endedAt = null;
    box.error = null;
    box.note = null;
    box.costStart = run.sessionCost || 0;
    run.currentBox = box.id;
    run.asks = null;
    this.log(run, `box ${box.id} (/${box.skill}) started${box.attempts > 1 ? ` (try ${box.attempts})` : ''}`);
  }

  // The first box goes on claude's command line, with the run input.
  firstPrompt(run, box) {
    return [`/${box.skill}`, box.args, run.input.text].filter(Boolean).join(' ');
  }

  async trackingProblem(run, box) {
    if (run.tracking !== false) return null;
    const [problem] = offProblems([box], await scanSkills());
    return problem ? `${problem}. ${OFF_HELP}` : null;
  }

  async finishBox(run, box, { ok, error, text = '', note }) {
    box.endedAt = new Date().toISOString();
    box.durationMs = (box.durationMs || 0) + Math.max(0, Date.parse(box.endedAt) - Date.parse(box.startedAt || box.endedAt));
    box.cost = round((box.cost || 0) + Math.max(0, (run.sessionCost || 0) - (box.costStart || 0)));
    box.costStart = run.sessionCost || 0;
    if (ok) {
      box.status = 'done';
      const done = readWhy(text);
      if (done.text.trim()) box.summary = done.text.slice(-4000);
      if (done.why) box.didWhy = done.why.slice(0, 3000);
      keepShipInfo(run, text);
      box.note = note || null;
      this.log(run, `box ${box.id} done${note ? ` (${note})` : ''}`);
    } else {
      box.status = 'failed';
      box.failures = (box.failures || 0) + 1;
      box.error = error;
      run.status = 'failed';
      run.error = `box ${box.id}: ${error}`;
      this.log(run, `box ${box.id} failed: ${error}`);
    }
    await saveRun(run);
    this.emitRun(run);
    return ok;
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

  // ---- internals ----

  mustGet(id) {
    const run = this.runs.get(id);
    if (!run) throw httpError(404, `run not found: ${id}`);
    return run;
  }

  // Hook and launcher calls carry the run's token, so only its own session can steer it.
  mustToken(id, token) {
    const run = this.mustGet(id);
    if (!token || token !== run.hookToken) throw httpError(403, 'wrong run token');
    return run;
  }

  totalCost(run) {
    run.cost = round((run.sessionCost || 0) + (run.learn?.cost || 0));
  }

  emitRun(run) {
    // A Windows notification when the run starts to need you.
    const was = this.lastStatus.get(run.id);
    this.lastStatus.set(run.id, run.status);
    if (was && was !== run.status && NOTIFY[run.status]) {
      const sent = notify({ title: `Orchestra: ${tabTitle(run)}`, body: `${run.input?.text?.slice(0, 80) || run.id} ${NOTIFY[run.status]}.`, url: focusUrl(tabTitle(run)) });
      this.log(run, `notification${sent ? '' : ' (off)'}: ${NOTIFY[run.status]}`);
    }
    this.emit('run', run);
    // A run that stopped working frees a slot.
    if (was === 'running' && run.status !== 'running') this.wantSchedule = true;
  }

  activity(run, boxId, kind, text) {
    const line = { at: new Date().toISOString(), boxId, kind, text };
    try {
      appendLine(path.join(runDir(run.id), 'activity.jsonl'), JSON.stringify(line));
    } catch {}
    this.emit('activity', { runId: run.id, ...line });
  }

  log(run, message) {
    const line = { at: new Date().toISOString(), message };
    try {
      appendLine(path.join(runDir(run.id), 'events.jsonl'), JSON.stringify(line));
    } catch {}
    this.emit('log', { runId: run.id, ...line });
  }
}

// A run saved before runs became terminal sessions (no hook token). Its claude -p session can be
// resumed in a terminal, so it becomes a stopped run: "Reopen terminal" goes on with the same conversation.
function upgrade(run) {
  if (run.hookToken) return false;
  run.hookToken = crypto.randomBytes(16).toString('hex');
  run.sessionSeen = !!run.sessionId;
  run.session = null;
  for (const b of run.boxes) {
    if (['question', 'approval'].includes(b.status)) b.status = 'running';
    delete b.pid;
  }
  if (['question', 'approval', 'running', 'waiting'].includes(run.status)) run.status = 'stopped';
  return true;
}

// A fresh step starts a new conversation (to keep each request small): it is told the story so far, from what the
// steps before wrote, then its own instruction. Plans, epics and code are on disk; the skills read them from there.
function handoffPrompt(run, box, prompt) {
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const all = run.boxes.filter((b) => b.status === 'done').map((b) => `- ${b.label} (/${b.skill}): ${cut(String(b.didWhy || b.summary || 'done').replace(/\s+/g, ' ').trim(), 1200)}`);
  // The prompt goes on claude's command line (Windows: 32767 chars with the rules and settings): the newest
  // steps first, up to HANDOFF_STEPS_CHARS.
  const done = [];
  let size = 0;
  for (const line of [...all].reverse()) {
    if (size + line.length > HANDOFF_STEPS_CHARS) break;
    done.unshift(line);
    size += line.length + 1;
  }
  if (done.length < all.length) done.unshift(`- (${all.length - done.length} earlier steps left out: their results are on disk)`);
  const ship = run.ship || {};
  const repos = (run.workspace?.repos || []).map((r) => `${r.folder}${r.branch ? ` (branch ${r.branch})` : ' (no branch yet)'}`);
  return [
    `This continues an Orchestra run in a new conversation, to keep it small. The job: ${cut(run.input?.text || '', 600)}${run.about ? ` (${run.about})` : ''}.`,
    done.length ? `What the steps before did:\n${done.join('\n')}` : '',
    ship.epicFolder ? `Epic folder: ${ship.epicFolder}.` : '',
    ship.prUrls?.length ? `Pull requests: ${ship.prUrls.join(', ')}.` : '',
    repos.length ? `This run's worktrees (in the current folder): ${repos.join(', ')}.` : '',
    'Read what you need from disk (the plan, the epic, the code, git log) instead of guessing.',
    prompt,
  ].filter(Boolean).join('\n\n');
}

// ---- pins ----

const MAX_PINS = 20;
const MAX_REPLIES = 5;

// Adds a pin (newest last in the file; the pane shows it first). Returns it, or null when there is no text.
function pushPin(run, { title, text, from }) {
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/^\s*\n|\s+$/g, '').slice(0, 20000);
  if (!body.trim()) return null;
  const pin = { id: newId('pin'), title: String(title || '').trim().slice(0, 80) || firstWords(body), text: body, from, at: new Date().toISOString() };
  run.pins = [...(run.pins || []), pin].slice(-MAX_PINS);
  return pin;
}

// Removes pins. which: a number as the pane shows it (1 = newest), 'all', or nothing for the one the pane shows.
// Returns the removed pins.
function dropPin(run, which) {
  const pins = run.pins || [];
  if (!pins.length) return [];
  if (which === 'all') {
    run.pins = [];
    return pins;
  }
  let id;
  if (which !== undefined && which !== null && which !== '') id = pins[pins.length - Number(which)]?.id;
  else id = paneShows(run) || pins.at(-1).id;
  const gone = pins.filter((p) => p.id === id);
  run.pins = pins.filter((p) => p.id !== id);
  return gone;
}

// The pin the steps pane shows now (the pane writes it to pane.json in the run's folder), while that pane runs.
function paneShows(run) {
  try {
    const { pin: id, pid } = JSON.parse(fsSync.readFileSync(path.join(runDir(run.id), 'pane.json'), 'utf8'));
    if (!pid || !alive(pid)) return null;
    return (run.pins || []).some((p) => p.id === id) ? id : null;
  } catch {
    return null;
  }
}

// Claude's last answers, so `pin` and `pin 2` can keep one. The WHAT I DID AND WHY notes are left out.
function keepReply(run, text) {
  const t = readWhy(text).text.trim() || String(text || '').trim();
  if (!t) return;
  run.replies = [t.slice(-20000), ...(run.replies || [])].slice(0, MAX_REPLIES);
}

// Every conversation this run has had (fresh steps start new ones), so clean-up forgets them all.
function allSessions(run) {
  return [...new Set([...(run.sessionIds || []), run.sessionId].filter(Boolean))];
}

// The next box, as Claude is told it by the Stop hook (or after `next`).
function instruction(run, box) {
  if (box.skill === WRAP_UP_SKILL) return wrapUpPrompt(run, box);
  return `Next step of this Orchestra run, box "${box.label}": run the skill /${box.skill}${box.args ? ` with: ${box.args}` : ''} (use the Skill tool).${againText(run, box)} When the step is fully finished, end with the WHAT I DID AND WHY section and the line ${DONE_MARK}.`;
}

// Claude settings for the session: the guard, Orchestra's hooks, and its status line.
function sessionSettings() {
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  // Each call takes the Orchestra lock for a moment; 10 minutes covers a long wait for it.
  const hook = (event, extra = {}) => ({ type: 'command', command: `${q(process.execPath)} ${q(path.join(config.root, 'bin', 'hook.mjs'))} ${event}`, timeout: 600, ...extra });
  const on = (event, extra) => [{ hooks: [hook(event, extra)] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(path.join(config.root, 'lib', 'guard-hook.mjs'))}` }] }],
      SessionStart: on('SessionStart'),
      UserPromptSubmit: on('UserPromptSubmit'),
      PostToolUse: [{ matcher: '*', hooks: [hook('PostToolUse')] }],
      Notification: on('Notification'),
      // The Stop hook may wait for the app lock.
      Stop: on('Stop', { timeout: 1800 }),
      SessionEnd: on('SessionEnd', { timeout: 30 }),
    },
    statusLine: { type: 'command', command: hook('status').command },
    // A lighter session: every request carries what loads, so runs load only what they use (your own sessions keep
    // everything). The ITP servers runs use, from the ITP .mcp.json the run folder carries, are pre-approved (each run
    // folder is new; without this Claude asks every run). opensearch is the read-only log search of the bug template.
    enabledMcpjsonServers: RUN_MCP,
    // The rest never connect in runs (they failed there anyway, and FM-MCP fetches a package with npx at each start).
    disabledMcpjsonServers: RUN_MCP_OFF,
    disabledMcpServers: RUN_MCP_OFF,
    enabledPlugins: { 'cowork-plugin-management@synced': false },
    enableArtifact: false,
  });
}

// The rules for the session, plus where this run's repos are.
function runRules(run) {
  const rules = [RUN_RULES];
  const repos = run.workspace?.ready ? run.workspace.repos : [];
  if (repos.length) {
    const list = repos.map((r) => (r.branch ? `${r.folder} (on branch ${r.branch})` : `${r.folder} (the latest ${r.base.replace(/^origin\//, '')}, no branch yet)`)).join(', ');
    rules.push(`This run has its own git worktrees, inside the current directory: ${list}. Work only there, never in the user's own checkouts (${repos.map((r) => r.source).join(', ')}).`);
    if (repos.some((r) => !r.branch)) {
      rules.push(`A worktree with no branch started from the development branch named above: treat that as the repo's checked-out development branch (for example its release name). Before you commit there, create or switch to the branch your skill's rules call for (for ITP epics, the epic branch). Do not commit with no branch.`);
    }
  }
  if (run.tracking === false) rules.push(OFF_RULE);
  if (!run.about) rules.push(ABOUT_RULE);
  const mine = readInstructionsSync();
  if (mine) rules.push(`The user's own rules, learned from past runs. Follow them:\n${mine}`);
  return rules.join('\n');
}

// The clean-up work, done with the lock let go: stop what runs from the folder, measure it, remove it, tidy git,
// forget the conversations. Returns { bytes, notes }.
async function sweep(ws, sessions, { merged }) {
  const notes = [];
  const serving = readServing();
  if (serving?.workspace && norm(serving.workspace) === norm(ws.dir)) {
    const r = await stopApp({ force: false });
    notes.push(r.refused ? 'the app on its ports was not started from this run: left alone' : 'stopped the app it served');
  }
  const procs = processesIn(ws.dir);
  for (const p of procs) killTree(p.pid);
  if (procs.length) notes.push(`stopped ${procs.length} process${procs.length > 1 ? 'es' : ''} running from its folder`);
  const bytes = await workspace.size(ws.dir);
  try {
    await workspace.remove(ws);
  } catch {
    // Shared .NET build servers keep DLLs open. They start again by themselves on the next build.
    spawnSync('dotnet', ['build-server', 'shutdown'], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
    for (const p of processesIn(ws.dir)) killTree(p.pid);
    await workspace.remove(ws);
    notes.push('stopped the .NET build servers that held its files');
  }
  notes.push(...(await workspace.tidyRepos(ws, { deleteMerged: merged })));
  const forgot = forgetConversation(sessions);
  if (forgot) notes.push(`removed its Claude conversation files (${gb(forgot)})`);
  return { bytes: bytes + forgot, notes };
}

// Deletes sessions' Claude conversation files (<projects>/<folder>/<sessionId>.jsonl and its folder).
// A cleaned run cannot be reopened, so they only take space. Returns the bytes freed.
function forgetConversation(sessions) {
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

// What the Wrap up step is told: what Orchestra knows about the run. The skill looks at the rest and asks you.
// A PR is not assumed: some runs have none and still have vault notes or Execution files to push.
function wrapUpPrompt(run, box) {
  const ship = run.ship || {};
  const repos = (run.workspace?.repos || []).map((r) => `${r.folder}${r.branch ? ` (branch ${r.branch})` : ''}`);
  const itp = config.itpRoot.replace(/\\/g, '/');
  return [
    `Next step of this Orchestra run, box "${box.label}": run the skill /${box.skill}${box.args ? ` with: ${box.args}` : ''} (use the Skill tool). What Orchestra knows about this run:`,
    `- Epic folder: ${ship.epicFolder || 'not known (look in this conversation; there may be none)'}`,
    `- Pull requests: ${ship.prUrls?.length ? ship.prUrls.join(', ') : 'none seen'}`,
    `- This run's repos (worktrees in the current folder): ${repos.join(', ') || 'none'}`,
    `- The vault: ${itp}/ITPKV. The ITP folder (the itp-workspace repo, on main): ${itp}`,
    `- Tracking: ${run.tracking === false ? 'OFF (do not offer to close the epic or to change the vault)' : 'on'}`,
    'While this step works, the vault and the ITP folder (its Execution/ files only) may be pushed to main; the user still clicks Allow for each push. End the way the skill says.',
  ].join('\n');
}

// The vault (ITPKV) is its own repo, and the team commits it locally on main by design.
// The git hooks allow work on main there only. Pushing to main stays refused everywhere.
function vaultDirs(run) {
  const dirs = [path.join(config.itpRoot, 'ITPKV')];
  if (run.workspace?.ready) dirs.push(path.join(run.workspace.dir, 'ITPKV'));
  return dirs.map((d) => d.replace(/\\/g, '/'));
}

// What is left after the run ships, read from the boxes' replies: the PR-create links finalize-epic
// prints, and the epic folder its close-epic.sh command names (orch run shows them; the Wrap up step gets them).
export function keepShipInfo(run, text) {
  const ship = (run.ship ??= { prUrls: [], epicFolder: null });
  for (const url of String(text).match(/https?:\/\/[^\s<>()"'`\]]+\/pull-requests\/new\?source=[^\s<>()"'`\]]+/g) || []) {
    const clean = url.replace(/[.,;:*_]+$/, '');
    if (!ship.prUrls.includes(clean)) ship.prUrls.push(clean);
  }
  const folder = String(text).match(/close-epic\.sh\s+([A-Za-z0-9][\w.-]*)/);
  if (folder) ship.epicFolder = folder[1];
}

function safeFollow(run) {
  try {
    return workspace.followBranches(run);
  } catch (err) {
    return [`could not read the branches: ${err.message}`];
  }
}

// Claude's final reply in the turn that just ended: from the hook input, else the transcript.
// The transcript is JSON lines; the reply is the text after the last tool call or user message.
export function lastReply(body) {
  if (typeof body?.last_assistant_message === 'string') return body.last_assistant_message;
  let text = '';
  try {
    const st = fsSync.statSync(body.transcript_path);
    const fd = fsSync.openSync(body.transcript_path, 'r');
    const size = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    fsSync.readSync(fd, buf, 0, size, st.size - size);
    fsSync.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return '';
  }
  const parts = [];
  for (const line of text.split('\n').reverse()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'user') break;
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    if (e.message.content.some((c) => c.type === 'tool_use')) break;
    const t = e.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t) parts.unshift(t);
  }
  return parts.join('\n');
}

// The run that may use the app (one at a time): a box marked "uses app" works, or the run took the app.
function findAppHolder(runs) {
  if (readYourHold()) return YOU; // orch app start: you hold it until orch app stop
  for (const run of runs.values()) {
    if (sessionOpen(run) && run.boxes.some((b) => b.status === 'running' && b.usesApp)) return run.id;
    if (keepsApp(run)) return run.id;
  }
  return null;
}

const WORKING = new Set(['running', 'question', 'approval']);

// A run that took the app keeps it while that step works, and while the run waits for you after it.
// It lets go on next, when the step fails, or when the tab closes.
function keepsApp(run) {
  return stepHolds(run, run.appHeld, true);
}

// A run in the line for the app still wants it while the step that asked works
// (or, when it asked while waiting for you, while it still waits after that step).
function wantsApp(run) {
  return stepHolds(run, run.appWant, false);
}

function stepHolds(run, mark, orWaiting) {
  if (!mark || !sessionOpen(run)) return false;
  const box = run.boxes.find((b) => b.id === mark.box);
  if (!box) return false;
  return WORKING.has(box.status) || ((orWaiting || !!mark.waiting) && waitingAfterBox(run)?.id === mark.box);
}

// The step the run waits for you after: it is done, no later step has started, and you have not typed next.
// While you talk to Claude between steps the status moves between 'waiting', 'running' and 'needs-you',
// but the run still waits after that step.
function waitingAfterBox(run) {
  if (!['waiting', 'running', 'needs-you'].includes(run.status) || !run.waitingAfter) return null;
  const i = run.boxes.findIndex((b) => b.id === run.waitingAfter);
  if (i < 0 || run.boxes[i].status !== 'done' || run.boxes.slice(i + 1).some((b) => b.status !== 'pending')) return null;
  return run.boxes[i];
}

// Drops app marks that no longer hold, so a redone step joins the line again. True when one was dropped.
function forgetApp(run) {
  let dropped = false;
  if (run.appHeld && !keepsApp(run)) dropped = delete run.appHeld;
  if (run.appWant && !wantsApp(run)) dropped = delete run.appWant;
  return dropped;
}

// A tab is gone when its launcher process ended, or when it never started after a few minutes.
// The launcher's alive file decides: older than a minute means gone, once its pid is dead too (a PC that just woke
// up has not written it yet), or after 10 minutes in any case (the pid may belong to another program now).
// Launchers from before the file: the pid alone.
function tabGone(run) {
  let age = null;
  try {
    age = Date.now() - fsSync.statSync(path.join(runDir(run.id), TAB_ALIVE)).mtimeMs;
  } catch {}
  if (age !== null && Date.parse(run.session.openedAt || 0) <= Date.now() - age + 1000) {
    if (age < 60 * 1000) return false;
    return age > 10 * 60 * 1000 || !run.session.pid || !alive(run.session.pid);
  }
  if (run.session.pid) return !alive(run.session.pid);
  return Date.now() - Date.parse(run.session.openedAt || 0) > 3 * 60 * 1000;
}

// A workspace whose build was cut off: its folder exists, it was never ready, and it was not cleaned.
function partialWorkspace(run) {
  return !!run.workspace?.dir && !run.workspace.ready && !run.cleanedAt && fsSync.existsSync(run.workspace.dir);
}

// A run that says it is running, has no tab, and whose start is not going on any more (its starter ended, or it
// took far too long). Old runs with no start mark and no tab are stuck too.
function startStuck(run) {
  if (run.status !== 'running' || sessionOpen(run)) return false;
  return !busy(startMark(run), 20 * 60 * 1000);
}
const startMark = (run) => run.starting && { pid: run.starting.pid, at: run.starting.at };

// Work marked by a process that is still alive (a clean-up going on).
function busy(mark, ms = 60 * 60 * 1000) {
  return !!mark && alive(mark.pid) && Date.now() - mark.at < ms;
}

// Starts `orch <args>` in its own process, which outlives this one (a hook or a closing tab).
export function spawnJob(args) {
  const env = childEnv();
  for (const k of ['ORCHESTRA_RUN_ID', 'ORCHESTRA_HOOK_TOKEN', 'ORCHESTRA_ALLOW_PUSH']) delete env[k];
  const child = spawn(process.execPath, [path.join(config.root, 'bin', 'orch.mjs'), ...args], { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on('error', () => {});
  child.unref();
}

function queueTime(run) {
  return run.queuedAt || run.createdAt;
}

function describeTool(c) {
  const i = c.input || {};
  const detail = i.command || i.file_path || i.pattern || i.skill || i.url || i.description || '';
  return `${c.name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

