// One Claude hook event from a run's terminal session, handled right here (no server).
// The run is named by the session's env (ORCHESTRA_RUN_ID, ORCHESTRA_HOOK_TOKEN), set by the launcher.
// Never throws: if anything goes wrong, the session goes on as if there were no hook.
import fs from 'node:fs';
import path from 'node:path';
import { withRunner } from './runner.mjs';
import { runDir } from './store.mjs';

// How long a hook may wait for the Orchestra lock. The status line must be quick; a lost activity
// line is fine; the rest steer the run, so they wait (their hook timeout is longer).
const LOCK_MS = { status: 1500, PostToolUse: 10000 };

export async function handle(event, body = {}, env = process.env) {
  const id = env.ORCHESTRA_RUN_ID;
  if (!id) return event === 'status' ? { line: 'Orchestra' } : {};
  try {
    return await withRunner((r) => r.onHook(id, event, body, env.ORCHESTRA_HOOK_TOKEN), { detach: true, lockMs: LOCK_MS[event] ?? 9 * 60 * 1000 });
  } catch (err) {
    if (event === 'status') return { line: statusFromDisk(id) };
    note(id, `hook ${event} failed: ${err.message}`);
    // Not this tab's run any more (a wrong token, a deleted run): nothing for the user to do here.
    if (err.status === 403 || err.status === 404) return {};
    return failedOutput(event, body, err);
  }
}

// Orchestra's own words in a run's tab: they must never reach Claude as plain talk when the hook fails.
const TAB_WORD = /^\/?(next|skip|redo|pin|unpin)\b|^\/(orch|orchestra)\b/i;

// What the tab shows when a hook fails, so a failure is never silent. A tool-call hook stays quiet (it only
// keeps the activity list; one lost line does not matter).
export function failedOutput(event, body, err) {
  const why = String(err?.message || err).slice(0, 300);
  if (event === 'UserPromptSubmit') {
    const word = String(body?.prompt ?? '').trim();
    if (TAB_WORD.test(word)) return { output: { decision: 'block', reason: `Orchestra could not handle "${word.slice(0, 60)}": ${why}. Try again in a moment.` } };
    return { output: { systemMessage: `Orchestra could not follow this message (${why}). Claude got it as usual.` } };
  }
  if (event === 'Stop') return { output: { systemMessage: `Orchestra could not move the run on (${why}). Type next to try again.` } };
  if (event === 'SessionStart') return { output: { systemMessage: `Orchestra could not register this tab (${why}).` } };
  return {};
}

// The status line when the lock is busy: what the run file says, without saving anything.
function statusFromDisk(id) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(runDir(id), 'state.json'), 'utf8'));
    const box = run.boxes.find((b) => b.status === 'running');
    return `Orchestra · ${box ? box.label : run.status} · $${(run.cost || 0).toFixed(2)}`;
  } catch {
    return 'Orchestra';
  }
}

function note(id, message) {
  try {
    fs.appendFileSync(path.join(runDir(id), 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), message }) + '\n');
  } catch {}
}

// What Claude reads back from the hook: JSON for the events, one line for the status line.
export function print(event, out) {
  if (event === 'status') process.stdout.write(out.line || 'Orchestra');
  else if (out.output) process.stdout.write(JSON.stringify(out.output));
}
