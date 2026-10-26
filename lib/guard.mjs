// What a run may not do on its own. Used by the Claude PreToolUse hook (guard-hook.mjs).
// Push and PR commands need your Approve. Anything aimed at `main` is refused, even after Approve.

// The rules every turn gets, added to Claude's system prompt.
export const RUN_RULES = [
  'You are running inside Orchestra, a workflow runner. The user is not watching this session live; they read your final reply.',
  'The AskUserQuestion tool is not available. If you need the user\'s answer or decision before you can go on, ask it in your final reply (one question, with your recommended answer), put the line ORCHESTRA:QUESTION as the very last line, and stop. Their answer comes as the next message.',
  'Pushing and opening pull requests need the user\'s Approve. If a push is blocked, do not try another way: in your final reply say what you want to push (repo, branch, commits) and why, put the line ORCHESTRA:APPROVAL as the very last line, and stop.',
  'Never commit on, push to, or switch to the main branch.',
].join('\n');

export const QUESTION_MARK = 'ORCHESTRA:QUESTION';
export const APPROVAL_MARK = 'ORCHESTRA:APPROVAL';

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

// Returns null when the command may run, or { message, needsApproval } when it must be blocked.
export function check(toolName, toolInput, env = process.env) {
  if (!['Bash', 'PowerShell'].includes(toolName)) return null;
  const cmd = String(toolInput?.command ?? '');
  const push = PUSH.exec(cmd);
  if (push) {
    const seg = segment(cmd, push.index);
    if (/\s--no-verify\b/.test(seg)) {
      return { needsApproval: false, message: 'Orchestra refuses `git push --no-verify`. Push without it, after the user approves.' };
    }
    if (/(?:\s|:|\+)(?:refs\/heads\/)?main(?=\s|$|["'])/.test(seg)) {
      return { needsApproval: false, message: 'Orchestra refuses any push to the main branch, even with Approve. Push the work branch instead.' };
    }
  }
  if (SWITCH_MAIN.test(cmd)) {
    return { needsApproval: false, message: 'Orchestra refuses switching to the main branch. Stay on the work branch.' };
  }
  if ((push || PR.test(cmd)) && env.ORCHESTRA_ALLOW_PUSH !== '1') {
    return {
      needsApproval: true,
      message: `Orchestra blocked this: pushing and opening pull requests need the user's Approve. Do not try another way. Stop now: in your final reply say what you want to push (repo, branch, commits) and why, and end with the line ${APPROVAL_MARK}. If the user approves, you will be told to run it.`,
    };
  }
  return null;
}

// Finds a marker on the last non-empty line of a reply. Returns the reply without it.
export function readMark(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const last = (lines.at(-1) || '').replace(/[*`_\s]/g, '');
  for (const mark of [QUESTION_MARK, APPROVAL_MARK]) {
    if (last === mark) return { mark, text: lines.slice(0, -1).join('\n').replace(/\s+$/, '') };
  }
  return { mark: null, text: String(text || '') };
}
