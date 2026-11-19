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
  // { server: [skills] }: a heavy server of runMcp that starts only in the steps of those skills (a step with mcp=on
  // starts them all). The others of runMcp start in every step.
  mcpOnlyIn: {},
  // The run rule about the main branch, and more rules for every run.
  mainRule: 'Work on a work branch. Commit on, push to, or switch to the main branch (main, master, or the remote\'s default branch) only when the user asked for it: say so in one line first; the push and the switch show the user an Allow prompt.',
  rules: [],
  // Folders that may commit on main locally (a notes repo the team keeps on main). None by default.
  mainOkDirs: () => [],
  // Env vars a run gets when its tracking is off.
  offEnv: {},
  // Tracking: a team tracker and a notes place that skills write to, which a run may be kept away from (tracking
  // off). false: it means nothing for this solution. Else an object (a pack keeps it in its tracking.mjs): tools (MCP tool
  // names, a regex source), commands ([RegExp]), place (the notes place as a command names it, a regex source; it
  // also lives on main), placePath (RegExp on a lower-case path), signs ([[RegExp, why]] in a SKILL.md), what (in
  // words), label (the skills column), message (the block), rule (the run rule).
  tracking: false,
  trackingOffText: 'Tracking is OFF.',
  // Folders the Wrap up step may commit and push on main ((root) => [dir]), and the only files it may commit there
  // (a regex source on the staged paths, or null).
  wrapUpPushDirs: () => [],
  wrapUpCommitOnly: null,
  // What a run shipped besides PR links, read from a reply: (text) => { label: value }.
  shipFrom: () => ({}),
  // Where the solution's own skills are (besides ~/.claude/skills).
  skillsDirs: (root) => (root ? [{ source: 'team', dir: path.join(root, '.claude', 'skills') }] : []),
  // Lines the Wrap up step is told about the run, and what the run page says it does.
  wrapUpLines: () => [],
  wrapUpNote: 'The Wrap up step shows what is left (uncommitted work, unpushed branches, PR links) and cleans up as you pick.',
  // The git hooks also refuse the remote's default branch (besides main and master). A pack whose repos' default
  // branches are development branches turns it off.
  protectDefaultBranch: true,
  // Whether setup installs the core's starter skills (orch-plan, orch-build, orch-review, orch-hello).
  starterSkills: true,
  // The app a step can start and hand to you: { script (in the pack's folder; bin/app.mjs runs it), stopFor(dir)
  // (clean-up and hold: stop it when it serves that folder; returns a note or null) }. Only a pack that knows how.
  // Optional: ownCopies(settings) (true: each run gets its own copy of the app, so steps marked "uses app" wait in no
  // shared line; the script makes room itself), dropFor(dir, runId) (clean-up and delete: delete the run's own copy;
  // a note or null),
  // note(settings) (lines for orch status, or null), help ([{ usage, about }] for orch help, after the app lines).
  app: false,
  // The pack's own settings (orch settings name=value): { name: { values, default, about, words: { value: text } } }.
  settings: {},
  // Clean-up: free what holds a run folder's files from outside it (dir) => note or null.
  freeFiles: null,
  // orch mine: the work you hold in the solution's own tracker, read only: (root, { gitBash, winPath }) =>
  // { items: [{ key, title, state, kind }], who?, problem? }. null: the pack has no tracker list (tickets come from
  // the /orch skill's tracker tools, or you type keys).
  mine: null,
  // The run's env for the solution's own scripts: (workspace) => { NAME: value }.
  workspaceEnv: () => ({}),
  // Names at the solution folder's root that a run folder does not link (besides .git and *.log).
  skipLinks: [],
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
  return detectPack(config.solutionRoot);
}

const name = await activeName();
export const pack = { ...NONE, ...(name === 'none' ? {} : await load(name)), name };
// The pack's own folder (its skills/ and templates/), or null.
export const packDir = name === 'none' ? null : path.join(PACKS_DIR, name);
