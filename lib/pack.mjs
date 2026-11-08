// Packs: what Orchestra knows about one kind of solution (packs/<name>/pack.mjs). The core knows nothing of any
// solution; a pack adds its repo list, run rules, MCP servers, skills, templates and app. No pack: the plain
// defaults below (repos found by themselves, no app, no tracking).
//
// The active pack: ORCHESTRA_PACK, else the one setup saved (settings "pack"), else the first pack whose detect()
// knows the solution folder, else none.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.mjs';

export const PACKS_DIR = path.join(config.root, 'packs');

const NONE = {
  name: 'none',
  about: 'no pack: repos are found in the solution folder; no app',
  detect: () => false,
  // [{ token, dir }] of the repos a run can use; null: the core finds them (the folder itself, or its child repos).
  repoDirs: null,
  // Branches tried first as a new run's starting point (before the checkout's own and the remote's default).
  defaultBases: [],
  // The MCP servers a run starts, and the ones it never starts (names as `claude mcp list` shows them).
  runMcp: [],
  runMcpOff: [],
  // The run rule about the main branch, and more rules for every run.
  mainRule: 'Never commit on, push to, or switch to the main branch (main, master, or the remote\'s default branch).',
  rules: [],
  // Folders that may commit on main locally (a notes repo the team keeps on main). None by default.
  mainOkDirs: () => [],
  // Env vars a run gets when its tracking is off.
  offEnv: {},
  // Whether "tracking" (a team server and notes repo that skills write to) means anything for this solution.
  tracking: false,
  trackingOffText: 'Tracking is OFF.',
  // Where the solution's own skills are (besides ~/.claude/skills).
  skillsDirs: (root) => (root ? [{ source: 'team', dir: path.join(root, '.claude', 'skills') }] : []),
  // Lines the Wrap up step is told about the run, and what the run page says it does.
  wrapUpLines: () => [],
  wrapUpNote: 'The Wrap up step shows what is left (uncommitted work, unpushed branches, PR links) and cleans up as you pick.',
  // Whether setup installs the core's starter skills (orch-plan, orch-build, orch-review, orch-hello).
  starterSkills: true,
  // The app a step can start and hand to you (bin/app.mjs). Only a pack that knows how.
  app: false,
};

function packFile(name) {
  return path.join(PACKS_DIR, name, 'pack.mjs');
}

export function packNames() {
  try {
    return fs.readdirSync(PACKS_DIR).filter((n) => fs.existsSync(packFile(n)));
  } catch {
    return [];
  }
}

const loaded = new Map();
async function load(name) {
  if (!loaded.has(name)) loaded.set(name, (await import(pathToFileURL(packFile(name)).href)).default);
  return loaded.get(name);
}

// The pack that knows this folder, or 'none'.
export async function detectPack(folder) {
  if (!folder) return 'none';
  for (const name of packNames()) {
    try {
      if ((await load(name)).detect?.(folder)) return name;
    } catch {}
  }
  return 'none';
}

async function activeName() {
  const want = process.env.ORCHESTRA_PACK || config.pack;
  if (want === 'none') return 'none';
  if (want && packNames().includes(want)) return want;
  return detectPack(config.itpRoot);
}

const name = await activeName();
export const pack = { ...NONE, ...(name === 'none' ? {} : await load(name)), name };
// The pack's own folder (its skills/ and templates/), or null.
export const packDir = name === 'none' ? null : path.join(PACKS_DIR, name);
