// A stand-in for `claude -p ... --output-format stream-json`. Spends no tokens.
// FAKE_CLAUDE_SLEEP_MS: wait before the result (to test stop/restart mid-box).
// FAKE_CLAUDE_FAIL_SKILL: report an error for this skill.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : crypto.randomUUID();
const skill = (/^\/([\w:.-]+)/.exec(prompt) || [])[1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

fs.appendFileSync('fake-calls.log', JSON.stringify({ prompt, resumed: resumeAt >= 0, sessionId }) + '\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });

const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0);
setTimeout(() => {
  const fail = process.env.FAKE_CLAUDE_FAIL_SKILL === skill;
  const text = fail ? `Skill ${skill} hit a problem.` : `Ran ${skill}.`;
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({
    type: 'result', subtype: 'success', is_error: fail, terminal_reason: 'completed', session_id: sessionId,
    total_cost_usd: 0.01, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
  });
}, sleep);
