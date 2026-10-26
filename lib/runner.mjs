// Runs workflows. One Claude session per run; each box is one `claude -p` call that resumes that session.
// Chat messages use the same session. A message sent while a box works waits until that box ends.
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.mjs';
import { RUN_RULES, QUESTION_MARK, APPROVAL_MARK, readMark } from './guard.mjs';
import * as workspace from './workspace.mjs';
import { notify } from './notify.mjs';
import { scanSkills } from './skills-scan.mjs';
import { OFF_RULE, OFF_HELP, offProblems } from './tracking.mjs';

// Run states that need you. Entering one sends a Windows notification (stopped and draft are your own doing).
const NOTIFY = { question: 'asks you a question', approval: 'wants your Approve to push', waiting: 'is waiting for you', failed: 'failed' };
import { getTemplate, newId, runDir, saveRun, saveRunSync, loadRuns, appendLine, validateTemplate, getSettings, saveSettings } from './store.mjs';

const ACTIVE = new Set(['running']);
// Boxes that have started stay locked in place when you edit a run.
const STARTED = new Set(['done', 'running', 'question', 'approval']);
// Runs that Resume / Continue / Start may put back in the queue.
const RESUMABLE = new Set(['stopped', 'failed', 'waiting', 'draft']);
// The prompt goes on the command line, and Windows caps that at 32767 chars.
const MAX_INPUT_CHARS = 8000;
const MAX_CHAT_CHARS = 8000;
// Set by the Claude Code session that started Orchestra. A child claude must not think it is part of that session.
const SESSION_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
]);

export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (SESSION_ENV.has(key)) continue;
    // The shell's ANTHROPIC_API_KEY has no credit, so runs use the claude.ai login instead.
    if (key === 'ANTHROPIC_API_KEY' && !config.keepApiKey) continue;
    // Only Orchestra decides these, per turn. Never inherit them.
    if (key.startsWith('ORCHESTRA_ALLOW') || key === 'ORCHESTRA_RUN_DIR' || key === 'ORCHESTRA_TRACKING') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// The guard for one turn. Git in the turn (and in any script it starts) uses Orchestra's hooks,
// set through env vars only, so nothing is written to the repo. Push works only when allowPush.
// Tracking OFF: the hook blocks Teamspace and vault writes, and ITP's own scripts skip Teamspace
// (ITP_REGISTRY_OFF=1 is their built-in "no server read or write" switch).
export function guardEnv(runId, allowPush, tracking = true) {
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    ORCHESTRA_RUN_DIR: runDir(runId),
    ORCHESTRA_ALLOW_PUSH: allowPush ? '1' : '0',
    ORCHESTRA_TRACKING: tracking ? 'on' : 'off',
    ...(tracking ? {} : { ITP_REGISTRY_OFF: '1' }),
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: path.join(config.root, 'lib', 'git-hooks').replace(/\\/g, '/'),
  };
}

// Claude settings for one turn: the PreToolUse hook that blocks push, PR and main.
function guardSettings() {
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  const command = `${q(process.execPath)} ${q(path.join(config.root, 'lib', 'guard-hook.mjs'))}`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*[Tt]eamspace.*', hooks: [{ type: 'command', command }] }] } });
}

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
    status: 'pending',
    attempts: 0,
    cost: 0,
    tokens: { input: 0, output: 0 },
    summary: '',
    error: null,
  };
}

export class Runner extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map(); // id -> run state (same object that is saved to state.json)
    this.children = new Map(); // id -> child process of the turn (box or chat) that is working now
    this.drives = new Map(); // id -> promise of the active drive loop, so a run is never driven twice
    this.stopRequested = new Set(); // ids whose working box was stopped by you
    this.shuttingDown = false;
    this.settings = { maxRunning: 2 };
    this.appHolder = null; // the run that may use the app right now
    this.lastStatus = new Map(); // id -> status last sent, to notice when a run starts to need you
  }

  // Loads saved runs. Unfinished ones go back in the queue and continue from their last finished box.
  async init() {
    this.settings = await getSettings();
    for (const run of await loadRuns()) {
      run.chat ??= [];
      this.runs.set(run.id, run);
      this.lastStatus.set(run.id, run.status);
      let changed = false;
      for (const msg of run.chat) {
        if (msg.status !== 'working') continue;
        if (msg.pid) killOrphan(msg.pid, msg.pidStartedAt);
        msg.status = 'queued';
        msg.pid = null;
        changed = true;
      }
      if (ACTIVE.has(run.status)) {
        for (const box of run.boxes) {
          if (box.status !== 'running') continue;
          if (box.pid) killOrphan(box.pid, box.pidStartedAt);
          box.status = 'pending';
          box.pid = null;
          box.note = 'Interrupted when Orchestra stopped. Runs again.';
        }
        run.resumedAt = new Date().toISOString();
        run.status = 'queued'; // keeps its old queuedAt, so it is first in line again
        changed = true;
        this.log(run, 'back in the queue after restart');
      }
      if (changed) await saveRun(run);
      if (run.status !== 'queued' && run.chat.some((m) => m.status === 'queued')) {
        this.drive(run.id); // answers the chat, then stops
      }
    }
    this.schedule();
  }

  getSettings() {
    return this.settings;
  }

  async setSettings(patch) {
    this.settings = await saveSettings({ ...this.settings, ...patch });
    this.schedule(); // a higher limit may start queued runs now
    return this.settings;
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  // Branches that runs with a workspace use, as "token:branch" -> run id. Two runs never share one.
  busyBranches() {
    const busy = new Map();
    for (const r of this.runs.values()) {
      for (const p of r.workspace?.repos || r.repoPlan || []) busy.set(`${p.token}:${p.branch}`, r.id);
    }
    return busy;
  }

  // start=false makes a draft: you can edit its boxes, then press Start.
  // repos: [{ token, mode: 'new'|'existing', branch, base }]. Left out: the template's repos, each on
  // a new branch named from the input.
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
    const plan = repos ?? (template.repos || []).map((token) => ({ token, mode: 'new', branch: workspace.branchNameFor(text, id) }));
    const repoPlan = workspace.checkPlan(plan, this.busyBranches());
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
      queuedAt: start ? new Date().toISOString() : null,
      sessionId: null,
      cwd,
      repoPlan,
      workspace: null,
      // A copy: editing this run's boxes never changes the template.
      boxes: template.boxes.map(newBox),
      chat: [],
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

  // With tracking OFF, refuses boxes whose skill writes to Teamspace or the vault.
  async checkTracking(run, boxes) {
    if (run.tracking !== false || !boxes.length) return;
    const problems = offProblems(boxes, await scanSkills());
    if (problems.length) throw httpError(409, `${problems.join('; ')}. ${OFF_HELP}`);
  }

  // Stops the working box. Its work so far stays; the box runs again on resume.
  // A queued run just leaves the queue.
  async stop(id) {
    const run = this.mustGet(id);
    if (run.status === 'queued') {
      run.status = 'stopped';
      await saveRun(run);
      this.emitRun(run);
      this.log(run, 'taken out of the queue by you');
      return run;
    }
    if (!ACTIVE.has(run.status)) return run;
    run.status = 'stopped';
    if (this.children.has(id)) this.stopRequested.add(id);
    await saveRun(run);
    this.killChild(id);
    this.emitRun(run);
    this.log(run, 'stopped by you');
    return run;
  }

  // Puts a stopped, failed, waiting or draft run in the queue. It continues from its first unfinished box.
  async resume(id) {
    const run = this.mustGet(id);
    // A stopped box may still be closing. Let its loop end first, or it would see the run as running again.
    if (this.drives.has(id)) await this.drives.get(id);
    if (!RESUMABLE.has(run.status)) return run;
    await this.checkTracking(run, run.boxes.filter((b) => b.status !== 'done'));
    const was = run.status;
    this.stopRequested.delete(id);
    for (const box of run.boxes) {
      if (box.status === 'failed' || box.status === 'running') {
        box.status = 'pending';
        box.error = null;
      }
    }
    run.status = 'queued';
    run.queuedAt = new Date().toISOString();
    run.error = null;
    run.waitingAfter = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, { draft: 'started by you', waiting: 'continued by you' }[was] || 'resumed by you');
    this.schedule();
    return run;
  }

  // Replaces the run's box list. Finished and working boxes stay first and keep their place;
  // only their label and "wait after" may change. The template never changes.
  async updateBoxes(id, list) {
    const run = this.mustGet(id);
    if (run.status === 'done') throw httpError(400, 'this run is finished; its boxes can no longer change');
    if (!Array.isArray(list)) throw httpError(400, 'boxes must be a list');
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
      if (i >= locked.length) b.args = String(n.args || '').slice(0, 2000);
      return b;
    });
    await saveRun(run);
    this.emitRun(run);
    this.log(run, 'boxes changed by you');
    return run;
  }

  // Sends a chat message to the run's AI. It waits if a box is working.
  async chat(id, text) {
    const run = this.mustGet(id);
    text = String(text ?? '').trim();
    if (!text) throw httpError(400, 'message is empty');
    if (text.length > MAX_CHAT_CHARS) throw httpError(400, `message is too long (max ${MAX_CHAT_CHARS} chars)`);
    // While a box asks you something, your message is the answer.
    if (run.status === 'question') return this.answer(run, text);
    const msg = { id: newId('msg'), text, at: new Date().toISOString(), status: 'queued', reply: '', error: null, cost: 0, tokens: { input: 0, output: 0 } };
    run.chat.push(msg);
    await saveRun(run);
    this.emitRun(run);
    this.drive(id); // a no-op if the run is already being driven; its loop reads the chat between boxes
    return run;
  }

  // Removes a run that is not working: its workspace (links first, then worktrees) and its folder.
  // Branches stay. Work that is not committed is lost, so that needs force.
  async deleteRun(id, { force = false } = {}) {
    const run = this.mustGet(id);
    if (ACTIVE.has(run.status) || this.drives.has(id)) throw httpError(409, 'stop the run before deleting it');
    const dirty = workspace.uncommitted(run.workspace);
    if (dirty.length && !force) {
      throw Object.assign(httpError(409, `uncommitted work in ${dirty.join(', ')}. Delete anyway to lose it.`), { uncommitted: dirty });
    }
    // The workspace goes first: if that fails, the run stays, so nothing is left half-deleted.
    if (run.workspace) await workspace.remove(run.workspace);
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

  // Kills every working turn but keeps runs marked running, so the next start resumes them.
  // Saves synchronously: the process exits right after, so async saves would never land.
  shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const id of this.children.keys()) this.killChild(id);
    for (const run of this.runs.values()) {
      const working = [...run.boxes, ...(run.chat || [])].filter((b) => b.pid);
      if (!working.length) continue;
      for (const item of working) item.pid = null; // the process is gone; a stale pid could match a new process later
      try {
        saveRunSync(run);
      } catch {}
    }
  }

  // ---- internals ----

  mustGet(id) {
    const run = this.runs.get(id);
    if (!run) throw httpError(404, `run not found: ${id}`);
    return run;
  }

  drive(id) {
    if (this.drives.has(id)) return this.drives.get(id);
    const p = this.driveLoop(id).finally(() => {
      this.drives.delete(id);
      if (this.shuttingDown) return;
      // The run may have got a slot, or a message, just as the loop was ending. Drive it again.
      const run = this.runs.get(id);
      const chatWaits = run?.status !== 'stopped' && run?.chat?.some((m) => m.status === 'queued');
      if (run && (ACTIVE.has(run.status) || chatWaits)) this.drive(id);
      this.schedule(); // this run may have freed a slot
    });
    this.drives.set(id, p);
    return p;
  }

  // Starts queued runs, oldest first, while fewer than the limit are working.
  // Only working runs use a slot: waiting, failed and stopped runs do not.
  schedule() {
    if (this.shuttingDown) return;
    const all = [...this.runs.values()];
    let working = all.filter((r) => ACTIVE.has(r.status)).length;
    const queue = all.filter((r) => r.status === 'queued').sort((a, b) => queueTime(a).localeCompare(queueTime(b)));
    for (const run of queue) {
      if (working >= this.settings.maxRunning) break;
      working++;
      run.status = 'running';
      // A failed save here is not fatal: the drive loop saves the same state soon.
      saveRun(run).catch((err) => this.log(run, `could not save state: ${err.message}`));
      this.emitRun(run);
      this.log(run, 'got a free slot; working');
      this.drive(run.id);
    }
  }

  async driveLoop(id) {
    try {
      for (;;) {
        const run = this.runs.get(id);
        if (!run || this.shuttingDown) return;
        // Your messages go first, between boxes.
        if (!(await this.answerChat(run))) return;
        if (!ACTIVE.has(run.status)) return;
        if (run.repoPlan?.length && !run.workspace?.ready && !(await this.prepareWorkspace(run))) return;
        const box = run.boxes.find((b) => b.status !== 'done');
        if (!box) {
          run.status = 'done';
          run.finishedAt = new Date().toISOString();
          await saveRun(run);
          this.emitRun(run);
          this.log(run, 'finished');
          continue; // answers a message sent during the last box
        }
        const ok = await this.runBox(run, box);
        if (!ok) continue;
        if (box.waitAfter && run.boxes.some((b) => b.status !== 'done') && ACTIVE.has(run.status)) {
          run.status = 'waiting';
          run.waitingAfter = box.id;
          await saveRun(run);
          this.emitRun(run);
          this.log(run, `waiting for you after box ${box.id}`);
        }
      }
    } catch (err) {
      const run = this.runs.get(id);
      if (!run || this.shuttingDown) return;
      // Never leave a claude working that Orchestra no longer tracks.
      this.killChild(id);
      this.children.delete(id);
      for (const box of run.boxes) {
        if (box.status !== 'running') continue;
        box.status = 'failed';
        box.pid = null;
        box.error = err.message;
      }
      for (const msg of run.chat || []) {
        if (msg.status !== 'working') continue;
        msg.status = 'failed';
        msg.pid = null;
        msg.error = err.message;
      }
      run.status = 'failed';
      run.error = `runner error: ${err.message}`;
      await saveRun(run).catch(() => {});
      this.emitRun(run);
      this.log(run, `runner error: ${err.message}`);
    }
  }

  // Answers queued chat messages, oldest first. Returns false when a stop or shutdown cut it short.
  async answerChat(run) {
    for (;;) {
      const msg = run.chat.find((m) => m.status === 'queued');
      if (!msg) return true;
      msg.status = 'working';
      msg.error = null;
      const base = path.join(runDir(run.id), 'chat', msg.id);
      this.takeApprovalRequests(run);
      const t = await this.spawnTurn(run, { prompt: msg.text, base, holder: msg, boxId: null, label: `chat message ${msg.id}` });
      if (this.shuttingDown) return false;
      const blocked = this.takeApprovalRequests(run);
      if (t.result.sawResult) this.addUsage(run, msg, t.result);
      if (t.stopped) {
        msg.status = 'queued'; // answered on resume
        await saveRun(run);
        this.emitRun(run);
        return false;
      }
      const error = t.exitError || (!t.result.sawResult ? noResultError(t) : t.result.ok ? null : t.result.error);
      msg.status = error ? 'failed' : 'answered';
      msg.error = error || (blocked.length ? 'A push was blocked. Pushes happen only inside a box, after your Approve.' : null);
      msg.reply = readMark(t.result.text || t.result.lastText || '').text;
      msg.answeredAt = new Date().toISOString();
      await saveRun(run);
      this.emitRun(run);
      this.log(run, error ? `chat answer failed: ${error}` : `chat answered ($${msg.cost})`);
    }
  }

  buildPrompt(run, box) {
    const parts = [`/${box.skill}`];
    if (box.args) parts.push(box.args);
    // The run input goes to the first box. Later boxes see it through the resumed session.
    if (run.boxes[0] === box || !run.sessionId) {
      if (run.input.text) parts.push(run.input.text);
    }
    return parts.join(' ');
  }

  buildArgs(run, prompt) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    args.push('--permission-mode', config.permissionMode);
    args.push('--append-system-prompt', runRules(run), '--settings', guardSettings());
    if (run.sessionId) args.push('--resume', run.sessionId);
    return args;
  }

  // Makes the run's workspace: worktrees of its repos on its branch. Returns false when it failed.
  async prepareWorkspace(run) {
    this.log(run, 'making the workspace (worktrees of the run repos)');
    try {
      run.workspace = await workspace.prepare(run, (m) => this.log(run, m));
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `workspace ready at ${run.workspace.dir}`);
      return true;
    } catch (err) {
      run.status = 'failed';
      run.error = `workspace: ${err.message}`;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, run.error);
      return false;
    }
  }

  // One run at a time may start the app to test it. Others wait here. Returns false when the run
  // stopped while it waited.
  async takeApp(run, box) {
    let told = false;
    while (this.appHolder && this.appHolder !== run.id) {
      if (!told) {
        box.note = `Waiting for the app: run ${this.appHolder} is using it.`;
        await saveRun(run);
        this.emitRun(run);
        this.log(run, `box ${box.id} waits for the app (run ${this.appHolder} has it)`);
        told = true;
      }
      await new Promise((r) => setTimeout(r, 500));
      if (!ACTIVE.has(run.status) || this.shuttingDown) return false;
    }
    this.appHolder = run.id;
    box.note = null;
    return true;
  }

  // Runs one turn of a box: the skill itself, or a follow-up after your answer or Approve.
  // Returns true when the box finished well and the run should go on.
  async runBox(run, box) {
    // Marks can change while a run waits, so check again right before the box starts.
    if (run.tracking === false && !box.resumePrompt) {
      const [problem] = offProblems([box], await scanSkills());
      if (problem) {
        box.startedAt = new Date().toISOString();
        return this.finishBox(run, box, { ok: false, error: `${problem}. ${OFF_HELP}` });
      }
    }
    if (box.usesApp && !(await this.takeApp(run, box))) return false;
    try {
      return await this.runBoxTurn(run, box);
    } finally {
      if (this.appHolder === run.id) this.appHolder = null;
    }
  }

  async runBoxTurn(run, box) {
    const followUp = box.resumePrompt;
    if (!followUp) box.attempts = (box.attempts || 0) + 1;
    box.turns = (box.turns || 0) + 1;
    box.status = 'running';
    if (!followUp || !box.startedAt) box.startedAt = new Date().toISOString();
    box.endedAt = null;
    box.error = null;
    box.note = null;
    run.currentBox = box.id;

    const base = path.join(runDir(run.id), 'boxes', `${box.id}.turn${box.turns}`);
    const prompt = followUp || this.buildPrompt(run, box);
    this.takeApprovalRequests(run); // drop any left from before this turn
    const t = await this.spawnTurn(run, { prompt, base, holder: box, boxId: box.id, label: `box ${box.id} (/${box.skill})${followUp ? ' follow-up' : ''}`, allowPush: !!box.allowPush });

    if (this.shuttingDown) return false; // leave state as running; next start resumes it
    const requests = this.takeApprovalRequests(run);
    const { mark, text } = readMark(t.result.text || t.result.lastText || '');
    if (t.result.sawResult) {
      this.addUsage(run, box, t.result);
      box.summary = text.slice(0, 4000);
    }
    if (!t.stopped && t.result.sawResult) {
      // The turn ended; a follow-up prompt and its push permission are used up.
      box.resumePrompt = null;
      box.allowPush = false;
    }

    // A blocked push, or a question: the box waits for you.
    if (!t.stopped && t.result.sawResult && (requests.length || mark === APPROVAL_MARK)) {
      box.approval = { requests, at: new Date().toISOString() };
      return this.pauseBox(run, box, 'approval', 'wants your Approve to push');
    }
    if (!t.stopped && t.result.sawResult && t.result.ok && mark === QUESTION_MARK) {
      box.question = text.slice(0, 4000);
      return this.pauseBox(run, box, 'question', 'asks you a question');
    }

    if (t.stopped) {
      box.endedAt = new Date().toISOString();
      if (t.result.sawResult && t.result.ok) {
        // It finished just before the stop landed. Keep the work; resume starts at the next box.
        box.status = 'done';
        box.durationMs = Date.parse(box.endedAt) - Date.parse(box.startedAt);
        this.log(run, `box ${box.id} done just before the stop ($${box.cost})`);
      } else {
        box.status = 'pending';
        box.note = 'Stopped by you. Runs again on resume.';
      }
      await saveRun(run);
      this.emitRun(run);
      return false;
    }
    if (t.exitError) return this.finishBox(run, box, { ok: false, error: t.exitError });
    if (!t.result.sawResult) return this.finishBox(run, box, { ok: false, error: noResultError(t) });
    if (!t.result.ok) return this.finishBox(run, box, { ok: false, error: t.result.error });
    return this.finishBox(run, box, { ok: true });
  }

  // Puts the box (and the run) in a state that waits for you: 'question' or 'approval'.
  async pauseBox(run, box, status, what) {
    box.status = status;
    box.endedAt = new Date().toISOString();
    run.status = status;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `box ${box.id} ${what}`);
    return false;
  }

  // Reads and clears the pushes the guard blocked during the last turn.
  takeApprovalRequests(run) {
    const file = path.join(runDir(run.id), 'approval-requests.jsonl');
    let text = '';
    try {
      text = fsSync.readFileSync(file, 'utf8');
      fsSync.rmSync(file, { force: true });
    } catch {}
    return text.trim().split('\n').filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }

  // Your answer to a box's question. The box continues in the same session with it.
  async answer(run, text) {
    const box = run.boxes.find((b) => b.status === 'question');
    if (!box) throw httpError(409, 'no box is waiting for an answer');
    run.chat.push({ id: newId('msg'), kind: 'answer', boxId: box.id, text, at: new Date().toISOString(), status: 'sent' });
    box.status = 'pending';
    box.resumePrompt = text;
    box.question = null;
    this.log(run, `you answered box ${box.id}`);
    return this.enqueue(run);
  }

  // Your Approve (ok) or Reject for a blocked push. The box continues with the decision.
  async approve(id, { ok, note } = {}) {
    const run = this.mustGet(id);
    const box = run.boxes.find((b) => b.status === 'approval');
    if (run.status !== 'approval' || !box) throw httpError(409, 'nothing is waiting for your Approve');
    note = String(note ?? '').trim().slice(0, 2000);
    const cmds = (box.approval?.requests || []).map((r) => r.command).filter(Boolean);
    const list = cmds.length ? ` (${[...new Set(cmds)].join('; ')})` : '';
    box.allowPush = !!ok;
    box.resumePrompt = ok
      ? `The user approved the push${list}. Do it now, then finish this step.${note ? ` The user adds: ${note}` : ''}`
      : `The user did not approve the push. Do not push.${note ? ` The user says: ${note}` : ''} Finish this step without pushing, or say what you need.`;
    (box.approvals ||= []).push({ ok: !!ok, note, requests: box.approval?.requests || [], at: new Date().toISOString() });
    box.approval = null;
    box.status = 'pending';
    run.chat.push({ id: newId('msg'), kind: 'approval', boxId: box.id, text: ok ? `Approved${note ? `: ${note}` : ''}` : `Not approved${note ? `: ${note}` : ''}`, at: new Date().toISOString(), status: 'sent' });
    this.log(run, ok ? `you approved the push in box ${box.id}` : `you did not approve the push in box ${box.id}`);
    return this.enqueue(run);
  }

  async enqueue(run) {
    run.status = 'queued';
    run.queuedAt = new Date().toISOString();
    await saveRun(run);
    this.emitRun(run);
    this.schedule();
    return run;
  }

  // Spawns one `claude -p` turn on the run's session and waits for it to end.
  // `holder` (a box or a chat message) gets the pid while the turn works.
  async spawnTurn(run, { prompt, base, holder, boxId, label, allowPush = false }) {
    const args = this.buildArgs(run, prompt);
    const isScript = /\.m?js$/i.test(config.claudeBin);
    const cmd = isScript ? process.execPath : config.claudeBin;
    const cmdArgs = isScript ? [config.claudeBin, ...args] : args;
    const result = { ok: false, error: null, sawResult: false, lastText: '', text: '', cost: 0, tokens: { input: 0, output: 0 } };
    appendLine(`${base}.cmd.txt`, JSON.stringify([cmd, ...cmdArgs]));

    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd: run.workspace?.ready ? run.workspace.dir : run.cwd, env: childEnv({ ...guardEnv(run.id, allowPush, run.tracking !== false), ...workspace.workspaceEnv(run.workspace) }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return { result, exitError: `could not start claude: ${err.message}` };
    }
    this.children.set(run.id, child);
    holder.pid = child.pid ?? null;
    holder.pidStartedAt = new Date().toISOString();

    // Attach every listener before the first await, so no output is missed.
    let stderrTail = '';
    const saves = [];
    const rl = readline.createInterface({ input: child.stdout });
    const rlClosed = new Promise((r) => rl.once('close', r));
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        appendLine(`${base}.jsonl`, line);
      } catch {}
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      this.onStreamEvent(run, boxId, ev, result, saves);
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
      try {
        appendLine(`${base}.stderr.txt`, d.toString());
      } catch {}
    });
    const exited = new Promise((resolve) => {
      child.once('close', (code) => resolve({ code }));
      child.once('error', (err) => resolve({ code: null, err }));
    });

    // A failed save here is not fatal: later saves write the same state.
    await saveRun(run).catch((err) => this.log(run, `could not save state: ${err.message}`));
    this.emitRun(run);
    this.log(run, `${label} started`);

    const exit = await exited;
    if (!exit.err) await rlClosed;
    await Promise.allSettled(saves);
    this.children.delete(run.id);
    holder.pid = null;
    return {
      result,
      code: exit.code,
      stderrTail,
      exitError: exit.err ? `could not start claude: ${exit.err.message}` : null,
      stopped: this.stopRequested.delete(run.id),
    };
  }

  onStreamEvent(run, boxId, ev, result, saves) {
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      if (run.sessionId !== ev.session_id) {
        run.sessionId = ev.session_id;
        // Save now, so a crash mid-box can still resume this session.
        saves.push(saveRun(run).catch((err) => this.log(run, `could not save session id: ${err.message}`)));
      }
      return;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text) {
          result.lastText = c.text;
          this.activity(run, boxId, 'text', c.text.slice(0, 2000));
        } else if (c.type === 'tool_use') {
          this.activity(run, boxId, 'tool', describeTool(c));
        }
      }
      return;
    }
    if (ev.type === 'result') {
      result.sawResult = true;
      const u = ev.usage || {};
      result.cost += Number(ev.total_cost_usd) || 0;
      result.tokens.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      result.tokens.output += u.output_tokens || 0;
      if (ev.session_id) run.sessionId = ev.session_id;
      const text = typeof ev.result === 'string' ? ev.result : '';
      result.text = text;
      const failed = ev.is_error === true || ev.subtype !== 'success' || (ev.terminal_reason && ev.terminal_reason !== 'completed');
      result.ok = !failed;
      if (failed) {
        const reasons = [
          ev.subtype !== 'success' && ev.subtype,
          ev.terminal_reason !== 'completed' && ev.terminal_reason,
          ...(Array.isArray(ev.errors) ? ev.errors.map(String) : []),
        ].filter(Boolean);
        const parts = [text, reasons.join(': ')].filter(Boolean);
        if (!parts.length && result.lastText) parts.push(`last message: ${result.lastText}`);
        result.error = (parts.join(' — ') || 'claude reported an error').slice(0, 1000);
      }
    }
  }

  // Adds a turn's cost and tokens to a box or chat message, then re-totals the run.
  addUsage(run, item, r) {
    item.cost = round((item.cost || 0) + r.cost);
    item.tokens = {
      input: (item.tokens?.input || 0) + r.tokens.input,
      output: (item.tokens?.output || 0) + r.tokens.output,
    };
    const sum = (list) => list.reduce((s, x) => s + (x.cost || 0), 0);
    run.chatCost = round(sum(run.chat || []));
    run.cost = round(sum(run.boxes) + run.chatCost);
  }

  async finishBox(run, box, { ok, error }) {
    box.endedAt = new Date().toISOString();
    box.durationMs = Date.parse(box.endedAt) - Date.parse(box.startedAt);
    if (ok) {
      box.status = 'done';
      this.log(run, `box ${box.id} done ($${box.cost})`);
    } else {
      box.status = 'failed';
      box.error = error;
      run.status = 'failed';
      run.error = `box ${box.id}: ${error}`;
      this.log(run, `box ${box.id} failed: ${error}`);
    }
    await saveRun(run);
    this.emitRun(run);
    return ok;
  }

  killChild(id) {
    const child = this.children.get(id);
    if (!child || child.exitCode !== null) return;
    killTree(child.pid);
  }

  emitRun(run) {
    // A Windows notification when the run starts to need you.
    const was = this.lastStatus.get(run.id);
    this.lastStatus.set(run.id, run.status);
    if (was && was !== run.status && NOTIFY[run.status]) {
      const sent = notify({ title: `Orchestra: ${run.templateName}`, body: `${run.input?.text?.slice(0, 80) || run.id} ${NOTIFY[run.status]}.`, url: `http://localhost:${config.port}/#/run/${run.id}` });
      this.log(run, `notification${sent ? '' : ' (off)'}: ${NOTIFY[run.status]}`);
    }
    this.emit('run', run);
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

// The rules for a turn, plus where this run's repos are.
function runRules(run) {
  const rules = [RUN_RULES];
  const repos = run.workspace?.ready ? run.workspace.repos : [];
  if (repos.length) {
    const list = repos.map((r) => `${r.folder} (branch ${r.branch})`).join(', ');
    rules.push(`This run has its own git worktrees, inside the current directory: ${list}. Work only there, never in the user's own checkouts (${repos.map((r) => r.source).join(', ')}).`);
  }
  if (run.tracking === false) rules.push(OFF_RULE);
  return rules.join('\n');
}

function queueTime(run) {
  return run.queuedAt || run.createdAt;
}

function noResultError(t) {
  const why = t.stderrTail?.trim() ? `: ${t.stderrTail.trim().slice(-500)}` : '';
  return `claude exited (code ${t.code}) without a result${why}`;
}

function describeTool(c) {
  const i = c.input || {};
  const detail = i.command || i.file_path || i.pattern || i.skill || i.url || i.description || '';
  return `${c.name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

// A box left running by a crashed server may still be alive. Windows reuses PIDs, so kill only when
// the process is a claude (or node) that started within seconds of when Orchestra spawned the box.
export function killOrphan(pid, spawnedAt) {
  if (!pid || pid === process.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    killTree(pid);
    return true;
  }
  const spawned = Date.parse(spawnedAt || '');
  if (!Number.isFinite(spawned)) return false;
  const ps = `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().ToString('o')`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const [name, started] = (r.stdout || '').trim().split('|');
  if (!/^(claude|node)$/i.test(name || '')) return false;
  if (Math.abs(Date.parse(started) - spawned) > 15000) return false;
  killTree(pid);
  return true;
}
