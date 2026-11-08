// The app queue: one run at a time has the app; the others wait in line.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import { saveRun } from '../store.mjs';
import { tabTitle } from '../terminal.mjs';
import { activeYourHold, YOU } from '../app.mjs';
import { httpError } from '../util.mjs';
import { sessionOpen, midTurn } from './steps.mjs';
import { instruction } from './prompts.mjs';

export class AppQueuePart {
  // The run that may use the app now: one whose "uses app" step works, or one that took the app
  // (bin/app.mjs take) and still keeps it. Worked out from the runs, so it is never out of date.
  get appHolder() {
    return findAppHolder(this.runs);
  }

  // The runs waiting for the app, first come first served.
  // Two ways to be in line: a step that asked for the app (bin/app.mjs take), or a next step that needs it (appNext).
  appLine() {
    const since = (r) => (wantsApp(r) ? r.appWant.at : r.appNext.at);
    return [...this.runs.values()].filter((r) => wantsApp(r) || waitsForAppStep(r)).sort((a, b) => since(a).localeCompare(since(b)));
  }

  // Who has the app and who waits for it. With id: also whether that run has it, and its place in line.
  appState(id) {
    const holder = this.runs.get(this.appHolder);
    const line = this.appLine();
    const yours = this.appHolder === YOU ? activeYourHold() : null;
    const out = {
      holder: holder
        ? { id: holder.id, title: tabTitle(holder), waitingForYou: holder.status === 'waiting', step: holder.steps.find((b) => WORKING.has(b.status))?.label || null }
        : yours ? { id: YOU, title: 'you', you: true, since: yours.at } : null,
      line: line.map((r) => ({ id: r.id, title: tabTitle(r), since: (wantsApp(r) ? r.appWant : r.appNext).at })),
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
    const working = run.steps.find((b) => WORKING.has(b.status));
    const step = working || waitingAfterStep(run);
    if (!sessionOpen(run) || !step) throw httpError(409, 'only a working step, or a run waiting for you after a step, can take the app');
    if (this.appHolder === run.id) return this.appState(run.id);
    if (!wantsApp(run)) {
      run.appWant = { step: step.id, at: new Date().toISOString(), ...(working ? {} : { waiting: true }) };
      this.log(run, 'waits for the app');
    }
    if (!this.appHolder && this.appLine().find(wantsApp) === run) {
      run.appHeld = { step: run.appWant.step, at: new Date().toISOString(), ...(run.appWant.waiting ? { waiting: true } : {}) };
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

  // The app is free: the first run in line whose next step needs it starts that step by itself. Its claude sits idle
  // at the prompt (the run waits), and no hook can give it a turn, so the launcher restarts it on the same
  // conversation with the step's instruction (restart.ok, as for a model change). A run you are talking to
  // (needs-you) is not interrupted: it goes on when you type next. Runs once per orch command or hook.
  async startAppWaiters() {
    if (this.appHolder) return;
    const first = this.appLine()[0];
    // Not while you talk to it: its claude has a turn (it starts when that turn ends: the Stop hook settles too).
    if (!first || !waitsForAppStep(first) || first.status !== 'waiting' || midTurn(first)) return;
    const working = [...this.runs.values()].filter((r) => r.status === 'running').length;
    if (working >= this.settings.maxRunning) return; // it starts when a slot frees up
    const step = first.steps.find((s) => s.id === first.appNext.step);
    delete first.appNext;
    first.waitingAfter = null;
    first.explainFor = null;
    this.startStep(first, step);
    this.log(first, `the app is free: step ${step.id} starts by itself`);
    await this.restartFor(first, step, `The app is free now. ${instruction(first, step)}`);
  }
}

// A run whose next step needs the app and waits for it (its tab is open, the step has not started).
export function waitsForAppStep(run) {
  if (!run.appNext || !sessionOpen(run)) return false;
  return run.steps.find((s) => s.id === run.appNext.step)?.status === 'pending';
}

// The run that may use the app (one at a time): a step marked "uses app" works, or the run took the app.
export function findAppHolder(runs) {
  if (activeYourHold()) return YOU; // orch app start: you hold it until orch app stop, or until your app is gone
  for (const run of runs.values()) {
    if (sessionOpen(run) && run.steps.some((b) => b.status === 'running' && b.app)) return run.id;
    if (keepsApp(run)) return run.id;
  }
  return null;
}

export const WORKING = new Set(['running', 'question', 'approval']);

// A run that took the app keeps it while that step works, and while the run waits for you after it.
// It lets go on next, when the step fails, or when the tab closes.
export function keepsApp(run) {
  return stepHolds(run, run.appHeld, true);
}

// A run in the line for the app still wants it while the step that asked works
// (or, when it asked while waiting for you, while it still waits after that step).
export function wantsApp(run) {
  return stepHolds(run, run.appWant, false);
}

export function stepHolds(run, mark, orWaiting) {
  if (!mark || !sessionOpen(run)) return false;
  const step = run.steps.find((b) => b.id === mark.step);
  if (!step) return false;
  return WORKING.has(step.status) || ((orWaiting || !!mark.waiting) && waitingAfterStep(run)?.id === mark.step);
}

// The step the run waits for you after: it is done, no later step has started, and you have not typed next.
// While you talk to Claude between steps the status moves between 'waiting', 'running' and 'needs-you',
// but the run still waits after that step.
export function waitingAfterStep(run) {
  if (!['waiting', 'running', 'needs-you'].includes(run.status) || !run.waitingAfter) return null;
  const i = run.steps.findIndex((b) => b.id === run.waitingAfter);
  if (i < 0 || run.steps[i].status !== 'done' || run.steps.slice(i + 1).some((b) => b.status !== 'pending')) return null;
  return run.steps[i];
}

// Drops app marks that no longer hold, so a redone step joins the line again. True when one was dropped.
export function forgetApp(run) {
  let dropped = false;
  if (run.appHeld && !keepsApp(run)) dropped = delete run.appHeld;
  if (run.appWant && !wantsApp(run)) dropped = delete run.appWant;
  if (run.appNext && !waitsForAppStep(run)) dropped = delete run.appNext;
  return dropped;
}
