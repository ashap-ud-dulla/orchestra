// What a run may not do on its own. Used by the Claude PreToolUse hook (guard-hook.mjs).
// Push and PR commands get Claude's Allow prompt, a push to `main` and switching to it too. The one refusal: the
// folders the pack keeps on main (its notes, its own folder) push only while the Wrap up step works.
import fs from 'node:fs';
import path from 'node:path';
import { WRAP_UP_FLAG } from './store.mjs';
import { pack } from './pack.mjs';
import { TICKET_KEY } from './util.mjs';

export const DONE_MARK = 'ORCHESTRA:DONE';
export const FAILED_MARK = 'ORCHESTRA:FAILED';
export const ABOUT_MARK = 'ORCHESTRA:ABOUT:';

// Asked until the run knows what its ticket is about. Orchestra shows the line next to the run's steps.
export const ABOUT_RULE = `Once you know what this run's ticket or job is about (for example after you first read the Jira ticket), put one line in your reply that starts with ${ABOUT_MARK} followed by the ticket title, then a dash and one short, plain sentence on what has to change. Write it only once. It reminds the user what this run is for.`;

// The ABOUT line in a reply, if any. Returns the reply without it.
export function readAbout(text) {
  const t = String(text || '');
  const m = t.match(/^[ \t*_`>-]*ORCHESTRA:ABOUT:[ \t*_`]*(.+)$/m);
  if (!m) return { about: null, text: t };
  const about = m[1].replace(/[*_`]+\s*$/, '').trim().slice(0, 400);
  return { about: about || null, text: t.replace(m[0], '').replace(/\n{3,}/g, '\n\n') };
}

// The task the run works on, said by its first step (intake): "ORCHESTRA:TASK ABC-123 | The title". The run then
// takes that key as its name. Returns the reply without the line.
export const TASK_MARK = 'ORCHESTRA:TASK';
const TASK_RE = new RegExp(`^[ \\t*_\`>-]*ORCHESTRA:TASK:?[ \\t*_\`]*(${TICKET_KEY})[ \\t]*(?:\\|[ \\t]*(.*?))?[ \\t*_\`]*$`, 'im');
export function readTask(text) {
  const t = String(text || '');
  const m = t.match(TASK_RE);
  if (!m) return { task: null, text: t };
  return { task: { key: m[1].toUpperCase(), title: (m[2] || '').trim().slice(0, 300) || null }, text: t.replace(m[0], '').replace(/\n{3,}/g, '\n\n') };
}

// The steps the first step suggested and the ones the user chose: "ORCHESTRA:PLAN suggested: a > b | chosen: a".
// Kept on the run, so the lessons can learn from the changes. Returns the reply without the line.
export function readPlan(text) {
  const t = String(text || '');
  const m = t.match(/^[ \t*_`>-]*ORCHESTRA:PLAN:?[ \t*_`]*(.+?)[ \t*_`]*$/m);
  if (!m) return { plan: null, text: t };
  const part = (k) => (new RegExp(`${k}:\\s*([^|]*)`, 'i').exec(m[1])?.[1] || '').trim();
  return { plan: { suggested: part('suggested').slice(0, 600), chosen: part('chosen').slice(0, 600) }, text: t.replace(m[0], '').replace(/\n{3,}/g, '\n\n') };
}

// Something the user asked for in plain words, for Orchestra to do after this reply: "ORCHESTRA:DO go wrap-up why".
// The words are what would follow /orch in the run's tab. Returns the reply without the line.
export const DO_MARK = 'ORCHESTRA:DO';
export function readDo(text) {
  const t = String(text || '');
  const m = t.match(/^[ \t*_`>-]*ORCHESTRA:DO\b(?!NE):?[ \t*_`]*(.+?)[ \t*_`]*$/m);
  if (!m) return { command: null, text: t };
  return { command: m[1].trim().slice(0, 500), text: t.replace(m[0], '').replace(/\n{3,}/g, '\n\n') };
}

// Pins: steps the user follows by hand (a test click path, values to pick). Claude wraps them in a PIN block;
// Orchestra keeps a copy in the steps pane, so they stay in sight while the talk goes on.
export const PIN_MARK = 'ORCHESTRA:PIN';
export const PIN_END = 'ORCHESTRA:END';
const PIN_HEAD = /^[ \t*_`>#-]*ORCHESTRA:PIN(?![\w:]*END)\b[ \t:*_`-]*(.*)$/;
const PIN_TAIL = /^[ \t*_`>#-]*ORCHESTRA:END\b.*$/;
const MAX_PIN = 20000;

// Every PIN block in a reply. Returns the pins ({ title, text }) and the reply with the marker lines taken out
// (the steps stay: the user saw them in the chat). A block with no END line runs to the WHAT I DID AND WHY part,
// or to the end.
export function readPins(text) {
  const lines = String(text || '').split('\n');
  const pins = [];
  const keep = [];
  let cur = null;
  const close = () => {
    const body = cur.lines.join('\n').replace(/^\s*\n|\s+$/g, '');
    if (body.trim()) pins.push({ title: cur.title || firstWords(body), text: body.slice(0, MAX_PIN) });
    cur = null;
  };
  for (const line of lines) {
    const head = PIN_HEAD.exec(line);
    if (head) {
      if (cur) close();
      cur = { title: head[1].replace(/[*_`]+\s*$/, '').trim().slice(0, 80), lines: [] };
      continue;
    }
    if (cur && PIN_TAIL.test(line)) {
      close();
      continue;
    }
    // No END line: the block ends at the notes or at the step's DONE / FAILED line.
    if (cur && (WHY_HEAD.test(line) || readMark(line).mark)) close();
    if (cur) cur.lines.push(line);
    keep.push(line);
  }
  if (cur) close();
  return { pins, text: pins.length ? keep.join('\n') : String(text || '') };
}

export function firstWords(text, n = 6) {
  const words = String(text || '').replace(/[#*_`>]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ').slice(0, 60) + (words.length > n ? '…' : '');
}

// The rules every session gets, added to Claude's system prompt.
export const RUN_RULES = [
  'You are running inside Orchestra, a workflow runner. This is an interactive session: the user is at this terminal. Ask questions the normal way (AskUserQuestion works) whenever you need their decision.',
  'Before each question, say the cause in 2 or 3 plain lines (what you found, why it matters), then ask one decision at a time. Anything the user will see on screen (a title, a label, a color, a message) is asked, never guessed.',
  'Orchestra gives you one workflow step at a time (a skill to run). Do only that step.',
  `When the step is fully finished, end your final reply with a short section that starts with the line WHAT I DID AND WHY: followed by 2 to 5 short bullets in plain, simple English (what you did, and why you did it that way: the choice and the reason; the user learns from these notes), then one line that starts with Not done: (what this step left open: findings not fixed, pushes not done, checks skipped or not run; "Not done: nothing" when nothing is open), and then the line ${DONE_MARK} as the very last line. Orchestra then gives you the next step.`,
  `If the step cannot be done, say why and end with the line ${FAILED_MARK}. While you are still working, asking, or waiting for the user, end with neither line.`,
  `When you give the user steps to follow by hand (a test click path, the exact values to pick, commands to run), put them between a line ${PIN_MARK} <short title> and a line ${PIN_END}. Write them once, inside the block: the user sees them in the chat, and Orchestra keeps a copy in the side pane so they stay in sight while you talk. Use it only for such steps.`,
  'Pushing and opening pull requests show the user an Allow prompt. Say what you push (repo, branch, commits) and why, just before you do it.',
  'If the file .orchestra/task.md exists in the run folder (the current directory), it is the task this run works on: read it before each step.',
  `When the user asks in their own words to move the run (go back or forward to a step, skip this step, redo it, put the run on hold, hand over or wrap up early, change the model or effort, pin or unpin), do not do it yourself: Orchestra does it. For going back, going forward or a hand-over, first say in one line what will happen (which steps run again, or which are skipped and not done) and ask yes or no. After the yes (right away for the others), end your reply with one line ${DO_MARK} <command>, where <command> is what would follow /orch in this tab: go <step> <why> (back or forward; a hand-over is go wrap-up <why>), skip, redo, next, model <model> effort=<effort>, hold <why>, pin, pin 2, unpin, unpin 2. Only when the user asked, one per reply, as the last line, and never in a reply that ends with ${DONE_MARK} or ${FAILED_MARK} (one exception: hold after a finished step, before ${DONE_MARK}).`,
].join('\n'); // + the pack's main-branch rule (lib/run/prompts.mjs runRules)

// The plain "what I did and why" note at the end of a finished step. Returns the reply without it.
const WHY_HEAD = /^[ \t#*_>]*what i did and why[ \t]*:?[ \t*_]*/im;
export function readWhy(text) {
  const t = String(text || '');
  const m = WHY_HEAD.exec(t);
  if (!m) return { text: t, why: null };
  return { text: t.slice(0, m.index).replace(/\s+$/, ''), why: t.slice(m.index + m[0].length).trim() || null };
}

// git [global options] push ...
const PUSH = /\bgit(?:\.exe)?\b(?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--?[\w-]+(?:=\S+)?)*\s+push\b/i;
const PR = /\bgh(?:\.exe)?\s+pr\s+(?:create|merge)\b/i;
// main and master (the git hooks also know the remote's default branch, where they can ask git).
const SWITCH_MAIN = /\bgit(?:\.exe)?\b[^;&|\n]*?\s(?:checkout|switch)\s+(?:-\S+\s+)*(?:main|master)(?=\s*$|\s*[;&|\n])/i;

// The part of the command from `start` up to the next ; & | or line break.
function segment(cmd, start) {
  const rest = cmd.slice(start);
  const end = rest.search(/[;&|\n]/);
  return end < 0 ? rest : rest.slice(0, end);
}

// One spelling for paths, so C:\x, C:/x and /c/x all match, anywhere in a command.
const canon = (p) => String(p).replace(/\\/g, '/').replace(/(^|[\s"'=(;&|])\/([a-z])\//gi, '$1$2:/').toLowerCase();

// Your own checkouts of the run's repos (ORCHESTRA_PROTECT, one per line). The run has its own worktrees.
function protectedHit(text, env) {
  const t = canon(text);
  for (const dir of String(env.ORCHESTRA_PROTECT || '').split('\n').filter(Boolean)) {
    const d = canon(dir).replace(/\/+$/, '');
    let i = t.indexOf(d);
    while (i >= 0) {
      if (!/[\w.-]/.test(t[i + d.length] || '')) return dir;
      i = t.indexOf(d, i + 1);
    }
  }
  return null;
}

// ---- tracking OFF (ORCHESTRA_TRACKING=off): the pack names what tracking is (its tracker and its notes place) ----

// Shell commands that change files in the pack's place. cp, Copy-Item and rsync count only when the place is the
// target (last word).
function placeWrites(place) {
  const p = `(?:${place})`;
  return [
    new RegExp(`(?:>>?|\\|\\s*tee\\b[^;&|\\n]*)\\s*["']?[^\\s"';&|]*${p}`),
    new RegExp(`\\b(?:mv|rm|rmdir|mkdir|touch|tee|ln|unlink|truncate|New-Item|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Rename-Item|Clear-Content)\\b[^;&|\\n]*${p}`, 'i'),
    new RegExp(`\\b(?:cp|Copy-Item|rsync)\\b[^;&|\\n]*\\s["']?[^\\s"';&|]*${p}[^\\s;&|]*["']?\\s*(?=$|[;&|\\n])`, 'i'),
    new RegExp(`\\bsed\\b[^;&|\\n]*\\s-i[^;&|\\n]*${p}`),
    new RegExp(`\\bgit\\b[^;&|\\n]*${p}[^;&|\\n]*\\s(?:commit|add|rm|mv|push|pull|merge|rebase|reset|checkout|switch|stash|restore|clean|cherry-pick|revert|apply|am)\\b`),
    new RegExp(`(?:^|[;&|\\n(])\\s*cd\\s+["']?[^\\s"';&|]*${p}[^;\\n]*(?:&&|;)[^\\n]*\\bgit\\s+(?:commit|add|rm|mv|push|pull|merge|rebase|reset|checkout|switch|stash|restore|clean)\\b`),
  ];
}

function trackingOffHit(toolName, toolInput, t) {
  if (t.tools && new RegExp(`^(?:${t.tools})$`).test(toolName)) return true; // the tracker's own MCP tools
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return !!t.placePath && t.placePath.test(canon(toolInput?.file_path ?? toolInput?.notebook_path ?? ''));
  }
  if (!['Bash', 'PowerShell'].includes(toolName)) return false;
  const cmd = String(toolInput?.command ?? '');
  if ((t.commands || []).some((re) => re.test(cmd))) return true;
  return !!t.place && new RegExp(t.place).test(cmd) && placeWrites(t.place).some((re) => re.test(cmd));
}

// ---- the Wrap up step ----

// Orchestra writes the flag in the run's folder while the Wrap up step works in the open tab.
function wrapUpOn(env) {
  return !!env.ORCHESTRA_RUN_DIR && fs.existsSync(path.join(env.ORCHESTRA_RUN_DIR, WRAP_UP_FLAG));
}

// One of the folders (one per line) named as a whole path: not a folder inside it.
function dirHit(text, dirs) {
  const t = canon(text);
  for (const dir of String(dirs || '').split('\n').filter(Boolean)) {
    const root = canon(dir).replace(/\/+$/, '');
    for (let i = t.indexOf(root); i >= 0; i = t.indexOf(root, i + 1)) {
      if (/^\/?(?:["'\s;&|)]|$)/.test(t.slice(i + root.length))) return true;
    }
  }
  return false;
}

// A command line aimed at a folder where main is fine: the pack's place (named as the pack writes it), a folder that
// may work on main (ORCHESTRA_MAIN_OK), or, while Wrap up works, one it may push (ORCHESTRA_WRAPUP_DIRS).
function mainOkHit(line, env, t, wrapUp) {
  if (t?.place && new RegExp(t.place).test(line)) return true;
  if (dirHit(line, env.ORCHESTRA_MAIN_OK)) return true;
  return wrapUp && (/\$\{?ORCHESTRA_WRAPUP_DIRS\b/.test(line) || dirHit(line, env.ORCHESTRA_WRAPUP_DIRS));
}

// The run's own folder holds Orchestra's state and the flag: the run's Claude may not change it.
function runDirHit(text, env) {
  if (/wrap-up\.ok/i.test(text)) return true;
  const dir = canon(env.ORCHESTRA_RUN_DIR || '').replace(/\/+$/, '');
  return !!dir && canon(text).startsWith(dir);
}
const RUN_DIR_MESSAGE = "Orchestra: that is Orchestra's own record of this run. Do not change it.";

// Returns null when the command may run, or { message, needsApproval } when it must be blocked.
// tracking: the pack's (lib/pack.mjs), or false.
export function check(toolName, toolInput, env = process.env, tracking = pack.tracking) {
  if (env.ORCHESTRA_TRACKING === 'off' && tracking && trackingOffHit(String(toolName || ''), toolInput, tracking)) {
    return { needsApproval: false, message: tracking.message };
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    if (runDirHit(toolInput?.file_path ?? toolInput?.notebook_path ?? '', env)) return { needsApproval: false, message: RUN_DIR_MESSAGE };
    const dir = protectedHit(toolInput?.file_path ?? toolInput?.notebook_path ?? '', env);
    return dir ? { needsApproval: false, message: `Orchestra: ${dir} is the user's own checkout. This run works in its own worktree of that repo (same folder name, inside the current directory). Edit there.` } : null;
  }
  if (!['Bash', 'PowerShell'].includes(toolName)) return null;
  const cmd = String(toolInput?.command ?? '');
  if (/wrap-up\.ok/i.test(cmd)) return { needsApproval: false, message: RUN_DIR_MESSAGE };
  const dir = protectedHit(cmd, env);
  if (dir) {
    return { needsApproval: false, message: `Orchestra: ${dir} is the user's own checkout. This run works in its own worktree of that repo (same folder name, inside the current directory). Use a relative path from there.` };
  }
  const push = PUSH.exec(cmd);
  if (push) {
    const seg = segment(cmd, push.index);
    if (/\s--no-verify\b/.test(seg)) {
      return { needsApproval: false, message: 'Orchestra refuses `git push --no-verify`. Push without it, after the user approves.' };
    }
    // A push to main asks you, like any push. The folders the pack keeps on main (its notes, its own folder) push
    // only while the Wrap up step works.
    const line = cmd.slice(Math.max(0, cmd.lastIndexOf('\n', push.index)), push.index + push[0].length);
    if (/(?:\s|:|\+)(?:refs\/heads\/)?(?:main|master)(?=\s|$|["'])/.test(seg)) {
      if (mainOkHit(line, env, tracking, true) && !wrapUpOn(env)) {
        return { needsApproval: false, message: 'Orchestra: this folder is pushed to main only in the Wrap up step.' };
      }
      if (env.ORCHESTRA_ALLOW_PUSH !== '1') {
        return { needsApproval: true, message: 'Orchestra: this pushes to the main branch. Allow only if you mean it.' };
      }
    }
  }
  // Switching to main asks you, except in the folders that live on main (the pack's place, ORCHESTRA_MAIN_OK).
  const sw = SWITCH_MAIN.exec(cmd);
  if (sw && !mainOkHit(cmd.slice(Math.max(0, cmd.lastIndexOf('\n', sw.index)), sw.index + sw[0].length), env, tracking, false)) {
    return { needsApproval: true, message: 'Orchestra: this switches to the main branch. Allow only if you mean it.' };
  }
  if ((push || PR.test(cmd)) && env.ORCHESTRA_ALLOW_PUSH !== '1') {
    return { needsApproval: true, message: 'Orchestra: pushing and opening pull requests need your OK. Check what is pushed, then allow or deny.' };
  }
  return null;
}

// Finds a marker on the last non-empty line of a reply. Returns the reply without it.
export function readMark(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const last = (lines.at(-1) || '').replace(/[*`_\s]/g, '');
  for (const mark of [DONE_MARK, FAILED_MARK]) {
    if (last === mark) return { mark, text: lines.slice(0, -1).join('\n').replace(/\s+$/, '') };
  }
  return { mark: null, text: String(text || '') };
}
