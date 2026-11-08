// orch setup: makes a fresh clone work on this PC.
//   1. remembers your solution folder (optional), its pack, your email and the run folder (data/settings.json, not
//      kept in git)
//   2. copies the starter templates (the pack's, else Orchestra's own) and skill marks once (yours are never
//      overwritten)
//   3. installs Orchestra's skills (skills/ in the repo, plus the pack's) into ~/.claude/skills, with this PC's
//      paths filled in
//   4. says which tools are missing (claude, wt, git, Node 22) and what it changed on the PC
// Run it again after a pull: it refreshes the installed skills. An installed skill you changed by hand is kept as
// SKILL.md.bak-<date> before it is replaced (edit skills in the repo's skills/ folder instead).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { getSettings, saveSettings, loadRuns } from './store.mjs';
import { OLD_SKILL_NAMES } from './upgrade.mjs';
import { detectPack, PACKS_DIR } from './pack.mjs';
import { FOCUS_SCHEME } from './notify.mjs';

const slash = (p) => path.resolve(p).replace(/\\/g, '/');
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// A skill's text with the placeholders filled in: {{ORCHESTRA}} (this repo) and {{ITP}} (the solution folder).
export function fillSkill(text, { root, itp }) {
  return text.replaceAll('{{ORCHESTRA}}', slash(root)).replaceAll('{{ITP}}', itp ? slash(itp) : '(no solution folder)');
}

function copyOnce(from, to, done) {
  if (!fs.existsSync(from)) return;
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const n of fs.readdirSync(from)) copyOnce(path.join(from, n), path.join(to, n), done);
  } else if (!fs.existsSync(to)) {
    fs.copyFileSync(from, to);
    done.push(path.relative(config.dataDir, to));
  }
}

// The skills to install: Orchestra's own (skills/), then the pack's (packs/<name>/skills/); a pack skill with the same
// name wins. The /orch skill gets the pack's own part (packs/<name>/orch.md) at its end.
const STARTER = new Set(['orch-plan', 'orch-build', 'orch-review', 'orch-hello']);
async function skillsToInstall(packName) {
  const out = new Map();
  const starter = packName === 'none' || (await import(pathToFileURL(path.join(PACKS_DIR, packName, 'pack.mjs')).href)).default.starterSkills !== false;
  for (const dir of [path.join(config.root, 'skills'), packName !== 'none' && path.join(PACKS_DIR, packName, 'skills')].filter(Boolean)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!fs.statSync(path.join(dir, name)).isDirectory() || (!starter && STARTER.has(name))) continue;
      out.set(name, path.join(dir, name));
    }
  }
  const extra = packName !== 'none' ? path.join(PACKS_DIR, packName, 'orch.md') : null;
  return { skills: out, orchExtra: extra && fs.existsSync(extra) ? fs.readFileSync(extra, 'utf8') : '' };
}

async function installSkills(itp, packName) {
  const { skills, orchExtra } = await skillsToInstall(packName);
  const out = [];
  const stamp = new Date().toISOString().slice(0, 10);
  for (const [name, from] of skills) {
    const to = path.join(config.homeSkillsDir, name);
    fs.mkdirSync(to, { recursive: true });
    // What setup installed last, per file: a copy that still matches it is ours and is just replaced; one that does
    // not was changed by hand and is kept as a backup first (never over an older backup).
    const notes = path.join(to, '.orchestra-installed.json');
    let last = {};
    try {
      last = JSON.parse(fs.readFileSync(notes, 'utf8'));
    } catch {}
    const prev = { ...last };
    const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
    let state = 'up to date';
    for (const file of fs.readdirSync(from)) {
      let text = fs.readFileSync(path.join(from, file), 'utf8');
      if (name === 'orch' && file === 'SKILL.md' && orchExtra) text = `${text.replace(/\s+$/, '')}\n${orchExtra}`;
      text = fillSkill(text, { root: config.root, itp });
      const target = path.join(to, file);
      const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      last[file] = hash(text);
      if (old === text) continue;
      let kept = null;
      if (old !== null && hash(old) !== prev[file]) {
        kept = `${file}.bak-${stamp}`;
        for (let n = 2; fs.existsSync(path.join(to, kept)); n++) kept = `${file}.bak-${stamp}-${n}`;
        fs.copyFileSync(target, path.join(to, kept));
      }
      fs.writeFileSync(target, text);
      state = old === null ? 'installed' : kept ? `updated (your changed copy: ${kept})` : 'updated';
    }
    fs.writeFileSync(notes, JSON.stringify(last, null, 1) + '\n');
    out.push({ name, state });
  }
  return out;
}

// Skills Orchestra installed under an old name, or from a pack that is no longer active. A claude that is open in a
// run's tab may still need them, so they go only when no run's tab is open (setup runs again later and removes them).
async function removeOldSkills(packName) {
  const out = [];
  const keep = new Set((await skillsToInstall(packName)).skills.keys());
  const ours = (n) => fs.existsSync(path.join(config.homeSkillsDir, n, '.orchestra-installed.json'));
  const packSkills = [];
  for (const p of fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR) : []) {
    const dir = path.join(PACKS_DIR, p, 'skills');
    if (fs.existsSync(dir)) packSkills.push(...fs.readdirSync(dir));
  }
  // orchestra: the menu skill before it was /orch.
  const found = [...new Set([...OLD_SKILL_NAMES, 'orchestra', ...packSkills, ...STARTER])].filter((n) => !keep.has(n) && ours(n));
  if (!found.length) return out;
  const open = (await loadRuns()).some((r) => r.session?.open);
  for (const name of found) {
    const what = [...OLD_SKILL_NAMES, 'orchestra'].includes(name) ? 'old name' : STARTER.has(name) ? 'a starter skill this pack does not use' : 'not in this pack';
    if (open) out.push({ name, state: `${what}, kept while a run tab is open (run setup again later)` });
    else {
      fs.rmSync(path.join(config.homeSkillsDir, name), { recursive: true, force: true });
      out.push({ name, state: `${what}, removed` });
    }
  }
  return out;
}

function has(tool) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// The tools runs need. claude must also start (a broken install is found here, not in a run's tab).
function missingTools() {
  const out = [];
  const node = Number(process.versions.node.split('.')[0]);
  if (node < 22) out.push(`Node 22 or newer (this is ${process.version})`);
  if (process.env.ORCHESTRA_CLAUDE_BIN === undefined) {
    const v = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 30000 });
    if (v.status !== 0) out.push('claude (Claude Code: it did not start with claude --version)');
  }
  for (const t of process.platform === 'win32' ? ['wt', 'git'] : ['git']) if (!has(t)) out.push(t);
  return out;
}

// Where run workspaces go: yours (worktrees=…), else C:/o (short paths keep .NET and node_modules builds working),
// else a folder in your profile when C:/o cannot be made.
function runFolder(want, before) {
  const pick = want || before.worktreesDir || (process.platform === 'win32' ? 'C:/o' : path.join(os.homedir(), 'orchestra-runs'));
  try {
    fs.mkdirSync(pick, { recursive: true });
    return slash(pick);
  } catch {
    if (want) throw bad(`cannot make the run folder ${want}`);
    const home = path.join(os.homedir(), 'orchestra-runs');
    fs.mkdirSync(home, { recursive: true });
    return slash(home);
  }
}

// setup uninstall=yes: removes what setup added to the PC (the installed skills, the notification link). Your
// runs, templates and settings stay in the clone.
function uninstall() {
  const removed = [];
  for (const n of fs.existsSync(config.homeSkillsDir) ? fs.readdirSync(config.homeSkillsDir) : []) {
    if (fs.existsSync(path.join(config.homeSkillsDir, n, '.orchestra-installed.json'))) {
      fs.rmSync(path.join(config.homeSkillsDir, n), { recursive: true, force: true });
      removed.push(`skill ${n}`);
    }
  }
  if (process.platform === 'win32' && !process.env.ORCHESTRA_HOME_SKILLS) {
    const r = spawnSync('reg', ['delete', `HKCU\\Software\\Classes\\${FOCUS_SCHEME}`, '/f'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) removed.push('the notification click link');
  }
  return { json: { removed }, text: removed.length ? `Removed: ${removed.join(', ')}. Your runs, templates and settings stay in ${config.root}.` : 'Nothing to remove.' };
}

// solution: the folder with your repos (or one repo); none for no folder. itp: its old name. Left out: the one saved.
export async function setup({ solution, itp, email, worktrees, uninstall: off } = {}) {
  if (off) return uninstall();
  const before = await getSettings();
  const given = solution ?? itp;
  const folder = given === 'none' ? null : given || config.itpRoot || null;
  if (folder && !fs.existsSync(folder)) throw bad(`there is no folder ${folder}`);
  if (folder && !fs.statSync(folder).isDirectory()) throw bad(`${folder} is not a folder`);
  const packName = process.env.ORCHESTRA_PACK || (await detectPack(folder));
  // Your email names your own skills folder in some solutions (ITP: .claude/users/<email>/skills): taken from git.
  const gitEmail = folder ? spawnSync('git', ['-C', folder, 'config', 'user.email'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() : '';
  const userEmail = email || before.userEmail || gitEmail || undefined;
  const runs = runFolder(worktrees, before);
  const next = { ...before, pack: packName, worktreesDir: runs, ...(userEmail ? { userEmail } : {}) };
  if (folder) next.itpRoot = slash(folder);
  else delete next.itpRoot;
  const settings = await saveSettings(next);
  const copied = [];
  const packDir = packName !== 'none' ? path.join(PACKS_DIR, packName) : null;
  copyOnce(packDir && fs.existsSync(path.join(packDir, 'templates')) ? path.join(packDir, 'templates') : path.join(config.defaultsDir, 'templates'), config.templatesDir, copied);
  if (packDir) copyOnce(path.join(packDir, 'skill-marks.json'), path.join(config.dataDir, 'skill-marks.json'), copied);
  const skills = [...(await installSkills(settings.itpRoot, packName)), ...(await removeOldSkills(packName))];
  await keepSkillsPrint(packName);
  const missing = missingTools();
  const apiKey = !!process.env.ANTHROPIC_API_KEY && !config.keepApiKey;
  const json = { solution: settings.itpRoot || null, itpRoot: settings.itpRoot || null, pack: packName, runFolder: runs, userEmail: settings.userEmail || null, copied, skills, missing, apiKey };
  const text = [
    `Solution folder: ${settings.itpRoot || 'none (runs use your own skills; set one with: orch setup solution=<folder>)'}`,
    `Pack: ${packName === 'none' ? 'none (repos are found in the folder; no app)' : packName}`,
    `Run folders go in: ${runs}`,
    settings.userEmail ? `Your email: ${settings.userEmail}` : 'Your email: not found in git (orch setup email=you@company.com).',
    `Starter files copied: ${copied.length ? copied.join(', ') : 'none needed (yours are kept)'}`,
    'Skills (installed in ~/.claude/skills):',
    ...skills.map((s) => `  ${s.name}: ${s.state}`),
    'What else it changes on this PC: Windows Terminal tabs in an "orchestra" window when runs start, and a link for',
    '  clicking a notification (made the first time one is sent). Undo: orch setup uninstall=yes',
    ...(apiKey ? ['ANTHROPIC_API_KEY is set: runs use your claude.ai login, not the key (to bill the key: ORCHESTRA_KEEP_API_KEY=1).'] : []),
    missing.length ? `Missing: ${missing.join(', ')}. Install them, then run orch setup again.` : 'Tools: all found (claude, wt, git, Node 22).',
    'Next: type /orch in Claude Code.',
  ].join('\n');
  return { json, text };
}

// ---- after a git pull ----

// A fingerprint of the skills setup installs (their source files). Setup keeps it; status compares, so a pull that
// changed a skill says "run orch setup".
async function skillsPrint(packName) {
  const h = crypto.createHash('sha256');
  const { skills, orchExtra } = await skillsToInstall(packName);
  for (const [name, dir] of [...skills].sort(([a], [b]) => a.localeCompare(b))) {
    for (const f of fs.readdirSync(dir).sort()) h.update(`${name}/${f}\n`).update(fs.readFileSync(path.join(dir, f)));
  }
  return h.update(orchExtra).digest('hex').slice(0, 16);
}
const printFile = () => path.join(config.dataDir, 'installed.json');

export async function keepSkillsPrint(packName) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(printFile(), JSON.stringify({ print: await skillsPrint(packName), at: new Date().toISOString() }) + '\n');
}

// True when the skills in the repo differ from what setup installed last.
export async function skillsChanged(packName) {
  try {
    return JSON.parse(fs.readFileSync(printFile(), 'utf8')).print !== (await skillsPrint(packName));
  } catch {
    return false; // never set up with this check: nothing to compare
  }
}
