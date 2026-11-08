// Files on disk: templates and run state. All JSON writes are atomic (temp file + rename).
import { LAUNCHERS, DEFAULT_LAUNCHER } from './launcher.mjs';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { EFFORTS, MODEL_RE } from './model.mjs';
import { upgradeRun, upgradeTemplate, VERSION } from './upgrade.mjs';

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
      const t = upgradeTemplate(await readJson(path.join(config.templatesDir, n)));
      if (validateTemplate(t).length === 0) out.push(t); // one broken file must not hide the rest
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTemplate(id) {
  try {
    return upgradeTemplate(await readJson(templateFile(id)));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export { EFFORTS };

export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['template must be an object'];
  if (!isSafeId(t.id)) errors.push('id must be letters, digits, - or _');
  if (!t.name || typeof t.name !== 'string') errors.push('name is required');
  if (!Array.isArray(t.steps) || t.steps.length === 0) errors.push('steps must be a non-empty list');
  const seen = new Set();
  for (const [i, b] of (t.steps || []).entries()) {
    if (!b || typeof b.skill !== 'string' || !/^[\w:.-]+$/.test(b.skill)) errors.push(`step ${i}: skill name is missing or invalid`);
    if (!isSafeId(b?.id)) errors.push(`step ${i}: id must be letters, digits, - or _`);
    else if (seen.has(b.id)) errors.push(`step ${i}: duplicate id ${b.id}`);
    else seen.add(b.id);
  }
  for (const [i, b] of [...(t.steps || []).entries(), ['template', t]]) {
    const where = i === 'template' ? 'template' : `step ${i}`;
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
  t.version = VERSION;
  await writeJson(templateFile(t.id), t);
  return t;
}

export async function deleteTemplate(id) {
  await fs.rm(templateFile(id), { force: true });
}

// ---- settings ----

// learn: look for lessons after each finished run that has something to learn from.
// pane: run tabs open split, with the run's steps in a pane on the right (orch watch); paneSize: its width, in % of the tab.
// launcher: how the ITP app starts (lib/launcher.mjs): apphost (the Aspire AppHost) or runstack (run-stack.ps1).
const DEFAULT_SETTINGS = { maxRunning: 2, learn: true, pane: true, paneSize: 30, launcher: DEFAULT_LAUNCHER }; // clean-up happens only when you say so (orch clean)

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
  const launcher = s.launcher === undefined ? DEFAULT_LAUNCHER : String(s.launcher).toLowerCase();
  if (!LAUNCHERS.includes(launcher)) throw Object.assign(new Error(`launcher must be ${LAUNCHERS.join(' or ')}`), { status: 400 });
  const out = { maxRunning, learn: s.learn !== false, pane: s.pane !== false, paneSize, launcher };
  // This PC's folders (orch setup): kept as they are.
  for (const k of ['itpRoot', 'worktreesDir', 'userEmail']) if (typeof s[k] === 'string' && s[k]) out[k] = s[k];
  await writeJson(settingsFile(), out);
  return out;
}

// ---- runs ----

// A cleaned run's folder moves to runs/archive/<id>: the board, stats and `runs --all` still read it; hooks and the
// queue never do. Its path is found here, so everything else just says runDir(id).
export const ARCHIVE = 'archive';
const archiveDir = () => path.join(config.runsDir, ARCHIVE);

export function runDir(id) {
  if (!isSafeId(id) || id === ARCHIVE) throw Object.assign(new Error(`bad run id: ${id}`), { status: 400 });
  const live = path.join(config.runsDir, id);
  if (fsSync.existsSync(live)) return live;
  const old = path.join(archiveDir(), id);
  return fsSync.existsSync(old) ? old : live;
}

export const isArchived = (id) => !fsSync.existsSync(path.join(config.runsDir, id)) && fsSync.existsSync(path.join(archiveDir(), id));

// Moves a cleaned run's folder into the archive. Windows may hold a file for a moment: tried again a few times.
// Returns false when it could not (it stays where it is; the next orch command tries again).
export async function archiveRun(id) {
  await flushSaves();
  const from = path.join(config.runsDir, id);
  if (!isSafeId(id) || id === ARCHIVE || !fsSync.existsSync(from)) return false;
  await fs.mkdir(archiveDir(), { recursive: true });
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rename(from, path.join(archiveDir(), id));
      return true;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) return false;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  return false;
}

// Saves of one run happen one after another, so an older save can never land after a newer one.
// Each write takes the state as it is when its turn comes.
const saveChains = new Map();

// The step that may push the vault and the ITP folder's Execution files (both live on main).
export const WRAP_UP_SKILL = 'wrap-up';
export const WRAP_UP_FLAG = 'wrap-up.ok';
// "Stop claude and start it again on the same conversation" (another model or effort for the next step).
// The launcher in the tab watches for it.
export const RESTART_FLAG = 'restart.ok';
// Written by the run's launcher every 10 s while its tab is open (bin/launch.mjs).
export const TAB_ALIVE = 'tab-alive';

// Flag files follow the state on every save. wrap-up.ok: the git hooks cannot read JSON, so it says "the Wrap up step
// is working in an open tab now". restart.ok: the launcher restarts claude (see RESTART_FLAG).
// Neither outlives its reason. wrap-up.ok holds the ITP folder, for tabs opened
// before ORCHESTRA_ITP_ROOT was in their env.
function syncFlags(run) {
  const flag = path.join(runDir(run.id), WRAP_UP_FLAG);
  const on = !!run.session?.open && run.steps?.some((b) => b.status === 'running' && b.skill === WRAP_UP_SKILL);
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

// archived: also the cleaned runs in runs/archive (the board and stats; never hooks).
export async function loadRuns({ archived = false } = {}) {
  const names = [];
  const seen = new Set(); // a run being moved may show up in both places for a moment
  for (const dir of [config.runsDir, ...(archived ? [archiveDir()] : [])]) {
    try {
      for (const n of await fs.readdir(dir)) if (isSafeId(n) && n !== ARCHIVE && !seen.has(n)) {
        seen.add(n);
        names.push([dir, n]);
      }
    } catch {}
  }
  const runs = [];
  broken.clear();
  for (const [dir, n] of names) {
    const file = path.join(dir, n, 'state.json');
    for (let i = 0; ; i++) {
      try {
        runs.push(upgradeRun(await readJson(file)));
        break;
      } catch (err) {
        if (err.code === 'ENOENT') break; // a folder with no run file (yet): not a run
        // Windows may hold the file for a moment while another process replaces it: try again.
        if (i < 4 && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
          await new Promise((r) => setTimeout(r, 40 * (i + 1)));
          continue;
        }
        broken.set(n, err.message.slice(0, 200));
        break;
      }
    }
  }
  return runs;
}

// Run files the last loadRuns could not read (id → why). They are kept as they are, never treated as deleted,
// and the board names them.
const broken = new Map();
export const brokenRuns = () => [...broken].map(([id, error]) => ({ id, error }));

export function appendLine(file, line) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}
