// A stand-in for `claude -p ... --output-format stream-json`, for the lesson-finder (learn.mjs). Spends no tokens.
// Runs themselves are interactive terminal sessions; the tests drive those through their hooks.
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const prompt = arg('-p') || '';
const resumed = args.includes('--resume');
const sessionId = resumed ? arg('--resume') : crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

fs.appendFileSync('fake-calls.log', JSON.stringify({ prompt: prompt.slice(0, 200), resumed, sessionId, noTools: arg('--disallowedTools') }) + '\n');
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });

const text = prompt.startsWith('ORCHESTRA-LEARN')
  ? 'Here you go:\n```json\n{"rules":[{"text":"Use blue for buttons.","why":"You picked blue at the gate."}],"workflow":[{"text":"Add a wait after Say hello.","why":"You stopped the run there.","change":{"op":"box","box":"hello","wait":"on"}},{"text":""}]}\n```'
  : 'OK.';
out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', session_id: sessionId, total_cost_usd: 0.01, result: text, usage: { input_tokens: 10, output_tokens: 5 } });
