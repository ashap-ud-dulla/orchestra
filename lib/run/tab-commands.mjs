// What you type in a run tab: next, skip, redo, pin, /orchestra model, /orchestra back.
// Its methods become Runner's own (lib/runner.mjs); `this` is the Runner.
import { DONE_MARK, ABOUT_RULE } from '../guard.mjs';
import { newId, saveRun, validateTemplate, WRAP_UP_SKILL } from '../store.mjs';
import { parseModelWords, modelText, MODEL_HELP } from '../model.mjs';
import { MAX_REPLIES } from '../limits.mjs';
import { httpError } from '../util.mjs';
import { newBox, findDone, doneList, splitStepRef, currentStep, sessionOpen } from './steps.mjs';
import { instruction } from './prompts.mjs';
import { pushPin, dropPin } from './pins.mjs';

export class TabCommandsPart {
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

  // `next` (nothing unfinished) or `skip`: start the step after, past any gate, and tell Claude what happened.
  async moveOn(run, from, context) {
    run.waitingAfter = null;
    const r = await this.advance(run, from, { force: true, appWaitMs: 0 });
    if (r.restart) return this.restartBlock(run, run.boxes.find((b) => b.id === run.restart.boxId));
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

  // `/orchestra model …` typed in the run's tab: `/orchestra model` shows the step's model and effort (and applies a
  // change made with `orch model`); `/orchestra model opus`, `… model opus ultracode`, `… model sonnet effort high`,
  // `/orchestra effort max` change them. A working step restarts claude at once on the same conversation and goes on
  // where it was (no redo). The hook sees the line before the skill loads, so it never reaches Claude (no cost).
  // Words that are not a model or effort (a ticket key, say): the /orchestra skill gets the line as usual.
  async onModelWord(run, text) {
    const m = /^\/orchestra\s+(model|effort)(?:\s+(.+))?$/i.exec(text);
    if (!m) return null;
    const { model, effort, unknown } = parseModelWords((m[2] || '').split(/[\s,]+/));
    if (unknown.length || (m[1].toLowerCase() === 'effort' && model !== undefined)) return null;
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
      const how = `Change it: /orchestra model ${MODEL_HELP}.`;
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
}
