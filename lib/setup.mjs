// orch setup: makes a fresh clone work on this PC.
//   1. remembers your solution folder (optional), its pack, your email and the run folder (data/settings.json, not
//      kept in git)
//   2. copies the starter templates (the pack's, else Orchestra's own) and skill marks once (yours are never
//      overwritten)
//   3. installs Orchestra's skills (skills/ in the repo, plus the pack's) into ~/.claude/skills, and its agents
//      (agents/*.md, plus the pack's) into ~/.claude/agents, with this PC's paths filled in
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
import { detectPack, packByName, PACKS_DIR } from './pack.mjs';
import { FOCUS_SCHEME } from './notify.mjs';
import { claudeCommand, claudeFound } from './claude-cmd.mjs';

const slash = (p) => path.resolve(p).replace(/\\/g, '/');
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// A skill's text with the placeholders filled in: {{ORCHESTRA}} (this repo) and {{SOLUTION}} (the solution folder).
export function fillSkill(text, { root, solution }) {
  return text.replaceAll('{{ORCHESTRA}}', slash(root)).replaceAll('{{SOLUTION}}', solution ? slash(solution) : '(no solution folder)');
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

async function installSkills(solution, packName) {
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
      text = fillSkill(text, { root: config.root, solution });
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

// ---- agents ----
// Orchestra's own agents (agents/*.md), then the pack's (packs/<name>/agents/*.md); a pack agent with the same name
// wins. An agent is one file, so what setup installed is kept in one list in the agents folder, per file its hash.
function agentsToInstall(packName) {
  const out = new Map();
  for (const dir of [config.agentsDir, packName !== 'none' && path.join(PACKS_DIR, packName, 'agents')].filter(Boolean)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) if (file.endsWith('.md') && fs.statSync(path.join(dir, file)).isFile()) out.set(file, path.join(dir, file));
  }
  return out;
}

const agentNotes = () => path.join(config.homeAgentsDir, '.orchestra-installed.json');
function readAgentNotes() {
  try {
    return JSON.parse(fs.readFileSync(agentNotes(), 'utf8'));
  } catch {
    return {};
  }
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// A file you changed by hand (its text is not what setup wrote last) is kept as <file>.bak-<date>[-n] first.
function keepHandEdit(dir, file, wrote) {
  const target = path.join(dir, file);
  if (!fs.existsSync(target) || sha(fs.readFileSync(target, 'utf8')) === wrote) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  let kept = `${file}.bak-${stamp}`;
  for (let n = 2; fs.existsSync(path.join(dir, kept)); n++) kept = `${file}.bak-${stamp}-${n}`;
  fs.copyFileSync(target, path.join(dir, kept));
  return kept;
}

function installAgents(solution, packName) {
  const agents = agentsToInstall(packName);
  if (!agents.size) return [];
  fs.mkdirSync(config.homeAgentsDir, { recursive: true });
  const notes = readAgentNotes();
  const out = [];
  for (const [file, from] of agents) {
    const text = fillSkill(fs.readFileSync(from, 'utf8'), { root: config.root, solution });
    const target = path.join(config.homeAgentsDir, file);
    const old = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const name = file.replace(/\.md$/, '');
    if (old === text) {
      notes[file] = sha(text);
      out.push({ name, state: 'up to date' });
      continue;
    }
    // A file of that name setup never wrote is yours: kept as a backup too, never lost.
    const kept = old === null ? null : keepHandEdit(config.homeAgentsDir, file, notes[file]);
    fs.writeFileSync(target, text);
    notes[file] = sha(text);
    out.push({ name, state: old === null ? 'installed' : kept ? `updated (your changed copy: ${kept})` : 'updated' });
  }
  fs.writeFileSync(agentNotes(), JSON.stringify(notes, null, 1) + '\n');
  return out;
}

// Agents setup installed that the active pack no longer ships: removed when no run's tab is open (a hand-edited one
// is kept as a backup first). Agent files setup never wrote are never touched.
async function removeOldAgents(packName) {
  const notes = readAgentNotes();
  const keep = agentsToInstall(packName);
  const found = Object.keys(notes).filter((f) => !keep.has(f));
  if (!found.length) return [];
  const open = (await loadRuns()).some((r) => r.session?.open);
  const out = [];
  for (const file of found) {
    const name = file.replace(/\.md$/, '');
    if (open) {
      out.push({ name, state: 'not in this pack, kept while a run tab is open (run setup again later)' });
      continue;
    }
    const kept = keepHandEdit(config.homeAgentsDir, file, notes[file]);
    fs.rmSync(path.join(config.homeAgentsDir, file), { force: true });
    delete notes[file];
    out.push({ name, state: kept ? `not in this pack, removed (your changed copy: ${kept})` : 'not in this pack, removed' });
  }
  fs.writeFileSync(agentNotes(), JSON.stringify(notes, null, 1) + '\n');
  return out;
}

function has(tool) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// Claude Code, started exactly the way runs start it (claude-cmd.mjs, no shell), so an install that works from a
// terminal but not for runs is found here, not in a run's tab. { line } when it starts, { missing } with the fix.
export function checkClaude() {
  let how;
  try {
    how = claudeFound();
  } catch (err) {
    return { missing: `claude (${err.message})` };
  }
  if (how.kind === 'not found') return { missing: 'claude (Claude Code is not installed. Install it in PowerShell: irm https://claude.ai/install.ps1 | iex — then open a new terminal and run orch setup again)' };
  const { cmd, args } = claudeCommand(['--version']);
  const v = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (v.status !== 0) {
    const said = `${v.error?.message || ''} ${v.stderr || ''} ${v.stdout || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' / ');
    return { missing: `claude (found ${how.file}, but it did not start${said ? `: ${said}` : ''}. Install the native Claude Code (PowerShell: irm https://claude.ai/install.ps1 | iex), then run orch setup again)` };
  }
  const version = ((v.stdout || '').trim().split(/\r?\n/)[0] || '?').replace(/\s*\(Claude Code\)\s*$/i, '');
  return { line: `Claude Code: ${version} (${how.kind}: ${how.file})` };
}

// The tools runs need. claude must also start (a broken install is found here, not in a run's tab).
function missingTools() {
  const out = [];
  let claude = null;
  const node = Number(process.versions.node.split('.')[0]);
  if (node < 22) out.push(`Node 22 or newer (this is ${process.version})`);
  if (process.env.ORCHESTRA_CLAUDE_BIN === undefined) {
    const c = checkClaude();
    if (c.missing) out.push(c.missing);
    claude = c.line || null;
  }
  for (const t of process.platform === 'win32' ? ['wt', 'git'] : ['git']) if (!has(t)) out.push(t);
  return { missing: out, claude };
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
  // Agents: only the files setup wrote (a hand-edited one is kept as a backup first).
  const notes = readAgentNotes();
  for (const file of Object.keys(notes)) {
    if (!fs.existsSync(path.join(config.homeAgentsDir, file))) continue;
    keepHandEdit(config.homeAgentsDir, file, notes[file]);
    fs.rmSync(path.join(config.homeAgentsDir, file), { force: true });
    removed.push(`agent ${file.replace(/\.md$/, '')}`);
  }
  fs.rmSync(agentNotes(), { force: true });
  if (process.platform === 'win32' && !process.env.ORCHESTRA_HOME_SKILLS) {
    const r = spawnSync('reg', ['delete', `HKCU\\Software\\Classes\\${FOCUS_SCHEME}`, '/f'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) removed.push('the notification click link');
  }
  return { json: { removed }, text: removed.length ? `Removed: ${removed.join(', ')}. Your runs, templates and settings stay in ${config.root}.` : 'Nothing to remove.' };
}

// solution: the folder with your repos (or one repo); none for no folder. Left out: the one saved.
export async function setup({ solution, email, worktrees, uninstall: off } = {}) {
  if (off) return uninstall();
  const before = await getSettings();
  const given = solution;
  const folder = given === 'none' ? null : given || config.solutionRoot || null;
  if (folder && !fs.existsSync(folder)) throw bad(`there is no folder ${folder}`);
  if (folder && !fs.statSync(folder).isDirectory()) throw bad(`${folder} is not a folder`);
  const packName = process.env.ORCHESTRA_PACK || (await detectPack(folder));
  // Your email (some packs name your own skills folder by it): taken from git.
  // The folder's git first (it may set its own), else your global git email.
  const gitEmail = spawnSync('git', folder ? ['-C', folder, 'config', 'user.email'] : ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || '';
  const userEmail = email || before.userEmail || gitEmail || undefined;
  const runs = runFolder(worktrees, before);
  const next = { ...before, pack: packName, worktreesDir: runs, ...(userEmail ? { userEmail } : {}) };
  if (folder) next.solution = slash(folder);
  else delete next.solution;
  const settings = await saveSettings(next);
  const copied = [];
  const packDir = packName !== 'none' ? path.join(PACKS_DIR, packName) : null;
  copyOnce(packDir && fs.existsSync(path.join(packDir, 'templates')) ? path.join(packDir, 'templates') : path.join(config.defaultsDir, 'templates'), config.templatesDir, copied);
  if (packDir) copyOnce(path.join(packDir, 'skill-marks.json'), path.join(config.dataDir, 'skill-marks.json'), copied);
  // Heavy marks (steps that build or run the app wait for a slot): the pack's, else Orchestra's own; yours are kept.
  copyOnce(packDir && fs.existsSync(path.join(packDir, 'heavy-marks.json')) ? path.join(packDir, 'heavy-marks.json') : path.join(config.defaultsDir, 'heavy-marks.json'), path.join(config.dataDir, 'heavy-marks.json'), copied);
  const skills = [...(await installSkills(settings.solution, packName)), ...(await removeOldSkills(packName))];
  const agents = [...installAgents(settings.solution, packName), ...(await removeOldAgents(packName))];
  await keepSkillsPrint(packName);
  const { missing, claude } = missingTools();
  const apiKey = !!process.env.ANTHROPIC_API_KEY && !config.keepApiKey;
  // What the pack's app needs on this PC (Docker and the like): said apart from the tools every run needs.
  const packObj = await packByName(packName);
  const appCheck = packObj.app?.setupCheck ? packObj.app.setupCheck(settings.solution || null) : [];
  const json = { solution: settings.solution || null, pack: packName, runFolder: runs, userEmail: settings.userEmail || null, copied, skills, agents, missing, claude, appCheck, apiKey };
  const text = [
    `Solution folder: ${settings.solution || 'none (runs use your own skills; set one with: orch setup solution=<folder>)'}`,
    `Pack: ${packName === 'none' ? 'none (repos are found in the folder; no app)' : packName}`,
    `Run folders go in: ${runs}`,
    settings.userEmail ? `Your email: ${settings.userEmail}` : 'Your email: not found in git (orch setup email=you@company.com).',
    `Starter files copied: ${copied.length ? copied.join(', ') : 'none needed (yours are kept)'}`,
    'Skills (installed in ~/.claude/skills):',
    ...skills.map((s) => `  ${s.name}: ${s.state}`),
    ...(agents.length ? ['Agents (installed in ~/.claude/agents):', ...agents.map((s) => `  ${s.name}: ${s.state}`)] : []),
    'What else it changes on this PC: Windows Terminal tabs in an "orchestra" window when runs start, and a link for',
    '  clicking a notification (made the first time one is sent). Undo: orch setup uninstall=yes',
    ...(apiKey ? ['ANTHROPIC_API_KEY is set: runs use your claude.ai login, not the key (to bill the key: ORCHESTRA_KEEP_API_KEY=1).'] : []),
    ...(claude ? [claude] : []),
    missing.length ? `Missing: ${missing.join(', ')}. Install them, then run orch setup again.` : 'Tools: all found (claude, wt, git, Node 22).',
    ...(appCheck.length ? ['For the app (runs work without it):', ...appCheck.map((c) => `  ${c.ok ? 'ok' : '!!'} ${c.text}`)] : []),
    'Next: open a NEW Claude Code window (one open before setup does not know /orch yet) and type /orch.',
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
  for (const [file, from] of [...agentsToInstall(packName)].sort(([a], [b]) => a.localeCompare(b))) h.update(`agents/${file}\n`).update(fs.readFileSync(from));
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
