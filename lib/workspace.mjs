// Per-run workspaces, the way ITP's own dev-parallel builds a lane (scripts/dev-parallel-v2.sh):
// a short-path folder where every top-level entry of the ITP workspace is a link to the real one,
// except the run's repos, which are fresh git worktrees on the run's branch. The run works with
// ITP_ROOT = that folder, so skills, scripts and relative paths work unchanged, and your own
// checkouts are never switched.
//
// Safety: links are listed in <ws>/.orchestra-links and always removed FIRST, so a delete can never
// reach through a link into your real files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const LINKS_FILE = '.orchestra-links';
// Never a run repo: Orchestra must not edit the ITP workspace repo itself.
const NOT_A_RUN_REPO = new Set(['itp-workspace', 'progress']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function git(dir, args, timeout = 120000) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

// The same, without blocking the server: for fetch and worktree add/remove, which can take minutes.
function gitAsync(dir, args, timeout = 120000) {
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

// Local and remote branches of a repo, for the "existing branch" picker.
export function branchesFor(token) {
  const repo = getRepo(token);
  const out = git(repo.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']).out;
  const names = new Set();
  for (const n of out.split('\n')) {
    const b = n.replace(/^origin\//, '');
    if (b && b !== 'HEAD' && b !== 'origin' && b !== 'main') names.add(b);
  }
  // A branch checked out somewhere (your checkout, another worktree) cannot get a run worktree.
  const inUse = new Set(git(repo.dir, ['worktree', 'list', '--porcelain']).out.split('\n').filter((l) => l.startsWith('branch refs/heads/')).map((l) => l.slice('branch refs/heads/'.length)));
  return { token, current: repo.current, defaultBase: repo.defaultBase, branches: [...names].sort().map((name) => ({ name, inUse: inUse.has(name) })) };
}

// ---- branch names ----

// feature/PROJ-101 from a Jira key in the input, else a few words of it.
export function branchNameFor(input, runId) {
  const key = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(String(input || ''))?.[0];
  if (key) return `feature/${key}`;
  const words = String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join('-');
  return `feature/${words || runId.slice(-6)}`;
}

export function checkBranchName(name) {
  const n = String(name || '').trim();
  if (!n) return 'branch name is empty';
  if (n === 'main' || n === 'refs/heads/main' || /^(origin\/)?main$/.test(n)) return 'the main branch is refused';
  if (!/^[A-Za-z0-9][\w./-]*$/.test(n) || n.includes('..') || n.endsWith('/') || n.endsWith('.lock')) return `not a valid branch name: ${n}`;
  return null;
}

// Checks what you picked in the New run form, before the run is made.
// plan: [{ token, mode: 'new'|'existing', branch, base? }]. Returns the cleaned plan.
export function checkPlan(plan, busy = new Map()) {
  if (!Array.isArray(plan) || !plan.length) return [];
  const seen = new Set();
  return plan.map((p) => {
    const repo = getRepo(p.token);
    if (seen.has(repo.token)) throw httpError(400, `repo ${repo.token} is listed twice`);
    seen.add(repo.token);
    const branch = String(p.branch || '').trim();
    const why = checkBranchName(branch);
    if (why) throw httpError(400, `${repo.token}: ${why}`);
    const mode = p.mode === 'existing' ? 'existing' : 'new';
    const exists = git(repo.dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    const remote = git(repo.dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).ok;
    if (mode === 'new' && (exists || remote)) throw httpError(400, `${repo.token}: branch ${branch} already exists. Pick "existing branch", or another name.`);
    if (mode === 'existing' && !exists && !remote) throw httpError(400, `${repo.token}: branch ${branch} does not exist`);
    const other = busy.get(`${repo.token}:${branch}`);
    if (other) throw httpError(409, `${repo.token}: branch ${branch} is already in use by run ${other}`);
    if (mode === 'existing' && exists) {
      const wt = git(repo.dir, ['worktree', 'list', '--porcelain']).out;
      if (wt.split('\n').includes(`branch refs/heads/${branch}`)) throw httpError(409, `${repo.token}: branch ${branch} is checked out somewhere else (see git worktree list)`);
    }
    const base = mode === 'new' ? String(p.base || repo.defaultBase || 'origin/main').trim() : null;
    return { token: repo.token, folder: repo.folder, source: repo.dir, mode, branch, base };
  });
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
  // 2. a worktree of each run repo, on the run branch
  for (const r of repos) {
    const dst = norm(path.join(ws, r.folder));
    r.dir = dst;
    if (fs.existsSync(path.join(dst, '.git'))) continue;
    if (r.mode === 'new') {
      const [remote, ...rest] = r.base.split('/');
      if (remote === 'origin' && rest.length) {
        const f = await gitAsync(r.source, ['fetch', '--quiet', '--no-tags', 'origin', rest.join('/')], 300000);
        if (!f.ok) log(`${r.token}: could not fetch ${r.base} (${f.err.slice(0, 200)}); using what is here`);
      }
      const add = await gitAsync(r.source, ['worktree', 'add', '--no-track', '-b', r.branch, dst, r.base], 600000);
      if (!add.ok) throw new Error(`${r.token}: cannot make a worktree for new branch ${r.branch} from ${r.base}: ${add.err.slice(0, 300)}`);
    } else {
      const local = git(r.source, ['show-ref', '--verify', '--quiet', `refs/heads/${r.branch}`]).ok;
      const add = local
        ? await gitAsync(r.source, ['worktree', 'add', dst, r.branch], 600000)
        : await gitAsync(r.source, ['worktree', 'add', '--track', '-b', r.branch, dst, `origin/${r.branch}`], 600000);
      if (!add.ok) throw new Error(`${r.token}: cannot make a worktree for branch ${r.branch}: ${add.err.slice(0, 300)}`);
    }
    // Dependencies are not in git: share them from your checkout instead of reinstalling.
    for (const dep of ['node_modules', 'probe/node_modules']) {
      const src = path.join(r.source, dep);
      const link = path.join(dst, dep);
      if (fs.existsSync(src) && !fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        makeLink(ws, link, src);
      }
    }
    log(`${r.token}: worktree ready at ${dst} on ${r.branch}`);
  }
  return { dir: ws, repos, ready: true };
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
  return (workspace?.repos || []).filter((r) => r.dir && fs.existsSync(r.dir) && git(r.dir, ['status', '--porcelain']).out).map((r) => r.token);
}

// Removes the workspace: links first, then the worktrees, then the folder. Branches are kept.
export async function remove(workspace) {
  const ws = workspace?.dir;
  if (!ws || !fs.existsSync(ws)) return;
  for (const link of readLinks(ws).reverse()) removeLink(link);
  for (const r of workspace.repos || []) {
    if (!r.dir || !fs.existsSync(r.dir)) continue;
    const rm = await gitAsync(r.source, ['worktree', 'remove', '--force', r.dir], 300000);
    if (!rm.ok && fs.existsSync(r.dir)) throw new Error(`${r.token}: cannot remove the worktree at ${r.dir}: ${rm.err.slice(0, 200)}`);
  }
  // Last check: nothing left may be a link.
  for (const name of fs.readdirSync(ws)) {
    if (fs.lstatSync(path.join(ws, name)).isSymbolicLink()) throw new Error(`refusing to delete ${ws}: ${name} is still a link`);
  }
  await fs.promises.rm(ws, { recursive: true, force: true, maxRetries: 5 });
}

// Env for a turn: ITP scripts see the workspace as the ITP root, and the run's repos as theirs.
export function workspaceEnv(workspace) {
  if (!workspace?.ready) return {};
  const branches = [...new Set(workspace.repos.map((r) => r.branch))];
  return {
    ITP_ROOT: workspace.dir,
    ITP_REPO_DIRS: workspace.repos.map((r) => `${r.token}=${r.dir}`).join('\n'),
    ...(branches.length === 1 ? { ITP_BRANCH_OVERRIDE: branches[0] } : {}),
    // The guard blocks edits in your own checkouts of these repos.
    ORCHESTRA_PROTECT: workspace.repos.map((r) => r.source).join('\n'),
  };
}
