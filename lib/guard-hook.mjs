// Claude PreToolUse hook for Orchestra runs. Claude sends the tool call as JSON on stdin.
// Exit 2 blocks the call; the text on stderr goes back to Claude.
import fs from 'node:fs';
import path from 'node:path';
import { check } from './guard.mjs';

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}
const verdict = check(input.tool_name, input.tool_input);
if (verdict) {
  if (verdict.needsApproval && process.env.ORCHESTRA_RUN_DIR) {
    const line = { at: new Date().toISOString(), source: 'claude', command: String(input.tool_input?.command ?? '').slice(0, 2000) };
    try {
      fs.appendFileSync(path.join(process.env.ORCHESTRA_RUN_DIR, 'approval-requests.jsonl'), JSON.stringify(line) + '\n');
    } catch {}
  }
  process.stderr.write(verdict.message + '\n');
  process.exit(2);
}
process.exit(0);
