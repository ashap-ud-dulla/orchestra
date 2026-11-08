// orch commands for lessons: look for them, accept or reject them, apply a workflow change, your rules.
import { listSuggestions, decide, markApplied, cleanChange, getInstructions, saveInstructions } from '../learn.mjs';
import { tabTitle } from '../terminal.mjs';
import { fail } from './args.mjs';
import { findRun, findTemplate } from './find.mjs';
import { templateCommands } from './templates.mjs';

export const lessonCommands = {
  async lessons(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const out = await r.learn(run.id, { auto: !!opt.auto });
    return { json: out, text: `${tabTitle(out)}: ${out.learn?.status === 'done' ? `${out.learn.count} lesson${out.learn.count === 1 ? '' : 's'} suggested. See: suggestions` : out.learn?.error || 'nothing to learn from'}` };
  },

  async learn(r, args) {
    return lessonCommands.lessons(r, args); // the name hooks use
  },

  async suggestions(r, { opt }) {
    const all = await listSuggestions();
    const list = opt.all ? all : all.filter((s) => s.status === 'new');
    const line = (s) => `[${s.id}] ${s.kind === 'rule' ? 'Rule' : 'Workflow'}: ${s.text}\n    why: ${s.why || ''}${s.templateName ? `  (from ${s.templateName}: ${s.input || ''})` : ''}${opt.all ? `  · ${s.status}${s.appliedAt ? `, applied to ${s.appliedTo}` : ''}` : ''}`
      + (s.kind === 'workflow' && !s.appliedAt && s.status !== 'rejected' ? `\n    change: ${s.change ? changeCommand(s.change, s.templateId) : '(none saved; give it with --change)'}` : '');
    // Accepted workflow changes that never reached their template: listed until they do.
    const owed = opt.all ? [] : notApplied(all);
    const text = [list.length ? list.map(line).join('\n') : 'No lessons waiting.'];
    if (owed.length) text.push('', 'Accepted, not in the template yet (apply: suggestion <id> apply):', ...owed.map(line));
    return { json: list, text: text.join('\n') };
  },

  // accept | reject | apply. A workflow change reaches its template only with --apply (or apply later).
  async suggestion(r, { pos, opt }) {
    const [id, action] = pos;
    if (action === 'apply') {
      let s = (await listSuggestions()).find((x) => x.id === id) || fail('suggestion not found', 404);
      if (s.kind !== 'workflow') fail('only a workflow change can be applied; a rule works once accepted');
      if (s.status === 'rejected') fail('this suggestion was rejected', 409);
      if (s.status === 'new') s = await decide(id, { action: 'accept', text: typeof opt.text === 'string' ? opt.text : undefined });
      return applySuggestion(r, s, opt);
    }
    const s = await decide(id, { action, text: typeof opt.text === 'string' ? opt.text : undefined });
    if (s.kind === 'workflow' && s.status === 'accepted') {
      if (opt.apply) return applySuggestion(r, s, opt);
      const how = s.change ? `The change: ${changeCommand(s.change, s.templateId)}\nApply it: suggestion ${s.id} apply` : `No exact change was saved. Apply it with: suggestion ${s.id} apply --change '{"op":"step","step":"<step>","wait":"on"}'`;
      return { json: s, text: `accepted: ${s.text}\nNot in the template yet. ${how}` };
    }
    return { json: s, text: `${s.status}: ${s.text}${s.status === 'accepted' && s.kind === 'rule' ? ' (added to your rules)' : ''}` };
  },

  async rules(r, { opt }) {
    if (typeof opt.set === 'string') await saveInstructions(opt.set);
    if (typeof opt.add === 'string') {
      const now = await getInstructions();
      await saveInstructions(`${now.replace(/\s*$/, '')}${now.trim() ? '\n' : ''}- ${opt.add.trim()}\n`);
    }
    const text = await getInstructions();
    return { json: { text }, text: text.trim() || '(no rules yet)' };
  },
};

// ---------- lessons that change a template ----------

// A workflow suggestion's change, as the template command that makes it.
export function changeArgs(c, templateId) {
  const q = (v) => (/\s|"/.test(v) ? JSON.stringify(v) : v);
  switch (c.op) {
    case 'step': {
      const set = ['wait', 'app', 'explain', 'fresh', 'model', 'effort', 'args', 'label'].filter((k) => c[k] !== undefined).map((k) => `${k}=${c[k]}`);
      return { pos: ['step', templateId, c.step, ...set], shown: ['step', templateId, c.step, ...set.map((w) => w.replace(/=(.*)/s, (m, v) => `=${q(v)}`))] };
    }
    case 'add': {
      const opt = { at: c.at, label: c.label, args: c.args, wait: c.wait };
      for (const k of Object.keys(opt)) if (opt[k] === undefined) delete opt[k];
      const flags = Object.entries(opt).map(([k, v]) => (k === 'wait' ? (v === 'on' ? '--wait' : '') : `--${k} ${q(String(v))}`)).filter(Boolean);
      return { pos: ['add', templateId, c.skill], opt, shown: ['add', templateId, c.skill, ...flags] };
    }
    case 'remove':
      return { pos: ['remove', templateId, c.step], shown: ['remove', templateId, c.step] };
    case 'move':
      return { pos: ['move', templateId, c.step, String(c.to)], shown: ['move', templateId, c.step, String(c.to)] };
  }
  fail('unknown change');
}

export function changeCommand(c, templateId) {
  return `template ${changeArgs(c, templateId).shown.join(' ')}`;
}

export function notApplied(list) {
  return list.filter((s) => s.kind === 'workflow' && s.status === 'accepted' && !s.appliedAt);
}

// Makes an accepted workflow change in its template. --change '<json>' gives or corrects the change;
// --template <id> names the template when the one it came from was renamed.
export async function applySuggestion(r, s, opt) {
  let change = s.change;
  if (typeof opt.change === 'string') {
    try {
      change = cleanChange(JSON.parse(opt.change));
    } catch {
      change = null;
    }
    if (!change) fail(`that change is not one Orchestra knows. Example: --change '{"op":"step","step":"plan","args":"show the full plan"}'`);
  }
  if (!change) fail(`no exact change was saved for this lesson. Give it: suggestion ${s.id} apply --change '{"op":"step","step":"<step>","wait":"on"}'`);
  const want = typeof opt.template === 'string' ? opt.template : s.templateId;
  let t;
  try {
    t = await findTemplate(want);
  } catch (err) {
    if (err.status === 404) fail(`template ${want} is not there any more (renamed?). Name it: suggestion ${s.id} apply --template <id>`, 404);
    throw err;
  }
  const { pos, opt: o = {} } = changeArgs(change, t.id);
  const res = await templateCommands.template(r, { pos, opt: o });
  await markApplied(s.id, { change, templateId: t.id });
  return { json: { ...s, change, appliedTo: t.id }, text: `accepted and applied: ${s.text}\n${res.text}` };
}
