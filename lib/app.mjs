// The ITP app and the processes behind it: which run's code it serves, who listens on its ports, and how to
// stop it safely. Used by bin/app.mjs (the "Test in the app" step) and by clean-up (lib/runner.mjs).
// Windows only: ports and processes are read with PowerShell, processes stopped with taskkill.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

export const SERVING = () => path.join(config.dataDir, 'app.json'); // { runId, title, workspace, pids, … }

// The app's ports by name. Tests use their own (ORCHESTRA_APP_PORTS=api=7101,web=7102).
export function appPorts() {
  const custom = process.env.ORCHESTRA_APP_PORTS;
  if (!custom) return { web: 9000, api: 50544, outsider: 50545, primary: 50546, secondary: 50547 };
  return Object.fromEntries(custom.split(',').filter(Boolean).map((pair) => {
    const [k, v] = pair.split('=');
    return [k, Number(v)];
  }));
}

export function readServing() {
  try {
    return JSON.parse(fs.readFileSync(SERVING(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeServing(s) {
  fs.mkdirSync(path.dirname(SERVING()), { recursive: true });
  if (s) fs.writeFileSync(SERVING(), JSON.stringify(s, null, 1) + '\n');
  else fs.rmSync(SERVING(), { force: true });
}

function powershell(script) {
  return spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout || '';
}

// pid listening on each app port: { port: pid }. IPv4 and IPv6 (ng serve may listen on [::1] only).
// Listening sockets are the ones with no remote port. (netstat misses sockets opened inside a sandbox.)
export function portOwners() {
  const ports = Object.values(appPorts()).join(',');
  const out = powershell(`Get-NetTCPConnection -LocalPort ${ports} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | ForEach-Object { '{0} {1}' -f $_.LocalPort, $_.OwningProcess }`);
  const owners = {};
  for (const line of out.split('\n')) {
    const [port, pid] = line.trim().split(' ').map(Number);
    if (port && pid) owners[port] = pid;
  }
  return owners;
}

// The program and command line of a process, to tell whose it is.
export function processInfo(pid) {
  return powershell(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.ExecutablePath; $p.CommandLine }`).trim().replace(/\s+/g, ' ');
}

export const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

// Processes whose program or command line is inside dir (a run's folder): its app, ng serve, build nodes.
// Never this process or its parents.
export function processesIn(dir) {
  const want = norm(path.resolve(dir)).replace(/\/$/, '') + '/';
  const out = powershell(`Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}' -f $_.ProcessId, $_.ExecutablePath, $_.CommandLine }`);
  const list = [];
  for (const line of out.split('\n')) {
    const [pid, exe, cmd] = line.replace(/\r$/, '').split('\t');
    const n = Number(pid);
    if (!n || n === process.pid || n === process.ppid) continue;
    if (norm(exe).startsWith(want) || norm(cmd).includes(want)) list.push({ pid: n, program: `${exe || ''} ${cmd || ''}`.trim() });
  }
  return list;
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

// The pids run-stack.ps1 wrote for a workspace's app (its cmd.exe wrappers; killing the tree stops the service).
export function stackPids(ws) {
  try {
    return Object.values(JSON.parse(fs.readFileSync(path.join(ws, '.run-logs', 'stack-pids.json'), 'utf8'))).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

// Started by Orchestra: from a run workspace (C:/o/...), or a pid it recorded.
function isOurs(pid, known) {
  if (known.has(pid)) return true;
  const info = norm(processInfo(pid));
  return !!info && info.includes(norm(config.worktreesDir) + '/');
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Stops the app. Refuses (returns the processes) when it runs from somewhere Orchestra did not start it, unless force.
export async function stopApp({ force }) {
  const serving = readServing();
  const known = new Set([...(serving?.pids || []), ...(serving?.workspace ? stackPids(serving.workspace) : [])]);
  const owners = portOwners();
  const foreign = Object.entries(owners).filter(([, pid]) => !isOurs(pid, known));
  if (foreign.length && !force) return { refused: foreign.map(([port, pid]) => ({ port: Number(port), pid, program: processInfo(pid) })) };
  for (const pid of new Set([...known, ...Object.values(owners)])) killTree(pid);
  for (let i = 0; i < 60 && Object.keys(portOwners()).length; i++) await sleep(500);
  const left = portOwners();
  writeServing(null);
  return { stopped: true, left };
}
