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

// Returns null when the command may run, or { message, needsApproval } when it must be blocked.
export function check(toolName, toolInput, env = process.env) {
  if (env.ORCHESTRA_TRACKING === 'off' && trackingOffHit(String(toolName || ''), toolInput)) {
    return { needsApproval: false, message: OFF_MESSAGE };
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const dir = protectedHit(toolInput?.file_path ?? toolInput?.notebook_path ?? '', env);
    return dir ? { needsApproval: false, message: `Orchestra: ${dir} is the user's own checkout. This run works in its own worktree of that repo (same folder name, inside the current directory). Edit there.` } : null;
  }
  if (!['Bash', 'PowerShell'].includes(toolName)) return null;
  const cmd = String(toolInput?.command ?? '');
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
