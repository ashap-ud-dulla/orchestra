// Lessons: after a run, look for rules and workflow changes worth keeping.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readInstructionsSync, material, buildPrompt, parseSuggestions, ask, addSuggestions } from '../learn.mjs';
import { runDir, saveRun } from '../store.mjs';
import { childEnv } from '../env.mjs';
import { httpError, round } from '../util.mjs';
import { spawnJob } from './session.mjs';

export class LessonsPart {
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
}
