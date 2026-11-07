// Runs inside a run's terminal tab: node bin/launch.mjs <runId> <token>
// Gets from Orchestra how to start claude (folder, env, arguments), starts it attached to this terminal,
// and tells Orchestra when it ends (the tab closed, or you quit claude).
// When the next step wants another model or effort, Orchestra writes restart.ok: the launcher then stops claude
// and starts it again in this same tab, on the same conversation (no hook can switch the model of a running claude).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from '../lib/env.mjs';
import { withRunner } from '../lib/runner.mjs';
import { runDir, RESTART_FLAG, TAB_ALIVE } from '../lib/store.mjs';
import { killTree } from '../lib/app.mjs';

const [runId, token] = process.argv.slice(2);
// Time for the Stop hook that asked for the restart to finish before claude is stopped.
const RESTART_GRACE_MS = Number(process.env.ORCHESTRA_RESTART_GRACE_MS ?? 2000);

function wait(msg) {
  console.log(msg);
  console.log('Press Enter to close this tab.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

async function closed(code, opts) {
  try {
    await withRunner((r) => r.onClosed(runId, token, opts), { detach: true, lockMs: 20000 });
  } catch {}
  process.exit(code ?? 0);
}

function start(spec) {
  const env = childEnv(spec.env, { keepApiKey: spec.keepApiKey });
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env, stdio: 'inherit' });
  const flag = path.join(runDir(runId), RESTART_FLAG);
  let restarting = false;
  const watch = setInterval(() => {
    if (restarting || !fs.existsSync(flag)) return;
    restarting = true;
    setTimeout(() => killTree(child.pid), RESTART_GRACE_MS);
  }, 1000);
  child.on('error', async (err) => {
    clearInterval(watch);
    // Tell Orchestra first, so the run says "failed: claude could not start" instead of "running".
    try {
      await withRunner((r) => r.onClosed(runId, token, { error: err.message }), { detach: true, lockMs: 20000 });
    } catch {}
    wait(`Could not start claude: ${err.message}`);
  });
  child.on('exit', async (code) => {
    clearInterval(watch);
    if (!restarting && !fs.existsSync(flag)) return closed(code);
    // Claude was stopped on purpose: put the terminal back in order (colors, cursor, screen), then start it again.
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1006l\n');
    let next;
    try {
      next = await withRunner((r) => r.relaunchSpec(runId, token, process.pid), { detach: true, lockMs: 20000 });
    } catch (err) {
      console.log(`Orchestra could not restart claude: ${err.message}`);
      return closed(1, { force: true });
    }
    const what = next.args.includes('--model') ? next.args[next.args.indexOf('--model') + 1] : 'the same model';
    if (next.args.includes('--resume')) console.log(`Orchestra: now with ${what}. Restarting claude on the same conversation…\n`);
    else console.log(`Orchestra: the next step starts a new conversation (${what}), told the story so far. Starting claude…\n`);
    start(next);
  });
}

let spec;
try {
  spec = await withRunner((r) => r.launchSpec(runId, token, process.pid), { detach: true });
} catch (err) {
  try {
    await withRunner((r) => r.onClosed(runId, token, { error: err.message }), { detach: true, lockMs: 20000 });
  } catch {}
  wait(`Orchestra could not start this run: ${err.message}`);
}

// The tab is alive: this file's time moves every 10 s while the launcher runs. Orchestra trusts it over the pid,
// which Windows may give to another program once this one has ended.
const beatFile = path.join(runDir(runId), TAB_ALIVE);
const beat = () => {
  try {
    fs.writeFileSync(beatFile, String(process.pid));
  } catch {}
};
beat();
setInterval(beat, 10000).unref();

if (spec) {
  console.log(`Orchestra run ${runId} · ${spec.title}`);
  console.log([
    'Type in this tab (or just talk to Claude):',
    '  next          go on (after a step that waits for you, or with a step that was cut off)',
    '  redo / skip   run this step again / move past it',
    '  pin           keep Claude\'s last answer in the pane on the right',
    '  /orchestra model opus effort high · /orchestra back <step> <why>',
    '',
  ].join('\n'));
  start(spec);
  // Closing the tab ends this process; pass it on so claude ends too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => {});
}
