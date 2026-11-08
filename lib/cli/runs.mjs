// orch commands for runs: the board, one run, start, reopen, stop, clean, pins, model, back.
import { gb } from '../runner.mjs';
import { parseModelWords, MODEL_HELP } from '../model.mjs';
import { size as workspaceSize } from '../workspace.mjs';
import { tabTitle, ticketKey } from '../terminal.mjs';
import { fail } from './args.mjs';
import { table, ago, unmark, board, statusLine, appLine, serving, runDetail, modelTag, brokenText } from '../format.mjs';
import { findRun, findTemplate } from './find.mjs';

export const runCommands = {
  async status(r) {
    const runs = r.list();
    const clean = { stale: r.staleRuns(), finished: r.finishedUncleaned() };
    return { json: { settings: r.getSettings(), runs, clean: { stale: clean.stale.map((x) => x.id), finished: clean.finished.map((x) => x.id) } }, text: statusLine(runs, r.getSettings(), r.appState(), clean) + brokenText() };
  },

  async runs(r, { opt }) {
    const runs = r.list();
    return { json: runs, text: board(runs, !!opt.all, r.appState()) + brokenText() };
  },

  async run(r, { pos }) {
    const run = findRun(r, pos[0]);
    return { json: run, text: runDetail(run, await r.timeline(run.id, 60), r.appState()) };
  },

  async timeline(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const list = await r.timeline(run.id, Number(opt.limit) || 400);
    return { json: list, text: list.map((e) => `${e.at.slice(0, 16).replace('T', ' ')} ${e.kind === 'log' ? '' : `[${e.kind}] `}${unmark(e.text)}`).join('\n') || '(nothing yet)' };
  },

  async start(r, { pos, opt }) {
    const [tplRef, ...inputs] = pos;
    const template = await findTemplate(tplRef);
    let repos;
    if (opt.repos === 'none') repos = [];
    else if (typeof opt.repos === 'string') repos = opt.repos.split(',').map((token) => ({ token: token.trim() })).filter((x) => x.token);
    if (typeof opt.base === 'string') {
      repos ??= (template.repos || []).map((token) => ({ token }));
      for (const pair of opt.base.split(',')) {
        const [token, base] = pair.split('=');
        const repo = repos.find((x) => x.token === token);
        if (!repo || !base) fail(`--base must be repo=branch for a repo of this run (got "${pair}")`);
        repo.base = base;
      }
    }
    const start = !opt.draft;
    let runs;
    if (typeof opt.text === 'string') runs = [await r.createRun({ templateId: template.id, input: { text: opt.text }, start, repos })];
    else if (inputs.length === 1) runs = [await r.createRun({ templateId: template.id, input: { text: inputs[0] }, start, repos })];
    else if (inputs.length) runs = await r.createRuns({ templateId: template.id, inputs, start, repos });
    else fail('give at least one ticket (or --text "the job")');
    const max = r.getSettings().maxRunning;
    const text = [
      `${start ? 'Started' : 'Made as draft'}: ${runs.length} run${runs.length > 1 ? 's' : ''} of "${template.name}" (${template.steps.length} steps).`,
      ...runs.map((x) => `  ${tabTitle(x)} · ${x.id}`),
      start ? `Each opens its own tab in the "orchestra" Windows Terminal window. ${max} work at once; the rest wait in the queue and start by themselves.` : 'Change the steps with: steps <run> --set …, then: reopen <run> to start.',
    ].join('\n');
    return { json: runs.length === 1 && inputs.length <= 1 ? runs[0] : runs, text };
  },

  async reopen(r, { pos }) {
    if (pos[0] === 'all') {
      const list = r.list().filter((x) => x.status === 'stopped' && x.sessionId && !x.cleanedAt && !x.session?.open);
      const done = [];
      for (const run of list) done.push(await r.resume(run.id));
      return { json: done, text: done.length ? `Reopening ${done.length} run${done.length > 1 ? 's' : ''}: ${done.map(tabTitle).join(', ')}. Each tab opens on its own conversation; type next there to go on.` : 'No stopped runs to reopen.' };
    }
    const run = findRun(r, pos[0]);
    const was = run.status;
    const out = await r.resume(run.id);
    return { json: out, text: was === 'draft' ? `${tabTitle(out)} started.` : `${tabTitle(out)} is ${out.status === 'running' ? 'starting' : out.status}. Its tab opens on the same conversation; type next to go on, redo to run the step again, skip to move past it.` };
  },

  async stop(r, { pos }) {
    const run = findRun(r, pos[0]);
    const out = await r.stop(run.id);
    return { json: out, text: `${tabTitle(out)} is ${out.status}.` };
  },

  // clean <run>: now. clean --done / --stale: every finished run (tab closed) / every run left alone 7+ days.
  // (Runs with a Wrap up step clean themselves when their tab closes, if you said so in that step.)
  async clean(r, { pos, opt }) {
    let list;
    if (opt.done) list = r.finishedUncleaned();
    else if (opt.stale) list = r.staleRuns();
    else list = [findRun(r, pos[0])];
    if (!list.length) return { json: [], text: 'Nothing to clean up.' };
    const results = [];
    for (const run of list) {
      try {
        const out = await r.cleanUp(run.id, { force: !!opt.force, auto: !!opt.auto, merged: !!opt.merged });
        results.push({ id: run.id, title: tabTitle(run), cleaned: !!out.cleanedAt, freed: out.freed || 0, kept: !!out.cleanupKept });
      } catch (err) {
        if (list.length === 1) throw err;
        results.push({ id: run.id, title: tabTitle(run), error: err.message });
      }
    }
    const line = (x) => (x.error ? `${x.title}: not cleaned: ${x.error}` : x.kept ? `${x.title}: kept (uncommitted work)` : x.cleaned ? `${x.title}: cleaned · ${gb(x.freed)} freed` : `${x.title}: nothing to clean up`);
    const total = results.reduce((s, x) => s + (x.freed || 0), 0);
    const text = [...results.map(line), results.length > 1 ? `Freed ${gb(total)} in all.` : '', 'Branches, notes and stats stay.'].filter(Boolean).join('\n');
    return { json: list.length === 1 && !opt.done && !opt.stale ? r.get(list[0].id) : results, text };
  },

  // The space each run folder takes (links not followed), and the total.
  async disk(r) {
    const list = r.list().filter((x) => x.workspace?.ready && !x.cleanedAt);
    const sizes = await r.outside(() => Promise.all(list.map(async (x) => ({ id: x.id, title: tabTitle(x), status: x.status, folder: x.workspace.dir, bytes: await workspaceSize(x.workspace.dir) }))));
    const total = sizes.reduce((s, x) => s + x.bytes, 0);
    const text = sizes.length
      ? `${table(sizes, [['Run', (x) => x.title], ['Status', (x) => x.status], ['Folder', (x) => x.folder], ['Size', (x) => gb(x.bytes)]])}\nTotal: ${gb(total)}. Clean one: clean <run> · all finished: clean --done`
      : 'No run folders.';
    return { json: { runs: sizes, total }, text };
  },

  async delete(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const out = await r.deleteRun(run.id, { force: !!opt.force });
    return { json: out, text: `${tabTitle(run)} deleted (its branches stay).` };
  },

  async pin(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const text = pos.slice(1).join(' ');
    if (!text) {
      const pins = (run.pins || []).slice().reverse();
      const body = pins.map((p, i) => [`── ${i + 1}. ${p.title} (${p.from === 'claude' ? 'pinned by Claude' : p.from === 'answer' ? "Claude's answer, pinned by you" : 'your note'}, ${ago(p.at)}) ──`, p.text, ''].join('\n'));
      return { json: { pins }, text: pins.length ? body.join('\n').trimEnd() : "(no pins: type pin in the run's tab to keep Claude's last answer in its pane)" };
    }
    const out = await r.addPin(run.id, { text, title: typeof opt.title === 'string' ? opt.title : '', from: 'you' });
    return { json: { pins: out.pins }, text: `${tabTitle(out)}: pinned "${out.pins.at(-1).title}" (${out.pins.length} pin${out.pins.length > 1 ? 's' : ''}).` };
  },

  async unpin(r, { pos }) {
    const run = findRun(r, pos[0]);
    const which = pos[1];
    if (which !== undefined && which !== 'all' && !/^\d+$/.test(which)) fail('unpin takes a pin number (1 = newest) or all');
    const { run: out, removed } = await r.removePin(run.id, which);
    return { json: { pins: out.pins, removed }, text: `${tabTitle(out)}: unpinned ${removed.map((p) => `"${p.title}"`).join(', ')} (${out.pins.length} left).` };
  },

  // The model and effort of the step the run is on. Changes only this run. A step that works now switches when
  // the user types `/orchestra model` in the run's tab (a restart from here could cut claude off mid-work).
  async model(r, { pos }) {
    const run = findRun(r, pos[0]);
    const { model, effort, unknown } = parseModelWords(pos.slice(1));
    if (unknown.length) fail(`not a model or effort: ${unknown.join(' ')}. Use: model <run> ${MODEL_HELP} (none clears)`);
    const { run: out, step, live } = await r.setStepModel(run.id, { model, effort });
    const now = modelTag(step) || 'the one before (none set)';
    const lines = [`${tabTitle(out)}: step "${step.label}" (${step.status === 'running' ? 'working now' : step.status === 'failed' ? 'failed' : 'next'}) runs with ${now}.`];
    if (live) lines.push(`Type "/orchestra model" in its tab to switch now: claude restarts on the same conversation and goes on where it was.`);
    else if (step.status === 'pending') lines.push('It starts with it when you type next in its tab.');
    if (step.effort === 'ultracode') lines.push('Ultracode starts many helper agents: deep, but it costs a lot.');
    lines.push('Only this run changed; the template stays (orch template step … model=… effort=…).');
    return { json: { step, live }, text: lines.join('\n') };
  },

  // Go back to a finished step: copies of it and the steps after it are added, and run next (in the tab).
  async back(r, { pos }) {
    const run = findRun(r, pos[0]);
    if (pos.length < 2) fail(`name the step to go back to (its number, or words from its name). ${run.steps.map((b, i) => (b.status === 'done' ? `${i + 1}. ${b.label}` : null)).filter(Boolean).join(' · ')}`);
    const { run: out, copies, reset } = await r.goBack(run.id, pos.slice(1).join(' '));
    const lines = [
      `${tabTitle(out)}: went back. New steps: ${copies.map((b) => b.label).join(' > ')}.${reset ? ` "${reset.label}" runs again after them.` : ''}`,
      copies[0].why ? `"${copies[0].label}" is told why: ${copies[0].why}` : `"${copies[0].label}" is told what the steps after it did; it asks you why if that is not clear.`,
      out.session?.open ? `Type next in its tab to start "${copies[0].label}".` : `Its tab is closed: orch reopen ${ticketKey(out) || out.id}, then type next there.`,
      'Quicker: in its tab, "/orchestra back build fix the review findings" goes back and starts at once.',
    ];
    return { json: { copies, reset }, text: [runDetail(out, []), '', ...lines].join('\n') };
  },

  async about(r, { pos }) {
    const run = findRun(r, pos[0]);
    if (pos.length < 2) return { json: { about: run.about || null }, text: run.about || '(not known yet: the run says it once it reads the ticket)' };
    const out = await r.setAbout(run.id, pos.slice(1).join(' '));
    return { json: out, text: `${tabTitle(out)}: ${out.about || '(cleared)'}` };
  },

  // Who has the app, who waits for it, and whose code it serves. `app release <run>` takes it from a run.
  async app(r, { pos }) {
    if (pos[0] === 'release') {
      const run = findRun(r, pos[1]);
      const out = await r.appRelease(run.id);
      return { json: out, text: `${tabTitle(run)} let go of the app.\n${appLine(out)}` };
    }
    if (pos[0]) fail('app [start|stop|restart|wait|logs|release [<run>]]');
    const app = r.appState();
    const s = serving();
    const whose = s?.runId === 'you' ? 'your checkout' : `${s?.title}'s code`;
    const text = [
      appLine(app),
      s ? `Serving: ${whose} from ${s.workspace}${s.branches ? ` (${s.branches})` : ''}, since ${ago(s.startedAt)}` : 'Serving: not started by Orchestra',
      'Runs take the app in their "Test in the app" step. You: orch app start (your own checkout) · orch app stop',
    ].join('\n');
    return { json: { ...app, serving: s }, text };
  },

  async steps(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    if (typeof opt.set !== 'string') fail('give the new steps with --set \'[{"id":…,"skill":…}]\'');
    let list;
    try {
      list = JSON.parse(opt.set);
    } catch {
      fail('--set must be a JSON list');
    }
    const out = await r.updateSteps(run.id, list);
    return { json: out, text: runDetail(out, []) };
  },

  // Starts queued runs (after the main work). tick <id>: this process is that run's starter (see schedule).
  async tick(r, { pos }) {
    const run = pos[0] ? r.get(pos[0]) : null;
    if (run && run.status === 'running' && run.starting?.pid === process.pid) await r.openRun(run);
    return { json: { ok: true }, text: 'ok' };
  },
};
