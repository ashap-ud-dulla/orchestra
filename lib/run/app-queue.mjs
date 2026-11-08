// The app queue: one run at a time has the app; the others wait in line.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import { saveRun } from '../store.mjs';
import { tabTitle } from '../terminal.mjs';
import { readYourHold, YOU } from '../app.mjs';
import { httpError } from '../util.mjs';
import { sessionOpen } from './steps.mjs';

export class AppQueuePart {
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

  // One run at a time may start the app to test it. Waits up to ms for it (the Stop hook waits with us).
  // The lock is let go while waiting, so the run holding the app can finish its box.
  async waitForApp(run, boxId, ms) {
    const end = Date.now() + ms;
    let told = false;
    const box = () => run.boxes.find((b) => b.id === boxId) || {};
    while (this.appHolder && this.appHolder !== run.id) {
      if (Date.now() >= end || !sessionOpen(run) || !this.runs.has(run.id)) return false;
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
}

// The run that may use the app (one at a time): a box marked "uses app" works, or the run took the app.
export function findAppHolder(runs) {
  if (readYourHold()) return YOU; // orch app start: you hold it until orch app stop
  for (const run of runs.values()) {
    if (sessionOpen(run) && run.boxes.some((b) => b.status === 'running' && b.usesApp)) return run.id;
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
  const box = run.boxes.find((b) => b.id === mark.box);
  if (!box) return false;
  return WORKING.has(box.status) || ((orWaiting || !!mark.waiting) && waitingAfterBox(run)?.id === mark.box);
}

// The step the run waits for you after: it is done, no later step has started, and you have not typed next.
// While you talk to Claude between steps the status moves between 'waiting', 'running' and 'needs-you',
// but the run still waits after that step.
export function waitingAfterBox(run) {
  if (!['waiting', 'running', 'needs-you'].includes(run.status) || !run.waitingAfter) return null;
  const i = run.boxes.findIndex((b) => b.id === run.waitingAfter);
  if (i < 0 || run.boxes[i].status !== 'done' || run.boxes.slice(i + 1).some((b) => b.status !== 'pending')) return null;
  return run.boxes[i];
}

// Drops app marks that no longer hold, so a redone step joins the line again. True when one was dropped.
export function forgetApp(run) {
  let dropped = false;
  if (run.appHeld && !keepsApp(run)) dropped = delete run.appHeld;
  if (run.appWant && !wantsApp(run)) dropped = delete run.appWant;
  return dropped;
}
