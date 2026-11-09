// How the ITP app is started: the launcher setting (orch settings launcher=apphost|runstack).
// One contract for bin/app.mjs: start [services] · stop · restart <service> · status · logs at <ws>/.run-logs/<service>.log.
//   apphost  the Aspire AppHost (ITP-API/Orbitax.Platform.Api/Applications/Orbitax.AppHost): every host the branch has,
//            Mission consumer and Scheduler included. Orchestra writes the run's resource list to the AppHost's
//            gitignored appsettings.local.json in the run's worktree, then runs it with the http launch profile.
//   runstack run-stack.ps1 at the workspace root (the old way, kept as a fallback). It has no Mission consumer,
//            no Scheduler and no MCP consumer.
// ORCHESTRA_APP_START (a JSON command line with {ws}) overrides both; the tests use it.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../lib/config.mjs';

export const LAUNCHERS = ['apphost', 'runstack'];
export const DEFAULT_LAUNCHER = 'apphost';

// Orchestra's service names, and what each launcher calls them (null: that launcher cannot start it).
const SERVICES = {
  webclient: { apphost: 'webclient', runstack: 'webclient', label: 'web app (:9000)' },
  api: { apphost: 'platform', runstack: 'api', label: 'Platform API (:50544)' },
  primary: { apphost: 'primary', runstack: 'primary', label: 'Primary (:50546)' },
  secondary: { apphost: 'secondary', runstack: 'secondary', label: 'Secondary (:50547)' },
  spreadsheet: { apphost: 'spreadsheetjob', runstack: 'spreadsheet', label: 'Spreadsheet Job (no port)' },
  mission: { apphost: 'mission', runstack: null, label: 'Mission consumer (:50550)' },
  scheduler: { apphost: 'scheduler', runstack: null, label: 'Scheduler (:50549)' },
  mcp: { apphost: 'mcp-consumer', runstack: null, label: 'MCP consumer (:50548)' },
  idp: { apphost: 'teamspace-agent', runstack: null, label: 'dev IdP (:10203)' },
  outsider: { apphost: 'outsider', runstack: 'outsider', label: 'Outsider (:50545)' },
};

// The AppHost's own names (platform, spreadsheetjob, mcp-consumer, teamspace-agent) work too.
const ALIASES = Object.fromEntries(Object.entries(SERVICES).flatMap(([k, v]) => [[k, k], [v.apphost, k], [v.runstack || k, k]]));

export function serviceName(s) {
  const key = ALIASES[String(s).trim().toLowerCase()];
  if (!key) throw new Error(`unknown service: ${s}. Services: ${Object.keys(SERVICES).join(', ')}`);
  return key;
}

export const serviceLabel = (key) => SERVICES[key]?.label || key;

// The log file name for an AppHost resource: Orchestra's service name (platform → api), or the resource's own.
export function logNameOf(resource) {
  return ALIASES[String(resource).toLowerCase()] || String(resource).toLowerCase();
}

// MSBuild's reused worker nodes can hang a cold `dotnet run` of the AppHost at "Building..." for good.
export const BUILD_ENV = { MSBUILDDISABLENODEREUSE: '1' };

// The dev IdP (teamspace-agent) runs from <ws>/teamspace-agent with its own debug.json (gitignored, it holds keys).
// Without it the IdP exits at once and the web login fails, and Aspire shows no reason. Returns the problem, or null.
export function idpProblem(ws) {
  const dir = path.join(ws, 'teamspace-agent');
  if (!fs.existsSync(dir)) return `no teamspace-agent folder in ${ws}`;
  if (!fs.existsSync(path.join(dir, 'debug.json'))) {
    return `${path.join(dir, 'debug.json')} is missing. Make it from debug.json.example (it needs the JwtTokenKey from your Debug.json)`;
  }
  return null;
}

export const apphostDir = (ws) => path.join(ws, 'ITP-API', 'Orbitax.Platform.Api', 'Applications', 'Orbitax.AppHost');

// The usual set: everything a full test needs. Outsider only when asked (--with outsider).
// apphost: Mission only when the branch has its consumer and MissionApis does not keep XatBot on Primary.
export function defaultServices(launcher, ws) {
  const base = ['webclient', 'api', 'primary', 'secondary', 'spreadsheet'];
  if (launcher !== 'apphost') return base;
  const list = [...base, 'scheduler', 'mcp', 'idp'];
  if (missionWanted(ws)) list.push('mission');
  return list;
}

export function hasMissionConsumer(ws) {
  return fs.existsSync(path.join(ws, 'ITP-API', 'Orbitax.Platform.Api', 'Applications', 'Orbitax.MissionPlatform.Consumer'));
}

// MissionApis="," keeps XatBot on Primary: then the Mission consumer must stay off (AppHost README).
export function missionApis() {
  if (process.env.ITP_MissionApis !== undefined) return process.env.ITP_MissionApis;
  try {
    const file = process.env.ITP_DebugJsonPath || 'C:/LocalStore/Debug.json'; // ITP's own default, on every dev PC
    const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => /^\s*"MissionApis"\s*:/.test(l));
    return line ? line.match(/:\s*"([^"]*)"/)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

function missionWanted(ws) {
  return hasMissionConsumer(ws) && missionApis() !== ',';
}

// The branch has the Mission consumer but this start leaves it off, while MissionApis still sends XatBot commands to
// the Mission queues: nothing would read them and they would hang. Then each host gets ITP_MissionApis="," for this
// start (an ITP_ env var wins over Debug.json), so XatBot falls back to Primary. Debug.json is not changed.
export function missionOff(ws, services) {
  return hasMissionConsumer(ws) && !services.includes('mission') && missionApis() !== ',';
}
const MISSION_OFF = { ITP_MissionApis: ',' };

// The services that launcher cannot start, from a list.
export function unsupported(launcher, services) {
  return services.filter((s) => !SERVICES[s][launcher]);
}

// The command that starts the app: { exe, args, cwd, env }. Throws with a plain message when it cannot.
// brokersRunning: Redis and RabbitMQ already listen (Windows services): the AppHost must not start its own.
export function startCommand(launcher, ws, services, { brokersRunning = false, itpRoot } = {}) {
  const custom = process.env.ORCHESTRA_APP_START;
  if (custom) {
    const [exe, ...args] = JSON.parse(custom.replaceAll('{ws}', ws.replace(/\\/g, '/')));
    // Its script (like start.mjs): a program that runs it is one of the app's hosts (stop ends it).
    const script = args.find((a) => /\.(m?js|ps1|cmd|bat|exe)$/i.test(a)) || null;
    return { exe, args, cwd: ws, env: {}, script };
  }
  if (launcher === 'runstack') {
    const script = path.join(ws, 'run-stack.ps1');
    if (!fs.existsSync(script)) throw new Error(`no run-stack.ps1 in ${ws}. Try: orch settings launcher=apphost`);
    const keys = services.map((s) => SERVICES[s].runstack).filter(Boolean);
    return { exe: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -Only ${keys.join(',')}`], cwd: ws, env: {} };
  }
  const dir = apphostDir(ws);
  if (!fs.existsSync(path.join(dir, 'Orbitax.AppHost.csproj'))) {
    throw new Error(`this branch has no Aspire AppHost (${dir}). For an old branch: orch settings launcher=runstack`);
  }
  writeApphostSettings(ws, services, { brokersRunning, itpRoot });
  return {
    exe: 'dotnet',
    args: ['run', '--project', 'Applications/Orbitax.AppHost', '--launch-profile', 'http'],
    cwd: path.join(ws, 'ITP-API', 'Orbitax.Platform.Api'),
    // The AppHost reads ITP_MissionApis too (its SQA check); the hosts get it from their env map (writeApphostSettings).
    env: { ASPIRE_ALLOW_UNSECURED_TRANSPORT: 'true', ...BUILD_ENV, ...(missionOff(ws, services) ? MISSION_OFF : {}) },
  };
}

// Restarting some services: { exe, args, … } for one command, or { full: true } when the launcher can only stop and
// start everything again. The AppHost can restart one resource only through the aspire CLI / MCP, which this PC does
// not have yet, so it restarts in full (the relaunch rebuilds what changed).
export function restartCommand(launcher, ws, services) {
  if (process.env.ORCHESTRA_APP_START || launcher === 'apphost') return { full: true };
  const keys = services.map((s) => SERVICES[s].runstack).filter(Boolean);
  const script = path.join(ws, 'run-stack.ps1');
  return { exe: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${script}' -Restart -Only ${keys.join(',')}`], cwd: ws, env: {} };
}

// ---------- the AppHost's appsettings.local.json ----------

// JSON with // comments and trailing commas (the example file has both). Strings are left alone.
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// The backup of a workspace's own appsettings.local.json lives in Orchestra's data folder (not in git), never in the
// ITP repo: there an extra file would show up in git status and could be pushed by mistake.
export function settingsBackup(ws) {
  const slug = path.resolve(ws).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return path.join(config.dataDir, 'apphost-backups', `${slug}.appsettings.local.json`);
}

// Keeps the workspace's appsettings.local.json once (an earlier backup is never overwritten). A backup that an older
// Orchestra left inside the repo (appsettings.local.json.bak-orchestra) moves to the data folder. Returns the path, or
// null when there is nothing to keep.
export function keepSettingsBackup(ws) {
  const file = path.join(apphostDir(ws), 'appsettings.local.json');
  const old = `${file}.bak-orchestra`;
  const backup = settingsBackup(ws);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (fs.existsSync(old)) {
    if (!fs.existsSync(backup)) fs.copyFileSync(old, backup);
    fs.rmSync(old);
  }
  if (!fs.existsSync(backup) && fs.existsSync(file)) fs.copyFileSync(file, backup);
  return fs.existsSync(backup) ? backup : null;
}

// Writes the run's resource list. Keeps what the file already had (per-resource settings like the webclient's
// scriptName or env, other AppHost keys); turns on exactly the chosen services, plus redis and rabbitmq unless they
// already run on this PC. A file it cannot read is kept as a backup (settingsBackup).
// The first time, the user's own ITP checkout's file (if any) is the starting point.
export function writeApphostSettings(ws, services, { brokersRunning = false, itpRoot } = {}) {
  const file = path.join(apphostDir(ws), 'appsettings.local.json');
  const own = itpRoot ? path.join(apphostDir(itpRoot), 'appsettings.local.json') : null;
  let base = {};
  const source = fs.existsSync(file) ? file : own && fs.existsSync(own) ? own : null;
  if (source) {
    try {
      base = parseJsonc(fs.readFileSync(source, 'utf8'));
    } catch {
      if (source === file) keepSettingsBackup(ws);
      base = {};
    }
  }
  const appHost = { ...(base.AppHost || {}) };
  const old = appHost.Resources || {};
  const want = new Set(services.map((s) => SERVICES[s].apphost));
  if (!brokersRunning) want.add('redis').add('rabbitmq');
  const names = new Set([...Object.keys(old), ...want, 'redis', 'rabbitmq']);
  const off = missionOff(ws, services);
  const resources = {};
  for (const name of names) {
    const keep = old[name] && typeof old[name] === 'object' ? { ...old[name] } : {};
    resources[name] = { ...keep, enabled: want.has(name) };
    if (!want.has(name) && resources[name].show === undefined) resources[name].show = false;
    // Mission off: every host this start runs gets ITP_MissionApis="," (see missionOff). Mission on: a "," left by an
    // earlier start comes out again (with the consumer running, XatBot belongs on it). Your other env keys stay.
    const env = { ...(keep.env && typeof keep.env === 'object' ? keep.env : {}) };
    if (off && want.has(name) && !['redis', 'rabbitmq'].includes(name)) Object.assign(env, MISSION_OFF);
    else if (env.ITP_MissionApis === ',') delete env.ITP_MissionApis;
    if (Object.keys(env).length) resources[name].env = env;
    else delete resources[name].env;
  }
  appHost.Resources = resources;
  const out = { ...base, AppHost: appHost };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return { file, resources };
}

// ---------- logs ----------

// Aspire's DCP keeps each service's console in its session folder as <id>_out and <id>_err. The file
// resource-executable-<id>.log names the service: `"Executable": "/<resource>-<8 letters>"`.
// Returns { id: resource } for the ids it can name now.
export function dcpResources(session) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(session);
  } catch {
    return out;
  }
  for (const n of names) {
    const id = n.match(/^resource-executable-(.+)\.log$/)?.[1];
    if (!id) continue;
    try {
      const exe = fs.readFileSync(path.join(session, n), 'utf8').match(/"Executable":\s*"\/([^"]+)"/)?.[1];
      if (exe) out[id] = exe.replace(/-[a-z0-9]{8}$/, '');
    } catch {}
  }
  return out;
}

// One DCP console line is `<number> <UTC time> <text>`, and Aspire runs the hosts with colors on
// (`ESC[32minfo ESC[39m: …`). Only the plain text is kept, as run-stack wrote it: the watcher's ^fail: needs that.
export const dcpLine = (line) => line.replace(/^\d+ \d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[\d;]*[A-Za-z]/g, '');

export const logsDir = (ws) => path.join(ws, '.run-logs');

// The per-service log files that exist now: { name: path }.
export function serviceLogs(ws) {
  try {
    return Object.fromEntries(fs.readdirSync(logsDir(ws)).filter((n) => n.endsWith('.log')).map((n) => [n.slice(0, -4), path.join(logsDir(ws), n)]));
  } catch {
    return {};
  }
}

// The dashboard's login line ("Login to the dashboard at <url>"): in the dashboard's own log (the copier's
// aspire-dashboard.log, JSON lines) or, with older Aspire, in the AppHost's console (orchestra-start.log).
export function dashboardLogin(ws) {
  for (const name of ['aspire-dashboard.log', 'orchestra-start.log']) {
    try {
      const url = fs.readFileSync(path.join(logsDir(ws), name), 'utf8').match(/Login to the dashboard at (http[^\s"\\]+)/i)?.[1];
      if (url) return url;
    } catch {}
  }
  return null;
}
