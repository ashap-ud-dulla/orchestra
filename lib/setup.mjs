// orch setup: makes a fresh clone work on this PC.
//   1. remembers the ITP folder and your email (data/settings.json, not kept in git)
//   2. copies the starter templates and skill marks from defaults/ once (yours are never overwritten)
//   3. installs Orchestra's skills (skills/ in the repo) into ~/.claude/skills, with this PC's paths filled in
//   4. says which tools are missing (claude, wt, git, Node 22)
// Run it again after a pull: it refreshes the installed skills. An installed skill you changed by hand is kept as
// SKILL.md.bak-<date> before it is replaced (edit skills in the repo's skills/ folder instead).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { getSettings, saveSettings, loadRuns } from './store.mjs';
import { OLD_SKILL_NAMES } from './upgrade.mjs';

const slash = (p) => path.resolve(p).replace(/\\/g, '/');

// A skill's text with the placeholders filled in: {{ORCHESTRA}} (this repo) and {{ITP}} (the ITP folder).
export function fillSkill(text, { root, itp }) {
  return text.replaceAll('{{ORCHESTRA}}', slash(root)).replaceAll('{{ITP}}', slash(itp));
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

function installSkills(itp) {
  const src = path.join(config.root, 'skills');
  const out = [];
  if (!fs.existsSync(src)) return out;
  const stamp = new Date().toISOString().slice(0, 10);
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    if (!fs.statSync(from).isDirectory()) continue;
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
      const text = fillSkill(fs.readFileSync(path.join(from, file), 'utf8'), { root: config.root, itp });
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

// Skills Orchestra installed under an old name. A claude that is open in a run's tab may still need the old name, so
// the old copy goes only when no run's tab is open (setup runs again later and removes it then).
async function removeOldSkills() {
  const out = [];
  // orchestra: the menu skill before it was /orch.
  const found = [...OLD_SKILL_NAMES, 'orchestra'].filter((n) => fs.existsSync(path.join(config.homeSkillsDir, n, '.orchestra-installed.json')));
  if (!found.length) return out;
  const open = (await loadRuns()).some((r) => r.session?.open);
  for (const name of found) {
    if (open) out.push({ name, state: 'old name, kept while a run tab is open (run setup again later)' });
    else {
      fs.rmSync(path.join(config.homeSkillsDir, name), { recursive: true, force: true });
      out.push({ name, state: 'old name, removed' });
    }
  }
  return out;
}

function has(tool) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'ignore', windowsHide: true }).status === 0;
}

export async function setup({ itp, email }) {
  const folder = itp || config.itpRoot;
  if (!folder) {
    throw Object.assign(new Error('name your ITP folder (the one with .claude/skills, ITP-API, ITP-WebClient): orch setup --itp <folder>'), { status: 400 });
  }
  if (!fs.existsSync(path.join(folder, '.claude', 'skills'))) {
    throw Object.assign(new Error(`${folder} has no .claude/skills folder: is it the ITP workspace folder?`), { status: 400 });
  }
  const before = await getSettings();
  // Your email names your own ITP skills folder (.claude/users/<email>/skills): taken from git, as ITP uses it.
  const gitEmail = spawnSync('git', ['-C', folder, 'config', 'user.email'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const userEmail = email || before.userEmail || gitEmail || undefined;
  const settings = await saveSettings({ ...before, itpRoot: slash(folder), ...(userEmail ? { userEmail } : {}) });
  const copied = [];
  copyOnce(path.join(config.defaultsDir, 'templates'), config.templatesDir, copied);
  copyOnce(path.join(config.defaultsDir, 'skill-marks.json'), path.join(config.dataDir, 'skill-marks.json'), copied);
  const skills = [...installSkills(settings.itpRoot), ...(await removeOldSkills())];
  const node = Number(process.versions.node.split('.')[0]);
  const missing = [...(node < 22 ? [`Node 22 or newer (this is ${process.version})`] : []), ...['claude', 'wt', 'git'].filter((t) => !has(t))];
  const json = { itpRoot: settings.itpRoot, userEmail: settings.userEmail || null, copied, skills, missing };
  const text = [
    `ITP folder: ${settings.itpRoot}`,
    settings.userEmail ? `Your email (for your own ITP skills folder): ${settings.userEmail}` : 'Your email: not found in git, so your own ITP skills folder is not read (orch setup --email you@company.com).',
    `Starter files copied: ${copied.length ? copied.join(', ') : 'none needed (yours are kept)'}`,
    'Skills:',
    ...skills.map((s) => `  ${s.name}: ${s.state}`),
    missing.length ? `Missing: ${missing.join(', ')}. Install them, then run orch setup again.` : 'Tools: all found (claude, wt, git, Node 22).',
    'Next: type /orch in Claude Code.',
  ].join('\n');
  return { json, text };
}
