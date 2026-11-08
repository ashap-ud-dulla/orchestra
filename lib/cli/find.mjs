// Finding a run or a template from what you typed; saving a template; step options.
import { listTemplates, getTemplate, saveTemplate, validateTemplate, isSafeId } from '../store.mjs';
import { applyModelOptions } from '../model.mjs';
import { scanSkills, missingSkills } from '../skills-scan.mjs';
import { offProblems, OFF_HELP } from '../tracking.mjs';
import { tabTitle, ticketKey, KEY_RE } from '../terminal.mjs';
import { fail, onOff } from './args.mjs';

// ---------- finding things ----------

// A run by id, end of id, or Jira key (the newest run with that key).
// Order: the exact id; a Jira key (the newest run of that ticket); the end of an id; else words from the run's name,
// About line or text, when they fit exactly one run.
export function findRun(runner, ref) {
  if (!ref) fail('name a run: a Jira key, words from its name, or the end of its id');
  const runs = runner.list();
  // this: the run whose tab runs this command (its token must match, so only its own Claude can say it).
  if (ref === 'this') {
    const run = runs.find((r) => r.id === process.env.ORCHESTRA_RUN_ID);
    if (!run || !process.env.ORCHESTRA_HOOK_TOKEN || process.env.ORCHESTRA_HOOK_TOKEN !== run.hookToken) fail('"this" works only inside a run\'s tab (it means that run)');
    return run;
  }
  const exact = runs.find((r) => r.id === ref);
  if (exact) return exact;
  const key = String(ref).toUpperCase();
  if (KEY_RE.test(key)) {
    const byKey = runs.filter((r) => ticketKey(r) === key);
    if (byKey.length) return byKey[0];
    fail(`no run for ticket ${key}`, 404); // a key never matches a free text that only mentions it
  }
  const byEnd = runs.filter((r) => r.id.endsWith(ref));
  if (byEnd.length === 1) return byEnd[0];
  if (byEnd.length > 1) fail(`"${ref}" matches ${byEnd.length} runs; give more of the id`);
  const words = String(ref).toLowerCase().split(/\s+/).filter(Boolean);
  const byWords = runs.filter((r) => {
    const text = `${tabTitle(r)} ${r.about || ''} ${r.input?.text || ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  if (byWords.length === 1) return byWords[0];
  if (byWords.length > 1) fail(`"${ref}" fits ${byWords.length} runs: ${byWords.map((r) => `${tabTitle(r)} (${r.id.slice(-6)})`).join(', ')}. Give more words or the id end.`, 409);
  fail(`run not found: ${ref}`, 404);
}

export async function findTemplate(ref) {
  if (!ref) fail('name a template');
  if (isSafeId(ref)) {
    const t = await getTemplate(ref);
    if (t) return t;
  }
  const all = await listTemplates();
  const low = String(ref).toLowerCase();
  const hits = all.filter((t) => t.name.toLowerCase() === low);
  if (hits.length === 1) return hits[0];
  const part = all.filter((t) => t.id.includes(low) || t.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (part.length > 1) fail(`"${ref}" matches several templates: ${part.map((t) => t.id).join(', ')}`);
  fail(`template not found: ${ref}`, 404);
}

export function slug(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 50) || 'step';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// Saves a template after the same checks the page made: valid, and no Teamspace/vault skills with tracking off.
export async function storeTemplate(t) {
  const errors = validateTemplate(t);
  if (errors.length) fail(errors.join('; '));
  const skills = await scanSkills();
  const missing = missingSkills(t.steps, skills);
  if (missing) fail(missing, 404);
  if (t.tracking === false) {
    const problems = offProblems(t.steps, skills);
    if (problems.length) fail(`${problems.join('; ')}. ${OFF_HELP.replace('on the Skills page', 'with skill-mark')}`, 409);
  }
  return saveTemplate(t);
}

export function stepOptions(step, o) {
  if (o.label !== undefined) step.label = String(o.label).slice(0, 80);
  if (o.args !== undefined) step.args = String(o.args).slice(0, 2000);
  if (o.wait !== undefined) step.wait = onOff(o.wait, 'wait');
  if (o.app !== undefined) step.app = onOff(o.app, 'app');
  if (o.explain !== undefined) step.explain = onOff(o.explain, 'explain');
  if (o.fresh !== undefined) step.fresh = onOff(o.fresh, 'fresh');
  if (o.heavy !== undefined) step.heavy = onOff(o.heavy, 'heavy');
  applyModelOptions(step, o); // the template save checks the values
  return step;
}
