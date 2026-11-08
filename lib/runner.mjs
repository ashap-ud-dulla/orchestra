// Runs workflows. Each run is one interactive claude session in its own terminal tab (terminal.mjs,
// launch.mjs). You talk to it there: questions, "Allow?" prompts and gates happen in the terminal.
// Orchestra follows the session through Claude hooks (bin/hook.mjs) and moves it from box to box:
// when the AI ends a step with ORCHESTRA:DONE, the Stop hook hands it the next box. A "wait for me"
// box stops there, and you type `next` in the terminal to go on (`redo` runs a box again).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DONE_MARK, FAILED_MARK, readMark, readWhy, readAbout, readPins } from './guard.mjs';
import * as workspace from './workspace.mjs';
import { notify, focusUrl } from './notify.mjs';
import { scanSkills } from './skills-scan.mjs';
import { OFF_HELP, offProblems } from './tracking.mjs';
import { getTemplate, newId, runDir, saveRun, loadRuns, brokenRuns, appendLine, validateTemplate, getSettings, saveSettings, flushSaves, WRAP_UP_SKILL } from './store.mjs';
import { withLock, without as withoutLock, held as lockHeld } from './lock.mjs';
import { tabTitle } from './terminal.mjs';
import { NOTIFY, MAX_INPUT_CHARS, MAX_BATCH, APP_WAIT_MS, LEARN_STUCK_MS } from './limits.mjs';
import { httpError, alive, round } from './util.mjs';
import { STARTED, newBox, nextBox, sessionOpen, describeTool } from './run/steps.mjs';
import { WALKTHROUGH, KEEP_LINE, instruction } from './run/prompts.mjs';
import { pushPin, keepReply } from './run/pins.mjs';
import { forgetApp } from './run/app-queue.mjs';
import { tabGone, startStuck, spawnJob } from './run/session.mjs';
import { keepShipInfo, safeFollow, lastReply } from './run/ship.mjs';
import { childEnv, guardEnv } from './env.mjs';
import { AppQueuePart } from './run/app-queue.mjs';
import { SessionPart } from './run/session.mjs';
import { TabCommandsPart } from './run/tab-commands.mjs';
import { CleanupPart } from './run/cleanup.mjs';
import { LessonsPart } from './run/lessons.mjs';

export { childEnv, guardEnv };
export { gb } from './run/cleanup.mjs';
export { lastReply, keepShipInfo } from './run/ship.mjs';
export { spawnJob } from './run/session.mjs';

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
export class Runner {
  constructor({ detach = false } = {}) {
    this.runs = new Map(); // id -> run state (same object that is saved to state.json)
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
      this.runs.set(run.id, run);
      this.lastStatus.set(run.id, run.status);
      let changed = false;
      // Its process ended, or it has gone on far longer than a lessons call may: the pid is not it any more.
      if (run.learn?.status === 'working' && (!alive(run.learn.pid) || Date.now() - Date.parse(run.learn.at) > LEARN_STUCK_MS)) {
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

  // What the ticket is about, said by hand (the run's Claude says it by itself with an ORCHESTRA:ABOUT: line).
  async setAbout(id, text) {
    const run = this.mustGet(id);
    run.about = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null;
    await saveRun(run);
    return run;
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
    // A run that stopped working frees a slot.
    if (was === 'running' && run.status !== 'running') this.wantSchedule = true;
  }

  activity(run, boxId, kind, text) {
    const line = { at: new Date().toISOString(), boxId, kind, text };
    try {
      appendLine(path.join(runDir(run.id), 'activity.jsonl'), JSON.stringify(line));
    } catch {}
  }

  log(run, message) {
    const line = { at: new Date().toISOString(), message };
    try {
      appendLine(path.join(runDir(run.id), 'events.jsonl'), JSON.stringify(line));
    } catch {}
  }
}

// The parts of Runner that live in lib/run/: their methods become Runner's own.
for (const Part of [AppQueuePart, SessionPart, TabCommandsPart, CleanupPart, LessonsPart]) {
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(Part.prototype))) if (name !== 'constructor') Object.defineProperty(Runner.prototype, name, d);
}
