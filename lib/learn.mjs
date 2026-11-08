// Learning from runs. After a run, a fresh claude (not the run's session, and with no tools that
// change anything) reads what you said at the gates, what failed and where you stopped it, then
// suggests rules and workflow changes. You accept or reject each one. Accepted rules go into
// data/instructions.md, and every later run gets them in its system prompt. A workflow change carries the exact
// template change, so accepting it can also apply it (orch suggestion <id> accept --apply).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config.mjs';
import { claudeCommand } from './claude-cmd.mjs';
import { readJson, writeJson, newId } from './store.mjs';
import { upgradeChange } from './upgrade.mjs';
import { readChat } from './run/chat.mjs';

const MAX_RULES_CHARS = 6000;
export const LEARN_TAG = 'ORCHESTRA-LEARN';

function suggestionsFile() {
  return path.join(config.dataDir, 'suggestions.json');
}
function instructionsFile() {
  return path.join(config.dataDir, 'instructions.md');
}

// ---- your rules (instructions.md) ----

export async function getInstructions() {
  try {
    return await fs.readFile(instructionsFile(), 'utf8');
  } catch {
    return '';
  }
}

// For the run rules, which are built while a turn starts.
export function readInstructionsSync() {
  try {
    return fsSync.readFileSync(instructionsFile(), 'utf8').trim().slice(0, MAX_RULES_CHARS);
  } catch {
    return '';
  }
}

export async function saveInstructions(text) {
  text = String(text ?? '');
  if (text.length > MAX_RULES_CHARS) throw Object.assign(new Error(`your rules are too long (max ${MAX_RULES_CHARS} chars)`), { status: 400 });
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(instructionsFile(), text.endsWith('\n') || !text ? text : text + '\n');
  return text;
}

// ---- suggestions ----

export async function listSuggestions() {
  try {
    const list = await readJson(suggestionsFile());
    if (!Array.isArray(list)) return [];
    for (const s of list) upgradeChange(s.change);
    return list;
  } catch {
    return [];
  }
}

// Saves of the list happen one after another, so two decisions at once cannot lose one.
let chain = Promise.resolve();
function update(fn) {
  const p = chain.then(async () => {
    const list = await listSuggestions();
    const out = await fn(list);
    await writeJson(suggestionsFile(), list);
    return out;
  });
  chain = p.catch(() => {});
  return p;
}

export function addSuggestions(run, found) {
  return update((list) => {
    const at = new Date().toISOString();
    const added = found.map((s) => ({ id: newId('sug'), runId: run.id, templateId: run.templateId, templateName: run.templateName, ...s, status: 'new', at }));
    list.push(...added);
    return added;
  });
}

// action: 'accept' (a rule goes into your rules; you may edit its text first) or 'reject'.
export function decide(id, { action, text } = {}) {
  if (!['accept', 'reject'].includes(action)) throw Object.assign(new Error('action must be accept or reject'), { status: 400 });
  return update(async (list) => {
    const s = list.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('suggestion not found'), { status: 404 });
    if (s.status !== 'new') throw Object.assign(new Error(`this suggestion was already ${s.status}`), { status: 409 });
    if (text !== undefined) {
      text = String(text).trim().replace(/\s+/g, ' ');
      if (!text || text.length > 500) throw Object.assign(new Error('the rule must be 1 to 500 chars'), { status: 400 });
      s.text = text;
    }
    s.status = action === 'accept' ? 'accepted' : 'rejected';
    s.decidedAt = new Date().toISOString();
    if (action === 'accept' && s.kind === 'rule') {
      const now = await getInstructions();
      await saveInstructions(`${now.replace(/\s*$/, '')}${now.trim() ? '\n' : ''}- ${s.text}\n`);
    }
    return s;
  });
}

// A workflow change reached its template: it is no longer only a hint.
export function markApplied(id, { change, templateId }) {
  return update((list) => {
    const s = list.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('suggestion not found'), { status: 404 });
    s.change = change;
    s.appliedTo = templateId;
    s.appliedAt = new Date().toISOString();
    return s;
  });
}

// The exact template change of a workflow suggestion, checked. Null when it is missing or not one of these:
//   {op:"step", step, wait|app|explain|fresh: "on"|"off", model, effort, args, label}   change a step
//   {op:"add", skill, at, label, args, wait}                     add a step (at = position, from 1)
//   {op:"remove", step} · {op:"move", step, to}
export function cleanChange(c) {
  if (!c || typeof c !== 'object') return null;
  const id = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const flag = (v) => (v === true || v === 'on' ? 'on' : v === false || v === 'off' ? 'off' : undefined);
  const pos = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : undefined);
  const out = { op: c.op };
  if (c.op === 'step') {
    if (!id(c.step)) return null;
    out.step = c.step;
    for (const k of ['wait', 'app', 'explain', 'fresh']) if (flag(c[k])) out[k] = flag(c[k]);
    if (str(c.args, 2000) !== undefined) out.args = str(c.args, 2000);
    if (str(c.label, 80) !== undefined) out.label = str(c.label, 80);
    // Checked again when the template is saved.
    for (const k of ['model', 'effort']) if (str(c[k], 64) !== undefined && /^[a-z][a-z0-9.\-[\]]*$/.test(str(c[k], 64))) out[k] = str(c[k], 64);
    return Object.keys(out).length > 2 ? out : null;
  }
  if (c.op === 'add') {
    if (typeof c.skill !== 'string' || !/^[\w:.-]+$/.test(c.skill)) return null;
    Object.assign(out, { skill: c.skill, at: pos(c.at), label: str(c.label, 80), args: str(c.args, 2000), wait: flag(c.wait) });
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }
  if (c.op === 'remove') return id(c.step) ? { op: 'remove', step: c.step } : null;
  if (c.op === 'move') return id(c.step) && pos(c.to) ? { op: 'move', step: c.step, to: pos(c.to) } : null;
  return null;
}

// ---- what a run teaches ----

// What you said and what went wrong in a run. Empty when there is nothing to learn from.
export function material(run) {
  const label = (id) => run.steps.find((b) => b.id === id)?.label || id;
  const lines = [];
  for (const m of readChat(run)) {
    if (m.kind === 'explain') continue;
    if (m.kind === 'answer') lines.push(`- You answered a question from "${label(m.stepId)}": ${m.text}`);
    else if (m.kind === 'approval') lines.push(`- Your push decision in "${label(m.stepId)}": ${m.text}`);
    else lines.push(`- You wrote in the chat: ${m.text}`);
  }
  for (const b of run.steps) {
    if (b.failures || b.status === 'failed') lines.push(`- Step "${b.label}" (/${b.skill}) failed ${b.failures || 1} time(s)${b.error ? `. Last error: ${String(b.error).slice(0, 400)}` : ''}`);
    if (b.attempts > 1) lines.push(`- Step "${b.label}" needed ${b.attempts} tries.`);
    if (b.question) lines.push(`- Step "${b.label}" asked: ${String(b.question).slice(0, 400)}`);
  }
  return lines.join('\n').slice(0, 6000);
}

export function buildPrompt(run, rules) {
  const steps = run.steps.map((b, i) => `${i + 1}. [${b.id}] "${b.label}" = /${b.skill}${b.args ? ` ${b.args}` : ''}${b.wait ? ' [waits for the user after]' : ''} — ${b.status}${b.durationMs != null ? `, ${Math.round(b.durationMs / 1000)}s` : ''}, $${(b.cost || 0).toFixed(4)}`).join('\n');
  return `${LEARN_TAG}
You help one developer improve how their AI workflows run. Below is one finished run of the workflow "${run.templateName}". Suggest what to learn from it.

The workflow's steps (in order, each one a Claude skill):
${steps}

What the user said and what went wrong:
${material(run) || '(nothing)'}

The user's rules that every run already follows:
${rules || '(none yet)'}

Give at most 3 rules and at most 2 workflow changes, only ones the run above clearly supports. None is a fine answer.
- A rule is one short sentence the AI should follow in future runs, in the user's way of working (for example a decision the user made at a gate that will come up again). Do not repeat an existing rule.
- A workflow change is one change to the steps: add, remove or move a step, change its extra text, or add or remove a wait. Name the step.
- For each, add "why": one short sentence that points at what happened in this run.
- For each workflow change, add "change": the exact change, using the step ids in [brackets] above. One of:
  {"op":"step","step":"<id>","wait":"on"}  (also "app", "explain", "fresh" (a new conversation for the step): "on"/"off"; "model": opus/sonnet; "effort": low..max; "args": the step's extra text, in full; "label")
  {"op":"add","skill":"<skill name>","at":<position from 1>,"label":"...","wait":"on"}
  {"op":"remove","step":"<id>"}   {"op":"move","step":"<id>","to":<position from 1>}
Use plain, simple English.

Reply with JSON only, no other text, in this shape:
{"rules":[{"text":"...","why":"..."}],"workflow":[{"text":"...","why":"...","change":{"op":"step","step":"...","wait":"on"}}]}`;
}

// Reads the suggestions out of the reply. Bad or missing parts are dropped.
export function parseSuggestions(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the reply had no JSON');
  const j = JSON.parse(t.slice(start, end + 1));
  const clean = (list, kind, max) => (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .slice(0, max)
    .map((s) => ({ kind, text: s.text.trim().slice(0, 500), why: String(s.why || '').trim().slice(0, 500), ...(kind === 'workflow' ? { change: cleanChange(s.change) } : {}) }));
  return [...clean(j.rules, 'rule', 3), ...clean(j.workflow, 'workflow', 2)];
}

// Tools a lesson-finder never needs: it only reads the prompt and answers.
const NO_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Skill', 'Agent', 'Task', 'WebFetch', 'WebSearch'];

// One fresh claude call. Returns { text, cost }.
// How long one lessons call may take (ORCHESTRA_LEARN_LIMIT_MS for tests).
const ASK_LIMIT_MS = Number(process.env.ORCHESTRA_LEARN_LIMIT_MS || 5 * 60 * 1000);

export function ask(prompt, { cwd, env }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--disallowedTools', NO_TOOLS.join(',')];
  return new Promise((resolve, reject) => {
    let child;
    try {
      const claude = claudeCommand(args);
      child = spawn(claude.cmd, claude.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(new Error(`could not start claude: ${err.message}`));
    }
    let result = null;
    let stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result') result = ev;
      } catch {}
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
    child.once('error', (err) => reject(new Error(`could not start claude: ${err.message}`)));
    // A claude that hangs must not hold the run's lessons forever.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid);
      } catch {}
    }, ASK_LIMIT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude gave no answer in ${ASK_LIMIT_MS / 60000} minutes. Ask for lessons again.`));
      if (!result) return reject(new Error(`claude exited (code ${code}) without a result${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      if (result.is_error || result.subtype !== 'success') return reject(new Error(String(result.result || result.subtype || 'claude reported an error').slice(0, 500)));
      resolve({ text: String(result.result || ''), cost: Number(result.total_cost_usd) || 0 });
    });
  });
}
