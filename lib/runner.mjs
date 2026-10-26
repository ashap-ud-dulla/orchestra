// Runs workflows. One Claude session per run; each box is one `claude -p` call that resumes that session.
// Chat messages use the same session. A message sent while a box works waits until that box ends.
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.mjs';
import { getTemplate, newId, runDir, saveRun, saveRunSync, loadRuns, appendLine, validateTemplate } from './store.mjs';

const ACTIVE = new Set(['running']);
// Runs that Resume / Continue / Start may move back to running.
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

export function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (SESSION_ENV.has(key)) continue;
    // The shell's ANTHROPIC_API_KEY has no credit, so runs use the claude.ai login instead.
    if (key === 'ANTHROPIC_API_KEY' && !config.keepApiKey) continue;
    env[k] = v;
  }
  return env;
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
  }

  // Loads saved runs and continues the unfinished ones from their last finished box.
  async init() {
    for (const run of await loadRuns()) {
      run.chat ??= [];
      this.runs.set(run.id, run);
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
        changed = true;
      }
      if (changed) await saveRun(run);
      if (ACTIVE.has(run.status)) {
        this.log(run, 'resumed after restart');
        this.drive(run.id);
      } else if (run.chat.some((m) => m.status === 'queued')) {
        this.drive(run.id); // answers the chat, then stops
      }
    }
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  // start=false makes a draft: you can edit its boxes, then press Start.
  async createRun({ templateId, input, start = true }) {
    const text = String(input?.text ?? input ?? '');
    if (text.length > MAX_INPUT_CHARS) {
      throw httpError(400, `input is too long (${text.length} chars, max ${MAX_INPUT_CHARS})`);
    }
    const template = await getTemplate(templateId);
    if (!template) throw httpError(404, `template not found: ${templateId}`);
    const id = newId('run');
    const cwd = path.join(runDir(id), 'work'); // build step 4 swaps this for per-run git worktrees
    await fs.mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();
    const run = {
      id,
      templateId: template.id,
      templateName: template.name,
      tracking: template.tracking !== false,
      input: { text },
      status: start ? 'running' : 'draft',
      sessionId: null,
      cwd,
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
    if (start) this.drive(id);
    return run;
  }

  // Stops the working box. Its work so far stays; the box runs again on resume.
  async stop(id) {
    const run = this.mustGet(id);
    if (!ACTIVE.has(run.status)) return run;
    run.status = 'stopped';
    if (this.children.has(id)) this.stopRequested.add(id);
    await saveRun(run);
    this.killChild(id);
    this.emitRun(run);
    this.log(run, 'stopped by you');
    return run;
  }

  // Continues a stopped, failed or waiting run from its first unfinished box. Also starts a draft.
  async resume(id) {
    const run = this.mustGet(id);
    // A stopped box may still be closing. Let its loop end first, or it would see the run as running again.
    if (this.drives.has(id)) await this.drives.get(id);
    if (!RESUMABLE.has(run.status)) return run;
    const was = run.status;
    this.stopRequested.delete(id);
    for (const box of run.boxes) {
      if (box.status === 'failed' || box.status === 'running') {
        box.status = 'pending';
        box.error = null;
      }
    }
    run.status = 'running';
    run.error = null;
    run.waitingAfter = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, { draft: 'started by you', waiting: 'continued by you' }[was] || 'resumed by you');
    this.drive(id);
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
    const locked = run.boxes.filter((b) => b.status === 'done' || b.status === 'running');
    for (const [i, b] of locked.entries()) {
      const n = list[i];
      if (n?.id !== b.id || n.skill !== b.skill) {
        throw httpError(409, `box ${b.id} has ${b.status === 'done' ? 'finished' : 'started'}; it must stay at place ${i + 1}`);
      }
    }
    const old = new Map(run.boxes.map((b) => [b.id, b]));
    run.boxes = list.map((n, i) => {
      const b = i < locked.length ? old.get(n.id) : old.get(n.id)?.skill === n.skill ? old.get(n.id) : newBox(n);
      b.label = String(n.label || n.skill).slice(0, 80);
      b.waitAfter = !!n.waitAfter;
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
    const msg = { id: newId('msg'), text, at: new Date().toISOString(), status: 'queued', reply: '', error: null, cost: 0, tokens: { input: 0, output: 0 } };
    run.chat.push(msg);
    await saveRun(run);
    this.emitRun(run);
    this.drive(id); // a no-op if the run is already being driven; its loop reads the chat between boxes
    return run;
  }

  // Removes a run that is not working. Its folder is deleted.
  async deleteRun(id) {
    const run = this.mustGet(id);
    if (ACTIVE.has(run.status) || this.drives.has(id)) throw httpError(409, 'stop the run before deleting it');
    this.runs.delete(id);
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
    const p = this.driveLoop(id).finally(() => this.drives.delete(id));
    this.drives.set(id, p);
    return p;
  }

  async driveLoop(id) {
    try {
      for (;;) {
        const run = this.runs.get(id);
        if (!run || this.shuttingDown) return;
        // Your messages go first, between boxes.
        if (!(await this.answerChat(run))) return;
        if (!ACTIVE.has(run.status)) return;
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
      const t = await this.spawnTurn(run, { prompt: msg.text, base, holder: msg, boxId: null, label: `chat message ${msg.id}` });
      if (this.shuttingDown) return false;
      if (t.result.sawResult) this.addUsage(run, msg, t.result);
      if (t.stopped) {
        msg.status = 'queued'; // answered on resume
        await saveRun(run);
        this.emitRun(run);
        return false;
      }
      const error = t.exitError || (!t.result.sawResult ? noResultError(t) : t.result.ok ? null : t.result.error);
      msg.status = error ? 'failed' : 'answered';
      msg.error = error;
      msg.reply = t.result.text || t.result.lastText || '';
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
    if (run.sessionId) args.push('--resume', run.sessionId);
    return args;
  }

  // Runs one box. Returns true when the box finished well and the run should go on.
  async runBox(run, box) {
    box.status = 'running';
    box.attempts = (box.attempts || 0) + 1;
    box.startedAt = new Date().toISOString();
    box.endedAt = null;
    box.error = null;
    box.note = null;
    run.currentBox = box.id;

    const base = path.join(runDir(run.id), 'boxes', `${box.id}.attempt${box.attempts}`);
    const t = await this.spawnTurn(run, { prompt: this.buildPrompt(run, box), base, holder: box, boxId: box.id, label: `box ${box.id} (/${box.skill})` });

    if (this.shuttingDown) return false; // leave state as running; next start resumes it
    if (t.result.sawResult) {
      this.addUsage(run, box, t.result);
      box.summary = (t.result.text || t.result.lastText || '').slice(0, 4000);
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

  // Spawns one `claude -p` turn on the run's session and waits for it to end.
  // `holder` (a box or a chat message) gets the pid while the turn works.
  async spawnTurn(run, { prompt, base, holder, boxId, label }) {
    const args = this.buildArgs(run, prompt);
    const isScript = /\.m?js$/i.test(config.claudeBin);
    const cmd = isScript ? process.execPath : config.claudeBin;
    const cmdArgs = isScript ? [config.claudeBin, ...args] : args;
    const result = { ok: false, error: null, sawResult: false, lastText: '', text: '', cost: 0, tokens: { input: 0, output: 0 } };
    appendLine(`${base}.cmd.txt`, JSON.stringify([cmd, ...cmdArgs]));

    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd: run.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
