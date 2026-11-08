// What a run may not do on its own. Used by the Claude PreToolUse hook (guard-hook.mjs).
// Push and PR commands get Claude's Allow prompt. Anything aimed at `main` is refused, except while the Wrap up
// step works: then the vault and the ITP folder (both live on main) may push, still after the Allow prompt.
import fs from 'node:fs';
import path from 'node:path';
import { WRAP_UP_FLAG } from './store.mjs';

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
  'Orchestra gives you one workflow step at a time (a skill to run). Do only that step.',
  `When the step is fully finished, end your final reply with a short section that starts with the line WHAT I DID AND WHY: followed by 2 to 5 short bullets in plain, simple English (what you did, and why you did it that way: the choice and the reason; the user learns from these notes), and then the line ${DONE_MARK} as the very last line. Orchestra then gives you the next step.`,
  `If the step cannot be done, say why and end with the line ${FAILED_MARK}. While you are still working, asking, or waiting for the user, end with neither line.`,
  `When you give the user steps to follow by hand (a test click path, the exact values to pick, commands to run), put them between a line ${PIN_MARK} <short title> and a line ${PIN_END}. Write them once, inside the block: the user sees them in the chat, and Orchestra keeps a copy in the side pane so they stay in sight while you talk. Use it only for such steps.`,
  'Pushing and opening pull requests show the user an Allow prompt. Say what you push (repo, branch, commits) and why, just before you do it.',
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
const SWITCH_MAIN = /\bgit(?:\.exe)?\b[^;&|\n]*?\s(?:checkout|switch)\s+(?:-\S+\s+)*main(?=\s*$|\s*[;&|\n])/i;

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

// ---- tracking OFF (ORCHESTRA_TRACKING=off): no Teamspace, no writes to the vault ----

// The teamspace program, its helpers, its server, and the ITP scripts that sync to it.
const TEAMSPACE = [
  /teamspace\.exe/i,
  /(?:^|[;&|\n(]|\/)\s*teamspace["']?(?=\s|$)/,
  /\bteamspace_bin\b|\$\{?TEAMSPACE_BIN\b/,
  /\bregistry_call\b|\bboard_sync_status\b|\bREGISTRY_URL=|registry-url|\bITP_REGISTRY_OFF=(?!1)/,
  /https?:\/\/[^\s"']*teamspace/i,
  /\b(?:close-epic|sync-[\w-]+|doc-sync|teamspace-env|install-teamspace|register-autopilot-usecases)\.(?:sh|ps1)\b/,
];
const VAULT = /(?:\bITPKV\b|\$\{?VAULT_DIR\b)/;
// Shell commands that change files. cp, Copy-Item and rsync count only when the vault is the target (last word).
const VAULT_WRITE = [
  /(?:>>?|\|\s*tee\b[^;&|\n]*)\s*["']?[^\s"';&|]*(?:ITPKV|\$\{?VAULT_DIR)/,
  /\b(?:mv|rm|rmdir|mkdir|touch|tee|ln|unlink|truncate|New-Item|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Rename-Item|Clear-Content)\b[^;&|\n]*(?:ITPKV|\$\{?VAULT_DIR)/i,
  /\b(?:cp|Copy-Item|rsync)\b[^;&|\n]*\s["']?[^\s"';&|]*(?:ITPKV|\$\{?VAULT_DIR)[^\s;&|]*["']?\s*(?=$|[;&|\n])/i,
  /\bsed\b[^;&|\n]*\s-i[^;&|\n]*(?:ITPKV|\$\{?VAULT_DIR)/,
  /\bgit\b[^;&|\n]*(?:ITPKV|\$\{?VAULT_DIR)[^;&|\n]*\s(?:commit|add|rm|mv|push|pull|merge|rebase|reset|checkout|switch|stash|restore|clean|cherry-pick|revert|apply|am)\b/,
  /(?:^|[;&|\n(])\s*cd\s+["']?[^\s"';&|]*(?:ITPKV|\$\{?VAULT_DIR)[^;\n]*(?:&&|;)[^\n]*\bgit\s+(?:commit|add|rm|mv|push|pull|merge|rebase|reset|checkout|switch|stash|restore|clean)\b/,
];
const OFF_MESSAGE = 'Orchestra: tracking is OFF for this run, so Teamspace and writes to the vault (ITPKV) are blocked. Do not try another way. Go on without it, or say in your final reply what you needed and stop.';

function trackingOffHit(toolName, toolInput) {
  if (/teamspace/i.test(toolName)) return true; // an MCP tool for Teamspace
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return /(?:^|\/)itpkv(?:\/|$)/.test(canon(toolInput?.file_path ?? toolInput?.notebook_path ?? ''));
  }
  if (!['Bash', 'PowerShell'].includes(toolName)) return false;
  const cmd = String(toolInput?.command ?? '');
  if (TEAMSPACE.some((re) => re.test(cmd))) return true;
  return VAULT.test(cmd) && VAULT_WRITE.some((re) => re.test(cmd));
}

// ---- the Wrap up step ----

// Orchestra writes the flag in the run's folder while the Wrap up step works in the open tab.
function wrapUpOn(env) {
  return !!env.ORCHESTRA_RUN_DIR && fs.existsSync(path.join(env.ORCHESTRA_RUN_DIR, WRAP_UP_FLAG));
}

// The ITP folder itself (ORCHESTRA_ITP_ROOT), named as a whole path: not a folder inside it, like ITP/ITP-API.
function itpHit(text, env) {
  if (/\$\{?ORCHESTRA_ITP_ROOT\b/.test(text)) return true;
  const fromFlag = () => {
    try {
      return fs.readFileSync(path.join(env.ORCHESTRA_RUN_DIR, WRAP_UP_FLAG), 'utf8').trim();
    } catch {
      return '';
    }
  };
  const root = canon(env.ORCHESTRA_ITP_ROOT || fromFlag()).replace(/\/+$/, '');
  if (!root) return false;
  const t = canon(text);
  for (let i = t.indexOf(root); i >= 0; i = t.indexOf(root, i + 1)) {
    if (/^\/?(?:["'\s;&|)]|$)/.test(t.slice(i + root.length))) return true;
  }
  return false;
}

// The run's own folder holds Orchestra's state and the flag: the run's Claude may not change it.
function runDirHit(text, env) {
  if (/wrap-up\.ok/i.test(text)) return true;
  const dir = canon(env.ORCHESTRA_RUN_DIR || '').replace(/\/+$/, '');
  return !!dir && canon(text).startsWith(dir);
}
const RUN_DIR_MESSAGE = "Orchestra: that is Orchestra's own record of this run. Do not change it.";

// Returns null when the command may run, or { message, needsApproval } when it must be blocked.
export function check(toolName, toolInput, env = process.env) {
  if (env.ORCHESTRA_TRACKING === 'off' && trackingOffHit(String(toolName || ''), toolInput)) {
    return { needsApproval: false, message: OFF_MESSAGE };
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
    // The Wrap up step may push the vault and the ITP folder (they live on main); nothing else ever pushes main.
    const line = cmd.slice(Math.max(0, cmd.lastIndexOf('\n', push.index)), push.index + push[0].length);
    const wrapUpPush = wrapUpOn(env) && (VAULT.test(line) || itpHit(line, env));
    if (!wrapUpPush && /(?:\s|:|\+)(?:refs\/heads\/)?main(?=\s|$|["'])/.test(seg)) {
      return { needsApproval: false, message: 'Orchestra refuses any push to the main branch, even with Approve. Push the work branch instead.' };
    }
  }
  // The vault lives on main; the team works there on purpose.
  const sw = SWITCH_MAIN.exec(cmd);
  if (sw && !/ITPKV|\$\{?VAULT_DIR\b/.test(cmd.slice(Math.max(0, cmd.lastIndexOf('\n', sw.index)), sw.index + sw[0].length))) {
    return { needsApproval: false, message: 'Orchestra refuses switching to the main branch. Stay on the work branch.' };
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
