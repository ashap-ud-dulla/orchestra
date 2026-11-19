// Runs workflows. Each run is one interactive claude session in its own terminal tab (terminal.mjs,
// launch.mjs). You talk to it there: questions, "Allow?" prompts and gates happen in the terminal.
// Orchestra follows the session through Claude hooks (bin/hook.mjs) and moves it from step to step:
// when the AI ends a step with ORCHESTRA:DONE, the Stop hook hands it the next step. A "wait for me"
// step stops there, and you type `next` in the terminal to go on (`redo` runs a step again).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fs2 from 'node:fs';
import path from 'node:path';
import { DONE_MARK, FAILED_MARK, readMark, readWhy, readAbout, readPins, readTask, readDo, readPlan } from './guard.mjs';
import * as workspace from './workspace.mjs';
import { notify, focusUrl } from './notify.mjs';
import { scanSkills, missingSkills } from './skills-scan.mjs';
import { OFF_HELP, offProblems, getHeavyMarks } from './tracking.mjs';
import { listTemplates, getTemplate, newId, runDir, saveRun, loadRuns, brokenRuns, appendLine, validateTemplate, getSettings, saveSettings, flushSaves, WRAP_UP_SKILL, archiveRun, isArchived } from './store.mjs';
import { withLock, without as withoutLock, held as lockHeld } from './lock.mjs';
import { tabTitle } from './terminal.mjs';
import { NOTIFY, MAX_INPUT_CHARS, MAX_BATCH, LEARN_STUCK_MS } from './limits.mjs';
import { httpError, alive, round } from './util.mjs';
import { STARTED, newStep, nextStep, sessionOpen, describeTool, youBack } from './run/steps.mjs';
import { EXPLAIN, KEEP_LINE, instruction, failAsk } from './run/prompts.mjs';
import { pushPin, keepReply } from './run/pins.mjs';
import { forgetApp } from './run/app-queue.mjs';
import { tabGone, startStuck, spawnTick } from './run/session.mjs';
import { keepShipInfo, safeFollow, lastReply } from './run/ship.mjs';
import { childEnv, guardEnv } from './env.mjs';
import { VERSION } from './upgrade.mjs';
import { AppQueuePart, HeavyPart } from './run/app-queue.mjs';
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
// archived: also load the cleaned runs (runs/archive): orch commands do, hooks never.
export async function withRunner(fn, { detach = false, lockMs, archived = false } = {}) {
  return withLock(async () => {
    const runner = new Runner({ detach, archived });
    await runner.init();
    try {
      return await fn(runner);
    } finally {
      await runner.settle();
    }
  }, lockMs);
}
export class Runner {
  constructor({ detach = false, archived = false } = {}) {
    this.archived = archived;
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
    this.heavyMarks = await getHeavyMarks(); // skills marked heavy (isHeavy)
    for (const run of await loadRuns({ archived: this.archived })) {
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
    // Cleaned runs move to the archive (runs cleaned before the archive existed too). Not from a hook: it has no time.
    if (this.archived) for (const run of this.runs.values()) if (run.cleanedAt && !sessionOpen(run) && !run.cleaning && !isArchived(run.id)) await archiveRun(run.id);
    this.wantSchedule = true;
  }

  // Loads the runs again after the lock was let go (other processes may have changed them).
  // Runs are updated in place, so references to them stay good; references to steps do not.
  async reload() {
    const fresh = new Map((await loadRuns({ archived: this.archived })).map((r) => [r.id, r]));
    const unreadable = new Set(brokenRuns().map((b) => b.id));
    for (const [id, run] of this.runs) {
      const f = fresh.get(id);
      if (!f) {
        // Deleted, or its file could not be read just now: only a deleted run leaves.
        if (!unreadable.has(id)) this.runs.delete(id);
        continue;
      }
      for (const k of Object.keys(run)) delete run[k];
      Object.assign(run, f);
    }
    for (const [id, f] of fresh) if (!this.runs.has(id)) this.runs.set(id, f);
    this.settings = await getSettings();
    this.heavyMarks = await getHeavyMarks();
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
      await this.startAppWaiters();
      await this.startSlotWaiters();
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
    if ([...this.runs.values()].some((r) => r.status === 'queued')) spawnTick();
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

  // start=false makes a draft: you can edit its steps, then press Start.
  // repos: [{ token, base? }]. Left out: the template's repos. Each starts from its development
  // branch with no branch of its own; the skills make the branch.
  async createRun({ templateId, input, start = true, repos }) {
    const text = String(input?.text ?? input ?? '');
    if (text.length > MAX_INPUT_CHARS) {
      throw httpError(400, `input is too long (${text.length} chars, max ${MAX_INPUT_CHARS})`);
    }
    const template = await this.templateFor(templateId);
    // A draft may hold such steps, so you can remove them before you press Start.
    if (start) await this.checkTracking({ tracking: template.tracking !== false }, template.steps);
    const id = newId('run');
    const repoPlan = workspace.checkPlan(repos ?? (template.repos || []).map((token) => ({ token })));
    // A run with repos works in its own workspace (made when it starts); one without, in an empty folder.
    const cwd = path.join(runDir(id), 'work');
    await fs.mkdir(cwd, { recursive: true });
    const now = new Date().toISOString();
    const run = {
      version: VERSION,
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
      // A copy: editing this run's steps never changes the template.
      // The template's model and effort fill the steps that name none.
      steps: template.steps.map((b) => newStep({ ...b, model: b.model || template.model, effort: b.effort || template.effort })),
      cost: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(id, run);
    await saveRun(run);
    this.emitRun(run);
    const from = template.id ? `template ${template.id}` : 'no template (its first step picks the task and the steps)';
    this.log(run, start ? `started from ${from}` : `draft made from ${from}`);
    if (start) this.wantSchedule = true; // after the main work (orch start: in other processes, so it returns at once)
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
    const template = await this.templateFor(templateId);
    if (start) await this.checkTracking({ tracking: template.tracking !== false }, template.steps);
    workspace.checkPlan(repos ?? (template.repos || []).map((token) => ({ token })));
    const runs = [];
    for (const text of list) runs.push(await this.createRun({ templateId, input: { text }, start, repos }));
    return runs;
  }

  // The template a run starts from. None named: a run whose only step is the first one (intake): it reads the task,
  // picks the template that fits and puts its steps in (orch use this <template>). Its repos are the usual ones (those
  // of your templates; with none, the solution's repos when there are 3 or fewer), so its workspace is made before
  // its tab opens, as for any run.
  async templateFor(templateId) {
    if (templateId) {
      const template = await getTemplate(templateId);
      if (!template) throw httpError(404, `template not found: ${templateId}`);
      return template;
    }
    const all = await listTemplates();
    let repos = [...new Set(all.flatMap((t) => t.repos || []))];
    if (!all.length) {
      const found = workspace.listRepos().filter((r) => r.cloned);
      repos = found.length <= 3 ? found.map((r) => r.token) : [];
    }
    return { id: null, name: 'New run', tracking: true, repos, steps: [{ id: 'intake', skill: 'intake', label: 'Pick the task and the steps', model: 'opus', effort: 'high' }] };
  }

  // orch use <run> <template>: the template's steps go after the steps the run has started (its first step). The run
  // also takes the template's name, tracking and repos: missing worktrees are added to its workspace now; a run that
  // had no workspace gets one, and its claude moves there at the next step's start.
  // guide: the template is only a guide; no steps go in (the run picks them one at a time with you).
  async useTemplate(id, templateId, { guide = false } = {}) {
    const run = this.mustGet(id);
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up');
    const t = await getTemplate(templateId);
    if (!t) throw httpError(404, `template not found: ${templateId}`);
    const keep = run.steps.filter((s) => STARTED.has(s.status));
    const ids = new Set(keep.map((s) => s.id));
    const add = t.steps.filter((s) => s.skill !== 'intake').map((s) => {
      let sid = s.id;
      for (let n = 2; ids.has(sid); n++) sid = `${s.id}-${n}`;
      ids.add(sid);
      return newStep({ ...s, id: sid, model: s.model || t.model, effort: s.effort || t.effort });
    });
    await this.checkTracking({ tracking: t.tracking !== false }, add);
    if (guide) {
      // The guide keeps each step's settings (a picked step takes them), with no wait gate: the pick is the gate.
      const pick = ({ status, attempts, cost, summary, error, wait, ...s }) => s;
      run.guide = { id: t.id, name: t.name, steps: t.steps.filter((s) => s.skill !== 'intake').map((s) => pick(newStep({ ...s, model: s.model || t.model, effort: s.effort || t.effort }))) };
      run.steps = keep;
    } else {
      delete run.guide;
      run.steps = [...keep, ...add];
    }
    Object.assign(run, { templateId: t.id, templateName: t.name, tracking: t.tracking !== false });
    const have = new Set((run.repoPlan || []).map((p) => p.token));
    const extra = workspace.checkPlan((t.repos || []).filter((token) => !have.has(token)).map((token) => ({ token })));
    if (extra.length) {
      run.repoPlan = [...(run.repoPlan || []), ...extra];
      const hadDir = !!run.workspace?.dir;
      if (run.workspace?.dir) run.workspace = { ...run.workspace, repos: [...run.workspace.repos, ...extra.map((p) => ({ ...p }))], ready: false };
      await saveRun(run);
      const before = run.cwd;
      if (!(await this.prepareWorkspace(run))) throw httpError(500, run.error || 'could not add the worktrees');
      // A run that worked in its empty folder moves to the workspace: its notes come along; claude restarts there.
      if (!hadDir) {
        try {
          fs2.cpSync(path.join(before, '.orchestra'), path.join(run.workspace.dir, '.orchestra'), { recursive: true });
        } catch {}
        run.moveToWorkspace = true;
      }
    }
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `${guide ? `guide template ${t.id} (steps are picked one at a time)` : `steps from template ${t.id}: ${add.map((s) => s.id).join(', ')}`}${extra.length ? ` · repos added: ${extra.map((p) => p.token).join(', ')}` : ''}`);
    return run;
  }

  // Before steps run: every skill must be there (named, with the closest one), and with tracking OFF, refuses steps
  // whose skill writes to the pack's tracker or notes place.
  async checkTracking(run, steps) {
    if (!steps.length) return;
    const skills = await scanSkills();
    const missing = missingSkills(steps, skills);
    if (missing.length) throw httpError(409, missing);
    if (run.tracking !== false) return;
    const problems = offProblems(steps, skills);
    if (problems.length) throw httpError(409, `${problems.join('; ')}. ${OFF_HELP}`);
  }

  // What the ticket is about, said by hand (the run's Claude says it by itself with an ORCHESTRA:ABOUT: line).
  // soft: a stand-in (a title from the pick list) that the run's own summary replaces once it says one.
  async setAbout(id, text, { soft = false } = {}) {
    const run = this.mustGet(id);
    run.about = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null;
    if (soft && run.about) run.aboutSoft = true;
    else delete run.aboutSoft;
    await saveRun(run);
    return run;
  }

  // Replaces the run's step list. Finished and working steps stay first and keep their place;
  // only their label and settings may change. The template never changes.
  async updateSteps(id, list) {
    const run = this.mustGet(id);
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone); its steps can no longer change');
    if (!Array.isArray(list)) throw httpError(400, 'steps must be a list');
    // A finished run may get new steps at the end (like Wrap up); then it waits for next again.
    if (run.status === 'done' && list.length <= run.steps.length) throw httpError(400, 'this run is finished; only new steps at the end can be added');
    const errors = validateTemplate({ id: 'x', name: 'x', steps: list });
    if (errors.length) throw httpError(400, errors.join('; '));
    const locked = run.steps.filter((b) => STARTED.has(b.status));
    for (const [i, b] of locked.entries()) {
      const n = list[i];
      if (n?.id !== b.id || n.skill !== b.skill) {
        throw httpError(409, `step ${b.id} has ${b.status === 'done' ? 'finished' : 'started'}; it must stay at place ${i + 1}`);
      }
    }
    const old = new Map(run.steps.map((b) => [b.id, b]));
    // Only new skills are checked; a step that already ran is history.
    await this.checkTracking(run, list.slice(locked.length).filter((n) => old.get(n.id)?.skill !== n.skill));
    run.steps = list.map((n, i) => {
      const b = i < locked.length ? old.get(n.id) : old.get(n.id)?.skill === n.skill ? old.get(n.id) : newStep(n);
      b.label = String(n.label || n.skill).slice(0, 80);
      b.wait = !!n.wait;
      b.app = !!n.app;
      b.explain = !!n.explain;
      b.fresh = !!n.fresh;
      b.heavy = !!n.heavy;
      b.mcp = !!n.mcp;
      b.model = n.model || null;
      b.effort = n.effort || null;
      if (i >= locked.length) b.args = String(n.args || '').slice(0, 2000);
      return b;
    });
    if (run.status === 'done' && nextStep(run)) {
      run.status = 'waiting';
      run.waitingAfter = locked.at(-1)?.id || null;
      run.finishedAt = null;
      run.note = 'New steps added. Type next in its tab to go on.';
    }
    await saveRun(run);
    this.emitRun(run);
    this.log(run, 'steps changed by you');
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
    this.activity(run, run.currentStep || null, 'tool', describeTool({ name: body.tool_name, input: body.tool_input }));
    // A tool ran, so an "Allow?" prompt was answered: the run works again.
    if (run.status === 'needs-you' && run.steps.some((b) => b.status === 'running')) {
      youBack(run);
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
    // An "Allow?" prompt is worth a notification; "waiting for your input" (idle) is not.
    run.needsYouWhy = /permission|approv|allow/i.test(run.note) ? 'allow' : null;
    run.youSince ||= new Date().toISOString();
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `needs you: ${run.note}`);
    return {};
  }

  // Claude ended its turn. A step marked done moves the run on; anything else waits for you.
  async onStop(run, body) {
    delete run.turnAt; // Claude's turn is over (see midTurn)
    // The run's own summary; it replaces a stand-in (aboutSoft: a title from the pick list), never one you set.
    const said = readAbout(lastReply(body));
    if (said.about && (!run.about || run.aboutSoft)) {
      run.about = said.about;
      delete run.aboutSoft;
      this.log(run, `about: ${said.about}`);
    }
    // The task the first step (intake) picked: the run takes its key as its name.
    const tasked = readTask(said.text);
    if (tasked.task) {
      run.task = { ...tasked.task, at: new Date().toISOString() };
      if (tasked.task.title && !run.about) run.about = tasked.task.title;
      this.log(run, `task: ${tasked.task.key}${tasked.task.title ? ` (${tasked.task.title})` : ''}`);
    }
    // The steps it suggested and the ones you chose (the lessons learn from your changes).
    const planned = readPlan(tasked.text);
    if (planned.plan) {
      run.plan = { ...planned.plan, at: new Date().toISOString() };
      if (planned.plan.suggested !== planned.plan.chosen) this.log(run, `steps suggested: ${planned.plan.suggested} · chosen: ${planned.plan.chosen}`);
    }
    // Something the user asked for in plain words (go to a step, skip, pin…): done after this reply, below.
    const asked = readDo(planned.text);
    const pinned = readPins(asked.text);
    for (const p of pinned.pins) {
      if ((run.pins || []).some((old) => old.text === p.text)) continue; // said again: pinned already
      const added = pushPin(run, { ...p, from: 'claude' });
      if (added) this.log(run, `pinned: ${added.title}`);
    }
    const { mark, text } = readMark(pinned.text);
    keepReply(run, text);
    for (const note of safeFollow(run)) this.log(run, note);
    if (text.trim()) this.activity(run, run.currentStep || null, 'text', text.slice(-2000));
    // A step that is done may park the run (the pick's "Put the run on hold"): DONE, then hold, no next step.
    const holdAfter = mark === DONE_MARK && step0(run)?.skill !== WRAP_UP_SKILL && /^hold\b/i.test(asked.command || '') ? asked.command.replace(/^hold\s*/i, '') : null;
    if (asked.command && holdAfter === null) {
      if (!mark) return this.doAsked(run, asked.command);
      this.log(run, `not done: "${asked.command}" came with ${mark} (a step's end is not a request)`);
    }

    // The walk-through after a step is over: go on as that step would have.
    if (run.explainFor) {
      const done = run.steps.find((b) => b.id === run.explainFor);
      run.explainFor = null;
      if (done) return this.advance(run, done);
    }
    const step = run.steps.find((b) => b.status === 'running');
    if (!step) {
      if (run.status === 'running') run.status = 'needs-you';
      await saveRun(run);
      this.emitRun(run);
      return {};
    }
    step.lastReply = text.slice(-4000);
    if (mark === DONE_MARK && step.skill === WRAP_UP_SKILL) {
      // You chose in the step: clean up when the tab closes, or keep the folder (a KEEP line).
      const keep = KEEP_LINE.test(text);
      run.cleanWhenClosed = !keep;
      await this.finishStep(run, step, { ok: true, text: text.replace(KEEP_LINE, '') });
      const r = await this.advance(run, step);
      if (run.status === 'done') {
        run.note = keep ? 'Wrapped up. The folder stays (you chose Keep): clean it later from /orch.' : 'Wrapped up. Close this tab: Orchestra then cleans up the run.';
        await saveRun(run);
        this.emitRun(run);
      }
      return r;
    }
    if (mark === DONE_MARK) {
      await this.finishStep(run, step, { ok: true, text });
      if (holdAfter !== null) {
        const out = await this.onHoldWord(run, holdAfter);
        return { output: { systemMessage: out.output.reason } };
      }
      if (step.explain) {
        run.explainFor = step.id;
        await saveRun(run);
        this.log(run, `explaining the code after step ${step.id}`);
        return { output: { decision: 'block', reason: EXPLAIN } };
      }
      return this.advance(run, step);
    }
    if (mark === FAILED_MARK) {
      await this.finishStep(run, step, { ok: false, error: text.trim().slice(-600) || 'the step could not be done' });
      // One more turn, so Claude asks what to do with a click (run it again, skip, another step): no typing.
      return { output: { decision: 'block', reason: failAsk(step) } };
    }
    // Still working with you: a question, or a talk. Only a question is worth a notification.
    run.status = 'needs-you';
    run.note = null;
    run.youSince ||= new Date().toISOString(); // the step's clock waits for you (youMs)
    run.asks = text.trim().slice(-600);
    run.needsYouWhy = asksSomething(text) ? 'question' : null;
    await saveRun(run);
    this.emitRun(run);
    return {};
  }

  // After doneStep: the next step (Claude goes on by itself), a gate (you type next), or the end.
  // force: you typed next, so a gate does not stop it.
  async advance(run, doneStep, { force = false } = {}) {
    let next = nextStep(run);
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
    if (doneStep?.wait && !force) {
      run.status = 'waiting';
      run.waitingAfter = doneStep.id;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `waiting for you after step ${doneStep.id}`);
      return {};
    }
    const problem = await this.trackingProblem(run, next);
    if (problem) {
      await this.finishStep(run, next, { ok: false, error: problem });
      return {};
    }
    // The app is in use: the run waits in line with its tab free (Claude's turn ends; you may talk to it), and its slot
    // goes to another run. The step starts by itself once the app is free (startAppWaiters).
    if (this.sharedApp(next) && this.appHolder && this.appHolder !== run.id) {
      run.status = 'waiting';
      run.appNext = { step: next.id, at: run.appNext?.step === next.id ? run.appNext.at : new Date().toISOString() };
      run.note = `Waiting for the app: ${this.holderName()} has it. "${next.label}" starts by itself when the app is free.`;
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `step ${next.id} waits for the app (${this.holderName()} has it)`);
      return { output: { systemMessage: `Orchestra: ${run.note}` } }; // shown to you; Claude's turn ends
    }
    delete run.appNext;
    // Every heavy slot is taken: the run waits with its tab free, and the step starts by itself (startSlotWaiters).
    if (this.isHeavy(next) && this.heavyBusy(run)) {
      this.waitForSlot(run, next);
      await saveRun(run);
      this.emitRun(run);
      this.log(run, `step ${next.id} waits for a free slot (${this.heavyNames(run)})`);
      return { output: { systemMessage: `Orchestra: ${run.note}` } };
    }
    delete run.slotNext;
    this.startStep(run, next);
    // Another model or effort: no block, so this claude ends its turn and the launcher starts the new one.
    if (this.wantsRestart(run, next)) return this.restartFor(run, next, instruction(run, next));
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    return { output: { decision: 'block', reason: instruction(run, next) } };
  }

  // The status line: shows the step and keeps the run's cost. Claude reports its conversation's running total, and a
  // resumed conversation goes on from its saved total; so the run's cost is the conversations that are over
  // (costPast, see fresh steps) plus this one's total. A 0 before claude has restored its total is skipped.
  async onStatus(run, body) {
    const cost = Number(body?.cost?.total_cost_usd);
    if (Number.isFinite(cost) && run.session) {
      // A resumed claude that counts from 0 again (its total went down, not to 0): what it said before is over, so the
      // run's cost never goes down and a step's cost is never lost (before, steps could add up to more than the run).
      if (cost > 0 && cost + 0.0001 < (run.sessionRaw || 0)) {
        run.costPast = run.sessionCost || 0;
        this.log(run, `claude's cost counted from 0 again: $${run.costPast.toFixed(2)} kept`);
      }
      const base = run.costPast || 0;
      const total = round(base + cost);
      if (total !== run.sessionCost && !(cost === 0 && (run.sessionCost || 0) > base)) {
        run.sessionCost = total;
        if (cost > 0) run.sessionRaw = cost;
        this.totalCost(run);
        await saveRun(run);
        this.emitRun(run);
      }
    }
    const step = run.steps.find((b) => b.status === 'running');
    const model = body?.model?.display_name || body?.model?.id;
    return { line: `Orchestra · ${step ? step.label : run.status}${model ? ` · ${model}` : ''} · $${(run.cost || 0).toFixed(2)}` };
  }

  // ---- steps ----

  startStep(run, step) {
    step.status = 'running';
    step.attempts = (step.attempts || 0) + 1;
    step.startedAt = new Date().toISOString();
    step.endedAt = null;
    step.error = null;
    step.note = null;
    step.costStart = run.sessionCost || 0;
    run.currentStep = step.id;
    run.asks = null;
    delete run.youSince;
    delete run.hold;
    this.log(run, `step ${step.id} (/${step.skill}) started${step.attempts > 1 ? ` (try ${step.attempts})` : ''}`);
  }

  // The first step goes on claude's command line, with the run input.
  firstPrompt(run, step) {
    return [`/${step.skill}`, step.args, run.input.text].filter(Boolean).join(' ');
  }

  async trackingProblem(run, step) {
    if (run.tracking !== false) return null;
    const [problem] = offProblems([step], await scanSkills());
    return problem ? `${problem}. ${OFF_HELP}` : null;
  }

  async finishStep(run, step, { ok, error, text = '', note }) {
    youBack(run);
    step.endedAt = new Date().toISOString();
    step.durationMs = (step.durationMs || 0) + Math.max(0, Date.parse(step.endedAt) - Date.parse(step.startedAt || step.endedAt));
    step.cost = round((step.cost || 0) + Math.max(0, (run.sessionCost || 0) - (step.costStart || 0)));
    step.costStart = run.sessionCost || 0;
    if (ok) {
      step.status = 'done';
      const done = readWhy(text);
      if (done.text.trim()) step.summary = done.text.slice(-4000);
      if (done.why) step.didWhy = done.why.slice(0, 3000);
      keepShipInfo(run, text);
      step.note = note || null;
      this.log(run, `step ${step.id} done${note ? ` (${note})` : ''}`);
    } else {
      step.status = 'failed';
      step.failures = (step.failures || 0) + 1;
      step.error = error;
      run.status = 'failed';
      run.error = `step ${step.id}: ${error}`;
      this.log(run, `step ${step.id} failed: ${error}`);
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
    // Only when you are really needed: an Allow prompt or a question (needs-you), a next gate (waiting, not a wait for
    // the app), a failed step. Not after every reply.
    const needed = run.status === 'needs-you' ? !!run.needsYouWhy : run.status === 'waiting' ? !run.appNext && !run.slotNext : true;
    if (was && was !== run.status && NOTIFY[run.status] && needed) {
      const sent = notify({ title: `Orchestra: ${tabTitle(run)}`, body: `${run.input?.text?.slice(0, 80) || run.id} ${NOTIFY[run.status]}.`, url: focusUrl(tabTitle(run)) });
      this.log(run, `notification${sent ? '' : ' (off)'}: ${NOTIFY[run.status]}`);
    }
    // A run that stopped working frees a slot.
    if (was === 'running' && run.status !== 'running') this.wantSchedule = true;
  }

  activity(run, stepId, kind, text) {
    const line = { at: new Date().toISOString(), stepId, kind, text };
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

const step0 = (run) => run.steps.find((b) => b.status === 'running');

// Does Claude's reply end with a question to you? (A "?" in its end: the question, maybe with a list of choices.)
export function asksSomething(text) {
  return String(text || '').trim().slice(-600).includes('?');
}

// The parts of Runner that live in lib/run/: their methods become Runner's own.
for (const Part of [AppQueuePart, SessionPart, TabCommandsPart, CleanupPart, LessonsPart]) {
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(Part.prototype))) if (name !== 'constructor') Object.defineProperty(Runner.prototype, name, d);
}
Object.assign(Runner.prototype, HeavyPart); // heavy steps and their slots (lib/run/app-queue.mjs)
