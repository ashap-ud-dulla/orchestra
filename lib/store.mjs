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
const DEFAULT_SETTINGS = { maxRunning: 2, learn: true };

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
  if (s.learn !== undefined && typeof s.learn !== 'boolean') throw Object.assign(new Error('learn must be true or false'), { status: 400 });
  const out = { maxRunning, learn: s.learn !== false };
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

export function saveRun(run) {
  run.updatedAt = new Date().toISOString();
  const file = path.join(runDir(run.id), 'state.json');
  const p = (saveChains.get(run.id) || Promise.resolve()).catch(() => {}).then(() => writeJson(file, run));
  saveChains.set(run.id, p);
  p.catch(() => {}).finally(() => saveChains.get(run.id) === p && saveChains.delete(run.id));
  return p;
}

export function saveRunSync(run) {
  run.updatedAt = new Date().toISOString();
  writeJsonSync(path.join(runDir(run.id), 'state.json'), run);
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
