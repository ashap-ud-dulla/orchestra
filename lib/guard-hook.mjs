// Claude PreToolUse hook for Orchestra runs. Claude sends the tool call as JSON on stdin.
// A hard refusal exits 2; the text on stderr goes back to Claude.
// A push or PR is not refused: Claude shows you its normal Allow prompt for it (even if it is allowlisted).
import fs from 'node:fs';
import { check } from './guard.mjs';

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}
// The terminal session lets git push; the approval is this prompt (a push to main too).
const verdict = check(input.tool_name, input.tool_input, { ...process.env, ORCHESTRA_ALLOW_PUSH: '0' });
if (verdict?.needsApproval) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: verdict.message } }));
  process.exit(0);
}
if (verdict) {
  process.stderr.write(verdict.message + '\n');
  process.exit(2);
}
process.exit(0);
