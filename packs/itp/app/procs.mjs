// The ITP app's processes: its ports, the hosts behind them (dotnet, ng serve, run-stack.ps1, Aspire's DCP), and how
// to stop it safely. Built on the core's process helpers (lib/app.mjs). Windows only.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../../lib/config.mjs';
import { sleep } from '../../../lib/util.mjs';
import { powershell, portOwners as ownersOf, processInfo, norm, processesIn, killTree, readServing, writeServing } from '../../../lib/app.mjs';

// The app's ports by name. Tests use their own (ORCHESTRA_APP_PORTS=api=7101,web=7102).
export function appPorts() {
  const custom = process.env.ORCHESTRA_APP_PORTS;
  if (!custom) return { web: 9000, api: 50544, outsider: 50545, primary: 50546, secondary: 50547, mcp: 50548, scheduler: 50549, mission: 50550, dashboard: 15200 };
  return Object.fromEntries(custom.split(',').filter(Boolean).map((pair) => {
    const [k, v] = pair.split('=');
    return [k, Number(v)];
  }));
}

// pid listening on each app port: { port: pid }.
export const portOwners = () => ownersOf(Object.values(appPorts()));

// Redis (6379) and RabbitMQ (5672) already listen: on this PC they run as Windows services, so the AppHost must not
// start its own. Tests set ORCHESTRA_BROKERS=on|off.
export function brokersListening() {
  if (process.env.ORCHESTRA_BROKERS) return process.env.ORCHESTRA_BROKERS === 'on';
  // Listening = no remote port, as in portOwners: on this PC their State comes back empty, so -State Listen misses them.
  const out = powershell(`Get-NetTCPConnection -LocalPort 6379,5672 -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | ForEach-Object { $_.LocalPort }`);
  const ports = new Set(out.split('\n').map((l) => Number(l.trim())).filter(Boolean));
  return ports.has(6379) && ports.has(5672);
}

// The app's hosts that run from a workspace, port or not (the Spreadsheet Job has none): programs inside it (the
// hosts' own .exe in their bin folders), and `dotnet run|exec|watch`, `ng serve` or run-stack.ps1 of that folder.
// Never an editor or IDE that has the folder open (Visual Studio names Orbitax.*.slnx), a log watcher, or a claude.
// startScript: the script of your own start command (ORCHESTRA_APP_START), saved when the app started: a program
// that runs it is a host too.
export function hostsIn(dir, startScript = null) {
  const want = norm(path.resolve(dir)).replace(/\/$/, '') + '/';
  const own = startScript && norm(startScript);
  return processesIn(dir).filter((p) => {
    const prog = norm(p.program);
    return prog.startsWith(want) || /\bdotnet(\.exe)?"?\s+(run|exec|watch)\b|\bng(\.cmd|\.js)?"?\s+serve\b|run-stack\.ps1/.test(prog) || (!!own && prog.includes(own));
  });
}

// The DCP session folder of the AppHost that runs from ws, or null. Aspire's DCP is started as
// `dcp.exe start-apiserver --monitor <AppHost pid> --kubeconfig <session folder>\kubeconfig`; the AppHost's program
// sits inside the workspace (…\Orbitax.AppHost\bin\…), so this finds the run's own app whatever the folder layout.
// Tests set ORCHESTRA_DCP_SESSION.
export function dcpSessionFor(ws) {
  if (process.env.ORCHESTRA_DCP_SESSION) return process.env.ORCHESTRA_DCP_SESSION;
  const want = norm(path.resolve(ws)).replace(/\/$/, '') + '/';
  const out = powershell(`Get-CimInstance Win32_Process -Filter "Name='dcp.exe'" | Where-Object { $_.CommandLine -match 'start-apiserver' } | ForEach-Object { $_.CommandLine }`);
  for (const line of out.split('\n')) {
    const monitor = Number(line.match(/--monitor\s+(\d+)/)?.[1]);
    const kube = line.match(/--kubeconfig\s+("[^"]+"|\S+)/)?.[1]?.replace(/"/g, '');
    if (!monitor || !kube) continue;
    if (norm(processInfo(monitor)).startsWith(want)) return path.dirname(kube);
  }
  return null;
}

// The pids run-stack.ps1 wrote for a workspace's app (its cmd.exe wrappers; killing the tree stops the service).
export function stackPids(ws) {
  try {
    return Object.values(JSON.parse(fs.readFileSync(path.join(ws, '.run-logs', 'stack-pids.json'), 'utf8'))).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

// Started by Orchestra: from a run workspace (C:/o/...), a pid it recorded, or a host of the folder Orchestra started
// the app from (your own checkout too: Aspire restarts a service under a new pid).
function isOurs(pid, known) {
  if (known.has(pid)) return true;
  const info = norm(processInfo(pid));
  return !!info && info.includes(norm(config.worktreesDir) + '/');
}

// Every process of the app Orchestra started (serving): its recorded pids, its hosts, the DCP of the AppHost that runs
// from its folder, and everything those started. Aspire's DCP owns the app's ports and starts each service, and
// neither its command line nor ng serve's (a relative path) names the folder, so the tree is what tells.
export function appTree(serving) {
  const tree = new Set();
  if (!serving) return tree;
  const out = powershell(`Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}\t{3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }), $_.CommandLine }`);
  const procs = out.split('\n').map((l) => l.replace(/\r$/, '').split('\t')).map(([pid, ppid, created, ...cmd]) => ({ pid: Number(pid), ppid: Number(ppid), created: Date.parse(created) || 0, cmd: norm(cmd.join('\t')) })).filter((p) => p.pid);
  // A saved pid counts only while it is still the process that was saved (not created after the save).
  const savedBy = serving.pidsAt ? serving.pidsAt + 5000 : Infinity;
  const roots = (serving.pids || []).filter((pid) => procs.some((p) => p.pid === pid && p.created <= savedBy));
  if (serving.workspace) {
    roots.push(...stackPids(serving.workspace), ...hostsIn(serving.workspace, serving.startScript).map((p) => p.pid));
    const session = dcpSessionFor(serving.workspace);
    if (session) roots.push(...procs.filter((p) => p.cmd.includes(norm(session).replace(/\/$/, '') + '/')).map((p) => p.pid));
  }
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), p.pid]);
  const todo = roots.filter((pid) => procs.some((p) => p.pid === pid));
  while (todo.length) {
    const pid = todo.pop();
    if (tree.has(pid) || pid === process.pid) continue;
    tree.add(pid);
    todo.push(...(children.get(pid) || []));
  }
  return tree;
}

// Stops the app. Refuses (returns the processes) when it runs from somewhere Orchestra did not start it, unless force.
export async function stopApp({ force }) {
  const serving = readServing();
  // The app's processes as they are now: saved pids that were reused by other programs are left out.
  const known = appTree(serving);
  const owners = portOwners();
  const foreign = Object.entries(owners).filter(([, pid]) => !isOurs(pid, known));
  if (foreign.length && !force) return { refused: foreign.map(([port, pid]) => ({ port: Number(port), pid, program: processInfo(pid) })) };
  for (const pid of new Set([...known, ...Object.values(owners)])) killTree(pid);
  // Hosts with no port that outlive their tree (the AppHost's resources, run-stack's Spreadsheet Job). Looked up
  // again: killing the trees above may have left some on their own.
  if (serving?.workspace) for (const p of hostsIn(serving.workspace, serving.startScript)) killTree(p.pid);
  for (let i = 0; i < 60 && Object.keys(portOwners()).length; i++) await sleep(500);
  const left = portOwners();
  // Something still holds a port: keep the record of what is left, so a later stop still knows it is the app's.
  writeServing(Object.keys(left).length && serving ? { ...serving, pids: [...new Set(Object.values(left))] } : null);
  return { stopped: true, left };
}

// Clean-up of a run folder: stop the app when it serves that folder. Returns a note, or null.
export async function stopFor(dir) {
  const serving = readServing();
  if (!serving?.workspace || norm(serving.workspace) !== norm(dir)) return null;
  const r = await stopApp({ force: false });
  return r.refused ? 'the app on its ports was not started from this run: left alone' : 'stopped the app it served';
}
