// Per-run workspaces, the way ITP's own dev-parallel builds a lane (scripts/dev-parallel-v2.sh):
// a short-path folder where every top-level entry of the ITP workspace is a link to the real one,
// except the run's repos, which are fresh git worktrees. The run works with ITP_ROOT = that folder,
// so skills, scripts and relative paths work unchanged, and your own checkouts are never switched.
//
// Orchestra does not pick the branch. Each worktree starts on the latest development code with no
// branch (detached), and the skills make or switch to their own (ITP epics: epics/<release>-…).
// After each turn Orchestra reads which branch each worktree is on. Commits made with no branch
// are kept safe on orchestra/<run id>.
//
// Safety: links are listed in <ws>/.orchestra-links and always removed FIRST, so a delete can never
// reach through a link into your real files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { httpError } from './util.mjs';

const LINKS_FILE = '.orchestra-links';
// Never a run repo: Orchestra must not edit the ITP workspace repo itself.
const NOT_A_RUN_REPO = new Set(['itp-workspace', 'progress']);

function git(dir, args, timeout = 120000) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

// The same, without blocking the server: for fetch and worktree add/remove, which can take minutes.
// Runs start side by side, so two may use git in the same repo at once: a step that finds git's lock busy
// ("Unable to create '…/index.lock'", "cannot lock ref") waits a moment and tries again.
async function gitAsync(dir, args, timeout = 120000) {
  for (let i = 0; ; i++) {
    const r = await gitOnce(dir, args, timeout);
    if (r.ok || i >= 4 || !/\.lock'|cannot lock ref|unable to lock|is locked/i.test(r.err)) return r;
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
}

function gitOnce(dir, args, timeout) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, ...args], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });
}

// Git Bash, which ITP's scripts need. Plain `bash` can be WSL's (C:\Windows\System32\bash.exe)
// when Orchestra was started from PowerShell, so look next to git first.
let bashPath = null;
function gitBash() {
  if (bashPath) return bashPath;
  const tries = [process.env.ORCHESTRA_BASH, process.env.CLAUDE_CODE_GIT_BASH_PATH];
  if (process.platform === 'win32') {
    const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    for (const g of where.split(/\r?\n/).filter(Boolean)) tries.push(path.join(path.dirname(path.dirname(g)), 'bin', 'bash.exe'));
    tries.push('C:/Program Files/Git/bin/bash.exe');
  }
  bashPath = tries.find((p) => p && fs.existsSync(p)) || 'bash';
  return bashPath;
}

const norm = (p) => path.resolve(p).replace(/\\/g, '/');

// ---- repos ----

let repoCache = { at: 0, list: [] };

// The repos a run can use, from ITP's own repo_dir_for (scripts/lib/common.sh). Read-only.
export function listRepos({ fresh = false } = {}) {
  if (!fresh && Date.now() - repoCache.at < 5 * 60 * 1000) return repoCache.list;
  const common = path.join(config.itpRoot, 'scripts', 'lib', 'common.sh');
  let text = '';
  try {
    text = fs.readFileSync(common, 'utf8');
  } catch {
    repoCache = { at: Date.now(), list: [] };
    return [];
  }
  // The tokens are the case labels inside repo_dir_for().
  const body = /repo_dir_for\(\)\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] || '';
  const tokens = [...body.matchAll(/^\s+([a-z][\w-]*)\)\s/gm)].map((m) => m[1]).filter((t) => !NOT_A_RUN_REPO.has(t));
  const script = `source scripts/lib/common.sh >/dev/null 2>&1; for t in ${tokens.join(' ')}; do printf '%s=%s\\n' "$t" "$(repo_dir_for "$t" 2>/dev/null)"; done`;
  const r = spawnSync(gitBash(), ['-c', script], { cwd: config.itpRoot, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ITP_ROOT: config.itpRoot, ITP_REPO_DIRS: '' } });
  const list = [];
  for (const line of (r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const token = line.slice(0, i).trim();
    let dir = line.slice(i + 1).trim();
    if (!dir) continue;
    dir = winPath(dir);
    const cloned = fs.existsSync(path.join(dir, '.git'));
    const repo = { token, dir: norm(dir), folder: path.basename(dir), cloned };
    if (cloned) {
      repo.current = git(dir, ['branch', '--show-current']).out;
      repo.defaultBase = defaultBase(dir, repo.current);
    }
    list.push(repo);
  }
  repoCache = { at: Date.now(), list };
  return list;
}

// Git Bash prints /c/x; Node wants C:/x.
function winPath(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return process.platform === 'win32' && m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

// The branch a new run branch starts from: the development branch your checkout is on,
// else origin/development/mission, else the remote's default branch.
function defaultBase(dir, current) {
  if (current && current !== 'main' && git(dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${current}`]).ok) return `origin/${current}`;
  if (git(dir, ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/development/mission']).ok) return 'origin/development/mission';
  const head = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out;
  return head || 'origin/main';
}

export function getRepo(token) {
  const repo = listRepos().find((r) => r.token === token);
  if (!repo) throw httpError(400, `unknown repo: ${token}`);
  if (!repo.cloned) throw httpError(400, `repo ${token} is not cloned at ${repo.dir}`);
  return repo;
}

// The code a worktree starts from: a remote branch like origin/development/lyra, or a commit.
// Starting from main's code is fine (carbon lives there); work on main is refused by the guards.
function checkBase(token, base) {
  const b = String(base || '').trim();
  if (!b) return null;
  if (!/^[A-Za-z0-9][\w./-]*$/.test(b) || b.includes('..')) throw httpError(400, `${token}: not a valid branch or commit: ${b}`);
  return b;
}

// Checks the repos you ticked in the New run form, before the run is made.
// plan: [{ token, base? }] (base defaults to the development branch your checkout is on). Returns the cleaned plan.
export function checkPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return [];
  const seen = new Set();
  return plan.map((p) => {
    const repo = getRepo(typeof p === 'string' ? p : p.token);
    if (seen.has(repo.token)) throw httpError(400, `repo ${repo.token} is listed twice`);
    seen.add(repo.token);
    const base = checkBase(repo.token, p.base) || repo.defaultBase || 'origin/development/mission';
    return { token: repo.token, folder: repo.folder, source: repo.dir, base, branch: null };
  });
}

// ---- following the branch the skills pick ----

export const SAFE_BRANCH = (runId) => `orchestra/${runId}`;

// Reads each worktree's branch into the run. A worktree with no branch but new commits gets the
// branch orchestra/<run id>, so the commits cannot be lost. Returns notes about what changed.
export function followBranches(run) {
  const notes = [];
  for (const r of run.workspace?.ready ? run.workspace.repos : []) {
    if (!r.dir || !fs.existsSync(r.dir)) continue;
    let branch = git(r.dir, ['branch', '--show-current']).out || null;
    if (!branch && r.baseCommit) {
      const ahead = Number(git(r.dir, ['rev-list', '--count', `${r.baseCommit}..HEAD`]).out) || 0;
      if (ahead > 0) {
        const name = SAFE_BRANCH(run.id);
        const made = git(r.dir, ['switch', '-c', name]);
        if (made.ok) {
          branch = name;
          notes.push(`${r.token}: ${ahead} commit${ahead > 1 ? 's were' : ' was'} made with no branch. Saved on ${name}.`);
        } else notes.push(`${r.token}: commits with no branch, and saving them on ${name} failed: ${made.err.slice(0, 200)}`);
      }
    }
    if (branch !== r.branch) {
      if (branch) notes.push(`${r.token}: now on branch ${branch}`);
      r.branch = branch;
    }
  }
  return notes;
}

// ---- building and removing ----

function makeLink(ws, link, target) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.appendFileSync(path.join(ws, LINKS_FILE), link + '\n');
}

// Removes the link itself, never what it points to.
function removeLink(link) {
  let st;
  try {
    st = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) throw new Error(`refusing to remove ${link}: it is not a link`);
  if (process.platform === 'win32') fs.rmdirSync(link); // a junction: removes the link only
  else fs.unlinkSync(link);
}

// A new, empty workspace folder (C:/o/<n>). The runner saves it on the run before the slow part, so a build that
// is cut off leaves a folder clean-up knows about.
export function reserve() {
  return freeSlot();
}

function freeSlot() {
  fs.mkdirSync(config.worktreesDir, { recursive: true });
  for (let i = 0; i < 1000; i++) {
    const dir = path.join(config.worktreesDir, i.toString(36));
    try {
      fs.mkdirSync(dir);
      return norm(dir);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free folder under ${config.worktreesDir}`);
}

// Builds the run's workspace. Safe to call again after a crash: finished parts are kept.
// Returns { dir, repos } to keep in the run state.
export async function prepare(run, log = () => {}) {
  const ws = run.workspace?.dir || freeSlot();
  const repos = run.workspace?.repos || run.repoPlan.map((p) => ({ ...p }));
  const picked = new Set(repos.map((r) => r.folder.toLowerCase()));
  const linked = new Set(readLinks(ws));
  // 1. everything at the workspace root that is not a run repo: a link (folders) or a copy (files)
  for (const name of fs.readdirSync(config.itpRoot)) {
    if (name === '.git' || name === '.parallel' || name.endsWith('.log') || picked.has(name.toLowerCase())) continue;
    if (name === '.claude') {
      buildClaudeDir(ws, linked);
      continue;
    }
    const src = path.join(config.itpRoot, name);
    const dst = path.join(ws, name);
    if (fs.existsSync(dst) || linked.has(dst)) continue;
    let st;
    try {
      st = fs.statSync(src);
    } catch {
      continue;
    }
    if (st.isDirectory()) makeLink(ws, dst, src);
    else fs.copyFileSync(src, dst);
  }
  // 2. a worktree of each run repo: the latest base code, with no branch (the skills make it)
  for (const r of repos) {
    const dst = norm(path.join(ws, r.folder));
    r.dir = dst;
    if (fs.existsSync(path.join(dst, '.git'))) continue;
    const [remote, ...rest] = r.base.split('/');
    if (remote === 'origin' && rest.length) {
      const f = await gitAsync(r.source, ['fetch', '--quiet', '--no-tags', 'origin', rest.join('/')], 300000);
      if (!f.ok) log(`${r.token}: could not fetch ${r.base} (${f.err.slice(0, 200)}); using what is here`);
    }
    const add = await gitAsync(r.source, ['worktree', 'add', '--detach', dst, r.base], 600000);
    if (!add.ok) throw new Error(`${r.token}: cannot make a worktree from ${r.base}: ${add.err.slice(0, 300)}`);
    r.baseCommit = git(dst, ['rev-parse', 'HEAD']).out;
    r.branch = null;
    // Dependencies are not in git: share them from your checkout instead of reinstalling.
    for (const dep of ['node_modules', 'probe/node_modules']) {
      const src = path.join(r.source, dep);
      const link = path.join(dst, dep);
      if (fs.existsSync(src) && !fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        makeLink(ws, link, src);
      }
    }
    log(`${r.token}: worktree ready at ${dst}, from ${r.base} (no branch yet)`);
  }
  return { dir: ws, repos, ready: true };
}

// The workspace's .claude is a real folder: its subfolders (skills, agents, commands, …) are links to
// ITP's, its files are copies. So when you answer "don't ask again" in a run, Claude writes
// .claude/settings.local.json here, not into the ITP repo. Orchestra keeps those answers in
// data/claude-local-settings.json and gives them to every new workspace.
const LOCAL_SETTINGS = 'settings.local.json';
const localSettingsStore = () => path.join(config.dataDir, 'claude-local-settings.json');

function buildClaudeDir(ws, linked) {
  const src = path.join(config.itpRoot, '.claude');
  const dst = path.join(ws, '.claude');
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name === LOCAL_SETTINGS) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    if (fs.existsSync(to) || linked.has(to)) continue;
    let st;
    try {
      st = fs.statSync(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) makeLink(ws, to, from);
    else fs.copyFileSync(from, to);
  }
  // First time: start from your own ITP answers (a copy; the ITP file is only read).
  const mine = path.join(dst, LOCAL_SETTINGS);
  const seed = [localSettingsStore(), path.join(src, LOCAL_SETTINGS)].find((f) => fs.existsSync(f));
  if (!fs.existsSync(mine) && seed) fs.copyFileSync(seed, mine);
}

// Keeps the run's "don't ask again" answers for later runs. Only valid JSON is kept.
export function saveLocalSettings(workspace) {
  const file = workspace?.dir && path.join(workspace.dir, '.claude', LOCAL_SETTINGS);
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  JSON.parse(text);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(localSettingsStore(), text);
  return true;
}

function readLinks(ws) {
  try {
    return fs.readFileSync(path.join(ws, LINKS_FILE), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// Repos with work that is not committed. Removing their worktree would lose it.
export function uncommitted(workspace) {
  return (workspace?.repos || []).filter((r) => r.dir && fs.existsSync(path.join(r.dir, '.git')) && git(r.dir, ['status', '--porcelain']).out).map((r) => r.token);
}

// Removes the workspace: links first, then the worktrees, then the folder. Branches are kept.
export async function remove(workspace) {
  const ws = workspace?.dir;
  if (!ws || !fs.existsSync(ws)) return;
  for (const link of readLinks(ws).reverse()) removeLink(link);
  for (const r of workspace.repos || []) {
    // A workspace cut off while it was built may not have saved the repo's folder yet: it is <ws>/<folder>.
    const dir = r.dir || (r.folder && norm(path.join(ws, r.folder)));
    if (!dir || !fs.existsSync(dir)) continue;
    // No longer a worktree (an earlier try removed it, but its folder stayed): the folder goes with the rest below.
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const rm = await gitAsync(r.source, ['worktree', 'remove', '--force', dir], 300000);
    if (!rm.ok && fs.existsSync(dir)) throw new Error(`${r.token}: cannot remove the worktree at ${dir}: ${rm.err.slice(0, 200)}`);
  }
  // Last check: nothing left may be a link.
  for (const name of fs.readdirSync(ws)) {
    if (fs.lstatSync(path.join(ws, name)).isSymbolicLink()) throw new Error(`refusing to delete ${ws}: ${name} is still a link`);
  }
  await fs.promises.rm(ws, { recursive: true, force: true, maxRetries: 5 });
}

// Bytes a folder takes, not following links (the ITP folders and node_modules a workspace links to are not its own).
export async function size(dir) {
  let total = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fs.promises.lstat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  if (fs.existsSync(dir)) await walk(dir);
  return total;
}

// After a workspace is gone: git forgets its worktree records, and the run's branches that are merged are deleted
// (git branch -d refuses unmerged ones, so work is never lost). Returns a line per repo.
export async function tidyRepos(workspace, { deleteMerged = false } = {}) {
  const notes = [];
  for (const r of workspace?.repos || []) {
    if (!r.source || !fs.existsSync(r.source)) continue;
    await gitAsync(r.source, ['worktree', 'prune']);
    if (!deleteMerged || !r.branch) continue;
    const del = await gitAsync(r.source, ['branch', '-d', r.branch]);
    notes.push(del.ok ? `${r.token}: deleted the merged branch ${r.branch}` : `${r.token}: kept ${r.branch} (git does not see it as merged here; delete it yourself if it was squash-merged)`);
  }
  return notes;
}

// Env for a turn: ITP scripts see the workspace as the ITP root, and the run's repos as theirs.
export function workspaceEnv(workspace) {
  if (!workspace?.ready) return {};
  // No ITP_BRANCH_OVERRIDE: ITP's scripts must use the epic's own branch.
  return {
    ITP_ROOT: workspace.dir,
    ITP_REPO_DIRS: workspace.repos.map((r) => `${r.token}=${r.dir}`).join('\n'),
    // The guard blocks edits in your own checkouts of these repos.
    ORCHESTRA_PROTECT: workspace.repos.map((r) => r.source).join('\n'),
  };
}
