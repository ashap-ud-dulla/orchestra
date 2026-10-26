// Paths and settings. Every value can be changed with an env var.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root: ROOT,
  port: Number(process.env.ORCHESTRA_PORT || 7077), // 7070 is taken by AnyDesk
  host: '127.0.0.1',
  dataDir: process.env.ORCHESTRA_DATA_DIR || path.join(ROOT, 'data'),
  runsDir: process.env.ORCHESTRA_RUNS_DIR || path.join(ROOT, 'runs'),
  pageDir: path.join(ROOT, 'page'),
  itpRoot: process.env.ORCHESTRA_ITP_ROOT || 'C:/Workstation/Workspace/ITP',
  // Run workspaces. A short path, because long Windows paths break .NET and node_modules builds.
  // ITP's own dev-parallel uses <drive>:/p, so Orchestra uses <drive>:/o.
  worktreesDir: process.env.ORCHESTRA_WORKTREES_DIR || (process.platform === 'win32' ? 'C:/o' : path.join(ROOT, 'worktrees')),
  // Windows notifications when a run needs you. Tests turn them off.
  notify: process.env.ORCHESTRA_NOTIFY !== '0',
  userEmail: process.env.ORCHESTRA_USER_EMAIL || 'ashap.bappy@orbitax.com',
  homeSkillsDir: path.join(os.homedir(), '.claude', 'skills'),
  // The claude binary. A .mjs path runs with node (used by the tests' fake claude).
  claudeBin: process.env.ORCHESTRA_CLAUDE_BIN || 'claude',
  // Build step 3 replaces this with the full guard policy.
  permissionMode: process.env.ORCHESTRA_PERMISSION_MODE || 'acceptEdits',
  // The shell's ANTHROPIC_API_KEY has no credit, so runs use the claude.ai login instead.
  keepApiKey: process.env.ORCHESTRA_KEEP_API_KEY === '1',
};

config.templatesDir = path.join(config.dataDir, 'templates');
