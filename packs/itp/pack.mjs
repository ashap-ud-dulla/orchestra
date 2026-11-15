// The ITP pack: what Orchestra knows about the ITP workspace (itp-workspace and its repos).
// Moved here from the core as it was; the core itself knows nothing of ITP.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import tracking from './tracking.mjs';
import { stopFor } from './app/procs.mjs';

// Tokens in repo_dir_for that are not code repos a run works in.
const NOT_A_RUN_REPO = new Set(['itp-workspace', 'progress']);

export default {
  about: 'the ITP workspace: repos from scripts/lib/common.sh, the vault (ITPKV), Teamspace tracking, the AppHost app',

  // The ITP workspace folder has ITP's own repo list.
  detect: (folder) => fs.existsSync(path.join(folder, 'scripts', 'lib', 'common.sh')),

  // The repos a run can use, from ITP's own repo_dir_for (scripts/lib/common.sh). Read-only.
  repoDirs(root, { gitBash, winPath }) {
    const common = path.join(root, 'scripts', 'lib', 'common.sh');
    let text = '';
    try {
      text = fs.readFileSync(common, 'utf8');
    } catch {
      return [];
    }
    // The tokens are the case labels inside repo_dir_for().
    const body = /repo_dir_for\(\)\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] || '';
    const tokens = [...body.matchAll(/^\s+([a-z][\w-]*)\)\s/gm)].map((m) => m[1]).filter((t) => !NOT_A_RUN_REPO.has(t));
    const script = `source scripts/lib/common.sh >/dev/null 2>&1; for t in ${tokens.join(' ')}; do printf '%s=%s\\n' "$t" "$(repo_dir_for "$t" 2>/dev/null)"; done`;
    const r = spawnSync(gitBash(), ['-c', script], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ITP_ROOT: root, ITP_REPO_DIRS: '' } });
    const out = [];
    for (const line of (r.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const dir = line.slice(i + 1).trim();
      if (dir) out.push({ token: line.slice(0, i).trim(), dir: winPath(dir) });
    }
    return out;
  },

  // ITP's scripts see the run folder as the ITP root, and the run's repos as theirs. No ITP_BRANCH_OVERRIDE: ITP's
  // scripts must use the epic's own branch.
  workspaceEnv: (ws) => ({ ITP_ROOT: ws.dir, ITP_REPO_DIRS: ws.repos.map((r) => `${r.token}=${r.dir}`).join('\n') }),
  // ITP's own dev-parallel folder is not linked into run folders.
  skipLinks: ['.parallel'],

  // ITP's integration branch, when the checkout is not on a development branch.
  defaultBases: ['origin/development/mission'],

  // The ITP servers runs use (from the ITP .mcp.json the run folder carries), and the ones that never start in runs
  // (they failed there anyway, and FM-MCP fetches a package with npx at each start). opensearch: the bug template's
  // read-only log search.
  runMcp: ['opensearch', 'jira', 'bitbucket', 'mongodb', 'mongodb-app', 'mongodb-global'],
  runMcpOff: ['FM-MCP', 'aspire', 'aspire-dashboard', 'mongodb-cluster'],
  // Each run started all of them: ~9 node processes and ~430 MB per run, while only Test in the app used Mongo
  // (2026-11-09: 2 calls in 6 runs) and only bug runs read the logs. Jira and Bitbucket are light: always on.
  mcpOnlyIn: {
    mongodb: ['app-test'],
    'mongodb-app': ['app-test'],
    'mongodb-global': ['app-test'],
    opensearch: ['bug-logs'],
  },

  mainRule: 'Work on a work branch. Commit on, push to, or switch to the main branch of a code repo only when the user asked for it: say so in one line first; the push and the switch show the user an Allow prompt. The vault (ITPKV) is committed locally on main, as the team skills do. Never push the vault, and never commit or push in the ITP folder itself, except in the Wrap up step (/wrap-up), for the jobs the user picks there.',

  // The vault (ITPKV) is its own repo, and the team commits it locally on main by design. The git hooks allow work on
  // main there; it pushes only in the Wrap up step.
  mainOkDirs(root, wsDir) {
    return [root && path.join(root, 'ITPKV'), wsDir && path.join(wsDir, 'ITPKV')].filter(Boolean).map((d) => d.replace(/\\/g, '/'));
  },

  // Tracking OFF: ITP's own scripts skip Teamspace (ITP_REGISTRY_OFF=1 is their built-in "no server read or write").
  offEnv: { ITP_REGISTRY_OFF: '1' },
  tracking,
  trackingOffText: 'Tracking is OFF: no Teamspace calls, no vault (ITPKV) writes.',

  rules: [
    'When the task in .orchestra/task.md is a Work Order and you run /plan-itp, add --wo with its key.',
    // The open items of a review, for the next-step pick (the review skill itself never edits code).
    'After /ai-itp-code-reviewer, its open items are the findings (High, Medium and Low) in the newest .code-reviews/<stamp>-<slug>/report.md: list each one not fixed and not waived (file:line and the problem, one short line). "Handle them now" fixes them in this step, after the user\'s ok; a waived one needs the user\'s reason. After the fixes, re-check only the fixed spots (do not run the full review again unless the user asks), and say "N fixed, M waived, K left".',
  ],

  // The Wrap up step may commit and push the ITP folder itself (on main), its Execution/ files only.
  wrapUpPushDirs: (root) => (root ? [String(root).replace(/\\/g, '/')] : []),
  wrapUpCommitOnly: '^Execution/',

  // What a run shipped, read from its replies: the epic folder close-epic.sh names.
  shipFrom(text) {
    const folder = String(text).match(/close-epic\.sh\s+([A-Za-z0-9][\w.-]*)/);
    return folder ? { 'Epic folder': folder[1] } : {};
  },

  // Team skills, and your own (.claude/users/<email>/skills).
  skillsDirs: (root, email) => [
    { source: 'team', dir: path.join(root, '.claude', 'skills') },
    ...(email ? [{ source: 'mine', dir: path.join(root, '.claude', 'users', email, 'skills') }] : []),
  ],

  wrapUpLines(run, root) {
    const itp = String(root || '').replace(/\\/g, '/');
    return [
      ...(run.ship?.notes?.['Epic folder'] ? [] : ['- Epic folder: not known (look in this conversation; there may be none)']),
      `- The vault: ${itp}/ITPKV. The ITP folder (the itp-workspace repo, on main): ${itp}`,
      `- Tracking: ${run.tracking === false ? 'OFF (do not offer to close the epic or to change the vault)' : 'on'}`,
      'While this step works, the vault and the ITP folder (its Execution/ files only) may be pushed to main; the user still clicks Allow for each push. End the way the skill says.',
    ];
  },
  wrapUpNote: 'The Wrap up step pushes the vault, closes the epic and pushes the ITP files, as you pick.',

  // The git hooks refuse main and master; ITP repos' default branches are development branches, left as they were.
  protectDefaultBranch: false,

  // The core's starter skills (orch-plan, orch-build, orch-review, orch-hello) are not installed: ITP has its own.
  starterSkills: false,

  // The ITP app (app/app.mjs, run through bin/app.mjs): the AppHost or run-stack launcher, Debug.json, Mission,
  // Outsider. stopFor: clean-up stops it when it serves the run's folder.
  app: { script: 'app/app.mjs', stopFor },
  // orch settings launcher=apphost|runstack: how the app starts.
  settings: {
    launcher: { values: ['apphost', 'runstack'], default: 'apphost', about: 'the app starts with', words: { apphost: 'the Aspire AppHost (apphost)', runstack: 'run-stack.ps1 (runstack)' } },
  },
  // Clean-up: shared .NET build servers keep DLLs open in a run folder.
  freeFiles() {
    spawnSync('dotnet', ['build-server', 'shutdown'], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
    return 'stopped the .NET build servers that held its files';
  },

  // orch mine: the Work Orders you hold or pair on, read only, through ITP's own helper (scripts/lib/common.sh
  // registry_call GET, the way the team skills read Teamspace). Never another method.
  mine(root, { gitBash }) {
    if (!root) return { items: [], problem: 'no ITP folder set up (orch setup solution=<folder>)' };
    const get = (apiPath) => {
      const script = `source scripts/lib/common.sh >/dev/null 2>&1 || { echo NOHELPER; exit 0; }
registry_configured || { echo NOCONF; exit 0; }
s="$(registry_call GET '${apiPath}')"; echo "STATUS $s"; cat "$REGISTRY_BODY" 2>/dev/null; rm -f "$REGISTRY_BODY"`;
      const r = spawnSync(gitBash(), ['-c', script], { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ITP_ROOT: root } });
      const out = r.stdout || '';
      if (/^NOHELPER/.test(out)) throw new Error(`no scripts/lib/common.sh in ${root}`);
      if (/^NOCONF/.test(out)) throw new Error('Teamspace is not configured on this PC (no .itp/registry-url)');
      const m = /^STATUS (\d+)\r?\n?([\s\S]*)$/.exec(out);
      if (!m) throw new Error(`could not read Teamspace${r.error ? ` (${r.error.message})` : ''}`);
      if (m[1] === '000') throw new Error('Teamspace is not reachable from this PC now');
      if (m[1] !== '200') throw new Error(`Teamspace answered ${m[1]} for ${apiPath}`);
      return JSON.parse(m[2]);
    };
    try {
      const me = get('/api/me');
      if (!me?.id) return { items: [], problem: 'Teamspace did not say who you are (/api/me)' };
      const on = get(`/api/members/${encodeURIComponent(me.id)}/working-on`);
      const items = (on?.items || []).map((x) => ({ key: x.woKey, title: x.title, state: x.state, kind: 'Work order' }));
      return { items, who: me.name || me.email || null };
    } catch (err) {
      return { items: [], problem: err.message };
    }
  },
};
