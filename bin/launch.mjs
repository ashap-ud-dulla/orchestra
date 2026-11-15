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
import { runDir, RESTART_FLAG, TAB_ALIVE, PROCS_FILE } from '../lib/store.mjs';
import { killTree, recordTree } from '../lib/app.mjs';
import { showTitle } from '../lib/terminal.mjs';
import { upgradeRun } from '../lib/upgrade.mjs';

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

// Claude's tree is written down soon after it starts (helper servers start then, and some lose their parent within
// seconds), then every 2 minutes, and once more before a restart stops it. Clean-up stops what of it still runs.
const RECORD_AT_MS = (process.env.ORCHESTRA_RECORD_AT_MS || '3000,8000,15000,30000,60000').split(',').map(Number);
const RECORD_EVERY_MS = Number(process.env.ORCHESTRA_RECORD_EVERY_MS ?? 120000);

function start(spec) {
  const env = childEnv(spec.env, { keepApiKey: spec.keepApiKey });
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env, stdio: 'inherit' });
  const flag = path.join(runDir(runId), RESTART_FLAG);
  const procs = path.join(runDir(runId), PROCS_FILE);
  const record = () => recordTree(procs, child.pid).catch(() => {});
  const timers = [...RECORD_AT_MS.map((ms) => setTimeout(record, ms)), setInterval(record, RECORD_EVERY_MS)];
  const stopRecording = () => timers.forEach((t) => clearTimeout(t));
  let restarting = false;
  const watch = setInterval(() => {
    if (restarting || !fs.existsSync(flag)) return;
    restarting = true;
    setTimeout(async () => {
      await record();
      killTree(child.pid);
    }, RESTART_GRACE_MS);
  }, 250); // a quick look (one file check), so a model switch starts without dead time
  child.on('error', async (err) => {
    clearInterval(watch);
    stopRecording();
    // Tell Orchestra first, so the run says "failed: claude could not start" instead of "running".
    try {
      await withRunner((r) => r.onClosed(runId, token, { error: err.message }), { detach: true, lockMs: 20000 });
    } catch {}
    wait(`Could not start claude: ${err.message}`);
  });
  child.on('exit', async (code) => {
    clearInterval(watch);
    stopRecording();
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

// The tab's name shows the run's mark (🔴 needs you, ⏳ in line, ✅ done): the run file is read again only when it
// changed (one file check every 2 s).
const stateFile = path.join(runDir(runId), 'state.json');
let stateAt = 0;
const mark = () => {
  try {
    const at = fs.statSync(stateFile).mtimeMs;
    if (at === stateAt) return;
    showTitle(upgradeRun(JSON.parse(fs.readFileSync(stateFile, 'utf8'))));
    stateAt = at; // only after a good read: a file caught mid-write is read again next time
  } catch {}
};
mark();
setInterval(mark, 2000).unref();

if (spec) {
  console.log(`Orchestra run ${runId} · ${spec.title}`);
  console.log('Talk to Claude here. next goes on, redo / skip run the step again / move past it, pin keeps an answer in the pane. /orch help shows the rest.\n');
  start(spec);
  // Closing the tab ends this process; pass it on so claude ends too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => {});
}
