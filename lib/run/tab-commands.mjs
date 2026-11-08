// What you type in a run tab: next, skip, redo, pin, unpin, and /orch <command> (model, back, steps, help, …).
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import { DONE_MARK, ABOUT_RULE } from '../guard.mjs';
import { newId, saveRun, validateTemplate, WRAP_UP_SKILL } from '../store.mjs';
import { parseModelWords, modelText, modelTypo, MODEL_HELP } from '../model.mjs';
import { READ_ONLY, didYouMean } from '../cli/spec.mjs';
import { runSteps } from '../format.mjs';
import { MAX_REPLIES } from '../limits.mjs';
import { httpError } from '../util.mjs';
import { findStep, stepList, splitStepRef, stepNow, sessionOpen, midTurn, PASSED } from './steps.mjs';
import { instruction } from './prompts.mjs';
import { pushPin, dropPin } from './pins.mjs';
import { addChat, readReplies } from './chat.mjs';

// The tab's commands, in one line (a wrong /orch word is answered with it).
export const TAB_USAGE = 'In this tab: next · skip · redo · /orch go <step> [why] · /orch model opus effort=high · pin · pin 2 · unpin · /orch steps · /orch runs · /orch help';

export class TabCommandsPart {
  // Your message in the terminal. `next` and `redo` steer the run; anything else is plain talk.
  // `/orch <words>` (and the old `/orchestra <words>`) is always Orchestra's: it never reaches the skill or Claude.
  async onPrompt(run, body) {
    let text = String(body.prompt ?? '').trim();
    const slash = /^\/(orch|orchestra)(?:\s+([\s\S]*))?$/i.exec(text);
    if (slash) {
      const rest = (slash[2] || '').trim();
      const words = rest.split(/\s+/).filter(Boolean);
      const word = (words[0] || 'help').toLowerCase();
      const say = (reason) => ({ output: { decision: 'block', reason } });
      if (['next', 'skip', 'redo'].includes(word) && words.length === 1) text = word; // as typed bare, below
      else if (word === 'pin' || word === 'unpin') return (await this.onPinWord(run, rest)) || say(`Orchestra: ${word === 'pin' ? 'pin · pin 2 · pin: your note' : 'unpin · unpin 2 · unpin all'}.`);
      else if (word === 'model' || word === 'effort') return this.onModelWord(run, rest);
      else if (['go', 'back', 'jump', 'from'].includes(word)) return (await this.onGoWord(run, rest)) || say(`Orchestra: /orch go <step> [why]. ${stepList(run)}`);
      else if (word === 'help') return say(this.tabHelp(run));
      else if (word === 'steps' && words.length === 1) return say(`Orchestra:\n${runSteps(run)}\nChange them from outside: /orch steps ${run.id.slice(-6)} add|set|remove|move …`);
      else if (READ_ONLY.has(word) || word === 'app') return say(await this.tabShow(word, words.slice(1)));
      else return say(`Orchestra: "/orch ${word}" is not a tab command.${didYouMean(word, ['next', 'skip', 'redo', 'go', 'back', 'jump', 'model', 'effort', 'pin', 'unpin', 'steps', 'help', ...READ_ONLY])} ${TAB_USAGE}`);
    }
    const cmd = text.toLowerCase().replace(/^\//, '');
    const pinned = await this.onPinWord(run, text);
    if (pinned) return pinned;
    // Talk (next and redo too): kept for the lessons. Tab commands above are not talk.
    if (text) addChat(run, { id: newId('msg'), kind: 'you', text: text.slice(0, 4000), at: new Date().toISOString() });
    // Claude has a turn now (until the Stop hook): nothing may restart it meanwhile (startAppWaiters, orch next).
    run.turnAt = new Date().toISOString();
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
      run.explainFor = null;
      const cur = run.steps.find((b) => b.status === 'running' || b.status === 'failed');
      // Wrap up said "not yet": next runs it again (it is the last step; skipping it would end the run unwrapped).
      if (cur?.skill === WRAP_UP_SKILL) {
        this.startStep(run, cur);
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
      run.explainFor = null;
      const cur = run.steps.find((b) => b.status === 'running' || b.status === 'failed');
      if (cur) {
        await this.finishStep(run, cur, { ok: true, text: cur.lastReply || '', note: 'skipped by you' });
        this.log(run, `step ${cur.id} skipped by you`);
      }
      return this.moveOn(run, cur, context);
    }

    if (cmd === 'redo') {
      const step = run.steps.find((b) => b.status === 'running' || b.status === 'failed') || [...run.steps].reverse().find((b) => b.status === 'done');
      if (!step) return context('There is no step to run again yet. Tell the user to type next to start the first step.');
      const problem = await this.trackingProblem(run, step);
      if (problem) return context(`${problem}. Tell the user this.`);
      if (step.app && this.appHolder && this.appHolder !== run.id) return context(`The app is in use by ${this.holderName()}. Tell the user to type redo again when it is free.`);
      run.explainFor = null;
      run.waitingAfter = null;
      this.startStep(run, step);
      if (this.wantsRestart(run, step)) {
        await this.restartFor(run, step, `The user wants to run this step again. ${instruction(run, step)}`);
        return this.restartBlock(run, step);
      }
      run.status = 'running';
      await saveRun(run);
      this.emitRun(run);
      return context(`The user wants to run this step again. ${instruction(run, step)}`);
    }

    if (run.status === 'needs-you') {
      run.status = 'running';
      run.note = null;
    }
    await saveRun(run);
    this.emitRun(run);
    return ask ? context('') : {};
  }

  // `next` (nothing unfinished) or `skip`: start the step after, past any gate, and tell Claude what happened.
  async moveOn(run, from, context) {
    run.waitingAfter = null;
    const r = await this.advance(run, from, { force: true });
    if (r.restart) return this.restartBlock(run, run.steps.find((b) => b.id === run.restart.stepId));
    if (r.output?.reason) return context(r.output.reason);
    if (run.status === 'done') return context('All steps of this Orchestra run are done. Tell the user the run is finished, in one short line.');
    return context(`Orchestra could not start the next step: ${run.note || run.error || 'unknown reason'}. Tell the user this in one short line.`);
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
      const reply = readReplies(run)[n - 1];
      if (!reply) return say(n === 1 ? 'Orchestra: there is no answer from Claude to pin yet.' : `Orchestra: Claude has no answer ${n} back to pin (it keeps the last ${MAX_REPLIES}).`);
      pin = { text: reply, from: 'answer' };
    }
    const added = pushPin(run, pin);
    if (!added) return say('Orchestra: nothing to pin.');
    await saveRun(run);
    this.log(run, `pinned: ${added.title}`);
    return say(`Orchestra pinned "${added.title}" to the side pane (${run.pins.length} pin${run.pins.length > 1 ? 's' : ''}). Click the pane, then use the arrow keys or the mouse wheel to scroll.`);
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

  // `/orch model …` typed in the run's tab: `/orch model` shows the step's model and effort (and applies a
  // change made with `orch model`); `/orch model opus`, `… model opus ultracode`, `… model sonnet effort high`,
  // `/orch effort max` change them. A working step restarts claude at once on the same conversation and goes on
  // where it was (no redo). The hook sees the line before the skill loads, so it never reaches Claude (no cost).
  // text: the words after /orch ("model opus effort=high", "effort max"). A word that is not a model or effort is
  // answered with the closest one; it never reaches Claude.
  async onModelWord(run, text) {
    const m = /^(model|effort)(?:\s+(.+))?$/i.exec(text);
    if (!m) return null;
    const say = (reason) => ({ output: { decision: 'block', reason } });
    const { model, effort, unknown } = parseModelWords((m[2] || '').split(/[\s,]+/));
    if (unknown.length) return say(`Orchestra: ${modelTypo(unknown)}`);
    if (m[1].toLowerCase() === 'effort' && model !== undefined) return say(`Orchestra: effort takes low|medium|high|xhigh|max|ultracode. For a model: /orch model ${MODEL_HELP}`);
    const step = stepNow(run);
    if (!step) return say('Orchestra: this run has no step left to change.');
    const before = modelText(step);
    if (model !== undefined) step.model = model;
    if (effort !== undefined) step.effort = effort;
    const after = modelText(step) || `${run.model || 'the default model'}${run.effort ? `, effort ${run.effort}` : ''}`;
    if (before !== modelText(step)) this.log(run, `step ${step.id} set to ${after} by you (in the tab)`);
    const cost = step.effort === 'ultracode' ? ' Ultracode starts many helper agents: deep, but it costs a lot.' : '';
    if (step.status !== 'running' || !this.wantsRestart(run, { ...step, fresh: false })) {
      await saveRun(run);
      this.emitRun(run);
      const how = `Change it: /orch model ${MODEL_HELP}.`;
      if (step.status === 'running') return say(`Orchestra: "${step.label}" already runs with ${after}. ${how}`);
      const when = step.status === 'failed' ? 'Type redo to run it again with it.' : 'It starts with it when you type next.';
      return say(`Orchestra: "${step.label}" (${step.status === 'failed' ? 'failed' : 'the next step'}) will run with ${after}. ${when}${cost}`);
    }
    // Same conversation, never a fresh one (that is for a step's start), and the step goes on: no redo.
    run.restart = { stepId: step.id, model: step.model || run.model || null, effort: step.effort || run.effort || null, fresh: false, at: new Date().toISOString() };
    run.launchPrompt = `Orchestra restarted you with ${after}, because the user asked for it. It is the same conversation: go on with `
      + `the step "${step.label}" from where you were. Do not start the step again. If you were waiting for the user, say in one line `
      + `that you now run with ${after}, and wait for them.`;
    run.status = 'running';
    run.note = null;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `restarting claude with ${after} for step ${step.id} (asked in the tab)`);
    return say(`Orchestra restarts this tab with ${after} for "${step.label}". Same conversation: it goes on where it was in a few seconds.${cost}`);
  }

  // The model and effort of the step the run is on (`orch model`, or `/orch model …` typed in the run's tab).
  // The step is the one working (or failed); before a step starts, the next one. Only this run changes, not its
  // template. Returns the step and whether the claude running now must restart to use it (`live`): the restart
  // itself happens from the tab (`/orch model` typed there), never from outside, because it would cut claude off mid-work.
  async setStepModel(id, { model, effort } = {}) {
    const run = this.mustGet(id);
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up');
    const step = stepNow(run);
    if (!step) throw httpError(409, 'this run has no step left');
    const errors = validateTemplate({ id: 'x', name: 'x', steps: [{ id: 'x', skill: 'x', model: model || null, effort: effort || null }] });
    if (errors.length) throw httpError(400, errors.join('; ').replace(/step 0: /g, ''));
    if (model !== undefined) step.model = model || null;
    if (effort !== undefined) step.effort = effort || null;
    await saveRun(run);
    this.emitRun(run);
    if (model !== undefined || effort !== undefined) this.log(run, `step ${step.id} set to ${modelText(step) || 'the one before'} by you`);
    return { run, step, live: step.status === 'running' && this.wantsRestart(run, { ...step, fresh: false }) };
  }

  // Go to any step of the run, back or forward, on the template's own steps (no copies).
  // - Back (the step is at or before where the run is): it and every step after it run again in order. What each did
  //   before is kept in its tries (notes, the cost and time add up); the step is told why, and what the later ones found.
  // - Forward: the steps between where the run is and the step are skipped (the one working now too); the step is told
  //   which were skipped and why. They are passed over, and go can return to them later.
  // Returns { run, target, back, reset, skipped } or throws. Starting the step is the caller's job.
  goTo(run, ref, why) {
    if (run.cleanedAt) throw httpError(409, 'this run was cleaned up (its worktrees are gone)');
    if (run.status === 'draft' || run.status === 'queued') throw httpError(409, 'this run has not started yet');
    const target = findStep(run, ref);
    if (!target) throw httpError(400, `no step "${ref}". ${stepList(run)}`);
    why = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 1500) || null;
    const t = run.steps.indexOf(target);
    // Where the run is: the step working (or failed), else the first not passed, else the end.
    const live = run.steps.find((s) => s.status === 'running' || s.status === 'failed');
    const at = live ? run.steps.indexOf(live) : (() => { const i = run.steps.findIndex((s) => !PASSED.has(s.status)); return i < 0 ? run.steps.length : i; })();
    const now = new Date().toISOString();
    const back = t <= at || PASSED.has(target.status);
    const reset = [];
    const skipped = [];
    if (back) {
      const later = run.steps.slice(t + 1).filter((s) => s.status === 'done');
      for (const s of run.steps.slice(t)) {
        if (s.status === 'pending') continue;
        (s.tries ||= []).push({ attempt: s.attempts || 0, status: s.status, summary: s.summary || '', didWhy: s.didWhy || null, note: s.note || null, error: s.error || null, cost: s.cost || 0, durationMs: s.durationMs || 0, endedAt: s.endedAt || now });
        Object.assign(s, { status: 'pending', summary: '', didWhy: null, note: null, error: null, lastReply: undefined, skippedFor: undefined });
        reset.push(s);
      }
      target.why = why;
      target.after = later.map((s) => s.id);
      delete target.jumpedOver;
    } else {
      for (const s of run.steps.slice(at, t)) {
        if (PASSED.has(s.status)) continue;
        Object.assign(s, { status: 'skipped', endedAt: now, error: null, note: `Skipped: you went to "${target.label}"${why ? ` (${why})` : ''}.` });
        skipped.push(s);
      }
      target.why = why;
      target.jumpedOver = skipped.map((s) => s.label);
      delete target.after;
    }
    if (run.currentStep && !run.steps.some((s) => s.id === run.currentStep && s.status === 'running')) run.currentStep = null;
    for (const k of ['waitingAfter', 'explainFor', 'finishedAt', 'appNext', 'turnAt']) delete run[k];
    run.cleanWhenClosed = false;
    run.error = null;
    run.status = 'waiting';
    run.note = `Went to "${target.label}". Type next in its tab to start it.`;
    this.log(run, `went ${back ? 'back' : 'forward'} to ${target.id}${reset.length > 1 ? `: ${reset.length} steps run again` : ''}${skipped.length ? `: skipped ${skipped.map((s) => s.id).join(', ')}` : ''}${why ? ` (why: ${why})` : ''}`);
    return { run, target, back, reset, skipped };
  }

  // `orch go <run> <step> [why]` (also back, jump): moves the run there; the step starts when the user types next in its
  // tab (or at once, through wordFromOutside, when the tab is open and Claude is idle). text: "<step> [why]".
  async go(id, text) {
    const run = this.mustGet(id);
    if (run.status === 'running' && sessionOpen(run)) throw httpError(409, 'it is working now: type "/orch go <step>" in its tab');
    const { ref, why } = splitStepRef(run, text);
    const out = this.goTo(run, ref, why);
    await saveRun(run);
    this.emitRun(run);
    return out;
  }

  // `/orch go <step> [why]` (also back, jump, from, "go back to", "go to") typed in the run's tab: moves the run and
  // starts the step at once. Claude restarts on the same conversation (a "new conversation" step starts a new one),
  // because a blocked prompt gives Claude no turn to start it in. Never reaches Claude or the skill (no cost).
  async onGoWord(run, text) {
    const m = /^(?:go\s+back\s+to|go\s+to|back\s+to|jump\s+to|go|back|jump|from)\s+(.+)$/i.exec(text);
    if (!m) return null;
    const say = (reason) => ({ output: { decision: 'block', reason } });
    const { ref, why } = splitStepRef(run, m[1]);
    let out;
    try {
      out = this.goTo(run, ref, why);
    } catch (err) {
      await saveRun(run);
      return say(`Orchestra: ${err.message}`);
    }
    const { target } = out;
    const what = out.back
      ? `went back to "${target.label}"${out.reset.length > 1 ? ` (it and the ${out.reset.length - 1} step${out.reset.length > 2 ? 's' : ''} after it run again)` : ''}`
      : `went to "${target.label}"${out.skipped.length ? ` (skipped: ${out.skipped.map((s) => s.label).join(', ')})` : ''}`;
    if (target.app && this.appHolder && this.appHolder !== run.id) {
      run.appNext = { step: target.id, at: new Date().toISOString() };
      run.note = `Waiting for the app: ${this.holderName()} has it. "${target.label}" starts by itself when the app is free.`;
      await saveRun(run);
      this.emitRun(run);
      return say(`Orchestra ${what}. "${target.label}" needs the app, and ${this.holderName()} has it: it starts by itself when the app is free.`);
    }
    this.startStep(run, target);
    await this.restartFor(run, target, instruction(run, target));
    return say(`Orchestra ${what}. It starts ${target.fresh ? 'in a new conversation' : 'on this conversation'} in a few seconds.`);
  }

  // `/orch help` in a run's tab: a short list that fits where the run is (free: it never reaches Claude).
  tabHelp(run) {
    const cur = run.steps.find((s) => s.status === 'running' || s.status === 'failed');
    const next = run.steps.find((s) => s.status === 'pending');
    const lines = ['Orchestra, in this tab:'];
    if (cur?.status === 'failed') lines.push(`  redo   run "${cur.label}" again`, '  skip   go on without it');
    else if (cur) lines.push(`  next   go on with "${cur.label}" (if it was cut off or asked you something)`, `  skip   mark "${cur.label}" done and go on`, '  redo   start it again');
    else if (next) lines.push(`  next   start "${next.label}"`, `  skip   skip "${next.label}"`);
    lines.push('  /orch go <step> [why]            go to any step: back (it and the steps after run again) or forward (skips the ones between)', '  /orch model opus effort=high     the model and effort of this step', "  pin · pin 2 · pin: note · unpin  keep text in the pane", '  /orch steps · /orch runs · /orch run · /orch app', 'Anything else goes to Claude as usual.');
    return lines.join('\n');
  }

  // A read-only orch command typed in a run's tab (/orch runs): its text, shown without reaching Claude.
  async tabShow(word, words) {
    const { commands } = await import('../cli/commands.mjs'); // here, not at the top: commands import the runner
    const { parse } = await import('../cli/spec.mjs');
    try {
      const { pos, opt } = parse([word, ...words]);
      const out = await commands[word](this, { pos, opt });
      const text = String(out.text || '');
      return `Orchestra:\n${text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text}`;
    } catch (err) {
      return `Orchestra: ${err.message}`;
    }
  }

  // `orch next|skip|redo <run>` from outside the tab: what typing it there does. Claude then needs a turn, so its
  // claude restarts on the same conversation with what it is told. Only while it is idle: never mid-work, never at
  // an Allow prompt (that would cut it off).
  async wordFromOutside(id, word) {
    const run = this.mustGet(id);
    if (!sessionOpen(run)) throw httpError(409, `its tab is closed: reopen it (orch reopen ${run.id.slice(-6)}), then type ${word} there`);
    if (run.status === 'running' || run.restart || midTurn(run)) throw httpError(409, `it is working now: type ${word} in its tab when it stops`);
    if (run.status === 'needs-you' && run.needsYouWhy === 'allow') throw httpError(409, 'it waits for your Allow in its tab: answer it there first');
    const out = await this.onPrompt(run, { prompt: word });
    if (run.restart) return `${word}: its claude restarts on the same conversation in a few seconds.`;
    const reason = out?.output?.reason;
    if (reason) return reason.replace(/^Orchestra:?\s*/, '');
    const told = out?.output?.hookSpecificOutput?.additionalContext;
    if (!told) return `${word}: nothing to do.`;
    run.restart = { stepId: run.currentStep || null, model: run.model || null, effort: run.effort || null, fresh: false, at: new Date().toISOString() };
    run.launchPrompt = `The user typed ${word} (from outside this tab). ${told}`;
    await saveRun(run);
    this.emitRun(run);
    this.log(run, `${word} from outside the tab: restarting its claude on the same conversation`);
    return `${word}: done. Its claude restarts on the same conversation in a few seconds and goes on.`;
  }
}
