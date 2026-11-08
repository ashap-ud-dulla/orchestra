// The ITP pack: what Orchestra knows about the ITP workspace (itp-workspace and its repos).
// Moved here from the core as it was; the core itself knows nothing of ITP.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

  // ITP's integration branch, when the checkout is not on a development branch.
  defaultBases: ['origin/development/mission'],

  // The ITP servers runs use (from the ITP .mcp.json the run folder carries), and the ones that never start in runs
  // (they failed there anyway, and FM-MCP fetches a package with npx at each start). opensearch: the bug template's
  // read-only log search.
  runMcp: ['opensearch', 'jira', 'bitbucket', 'mongodb', 'mongodb-app', 'mongodb-global'],
  runMcpOff: ['FM-MCP', 'aspire', 'aspire-dashboard', 'mongodb-cluster'],

  mainRule: 'Never commit on, push to, or switch to the main branch. One exception: the vault (ITPKV) is committed locally on main, as the team skills do. Never push the vault, and never commit or push in the ITP folder itself, except in the Wrap up step (/wrap-up), for the jobs the user picks there.',

  // The vault (ITPKV) is its own repo, and the team commits it locally on main by design. The git hooks allow work on
  // main there only. Pushing to main stays refused everywhere.
  mainOkDirs(root, wsDir) {
    return [root && path.join(root, 'ITPKV'), wsDir && path.join(wsDir, 'ITPKV')].filter(Boolean).map((d) => d.replace(/\\/g, '/'));
  },

  // Tracking OFF: ITP's own scripts skip Teamspace (ITP_REGISTRY_OFF=1 is their built-in "no server read or write").
  offEnv: { ITP_REGISTRY_OFF: '1' },
  tracking: true,
  trackingOffText: 'Tracking is OFF: no Teamspace calls, no vault (ITPKV) writes.',

  // Team skills, and your own (.claude/users/<email>/skills).
  skillsDirs: (root, email) => [
    { source: 'team', dir: path.join(root, '.claude', 'skills') },
    ...(email ? [{ source: 'mine', dir: path.join(root, '.claude', 'users', email, 'skills') }] : []),
  ],

  wrapUpLines(run, root) {
    const itp = String(root || '').replace(/\\/g, '/');
    return [
      `- The vault: ${itp}/ITPKV. The ITP folder (the itp-workspace repo, on main): ${itp}`,
      `- Tracking: ${run.tracking === false ? 'OFF (do not offer to close the epic or to change the vault)' : 'on'}`,
      'While this step works, the vault and the ITP folder (its Execution/ files only) may be pushed to main; the user still clicks Allow for each push. End the way the skill says.',
    ];
  },
  wrapUpNote: 'The Wrap up step pushes the vault, closes the epic and pushes the ITP files, as you pick.',

  // The core's starter skills (orch-plan, orch-build, orch-review, orch-hello) are not installed: ITP has its own.
  starterSkills: false,

  // bin/app.mjs: the AppHost or run-stack launcher (lib/launcher.mjs), Debug.json, Mission, Outsider.
  app: true,
};
