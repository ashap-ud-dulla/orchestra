// The two hooks that fire all the time, answered without the lock and without loading Orchestra:
// - PostToolUse (after every tool call): one activity line is added to the run's activity.jsonl.
// - status (the status line, after every reply): the line is built from the run file.
// They only read the run file. When the run must change (a tool ran while the run "needs you", or the cost moved),
// they return null and the full hook (hook-handler.mjs, with the lock) does it.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { describeTool } from './run/steps.mjs';
import { upgradeRun } from './upgrade.mjs';

const round = (n) => Math.round(n * 1e6) / 1e6; // as util.round

function readRun(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || id === 'archive') return null;
  const dir = path.join(config.runsDir, id);
  try {
    return { dir, run: upgradeRun(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))) };
  } catch {
    return null; // missing, or being replaced right now: the full hook handles it
  }
}

export function fastHook(event, body, env = process.env) {
  if (event !== 'PostToolUse' && event !== 'status') return null;
  const id = env.ORCHESTRA_RUN_ID;
  if (!id) return null;
  const got = readRun(id);
  if (!got) return null;
  const { dir, run } = got;
  if (!env.ORCHESTRA_HOOK_TOKEN || env.ORCHESTRA_HOOK_TOKEN !== run.hookToken) return null;
  const working = (run.steps || []).find((s) => s.status === 'running');

  if (event === 'PostToolUse') {
    // A tool ran, so an "Allow?" prompt was answered: the run works again. That is a change: the full hook.
    if (run.status === 'needs-you' && working) return null;
    const line = { at: new Date().toISOString(), stepId: run.currentStep || null, kind: 'tool', text: describeTool({ name: body.tool_name, input: body.tool_input }) };
    try {
      fs.appendFileSync(path.join(dir, 'activity.jsonl'), JSON.stringify(line) + '\n');
    } catch {}
    return {};
  }

  // status: the same rule as Runner.onStatus, to know whether the cost changes.
  const cost = Number(body?.cost?.total_cost_usd);
  if (Number.isFinite(cost) && run.session) {
    const base = run.costPast || 0;
    const total = round(base + cost);
    if (total !== run.sessionCost && !(cost === 0 && (run.sessionCost || 0) > base)) return null;
  }
  const model = body?.model?.display_name || body?.model?.id;
  return { line: `Orchestra · ${working ? working.label : run.status}${model ? ` · ${model}` : ''} · $${(run.cost || 0).toFixed(2)}` };
}
