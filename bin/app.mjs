// The app, one run at a time: node bin/app.mjs <command>
// A run's Claude calls this from its "Test in the app" step (the orchestra-app-test skill), inside its own workspace.
// Only one copy of the ITP app can run (fixed ports), so runs wait in line for it, first come first served.
// Outside a run (orch app start|stop|restart|wait|logs|release), it is you: the app serves your own ITP checkout
// (the setup's ITP folder), and you hold it until orch app stop. A run that has the app is never pushed out.
//   build             build this run's code before its turn (no ports, no waiting)
//   take [--minutes N] join the line and wait for the app (N minutes at most, default 1.5; run it again if still waiting)
//   start [--services a,b] [--with a,b] [--without a,b] [--force]  stop the app that runs now, start it from this run's workspace
//                     with the launcher setting (apphost or runstack), wait until it answers
//   restart [services] restart the app this run started (after a Debug.json switch or a code change)
//   wait [--minutes N] wait more for an app that is still starting
//   logs [service]    the log files there are, or the last lines of one: <ws>/.run-logs/<service>.log
//   release           let go of the app (it keeps running until the next run starts its own)
//   stop [--force]    stop the app
//   status            who has the app, who waits, and whose code it serves
// The run is read from ORCHESTRA_RUN_ID / ORCHESTRA_HOOK_TOKEN, set in each run's tab.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withRunner } from '../lib/runner.mjs';
import { tabTitle } from '../lib/terminal.mjs';
import { appPorts, readServing, writeServing, portOwners, processInfo, norm, stackPids, stopApp, brokersListening, readYourHold, writeYourHold, YOU, hostsIn } from '../lib/app.mjs';
import { config } from '../lib/config.mjs';
import * as launcher from '../lib/launcher.mjs';

const NOT_MINE = 5; // exit code: the app runs from somewhere Orchestra did not start it

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
// The words after the command that are not options or their values.
const positional = (from) => args.slice(from).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && ['--minutes', '--services', '--with', '--without', '--lines'].includes(all[i - 1])));
const list = (text) => [...new Set(String(text || '').split(/[\s,]+/).filter(Boolean).map(launcher.serviceName))];
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
    return JSON.parse(JSON.stringify({ run, app: r.appState(runId), launcher: r.getSettings().launcher || launcher.DEFAULT_LAUNCHER }));
  });
}

function workspaceOf(run) {
  return run.workspace?.ready ? run.workspace.dir : run.cwd;
}

const inRun = () => !!(runId && token);
const actorId = () => (inRun() ? runId : YOU);

// Who is starting the app, as { id, title, ws, branches }: this run, or you (your own ITP checkout).
function actorOf(mine) {
  if (mine.run) {
    const run = mine.run;
    return { id: run.id, title: tabTitle(run), ws: workspaceOf(run), branches: (run.workspace?.repos || []).map((r) => `${r.folder || r.token}: ${r.branch || `${r.base} (no branch)`}`).join(', ') };
  }
  const ws = config.itpRoot;
  const branch = (dir) => spawnSync('git', ['-C', path.join(ws, dir), 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  const branches = ['ITP-API', 'ITP-WebClient'].filter((d) => fs.existsSync(path.join(ws, d))).map((d) => `${d}: ${branch(d) || '(no branch)'}`).join(', ');
  return { id: YOU, title: 'you (your checkout)', ws, branches };
}

// Outside a run: takes the app for you, unless a run has it (then it says which run, and what it does).
async function takeForYou() {
  if (!config.itpRoot) fail(`Orchestra does not know your ITP folder yet. Run: node ${path.join(config.root, 'bin', 'orch.mjs').replace(/\\/g, '/')} setup --itp <your ITP folder>`);
  return withRunner((r) => {
    const app = JSON.parse(JSON.stringify(r.appState()));
    const h = app.holder;
    if (h && !h.you) {
      const doing = h.waitingForYou ? 'waiting for you after its step: type next in its tab to hand the app on' : `working in its step${h.step ? ` "${h.step}"` : ''}`;
      fail(`run ${h.title} has the app (${doing}). Wait until it lets go, or take it from the run: orch app release ${h.title}`);
    }
    if (!h) writeYourHold({ at: new Date().toISOString(), workspace: config.itpRoot });
    return { app: { ...app, has: true }, launcher: r.getSettings().launcher || launcher.DEFAULT_LAUNCHER };
  });
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
  // 127.0.0.1 first: Node may take localhost as IPv6 (::1) while the api listens on IPv4 only. localhost second:
  // ng serve may listen on [::1] only.
  const either = async (port, rest, ok200) => (await answers(`http://127.0.0.1:${port}${rest}`, ok200)) || answers(`http://localhost:${port}${rest}`, ok200);
  const api = p.api ? await either(p.api, '/health', true) : true;
  const web = p.web ? await either(p.web, '/', false) : true;
  return { api, web, up: api && web };
}

function tail(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n);
  } catch {
    return [];
  }
}

function logTail(ws) {
  const lines = [];
  for (const [name, file] of Object.entries(launcher.serviceLogs(ws))) lines.push(`--- ${name}.log`, ...tail(file, 8));
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
    const r = spawnSync(exe, rest, { cwd: ws, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...launcher.BUILD_ENV } });
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
      const who = app.holder?.you ? ' (the user runs their own app: wait, or ask them to stop it with orch app stop)' : app.holder ? ` (${app.holder.title} has it${app.holder.waitingForYou ? ', waiting for the user' : ''})` : '';
      if (app.place !== lastPlace) say(`Waiting for the app: ${ordinal(app.place)} in line${who}.`);
      lastPlace = app.place;
      if (Date.now() >= end) {
        say('Still waiting. Run take again to keep your place.');
        process.exit(3);
      }
      await sleep(3000);
    }
  },

  async start() {
    const mine = inRun() ? await me() : await takeForYou();
    if (!mine.app.has) fail('this run does not have the app. Run take first.');
    const actor = actorOf(mine);
    const ws = actor.ws;
    const serving0 = readServing(); // stopping forgets it; a start after a fix keeps its services
    say(`Stopping the app that runs now${readServing() ? ` (${readServing().title})` : ''} …`);
    const stopped = await stopApp({ force: flag('force') });
    if (stopped.refused) {
      say('The app runs from somewhere Orchestra did not start it (maybe your own checkout):');
      for (const f of stopped.refused) say(`  port ${f.port}: pid ${f.pid} ${f.program}`);
      say('Ask the user. If they say ok, run start again with --force.');
      process.exit(NOT_MINE);
    }
    if (Object.keys(stopped.left).length) fail(`these ports are still busy: ${Object.keys(stopped.left).join(', ')}`);

    const services = pickServices(mine.launcher, ws, serving0);
    await launch(actor, ws, mine.launcher, services);
  },

  async restart() {
    const mine = inRun() ? await me() : { app: { has: !!readYourHold() } };
    const serving = readServing();
    if (!mine.app.has) fail(inRun() ? 'this run does not have the app. Run take first.' : 'you do not have the app. Start it: orch app start');
    if (!serving || serving.runId !== actorId()) fail(`the app was not started by ${inRun() ? 'this run' : 'you'}. Start it first.`);
    const actor = inRun() ? actorOf(mine) : actorOf({});
    const ws = serving.workspace;
    const how = serving.launcher || launcher.DEFAULT_LAUNCHER;
    const named = positional(1);
    const services = named.length ? list(named.join(',')) : serving.services;
    const cmd = launcher.restartCommand(how, ws, services);
    if (cmd.full) {
      say(`Restarting the whole app${how === 'apphost' ? ' (the AppHost restarts one service only through the aspire CLI, which is not set up here)' : ''}. The relaunch rebuilds what changed.`);
      const stopped = await stopApp({ force: false });
      if (stopped.refused) fail('the app on its ports was not started by Orchestra. Run start --force after the user says ok.', NOT_MINE);
      await launch(actor, ws, how, serving.services);
      return;
    }
    say(`Restarting ${services.join(', ')} …`);
    fs.mkdirSync(launcher.logsDir(ws), { recursive: true });
    const out = fs.openSync(path.join(launcher.logsDir(ws), 'orchestra-restart.log'), 'w');
    const child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    child.unref();
    writeServing({ ...serving, pids: [...new Set([...(serving.pids || []), child.pid])] });
    await sleep(5000); // let the old processes go before the up-check
    await finishStart(ws);
  },

  async logs() {
    const serving = readServing();
    let ws = serving?.workspace;
    if (runId && token) ws = workspaceOf((await me()).run);
    if (!ws) fail('no app was started by Orchestra, and this is not a run.');
    const files = launcher.serviceLogs(ws);
    const want = positional(1)[0];
    if (want) {
      let file = files[want];
      if (!file) {
        try {
          file = files[launcher.serviceName(want)];
        } catch {}
      }
      if (!file) fail(`no ${want}.log in ${launcher.logsDir(ws)}. There are: ${Object.keys(files).join(', ') || 'none'}`);
      say(tail(file, Number(option('lines')) || 40).join('\n'));
      return;
    }
    say(`Logs in ${launcher.logsDir(ws)}:`);
    for (const [name, file] of Object.entries(files)) say(`  ${name}.log  (${fs.statSync(file).size} bytes)`);
    if (!Object.keys(files).length) say('  none yet');
    say(logNote(ws, serving));
  },

  async wait() {
    const serving = readServing();
    if (!serving || serving.runId !== actorId()) fail(`the app was not started by ${inRun() ? 'this run' : 'you'}. Start it first.`);
    await finishStart(serving.workspace);
  },

  async release() {
    if (inRun()) await withRunner((r) => r.appRelease(runId, token));
    else if (readYourHold()) writeYourHold(null);
    else return say('You do not hold the app.');
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
    if (!inRun() && readYourHold()) writeYourHold(null); // you let go: runs waiting for the app go on
    say('The app is stopped.');
  },

  async status() {
    const { app, how } = await withRunner((r) => JSON.parse(JSON.stringify({ app: r.appState(), how: r.getSettings().launcher || launcher.DEFAULT_LAUNCHER })));
    const serving = readServing();
    const h = await health();
    say(appText(app, serving, h));
    say(`Starts with: ${how}${serving?.launcher && serving.launcher !== how ? ` (the app now was started with ${serving.launcher})` : ''}`);
    const login = serving?.launcher === 'apphost' ? launcher.dashboardLogin(serving.workspace) : null;
    if (login) say(`Dashboard: ${login}`);
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
  let from = apiOwner ? norm(processInfo(apiOwner)) : '';
  // With the AppHost, Aspire's DCP holds the port and passes requests on: the api itself is the Platform API host.
  if (/\/dcp\.exe/.test(from)) from = hostsIn(ws).map((h) => norm(h.program)).find((h) => /orbitax\.platform\.api(\.exe|\.dll)/.test(h)) || '';
  const elsewhere = from && !from.includes(norm(ws));
  say(`The app is up: http://localhost:${p.web}${p.api ? ` (api http://localhost:${p.api})` : ''}, serving ${ws}.`);
  if (elsewhere) say(`Warning: the api process does not come from this workspace: ${from}`);
  if (serving.launcher === 'apphost') {
    const login = launcher.dashboardLogin(ws);
    say(login ? `Aspire dashboard (each service's console, traces): ${login}` : 'Aspire dashboard: http://localhost:15200 (its login line comes in .run-logs/aspire-dashboard.log; app status shows it)');
  }
  say(logNote(ws, serving));
}

// Which services to start: --services replaces the usual set, --with adds to it. A start with neither keeps the
// services of the app this run started before (a start again after a fix).
function pickServices(how, ws, serving) {
  const again = serving?.runId === actorId() && serving.launcher === how && serving.services?.length;
  let services = option('services') ? list(option('services')) : again ? serving.services : launcher.defaultServices(how, ws);
  if (flag('workers') && !option('services')) services = [...new Set([...services, 'primary', 'secondary', 'spreadsheet'])];
  services = [...new Set([...services, ...list(option('with'))])];
  const without = list(option('without'));
  services = services.filter((s) => !without.includes(s));
  if (how === 'apphost' && launcher.missionOff(ws, services)) say('Mission consumer: off. XatBot commands go to Primary for this start (ITP_MissionApis=","); your Debug.json is not changed.');
  const cannot = launcher.unsupported(how, services);
  if (cannot.length && !process.env.ORCHESTRA_APP_START) {
    say(`Note: run-stack.ps1 cannot start ${cannot.join(', ')}. For those: orch settings launcher=apphost`);
    services = services.filter((s) => !cannot.includes(s));
  }
  const idp = how === 'apphost' && services.includes('idp') ? launcher.idpProblem(ws) : null;
  if (idp) {
    say(`Note: the dev IdP (web login, :10203) cannot start: ${idp}. Starting without it; tell the user.`);
    services = services.filter((s) => s !== 'idp');
  }
  return services;
}

// Starts the app from ws with the launcher, records it as serving, and waits until it answers.
async function launch(actor, ws, how, services) {
  let cmd;
  // Your own checkout: the AppHost's appsettings.local.json there is yours. Keep your copy once before Orchestra
  // writes its service list into it.
  const local = path.join(launcher.apphostDir(ws), 'appsettings.local.json');
  if (actor.id === YOU && how === 'apphost') {
    const had = fs.existsSync(launcher.settingsBackup(ws));
    const backup = launcher.keepSettingsBackup(ws);
    if (backup && !had) say(`Kept your AppHost settings as ${backup} (Orchestra writes the service list into ${path.basename(local)}).`);
  }
  try {
    const brokersRunning = how === 'apphost' && !process.env.ORCHESTRA_APP_START && brokersListening();
    cmd = launcher.startCommand(how, ws, services, { brokersRunning, itpRoot: config.itpRoot });
  } catch (err) {
    fail(err.message);
  }
  fs.mkdirSync(launcher.logsDir(ws), { recursive: true });
  // The service logs of the app before are not this start's: the copier writes them fresh.
  if (how === 'apphost') for (const [name, file] of Object.entries(launcher.serviceLogs(ws))) if (!/^orchestra-/.test(name)) fs.rmSync(file, { force: true });
  const out = fs.openSync(path.join(launcher.logsDir(ws), 'orchestra-start.log'), 'w');
  const child = spawn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  const pids = [child.pid];
  // Aspire writes no per-service log files: the copier makes .run-logs/<service>.log from its DCP (bin/app-logs.mjs).
  if (how === 'apphost' && (!process.env.ORCHESTRA_APP_START || process.env.ORCHESTRA_DCP_SESSION)) {
    const copier = spawn(process.execPath, [path.join(config.root, 'bin', 'app-logs.mjs'), ws, String(child.pid)], { detached: true, stdio: 'ignore', windowsHide: true });
    copier.unref();
    pids.push(copier.pid);
  }
  writeServing({ runId: actor.id, title: actor.title, workspace: ws, branches: actor.branches, launcher: how, services, pids, startedAt: new Date().toISOString() });
  say(`Starting the app from ${ws} with ${how === 'apphost' ? 'the Aspire AppHost' : 'run-stack.ps1'}:`);
  for (const s of services) say(`  ${launcher.serviceLabel(s)}`);
  say('A cold start can take many minutes (the .NET services compile).');
  await finishStart(ws);
}

// Where to watch the logs: .run-logs/<service>.log (run-stack writes them; with the AppHost, the copier does).
function logNote(ws, serving) {
  const files = Object.keys(launcher.serviceLogs(ws)).filter((n) => !/^(orchestra-|manual-|aspire-)/.test(n));
  if (files.length) return `Live logs: ${files.map((n) => `.run-logs/${n}.log`).join(', ')}`;
  if (serving?.launcher === 'apphost') return "Live logs: none yet. Orchestra copies each service's console from Aspire into .run-logs/ while the app runs; if they stay missing, the copier found no Aspire files: tell the user, and read the Aspire dashboard meanwhile.";
  return 'Live logs: none yet in .run-logs/.';
}

function ordinal(n) {
  return `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
}

function appText(app, serving, h) {
  const lines = [];
  lines.push(app.holder?.you ? 'Has the app: you (your own checkout; orch app stop frees it)' : app.holder ? `Has the app: ${app.holder.title}${app.holder.waitingForYou ? ' (waiting for you)' : ''}` : 'Has the app: nobody');
  lines.push(`In line: ${app.line.length ? app.line.map((x) => x.title).join(', ') : 'nobody'}`);
  const whose = serving?.runId === YOU ? 'your checkout' : `${serving?.title}'s code`;
  const at = serving ? new Date(serving.startedAt).toTimeString().slice(0, 5) : ''; // this PC's time, not UTC
  lines.push(serving ? `Serving: ${whose} from ${serving.workspace}${serving.branches ? ` (${serving.branches})` : ''}, started ${at}` : 'Serving: not started by Orchestra');
  if (serving?.services?.length) lines.push(`Services: ${serving.services.join(', ')}`);
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
