// Claude hook for a run's terminal session: node bin/hook.mjs <event>
// Claude sends the hook JSON on stdin. Orchestra moves the run on and prints its answer
// (for Stop: "go on with the next step"; for UserPromptSubmit: the next step after "next").
// "status" is the status line: it prints one line.
// The hooks that fire all the time (a tool call, the status line) are answered by lib/hook-fast.mjs when nothing
// changes; the rest of Orchestra loads only when it is needed.
import fs from 'node:fs';
import { fastHook } from '../lib/hook-fast.mjs';

const event = process.argv[2] || '';
let body = {};
try {
  body = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}

const write = (out) => {
  if (event === 'status') process.stdout.write(out.line || 'Orchestra');
  else if (out.output) process.stdout.write(JSON.stringify(out.output));
};
let out = null;
try {
  out = fastHook(event, body);
} catch {}
if (out) write(out);
else {
  const { handle } = await import('../lib/hook-handler.mjs');
  write(await handle(event, body));
}
process.exit(0);
