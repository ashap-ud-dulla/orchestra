// The app, one run at a time: node bin/app.mjs <command>
// A run's Claude calls this from its "Test in the app" step (the orchestra-app-test skill), inside its own workspace.
// Only one copy of the ITP app can run (fixed ports), so runs wait in line for it, first come first served.
//   build             build this run's code before its turn (no ports, no waiting)
//   take [--minutes N] join the line and wait for the app (N minutes at most, default 1.5; run it again if still waiting)
//   start [--workers] [--force]  stop the app that runs now, start it from this run's workspace, wait until it answers
//   wait [--minutes N] wait more for an app that is still starting
//   release           let go of the app (it keeps running until the next run starts its own)
//   stop [--force]    stop the app
//   status            who has the app, who waits, and whose code it serves
// The run is read from ORCHESTRA_RUN_ID / ORCHESTRA_HOOK_TOKEN, set in each run's tab.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withRunner } from '../lib/runner.mjs';
import { tabTitle } from '../lib/terminal.mjs';
import { appPorts, readServing, writeServing, portOwners, processInfo, norm, stackPids, stopApp } from '../lib/app.mjs';

const NOT_MINE = 5; // exit code: the app runs from somewhere Orchestra did not start it

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const flag = (name) => args.includes(`--${name}`);
const minutes = () => {
  const i = args.indexOf('--minutes');
  const n = i >= 0 ? Number(args[i + 1]) : 1.5;
  return Number.isFinite(n) && n >= 0 ? n : 1.5;
};
const runId = process.env.ORCHESTRA_RUN_ID;
const token = process.env.ORCHESTRA_HOOK_TOKEN;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const say = (s) => process.stdout.write(s + '\n');

function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function needRun() {
  if (!runId || !token) fail('run this from an Orchestra run (its tab sets ORCHESTRA_RUN_ID)');
}

// This run, as plain data, and the app's line as it is now.
async function me() {
  return withRunner((r) => {
    const run = r.mustToken(runId, token);
    return JSON.parse(JSON.stringify({ run, app: r.appState(runId) }));
  });
}

function workspaceOf(run) {
  return run.workspace?.ready ? run.workspace.dir : run.cwd;
}

// ---------- the app's health ----------

async function answers(url, ok200) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return ok200 ? res.ok : true;
  } catch {
    return false;
  }
}

async function health() {
  const p = appPorts();
  const api = p.api ? await answers(`http://localhost:${p.api}/health`, true) : true;
  const web = p.web ? await answers(`http://localhost:${p.web}/`, false) : true;
  return { api, web, up: api && web };
}

function logTail(ws) {
  const dir = path.join(ws, '.run-logs');
  const lines = [];
  try {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.log'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n').slice(-8);
      lines.push(`--- ${name}`, ...text);
    }
  } catch {}
  return lines.join('\n') || '(no logs yet)';
}

// Waits until the app answers. Returns true when up.
async function waitUp(ws, mins) {
  const end = Date.now() + mins * 60000;
  let last = '';
  for (;;) {
    const h = await health();
    if (h.up) return true;
    const now = `api ${h.api ? 'up' : 'starting'} · web ${h.web ? 'up' : 'starting'}`;
    if (now !== last) say(`  ${new Date().toTimeString().slice(0, 8)} ${now}`);
    last = now;
    if (Date.now() >= end) return false;
    await sleep(3000);
  }
}

// ---------- commands ----------

const commands = {
  async build() {
    needRun();
    const { run } = await me();
    const ws = workspaceOf(run);
    const custom = process.env.ORCHESTRA_APP_BUILD;
    const proj = path.join(ws, 'ITP-API', 'run-dev.hosts.proj');
    const [exe, ...rest] = custom ? JSON.parse(custom.replaceAll('{ws}', ws.replace(/\\/g, '/'))) : ['dotnet', 'build', proj, '-nologo', '-v', 'q'];
    if (!custom && !fs.existsSync(proj)) return say('Nothing to build here (no ITP-API in this workspace). The webclient builds when the app starts.');
    say(`Building ${ws} …`);
    const r = spawnSync(exe, rest, { cwd: ws, stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) fail('the build failed (see above). Fix it before you take the app.', r.status || 1);
    say('Built. The webclient compiles when the app starts. Next: take the app.');
  },

  async take() {
    needRun();
    const end = Date.now() + minutes() * 60000;
    let lastPlace = null;
    for (;;) {
      const app = await withRunner((r) => r.appTake(runId, token));
      if (app.has) {
        const serving = readServing();
        say(`You have the app.${serving ? ` It serves ${serving.title}'s code now: start it from this run.` : ' Start it from this run.'}`);
        return;
      }
      if (app.place !== lastPlace) say(`Waiting for the app: ${ordinal(app.place)} in line${app.holder ? ` (${app.holder.title} has it${app.holder.waitingForYou ? ', waiting for the user' : ''})` : ''}.`);
      lastPlace = app.place;
      if (Date.now() >= end) {
        say('Still waiting. Run take again to keep your place.');
        process.exit(3);
      }
      await sleep(3000);
    }
  },

  async start() {
    needRun();
    const { run, app } = await me();
    if (!app.has) fail('this run does not have the app. Run take first.');
    const ws = workspaceOf(run);
    say(`Stopping the app that runs now${readServing() ? ` (${readServing().title})` : ''} …`);
    const stopped = await stopApp({ force: flag('force') });
    if (stopped.refused) {
      say('The app runs from somewhere Orchestra did not start it (maybe your own checkout):');
      for (const f of stopped.refused) say(`  port ${f.port}: pid ${f.pid} ${f.program}`);
      say('Ask the user. If they say ok, run start again with --force.');
      process.exit(NOT_MINE);
    }
    if (Object.keys(stopped.left).length) fail(`these ports are still busy: ${Object.keys(stopped.left).join(', ')}`);

    const keys = ['webclient', 'api', 'outsider', ...(flag('workers') ? ['primary', 'secondary', 'spreadsheet'] : [])];
    const custom = process.env.ORCHESTRA_APP_START;
    const script = path.join(ws, 'run-stack.ps1');
    if (!custom && !fs.existsSync(script)) fail(`no run-stack.ps1 in ${ws}`);
    const [exe, ...rest] = custom
      ? JSON.parse(custom.replaceAll('{ws}', ws.replace(/\\/g, '/')))
      : ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -Only ${keys.join(',')}`];
    fs.mkdirSync(path.join(ws, '.run-logs'), { recursive: true });
    const out = fs.openSync(path.join(ws, '.run-logs', 'orchestra-start.log'), 'w');
    const child = spawn(exe, rest, { cwd: ws, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    const branches = (run.workspace?.repos || []).map((r) => `${r.folder || r.token}: ${r.branch || `${r.base} (no branch)`}`).join(', ');
    writeServing({ runId: run.id, title: tabTitle(run), workspace: ws, branches, services: keys, pids: [child.pid], startedAt: new Date().toISOString() });
    say(`Starting the app from ${ws} (${keys.join(', ')}). A cold start can take many minutes.`);
    await finishStart(ws);
  },

  async wait() {
    needRun();
    const serving = readServing();
    if (!serving || serving.runId !== runId) fail('the app was not started by this run. Run start.');
    await finishStart(serving.workspace);
  },

  async release() {
    needRun();
    await withRunner((r) => r.appRelease(runId, token));
    say('Let go of the app. It keeps running until the next run starts its own.');
  },

  async stop() {
    if (runId) {
      const { app } = await me();
      if (!app.has && app.holder) fail(`${app.holder.title} has the app; only it (or you, outside a run) may stop it.`);
    }
    const r = await stopApp({ force: flag('force') });
    if (r.refused) {
      say('Not stopped: the app runs from somewhere Orchestra did not start it:');
      for (const f of r.refused) say(`  port ${f.port}: pid ${f.pid} ${f.program}`);
      say('Run stop --force to stop it anyway.');
      process.exit(NOT_MINE);
    }
    say('The app is stopped.');
  },

  async status() {
    const app = await withRunner((r) => r.appState());
    const serving = readServing();
    const h = await health();
    say(appText(app, serving, h));
  },
};

// Waits for the app, then records which processes serve it and checks they come from this workspace.
async function finishStart(ws) {
  if (!(await waitUp(ws, minutes() || 1.5))) {
    say(`Not up yet. Run wait to keep waiting. The logs so far:\n${logTail(ws)}`);
    process.exit(2);
  }
  const serving = readServing() || {};
  const owners = portOwners();
  serving.pids = [...new Set([...(serving.pids || []), ...stackPids(ws), ...Object.values(owners)])];
  writeServing(serving);
  const p = appPorts();
  const apiOwner = owners[p.api];
  const from = apiOwner ? norm(processInfo(apiOwner)) : '';
  const elsewhere = from && !from.includes(norm(ws));
  say(`The app is up: http://localhost:${p.web}${p.api ? ` (api http://localhost:${p.api})` : ''}, serving ${ws}.`);
  if (elsewhere) say(`Warning: the api process does not come from this workspace: ${from}`);
}

function ordinal(n) {
  return `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
}

function appText(app, serving, h) {
  const lines = [];
  lines.push(app.holder ? `Has the app: ${app.holder.title}${app.holder.waitingForYou ? ' (waiting for you)' : ''}` : 'Has the app: nobody');
  lines.push(`In line: ${app.line.length ? app.line.map((x) => x.title).join(', ') : 'nobody'}`);
  lines.push(serving ? `Serving: ${serving.title}'s code from ${serving.workspace}${serving.branches ? ` (${serving.branches})` : ''}, started ${serving.startedAt.slice(11, 16)}` : 'Serving: not started by Orchestra');
  if (h) lines.push(`Answers: api ${h.api ? 'yes' : 'no'} · web ${h.web ? 'yes' : 'no'}`);
  return lines.join('\n');
}

const run = commands[cmd];
if (!run) fail(`unknown command: ${cmd}. Commands: ${Object.keys(commands).join(', ')}`);
try {
  await run();
  process.exit(0);
} catch (err) {
  fail(err.message || String(err), err.status === 409 ? 3 : 1);
}
