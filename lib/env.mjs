// The environment a run's claude gets. Shared by the runner and the in-tab launcher (launch.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from './pack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Set by the Claude Code session that started Orchestra. A run's claude must not think it is part of that session.
const SESSION_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
]);

// base (default: this process's env) without the parent-session variables, the API key
// (the shell's key has no credit, so runs use the claude.ai login) and Orchestra's own run variables,
// plus extra.
export function childEnv(extra = {}, { base = process.env, keepApiKey = process.env.ORCHESTRA_KEEP_API_KEY === '1' } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const key = k.toUpperCase();
    if (SESSION_ENV.has(key)) continue;
    if (key === 'ANTHROPIC_API_KEY' && !keepApiKey) continue;
    // Only Orchestra decides these, per run. Never inherit them.
    if (key.startsWith('ORCHESTRA_ALLOW') || key === 'ORCHESTRA_RUN_DIR' || key === 'ORCHESTRA_TRACKING') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// The guard env. Git in the session (and in any script it starts) uses Orchestra's hooks, set through
// env vars only, so nothing is written to the repo. Those hooks still refuse pushes to main.
// allowPush: the git hooks let other pushes through. In a terminal session Claude's own Allow prompt
// is the approval (the PreToolUse guard asks for every push).
// Tracking OFF: the guard blocks the pack's tracker and notes writes, and the pack's env turns its scripts' tracking
// off (pack.offEnv).
export function guardEnv(runDir, allowPush, tracking = true, base = process.env) {
  const n = Number(base.GIT_CONFIG_COUNT) || 0;
  return {
    ORCHESTRA_RUN_DIR: runDir,
    ORCHESTRA_ALLOW_PUSH: allowPush ? '1' : '0',
    ORCHESTRA_TRACKING: tracking ? 'on' : 'off',
    ...(tracking ? {} : pack.offEnv),
    // With no pack the git hooks also refuse the remote's default branch (lib/git-hooks/_orchestra.sh).
    ...(pack.protectDefaultBranch ? { ORCHESTRA_PROTECT_DEFAULT: '1' } : {}),
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${n}`]: path.join(ROOT, 'lib', 'git-hooks').replace(/\\/g, '/'),
  };
}
