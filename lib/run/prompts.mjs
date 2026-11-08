// What Orchestra tells the run's Claude: step instructions, the handoff story, wrap-up, the rules, the session settings.
import path from 'node:path';
import { config } from '../config.mjs';
import { pack } from '../pack.mjs';
import { RUN_RULES, DONE_MARK, ABOUT_RULE } from '../guard.mjs';
import { OFF_RULE } from '../tracking.mjs';
import { readInstructionsSync } from '../learn.mjs';
import { WRAP_UP_SKILL } from '../store.mjs';
import { SKILL_RENAMES } from '../upgrade.mjs';
import fs from 'node:fs';
import { HANDOFF_STEPS_CHARS } from '../limits.mjs';

// Given after a step with "explain the code" ticked.
export const EXPLAIN = `Before the next step: walk me through the code this run has changed so far, so I can learn from it. Look at the real changes (git diff against the base branch in each repo of this run). For each important change: name the file with path:line, the pattern or approach used, and why it fits here, plus the simpler or other option and why it was not used. Plain, simple English, short sentences. Do not change any files and do not commit. End with the line ${DONE_MARK} when you are done explaining.`;

// The Wrap up step's line for "keep the folder, do not clean it when the tab closes".
export const KEEP_LINE = /^[ \t*_`>-]*ORCHESTRA:KEEP[ \t*_`]*$\n?/m;

// Told to the first step of a go back: it runs again, why, and what the steps after it found.
export function againText(run, step) {
  if (step.jumpedOver) return jumpText(run, step);
  if (!('why' in step) || !(step.againOf || step.tries?.length)) return '';
  const cut = (v, n) => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const later = (step.after || []).map((id) => run.steps.find((b) => b.id === id)).filter(Boolean)
    .map((b) => { const last = b.tries?.at(-1); return `- ${b.label} (/${b.skill}): ${cut(b.didWhy || b.summary || last?.didWhy || last?.summary || 'done', 600)}`; });
  return [
    ` The user went back to this step: it ran before, and its work is on disk and in git. Build on it; do not start over.`,
    step.why ? ` Why the user went back: ${step.why}` : ' The user did not say why: if it is not clear from the steps below, ask them in one short question first.',
    later.length ? ` What the steps after it did (read their results on disk, like review findings, before you change anything):\n${later.join('\n')}\n` : '',
  ].join('');
}

// The step the user jumped to (orch go forward): which steps were skipped and why. Wrap up hears not to do their work.
function jumpText(run, step) {
  const skipped = step.jumpedOver.length ? ` Steps skipped to get here (not done): ${step.jumpedOver.join(', ')}.` : '';
  const why = step.why ? ` Why: ${step.why.replace(/[.!?]*$/, '.')}` : '';
  const wrap = step.skill === WRAP_UP_SKILL && step.jumpedOver.length ? ' Do not do the skipped steps\' work or say they are done; offer the jobs for what exists now (for example push the vault notes, or a short handover note of what was found and what is left).' : '';
  return ` The user went straight to this step.${skipped}${why}${wrap}`;
}

// A claude that started before the step skills got their short names may only know the old one (setup keeps the old
// copy while a run's tab is open).
const oldName = (skill) => {
  const old = Object.entries(SKILL_RENAMES).find(([, now]) => now === skill)?.[0];
  return old && fs.existsSync(path.join(config.homeSkillsDir, old)) ? `; if /${skill} is not in your skill list, it is /${old}, the same skill under its old name` : '';
};

// The next step, as Claude is told it by the Stop hook (or after `next`).
export function instruction(run, step) {
  if (step.skill === WRAP_UP_SKILL) return wrapUpPrompt(run, step);
  return `Next step of this Orchestra run, step "${step.label}": run the skill /${step.skill}${step.args ? ` with: ${step.args}` : ''} (use the Skill tool${oldName(step.skill)}).${againText(run, step)} When the step is fully finished, end with the WHAT I DID AND WHY section and the line ${DONE_MARK}.`;
}

// A fresh step starts a new conversation (to keep each request small): it is told the story so far, from what the
// steps before wrote, then its own instruction. Plans, epics and code are on disk; the skills read them from there.
export function handoffPrompt(run, step, prompt) {
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const all = run.steps.filter((b) => b.status === 'done' || b.status === 'skipped').map((b) => `- ${b.label} (/${b.skill}): ${b.status === 'skipped' ? 'skipped (not done)' : cut(String(b.didWhy || b.summary || 'done').replace(/\s+/g, ' ').trim(), 1200)}`);
  // The prompt goes on claude's command line (Windows: 32767 chars with the rules and settings): the newest
  // steps first, up to HANDOFF_STEPS_CHARS.
  const done = [];
  let size = 0;
  for (const line of [...all].reverse()) {
    if (size + line.length > HANDOFF_STEPS_CHARS) break;
    done.unshift(line);
    size += line.length + 1;
  }
  if (done.length < all.length) done.unshift(`- (${all.length - done.length} earlier steps left out: their results are on disk)`);
  const ship = run.ship || {};
  const repos = (run.workspace?.repos || []).map((r) => `${r.folder}${r.branch ? ` (branch ${r.branch})` : ' (no branch yet)'}`);
  return [
    `This continues an Orchestra run in a new conversation, to keep it small. The job: ${cut(run.input?.text || '', 600)}${run.about ? ` (${run.about})` : ''}.`,
    done.length ? `What the steps before did:\n${done.join('\n')}` : '',
    ship.epicFolder ? `Epic folder: ${ship.epicFolder}.` : '',
    ship.prUrls?.length ? `Pull requests: ${ship.prUrls.join(', ')}.` : '',
    repos.length ? `This run's worktrees (in the current folder): ${repos.join(', ')}.` : '',
    'Read what you need from disk (the plan, the epic, the code, git log) instead of guessing.',
    prompt,
  ].filter(Boolean).join('\n\n');
}

// What the Wrap up step is told: what Orchestra knows about the run. The skill looks at the rest and asks you.
// A PR is not assumed: some runs have none and still have vault notes or Execution files to push.
export function wrapUpPrompt(run, step) {
  const ship = run.ship || {};
  const repos = (run.workspace?.repos || []).map((r) => `${r.folder}${r.branch ? ` (branch ${r.branch})` : ''}`);
  return [
    `Next step of this Orchestra run, step "${step.label}": run the skill /${step.skill}${step.args ? ` with: ${step.args}` : ''} (use the Skill tool${oldName(step.skill)}). What Orchestra knows about this run:`,
    ...(ship.epicFolder || pack.tracking ? [`- Epic folder: ${ship.epicFolder || 'not known (look in this conversation; there may be none)'}`] : []),
    `- Pull requests: ${ship.prUrls?.length ? ship.prUrls.join(', ') : 'none seen'}`,
    `- This run's repos (worktrees in the current folder): ${repos.join(', ') || 'none'}`,
    ...pack.wrapUpLines(run, config.itpRoot),
    ...(againText(run, step) ? [`-${againText(run, step)}`] : []),
  ].join('\n');
}

// The rules for the session, plus where this run's repos are.
export function runRules(run) {
  const rules = [RUN_RULES, pack.mainRule, ...pack.rules];
  const repos = run.workspace?.ready ? run.workspace.repos : [];
  if (repos.length) {
    const list = repos.map((r) => (r.branch ? `${r.folder} (on branch ${r.branch})` : `${r.folder} (the latest ${r.base.replace(/^origin\//, '')}, no branch yet)`)).join(', ');
    rules.push(`This run has its own git worktrees, inside the current directory: ${list}. Work only there, never in the user's own checkouts (${repos.map((r) => r.source).join(', ')}).`);
    if (repos.some((r) => !r.branch)) {
      rules.push(`A worktree with no branch started from the development branch named above: treat that as the repo's checked-out development branch (for example its release name). Before you commit there, create or switch to the branch your skill's rules call for (for example an epic branch). Do not commit with no branch.`);
    }
  }
  if (run.tracking === false) rules.push(OFF_RULE);
  if (!run.about) rules.push(ABOUT_RULE);
  const mine = readInstructionsSync();
  if (mine) rules.push(`The user's own rules, learned from past runs. Follow them:\n${mine}`);
  return rules.join('\n');
}

// The PreToolUse guard sees these tools.
export const GUARD_MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|mcp__.*[Tt]eamspace.*';

// The MCP servers a run starts and the ones it never starts: the pack's (names as `claude mcp list` shows them).
// (claude.ai connectors stay: their tools are only listed by name until used, so they cost almost nothing.)
export const RUN_MCP = pack.runMcp;
export const RUN_MCP_OFF = pack.runMcpOff;

// Claude settings for the session: the guard, Orchestra's hooks, and its status line.
export function sessionSettings() {
  const q = (p) => `"${p.replace(/\\/g, '/')}"`;
  // Each call takes the Orchestra lock for a moment; 10 minutes covers a long wait for it.
  const hook = (event, extra = {}) => ({ type: 'command', command: `${q(process.execPath)} ${q(path.join(config.root, 'bin', 'hook.mjs'))} ${event}`, timeout: 600, ...extra });
  const on = (event, extra) => [{ hooks: [hook(event, extra)] }];
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(path.join(config.root, 'lib', 'guard-hook.mjs'))}` }] }],
      SessionStart: on('SessionStart'),
      UserPromptSubmit: on('UserPromptSubmit'),
      PostToolUse: [{ matcher: '*', hooks: [hook('PostToolUse')] }],
      Notification: on('Notification'),
      // The Stop hook may wait for the app lock.
      Stop: on('Stop', { timeout: 1800 }),
      SessionEnd: on('SessionEnd', { timeout: 30 }),
    },
    statusLine: { type: 'command', command: hook('status').command },
    // A lighter session: every request carries what loads, so runs load only what they use (your own sessions keep
    // everything). The ITP servers runs use, from the ITP .mcp.json the run folder carries, are pre-approved (each run
    // folder is new; without this Claude asks every run). opensearch is the read-only log search of the bug template.
    enabledMcpjsonServers: RUN_MCP,
    // The rest never connect in runs (they failed there anyway, and FM-MCP fetches a package with npx at each start).
    disabledMcpjsonServers: RUN_MCP_OFF,
    disabledMcpServers: RUN_MCP_OFF,
    enabledPlugins: { 'cowork-plugin-management@synced': false },
    enableArtifact: false,
  });
}
