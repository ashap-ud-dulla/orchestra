// Claude hook for a run's terminal session: node bin/hook.mjs <event>
// Claude sends the hook JSON on stdin. Orchestra moves the run on and prints its answer
// (for Stop: "go on with the next box"; for UserPromptSubmit: the next box after "next").
// "status" is the status line: it prints one line.
import fs from 'node:fs';
import { handle, print } from '../lib/hook-handler.mjs';

const event = process.argv[2] || '';
let body = {};
try {
  body = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}

print(event, await handle(event, body));
process.exit(0);
