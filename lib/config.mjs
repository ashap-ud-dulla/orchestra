// Paths and settings. Every value can be changed with an env var. Nothing here is tied to one PC: the solution folder
// comes from `orch setup` (saved in data/settings.json, which git does not keep), or ORCHESTRA_SOLUTION_ROOT.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.ORCHESTRA_DATA_DIR || path.join(ROOT, 'data');

// This PC's own settings (orch setup / orch settings write them).
function local() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}
const mine = local();

export const config = {
  root: ROOT,
  dataDir,
  runsDir: process.env.ORCHESTRA_RUNS_DIR || path.join(ROOT, 'runs'),
  // Starter templates and skill marks, kept in git. orch setup copies them into dataDir once.
  defaultsDir: path.join(ROOT, 'defaults'),
  // The solution folder (your repos, or one repo; the pack reads its own files there). null: none set up.
  solutionRoot: process.env.ORCHESTRA_SOLUTION_ROOT || mine.solution || null,
  // The pack for this solution (packs/<name>): saved by setup; none found = detected from the folder.
  pack: process.env.ORCHESTRA_PACK || mine.pack || null,
  // Run workspaces. A short path, because long Windows paths break .NET and node_modules builds.
  worktreesDir: process.env.ORCHESTRA_WORKTREES_DIR || mine.worktreesDir || (process.platform === 'win32' ? 'C:/o' : path.join(ROOT, 'worktrees')),
  // Your email (orch setup takes it from git in the solution folder). Some packs name your own skills folder by it.
  userEmail: process.env.ORCHESTRA_USER_EMAIL || mine.userEmail || null,
  // Windows notifications when a run needs you. Tests turn them off.
  notify: process.env.ORCHESTRA_NOTIFY !== '0',
  // Where Claude Code looks for personal skills; orch setup installs Orchestra's skills there.
  homeSkillsDir: process.env.ORCHESTRA_HOME_SKILLS || path.join(os.homedir(), '.claude', 'skills'),
  // Where Claude keeps its conversations (one file per session). Clean-up removes a cleaned run's files.
  claudeProjectsDir: process.env.ORCHESTRA_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects'),
  // The claude binary. A .mjs path runs with node (used by the tests' fake claude).
  claudeBin: process.env.ORCHESTRA_CLAUDE_BIN || 'claude',
  // How a run's terminal tab opens: 'wt' (Windows Terminal), or 'none' (tests: nothing opens).
  terminal: process.env.ORCHESTRA_TERMINAL || 'wt',
  // A shell ANTHROPIC_API_KEY would bill the API; runs use the claude.ai login unless this is 1.
  keepApiKey: process.env.ORCHESTRA_KEEP_API_KEY === '1',
};

config.templatesDir = path.join(config.dataDir, 'templates');
