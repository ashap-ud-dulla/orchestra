// A stand-in for `claude -p ... --output-format stream-json`. Spends no tokens.
// FAKE_CLAUDE_SLEEP_MS: wait before the result (to test stop/restart mid-box).
// FAKE_CLAUDE_FAIL_SKILL: report an error for this skill.
// FAKE_CLAUDE_ASK_SKILL: this skill asks a question (ends with the ORCHESTRA:QUESTION line).
// FAKE_CLAUDE_TOUCH: write a file named this in each run repo worktree (to test uncommitted work).
// FAKE_CLAUDE_PUSH_SKILL: this skill tries `git push`, through the PreToolUse hook Orchestra passed in --settings.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const prompt = arg('-p') || '';
const resumed = args.includes('--resume');
const sessionId = resumed ? arg('--resume') : crypto.randomUUID();
const skill = (/^\/([\w:.-]+)/.exec(prompt) || [])[1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

fs.appendFileSync('fake-calls.log', JSON.stringify({ prompt, resumed, sessionId, rules: !!arg('--append-system-prompt'), allowPush: process.env.ORCHESTRA_ALLOW_PUSH, cwd: process.cwd(), itpRoot: process.env.ITP_ROOT, repoDirs: process.env.ITP_REPO_DIRS, branch: process.env.ITP_BRANCH_OVERRIDE, protect: process.env.ORCHESTRA_PROTECT, tracking: process.env.ORCHESTRA_TRACKING, registryOff: process.env.ITP_REGISTRY_OFF, offRule: /Tracking is OFF/.test(arg('--append-system-prompt') || ''), myRules: /The user's own rules[^]*Use blue/.test(arg('--append-system-prompt') || ''), noTools: arg('--disallowedTools') }) + '\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });

// Runs the guard hook the way Claude would. Returns true when the push is allowed.
function tryPush(command) {
  const hook = JSON.parse(arg('--settings') || '{}').hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (!hook) return true;
  const r = spawnSync(hook, { shell: true, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  return r.status !== 2;
}

function reply() {
  if (process.env.FAKE_CLAUDE_FAIL_SKILL === skill && skill) return { text: `Skill ${skill} hit a problem.`, fail: true };
  if (process.env.FAKE_CLAUDE_ASK_SKILL === skill && skill) return { text: 'Which color do you like? I suggest blue.\nORCHESTRA:QUESTION' };
  if ((process.env.FAKE_CLAUDE_PUSH_SKILL === skill && skill) || prompt.startsWith('The user approved')) {
    return tryPush('git push -u origin feature/x') ? { text: 'Pushed feature/x.' } : { text: 'The push was blocked. I want to push feature/x.\nORCHESTRA:APPROVAL' };
  }
  if (prompt.startsWith('The user did not approve')) return { text: 'OK, I did not push.' };
  if (prompt.startsWith('ORCHESTRA-LEARN')) {
    return { text: 'Here you go:\n```json\n{"rules":[{"text":"Use blue for buttons.","why":"You picked blue at the gate."}],"workflow":[{"text":"Add a wait after Say hello.","why":"You stopped the run there."},{"text":""}]}\n```' };
  }
  if (prompt.startsWith('Walk me through the code')) return { text: 'Walk-through: a.cs:1 uses a guard clause, because it keeps the happy path flat.' };
  // A finished step ends with the plain "what I did and why" note, as the run rules ask.
  if (skill) return { text: `Ran ${skill}.\n\n**What I did and why:**\n- I ran ${skill}, because the box asked for it.` };
  return { text: `Ran ${skill}.` };
}

if (process.env.FAKE_CLAUDE_TOUCH && process.env.ITP_REPO_DIRS) {
  for (const line of process.env.ITP_REPO_DIRS.split('\n')) fs.writeFileSync(`${line.slice(line.indexOf('=') + 1)}/${process.env.FAKE_CLAUDE_TOUCH}`, 'x');
}

// FAKE_CLAUDE_GIT=<skill>:<branch>: that skill makes the branch in each run repo and commits there,
// like an ITP epic does. <skill>:- commits with no branch.
const gitPlan = process.env.FAKE_CLAUDE_GIT || '';
if (skill && gitPlan.startsWith(`${skill}:`) && process.env.ITP_REPO_DIRS) {
  const branch = gitPlan.slice(skill.length + 1);
  const who = { GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@f', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@f' };
  for (const line of process.env.ITP_REPO_DIRS.split('\n')) {
    const dir = line.slice(line.indexOf('=') + 1);
    const g = (a) => spawnSync('git', ['-C', dir, ...a], { env: { ...process.env, ...who }, encoding: 'utf8' });
    if (branch !== '-') g(['switch', '-q', '-c', branch]);
    fs.writeFileSync(`${dir}/fake-work.txt`, skill);
    g(['add', 'fake-work.txt']);
    g(['commit', '-qm', 'fake work']);
  }
}

const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
setTimeout(() => {
  const { text, fail = false } = reply();
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({
    type: 'result', subtype: 'success', is_error: fail, terminal_reason: 'completed', session_id: sessionId,
    total_cost_usd: 0.01, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
  });
}, sleep);
