// What Orchestra tells the run's Claude: step instructions, the handoff story, wrap-up, the rules, the session settings.
import path from 'node:path';
import { config } from '../config.mjs';
import { pack } from '../pack.mjs';
import { RUN_RULES, DONE_MARK, ABOUT_RULE, DO_MARK } from '../guard.mjs';
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
  const wrap = step.skill === WRAP_UP_SKILL && step.jumpedOver.length ? ' Do not do the skipped steps\' work or say they are done; offer the jobs for what exists now (for example push notes that were written). Handing over: first write the handover note (.orchestra/handover.md), as the skill says.' : '';
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
  return `Next step of this Orchestra run, step "${step.label}": run the skill /${step.skill}${step.args ? ` with: ${step.args}` : ''} (use the Skill tool${oldName(step.skill)}).${againText(run, step)} When the step is fully finished, end with the WHAT I DID AND WHY section and the line ${DONE_MARK}.${pickText(run)}`;
}

// A failed step: Claude asks what to do next, with a click (never "type redo").
export function failAsk(step) {
  return `The step "${step.label}" failed. Before you ask, say the cause in 2 or 3 plain lines. Then ask the user what to do with AskUserQuestion (one question, a click): "Run it again" (Recommended; say in its description what you would change), "Skip it" (the run goes on without it), "Go to another step" (name the one or two that fit). After the click, end your reply with one line: ${DO_MARK} redo, ${DO_MARK} skip, or ${DO_MARK} go <step> <why>. Do not run the step again yourself.`;
}

// A tab reopened on the same conversation: Claude asks how to go on, with a click (not a blank wait).
export function reopenPrompt(run) {
  const cur = run.steps.find((s) => s.status === 'running');
  const failed = run.steps.find((s) => s.status === 'failed');
  const next = run.steps.find((s) => s.status === 'pending');
  const ask = 'Orchestra reopened this tab on the same conversation. Ask the user with AskUserQuestion (one question, a click) how to go on, and do nothing else before the answer:';
  if (failed) return `Orchestra reopened this tab on the same conversation. ${failAsk(failed)}`;
  if (run.hold && !cur && !next && run.guide) return `${ask} the next step (the pick in your run rules) with one more option, "Keep it on hold". This run was put on hold after a step ended${run.hold.why ? ` (${run.hold.why})` : ''}. After a step is picked: add it with ${orchCmd()} steps this add <guide step id or skill>, then end your reply with the line ${DO_MARK} next. Keep: say in one line that it stays on hold, and end with nothing.`;
  if (run.hold) return `${ask} "Go on with ${(cur || next)?.label || 'the run'}" (Recommended) · "Keep it on hold". This run was put on hold${run.hold.why ? ` (${run.hold.why})` : ''}. Go on: end your reply with the line ${DO_MARK} next. Keep: say in one line that it stays on hold, and end with nothing.`;
  if (cur) return `${ask} "Go on where it stopped" (Recommended) · "Start ${cur.label} again" · "Put the run on hold". The tab closed while the step "${cur.label}" worked. Go on: carry on with the step from where you were (read what is on disk first). Start again: end your reply with the line ${DO_MARK} redo. Hold: end it with ${DO_MARK} hold <why, in a few words>.`;
  if (next) return `${ask} "Start ${next.label}" (Recommended) · "Not now" · "Put the run on hold". Start: end your reply with the line ${DO_MARK} next. Not now: say in one line that the run waits, and end with nothing. Hold: end it with ${DO_MARK} hold <why, in a few words>.`;
  return '';
}

// A guided run: the next-step pick, in full when this claude's rules do not have it yet (the guide came later).
export function pickText(run) {
  if (!run.guide) return '';
  if (!run.session?.pickRule) return `\n\n${pickRule(run)}`;
  return ' Before that line, ask the user which step comes next (the pick in your run rules).';
}

// A fresh step starts a new conversation (to keep each request small): it is told the story so far, from what the
// steps before wrote, then its own instruction. Plans and code are on disk; the skills read them from there.
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
    ...Object.entries(ship.notes || {}).map(([k, v]) => `${k}: ${v}.`),
    ship.prUrls?.length ? `Pull requests: ${ship.prUrls.join(', ')}.` : '',
    repos.length ? `This run's worktrees (in the current folder): ${repos.join(', ')}.` : '',
    'Read what you need from disk (the plan, the code, git log) instead of guessing.',
    prompt,
  ].filter(Boolean).join('\n\n');
}

// What the Wrap up step is told: what Orchestra knows about the run. The skill looks at the rest and asks you.
// A PR is not assumed: some runs have none and still have notes or files to push (the pack's lines say which).
export function wrapUpPrompt(run, step) {
  const ship = run.ship || {};
  const repos = (run.workspace?.repos || []).map((r) => `${r.folder}${r.branch ? ` (branch ${r.branch})` : ''}`);
  return [
    `Next step of this Orchestra run, step "${step.label}": run the skill /${step.skill}${step.args ? ` with: ${step.args}` : ''} (use the Skill tool${oldName(step.skill)}). What Orchestra knows about this run:`,
    ...Object.entries(ship.notes || {}).map(([k, v]) => `- ${k}: ${v}`),
    `- Pull requests: ${ship.prUrls?.length ? ship.prUrls.join(', ') : 'none seen'}`,
    `- This run's repos (worktrees in the current folder): ${repos.join(', ') || 'none'}`,
    ...pack.wrapUpLines(run, config.solutionRoot),
    ...(againText(run, step) ? [`-${againText(run, step)}`] : []),
  ].join('\n');
}

// A guided run picks its steps one at a time: Claude suggests, the user clicks. The pick happens before the DONE line,
// so the run goes straight into the step that was added (with nothing added, DONE ends the run).
export function pickRule(run) {
  const orch = orchCmd();
  return [
    `This run picks its steps one at a time with the user; the template "${run.guide.name}" is only a guide. When the work of a step is done (and only then), before the WHAT I DID AND WHY section and the ${DONE_MARK} line, ask which step comes next with AskUserQuestion: one question, the user clicks (never make them type a command). The options, in this order:`,
    `- Open items first: if this step left anything open (findings not fixed, a failure, something not done or not checked), an option "Handle them now", with the items in its description, one short line each. If picked, handle them in this step (ask first where a choice is the user's; an item the user waives needs their reason, write it down), say what is fixed and what is left, then ask this question again.`,
    `- The usual next step: the first one under "Likely next" in ${orch} run this, marked (Recommended) when nothing is open.`,
    `- One or two other steps that fit what this step learned (a later guide step, or a skill found with ${orch} skills <words>), each with its reason.`,
    `- "Done": no more steps (when the guide has a wrap-up step not picked yet, offer it as its own option instead).`,
    `- "Put the run on hold": the user comes back to it later (it frees the run's slot and the app). If picked: add nothing; end with the WHAT I DID AND WHY section, then a line ${DO_MARK} hold <why, in a few words>, then ${DONE_MARK}. Reopening the tab later asks for the next step.`,
    `Each option: the step's label, one plain reason, its model and effort, its usual cost and AI time when "Likely next" shows them (for example "opus high, usually $3 and 14 min"), and "restarts the tab" when its model, effort or new conversation differs from yours. After the click, add it with ${orch} steps this add <guide step id or skill> (a guide step keeps its own settings), then end the reply with the WHAT I DID AND WHY section and ${DONE_MARK}: the run goes into the new step by itself. "Done" with nothing to add: just end with ${DONE_MARK}; the run then finishes. To change or drop a step that is already in, use ${orch} steps this set|remove|move, after the user's yes.`,
  ].join('\n');
}

// The rules for the session, plus where this run's repos are.
export function runRules(run) {
  const rules = [RUN_RULES, pack.mainRule, ...pack.rules];
  if (run.guide) rules.push(pickRule(run));
  // Re-plan: the steps still to come follow what the run learns, always after the user's yes.
  else rules.push(`When a step ends and what it learned changes which of the steps still to come are needed (one no longer fits, one is missing), say so in one line each, with the reason, and ask. After the yes, change them with ${orchCmd()} steps this add|remove|set|move … (see ${orchCmd()} run this). Never change the steps without asking.`);
  const repos = run.workspace?.ready ? run.workspace.repos : [];
  if (repos.length) {
    const list = repos.map((r) => (r.branch ? `${r.folder} (on branch ${r.branch})` : `${r.folder} (the latest ${r.base.replace(/^origin\//, '')}, no branch yet)`)).join(', ');
    rules.push(`This run has its own git worktrees, inside the current directory: ${list}. Work only there, never in the user's own checkouts (${repos.map((r) => r.source).join(', ')}).`);
    if (repos.some((r) => !r.branch)) {
      rules.push(`A worktree with no branch started from the development branch named above: treat that as the repo's checked-out development branch (for example its release name). Before you commit there, create or switch to the branch your skill's rules call for (for example a feature branch). Do not commit with no branch.`);
    }
  }
  if (run.tracking === false) rules.push(OFF_RULE);
  if (!run.about || run.aboutSoft) rules.push(ABOUT_RULE);
  const mine = readInstructionsSync();
  if (mine) rules.push(`The user's own rules, learned from past runs. Follow them:\n${mine}`);
  return rules.join('\n');
}

// The PreToolUse guard sees these tools.
export const GUARD_MATCHER = ['Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', pack.tracking?.tools].filter(Boolean).join('|');

// The MCP servers a run starts and the ones it never starts: the pack's (names as `claude mcp list` shows them).
// (claude.ai connectors stay: their tools are only listed by name until used, so they cost almost nothing.)
export const RUN_MCP = pack.runMcp;
export const RUN_MCP_OFF = pack.runMcpOff;
// The servers a step starts: the pack's heavy ones only in the skills that use them (mcpOnlyIn), all with mcp=on.
export function mcpFor(step) {
  const only = pack.mcpOnlyIn || {};
  return RUN_MCP.filter((s) => step?.mcp || !only[s] || only[s].includes(step?.skill));
}

// How a run's Claude calls orch (the skills write it the same way: node {{ORCHESTRA}}/bin/orch.mjs …).
export const orchCmd = () => `node ${config.root.replace(/\\/g, '/')}/bin/orch.mjs`;
// The orch commands a run may run without asking: on its own run, and read-only ones.
export const RUN_ORCH = ['use this', 'steps this', 'template from this', 'skill-mark', 'runs', 'run this', 'stats', 'templates', 'template show', 'skills'];

// Claude settings for the session: the guard, Orchestra's hooks, and its status line.
export function sessionSettings(mcpOn = RUN_MCP) {
  const mcpOff = [...RUN_MCP_OFF, ...RUN_MCP.filter((s) => !mcpOn.includes(s))];
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
    // The run's Claude may run these orch commands with no Allow prompt: the ones on its own run ("this") and the
    // read-only ones its first step uses to pick the steps. Anything else still asks.
    permissions: { allow: RUN_ORCH.map((c) => `Bash(${orchCmd()} ${c}:*)`) },
    // A lighter session: every request carries what loads, so runs load only what they use (your own sessions keep
    // everything). The pack's servers runs use, from the .mcp.json the run folder carries, are pre-approved (each run
    // folder is new; without this Claude asks every run). opensearch is the read-only log search of the bug template.
    // Only this step's ones start (mcpFor); a later step that needs another restarts claude (wantsRestart).
    enabledMcpjsonServers: mcpOn,
    // The rest never connect in runs (they failed there anyway, and FM-MCP fetches a package with npx at each start).
    disabledMcpjsonServers: mcpOff,
    disabledMcpServers: mcpOff,
    enabledPlugins: { 'cowork-plugin-management@synced': false },
    enableArtifact: false,
  });
}
