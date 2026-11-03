// Files on disk: templates and run state. All JSON writes are atomic (temp file + rename).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newId(prefix) {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  // Windows can briefly lock the target (antivirus, indexer). Retry a few times.
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

// For the exit path, where async work never finishes.
export function writeJsonSync(file, data) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.sync.tmp`;
  fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fsSync.renameSync(tmp, file);
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// ---- templates ----

function templateFile(id) {
  if (!isSafeId(id)) throw Object.assign(new Error(`bad template id: ${id}`), { status: 400 });
  return path.join(config.templatesDir, `${id}.json`);
}

export async function listTemplates() {
  let names = [];
  try {
    names = await fs.readdir(config.templatesDir);
  } catch {}
  const out = [];
  for (const n of names.filter((n) => n.endsWith('.json'))) {
    try {
      const t = await readJson(path.join(config.templatesDir, n));
      if (validateTemplate(t).length === 0) out.push(t); // one broken file must not hide the rest
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(id) {
  try {
    return await readJson(templateFile(id));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// A step's model (an alias or a full id, like claude-sonnet-5-5 or opus[1m]) and effort. Ultracode is xhigh effort
// plus many helper agents (costly); it works only from the command line, so a step asks for it here.
const MODEL_RE = /^[a-z][a-z0-9.\-[\]]{1,63}$/;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['template must be an object'];
  if (!isSafeId(t.id)) errors.push('id must be letters, digits, - or _');
  if (!t.name || typeof t.name !== 'string') errors.push('name is required');
  if (!Array.isArray(t.boxes) || t.boxes.length === 0) errors.push('boxes must be a non-empty list');
  const seen = new Set();
  for (const [i, b] of (t.boxes || []).entries()) {
    if (!b || typeof b.skill !== 'string' || !/^[\w:.-]+$/.test(b.skill)) errors.push(`box ${i}: skill name is missing or invalid`);
    if (!isSafeId(b?.id)) errors.push(`box ${i}: id must be letters, digits, - or _`);
    else if (seen.has(b.id)) errors.push(`box ${i}: duplicate id ${b.id}`);
    else seen.add(b.id);
  }
  for (const [i, b] of [...(t.boxes || []).entries(), ['template', t]]) {
    const where = i === 'template' ? 'template' : `box ${i}`;
    if (b?.model != null && !MODEL_RE.test(b.model)) errors.push(`${where}: model must be opus, sonnet, haiku, fable or a model id`);
    if (b?.effort != null && !EFFORTS.includes(b.effort)) errors.push(`${where}: effort must be ${EFFORTS.join(', ')}`);
  }
  if (t.repos !== undefined && (!Array.isArray(t.repos) || t.repos.some((r) => typeof r !== 'string' || !/^[a-z][\w-]*$/.test(r)))) {
    errors.push('repos must be a list of repo names');
  }
  if (t.tracking !== undefined && typeof t.tracking !== 'boolean') errors.push('tracking must be true or false');
  return errors;
}

export async function saveTemplate(t) {
  const errors = validateTemplate(t);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
  await writeJson(templateFile(t.id), t);
  return t;
}

export async function deleteTemplate(id) {
  await fs.rm(templateFile(id), { force: true });
}

// ---- settings ----

// learn: look for lessons after each finished run that has something to learn from.
// pane: run tabs open split, with the run's steps in a pane on the right (orch watch); paneSize: its width, in % of the tab.
const DEFAULT_SETTINGS = { maxRunning: 2, learn: true, pane: true, paneSize: 30 }; // clean-up happens only when you say so (orch clean)

function settingsFile() {
  return path.join(config.dataDir, 'settings.json');
}

export async function getSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(await readJson(settingsFile())) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s) {
  const maxRunning = Number(s.maxRunning);
  if (!Number.isInteger(maxRunning) || maxRunning < 1 || maxRunning > 20) {
    throw Object.assign(new Error('runs at once must be a whole number from 1 to 20'), { status: 400 });
  }
  for (const k of ['learn', 'pane']) {
    if (s[k] !== undefined && typeof s[k] !== 'boolean') throw Object.assign(new Error(`${k} must be true or false`), { status: 400 });
  }
  const paneSize = s.paneSize === undefined ? 30 : Number(s.paneSize);
  if (!Number.isInteger(paneSize) || paneSize < 15 || paneSize > 70) {
    throw Object.assign(new Error('the pane width must be a whole number from 15 to 70 (% of the tab)'), { status: 400 });
  }
  const out = { maxRunning, learn: s.learn !== false, pane: s.pane !== false, paneSize };
  await writeJson(settingsFile(), out);
  return out;
}

// ---- runs ----

export function runDir(id) {
  if (!isSafeId(id)) throw Object.assign(new Error(`bad run id: ${id}`), { status: 400 });
  return path.join(config.runsDir, id);
}

// Saves of one run happen one after another, so an older save can never land after a newer one.
// Each write takes the state as it is when its turn comes.
const saveChains = new Map();

// The step that may push the vault and the ITP folder's Execution files (both live on main).
export const WRAP_UP_SKILL = 'orchestra-wrap-up';
export const WRAP_UP_FLAG = 'wrap-up.ok';
// "Stop claude and start it again on the same conversation" (another model or effort for the next step).
// The launcher in the tab watches for it.
export const RESTART_FLAG = 'restart.ok';

// Flag files follow the state on every save. wrap-up.ok: the git hooks cannot read JSON, so it says "the Wrap up step
// is working in an open tab now". restart.ok: the launcher restarts claude (see RESTART_FLAG).
// Neither outlives its reason. wrap-up.ok holds the ITP folder, for tabs opened
// before ORCHESTRA_ITP_ROOT was in their env.
function syncFlags(run) {
  const flag = path.join(runDir(run.id), WRAP_UP_FLAG);
  const on = !!run.session?.open && run.boxes?.some((b) => b.status === 'running' && b.skill === WRAP_UP_SKILL);
  try {
    if (on) fsSync.writeFileSync(flag, config.itpRoot.replace(/\\/g, '/'));
    else fsSync.rmSync(flag, { force: true });
  } catch {}
  const restart = path.join(runDir(run.id), RESTART_FLAG);
  try {
    if (run.restart && run.session?.open) fsSync.writeFileSync(restart, JSON.stringify(run.restart));
    else fsSync.rmSync(restart, { force: true });
  } catch {}
}

export function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  const file = path.join(runDir(run.id), 'state.json');
  const p = (saveChains.get(run.id) || Promise.resolve()).catch(() => {}).then(() => writeJson(file, run)).then(() => syncFlags(run));
  saveChains.set(run.id, p);
  p.catch(() => {}).finally(() => saveChains.get(run.id) === p && saveChains.delete(run.id));
  return p;
}

// Waits until every save started in this process is on disk (before the lock is let go).
export async function flushSaves() {
  while (saveChains.size) await Promise.all([...saveChains.values()].map((p) => p.catch(() => {})));
}

export function saveRunSync(run) {
  run.updatedAt = new Date().toISOString();
  writeJsonSync(path.join(runDir(run.id), 'state.json'), run);
  syncFlags(run);
}

export async function loadRuns() {
  let names = [];
  try {
    names = await fs.readdir(config.runsDir);
  } catch {}
  const runs = [];
  for (const n of names) {
    if (!isSafeId(n)) continue;
    try {
      runs.push(await readJson(path.join(config.runsDir, n, 'state.json')));
    } catch {}
  }
  return runs;
}

export function appendLine(file, line) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}
