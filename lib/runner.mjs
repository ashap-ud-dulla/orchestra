// Runs workflows. One Claude session per run; each box is one `claude -p` call that resumes that session.
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.mjs';
import { getTemplate, newId, runDir, saveRun, saveRunSync, loadRuns, appendLine } from './store.mjs';

const ACTIVE = new Set(['running']);
// The prompt goes on the command line, and Windows caps that at 32767 chars.
const MAX_INPUT_CHARS = 8000;
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

export class Runner extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map(); // id -> run state (same object that is saved to state.json)
    this.children = new Map(); // id -> child process of the box that is working now
    this.drives = new Map(); // id -> promise of the active drive loop, so a run is never driven twice
    this.stopRequested = new Set(); // ids whose working box was stopped by you
    this.shuttingDown = false;
  }

  // Loads saved runs and continues the unfinished ones from their last finished box.
  async init() {
    for (const run of await loadRuns()) {
      this.runs.set(run.id, run);
      if (!ACTIVE.has(run.status)) continue;
      for (const box of run.boxes) {
        if (box.status !== 'running') continue;
        if (box.pid) killOrphan(box.pid, box.pidStartedAt);
        box.status = 'pending';
        box.pid = null;
        box.note = 'Interrupted when Orchestra stopped. Runs again.';
      }
      run.resumedAt = new Date().toISOString();
      await saveRun(run);
      this.log(run, 'resumed after restart');
      this.drive(run.id);
    }
  }

  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.runs.get(id) || null;
  }

  async createRun({ templateId, input }) {
    const text = String(input?.text ?? input ?? '');
    if (text.length > MAX_INPUT_CHARS) {
      throw Object.assign(new Error(`input is too long (${text.length} chars, max ${MAX_INPUT_CHARS})`), { status: 400 });
    }
    const template = await getTemplate(templateId);
    if (!template) throw Object.assign(new Error(`template not found: ${templateId}`), { status: 404 });
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
      status: 'running',
      sessionId: null,
      cwd,
      // A copy: editing this run's boxes never changes the template.
      boxes: template.boxes.map((b) => ({
        id: b.id,
        skill: b.skill,
        label: b.label || b.skill,
        args: b.args || '',
        waitAfter: !!b.waitAfter,
        status: 'pending',
        attempts: 0,
        cost: 0,
        tokens: { input: 0, output: 0 },
        summary: '',
        error: null,
      })),
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, run);
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `started from template ${template.id}`);
    this.drive(id);
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

  // Continues a stopped or failed run from its first unfinished box.
  async resume(id) {
    const run = this.mustGet(id);
    // A stopped box may still be closing. Let its loop end first, or it would see the run as running again.
    if (this.drives.has(id)) await this.drives.get(id);
    if (!['stopped', 'failed'].includes(run.status)) return run;
    this.stopRequested.delete(id);
    for (const box of run.boxes) {
      if (box.status === 'failed' || box.status === 'running') {
        box.status = 'pending';
        box.error = null;
      }
    }
    run.status = 'running';
    run.error = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, 'resumed by you');
    this.drive(id);
    return run;
  }

  // Kills every working box but keeps runs marked running, so the next start resumes them.
  // Saves synchronously: the process exits right after, so async saves would never land.
  shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const id of this.children.keys()) this.killChild(id);
    for (const run of this.runs.values()) {
      const working = run.boxes.filter((b) => b.pid);
      if (!working.length) continue;
      for (const box of working) box.pid = null; // the process is gone; a stale pid could match a new process later
      try {
        saveRunSync(run);
      } catch {}
    }
  }

  // ---- internals ----

  mustGet(id) {
    const run = this.runs.get(id);
    if (!run) throw Object.assign(new Error(`run not found: ${id}`), { status: 404 });
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
        if (!run || !ACTIVE.has(run.status) || this.shuttingDown) return;
        const box = run.boxes.find((b) => b.status !== 'done');
        if (!box) {
          run.status = 'done';
          run.finishedAt = new Date().toISOString();
          await saveRun(run);
          this.emitRun(run);
          this.log(run, 'finished');
          return;
        }
        const ok = await this.runBox(run, box);
        if (!ok) return;
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
      run.status = 'failed';
      run.error = `runner error: ${err.message}`;
      await saveRun(run).catch(() => {});
      this.emitRun(run);
      this.log(run, `runner error: ${err.message}`);
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

  buildArgs(run, box) {
    const args = ['-p', this.buildPrompt(run, box), '--output-format', 'stream-json', '--verbose'];
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

    const args = this.buildArgs(run, box);
    const isScript = /\.m?js$/i.test(config.claudeBin);
    const cmd = isScript ? process.execPath : config.claudeBin;
    const cmdArgs = isScript ? [config.claudeBin, ...args] : args;

    const boxDir = path.join(runDir(run.id), 'boxes');
    const base = path.join(boxDir, `${box.id}.attempt${box.attempts}`);
    appendLine(`${base}.cmd.txt`, JSON.stringify([cmd, ...cmdArgs]));

    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd: run.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return this.finishBox(run, box, { ok: false, error: `could not start claude: ${err.message}` });
    }
    this.children.set(run.id, child);
    box.pid = child.pid ?? null;
    box.pidStartedAt = new Date().toISOString();

    // Attach every listener before the first await, so no output is missed.
    const result = { ok: false, error: null, sawResult: false, lastText: '' };
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
      this.onStreamEvent(run, box, ev, result, saves);
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
    this.log(run, `box ${box.id} (/${box.skill}) started`);

    const exit = await exited;
    if (!exit.err) await rlClosed;
    await Promise.allSettled(saves);
    this.children.delete(run.id);
    box.pid = null;

    if (this.shuttingDown) return false; // leave state as running; next start resumes it

    if (this.stopRequested.delete(run.id)) {
      box.endedAt = new Date().toISOString();
      if (result.sawResult && result.ok) {
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
    if (exit.err) return this.finishBox(run, box, { ok: false, error: `could not start claude: ${exit.err.message}` });
    if (!result.sawResult) {
      const why = stderrTail.trim() ? `: ${stderrTail.trim().slice(-500)}` : '';
      return this.finishBox(run, box, { ok: false, error: `claude exited (code ${exit.code}) without a result${why}` });
    }
    if (!result.ok) return this.finishBox(run, box, { ok: false, error: result.error });
    return this.finishBox(run, box, { ok: true });
  }

  onStreamEvent(run, box, ev, result, saves) {
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
          this.emit('activity', { runId: run.id, boxId: box.id, kind: 'text', text: c.text.slice(0, 2000) });
        } else if (c.type === 'tool_use') {
          this.emit('activity', { runId: run.id, boxId: box.id, kind: 'tool', text: describeTool(c) });
        }
      }
      return;
    }
    if (ev.type === 'result') {
      result.sawResult = true;
      const cost = Number(ev.total_cost_usd) || 0;
      const u = ev.usage || {};
      box.cost = round((box.cost || 0) + cost);
      box.tokens = {
        input: (box.tokens?.input || 0) + (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        output: (box.tokens?.output || 0) + (u.output_tokens || 0),
      };
      run.cost = round(run.boxes.reduce((s, b) => s + (b.cost || 0), 0));
      if (ev.session_id) run.sessionId = ev.session_id;
      const text = typeof ev.result === 'string' ? ev.result : '';
      box.summary = (text || result.lastText || '').slice(0, 4000);
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

  log(run, message) {
    const line = { at: new Date().toISOString(), message };
    try {
      appendLine(path.join(runDir(run.id), 'events.jsonl'), JSON.stringify(line));
    } catch {}
    this.emit('log', { runId: run.id, ...line });
  }
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
