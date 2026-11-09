// The app, one holder at a time: which run's code it serves (data/app.json), your own hold on it, and the process
// helpers a pack's app and clean-up use. What the app is and how it starts is the pack's (pack.app).
// Windows only: ports and processes are read with PowerShell, processes stopped with taskkill.
import { spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { alive } from './util.mjs';

export const SERVING = () => path.join(config.dataDir, 'app.json'); // { runId, title, workspace, pids, … }

// You hold the app (orch app start, outside any run): { at, workspace }. Runs that want the app wait while it is here.
export const YOU = 'you';
const YOURS = () => path.join(config.dataDir, 'app-you.json');

export function readYourHold() {
  try {
    return JSON.parse(fs.readFileSync(YOURS(), 'utf8'));
  } catch {
    return null;
  }
}

// Your hold on the app, while it still means something: it ends by itself once the app you started is gone (none
// of its processes lives), so runs waiting for the app go on. A hold with no app record yet is the start itself:
// kept for 15 minutes.
export function activeYourHold() {
  const h = readYourHold();
  if (!h) return null;
  const s = readServing();
  if (s?.runId === YOU ? (s.pids || []).some((pid) => alive(pid)) : Date.now() - Date.parse(h.at || 0) < 15 * 60 * 1000) return h;
  try {
    writeYourHold(null);
  } catch {}
  return null;
}

export function writeYourHold(h) {
  fs.mkdirSync(path.dirname(YOURS()), { recursive: true });
  if (h) fs.writeFileSync(YOURS(), JSON.stringify(h, null, 1) + '\n');
  else fs.rmSync(YOURS(), { force: true });
}

export function readServing() {
  try {
    return JSON.parse(fs.readFileSync(SERVING(), 'utf8'));
  } catch {
    return null;
  }
}

// pidsAt: when the pids were last written. Each of them belonged to a live process of the app then, so a process
// with that pid that was created later is another program that got a reused pid: it is never killed.
export function writeServing(s) {
  fs.mkdirSync(path.dirname(SERVING()), { recursive: true });
  if (s) fs.writeFileSync(SERVING(), JSON.stringify({ ...s, pidsAt: Date.now() }, null, 1) + '\n');
  else fs.rmSync(SERVING(), { force: true });
}

export function powershell(script) {
  return spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout || '';
}

// pid listening on each of the ports: { port: pid }. IPv4 and IPv6 (a dev server may listen on [::1] only).
// Listening sockets are the ones with no remote port. (netstat misses sockets opened inside a sandbox.)
export function portOwners(ports) {
  if (!ports.length) return {};
  const out = powershell(`Get-NetTCPConnection -LocalPort ${ports.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | ForEach-Object { '{0} {1}' -f $_.LocalPort, $_.OwningProcess }`);
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

// Processes whose program or command line is inside dir (a run's folder): its app, dev servers, build nodes.
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

// ---- the processes a run's claude started ----
// A program that claude starts (a helper server, say) may outlive the program between them, and then has no parent
// left: no tree reaches it, and its command line need not name the run folder (only its working folder does, which
// Windows does not show). So while the tab is open the launcher writes down claude's whole tree now and then
// (runs/<id>/procs.json), and clean-up stops whatever of it still runs. Each process is kept with its start time, so
// a pid Windows gave to another program later is never stopped.

const PS_TREE = `Get-CimInstance Win32_Process | ForEach-Object { '{0}\t{1}\t{2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) }`;

function parseTree(out) {
  return String(out || '').split('\n').map((l) => l.replace(/\r$/, '').split('\t')).map(([pid, ppid, created]) => ({ pid: Number(pid), ppid: Number(ppid), created: created || '' })).filter((p) => p.pid);
}

// Every process under rootPid (not rootPid itself), as [{ pid, created }]. Async: a launcher must not block its tab.
export function descendants(rootPid) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', PS_TREE], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      const procs = parseTree(out);
      const kids = new Map();
      for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
      const found = [];
      const todo = [...(kids.get(Number(rootPid)) || [])];
      while (todo.length) {
        const p = todo.pop();
        if (found.some((f) => f.pid === p.pid)) continue;
        found.push({ pid: p.pid, created: p.created });
        todo.push(...(kids.get(p.pid) || []));
      }
      resolve(found);
    });
  });
}

// Adds claude's tree as it is now to the run's record (file). At most 500 kept, the newest.
export async function recordTree(file, rootPid) {
  const now = await descendants(rootPid);
  if (!now.length) return;
  let kept = [];
  try {
    kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const key = (p) => `${p.pid}@${p.created}`;
  const seen = new Set(kept.map(key));
  const all = [...kept, ...now.filter((p) => !seen.has(key(p)))].slice(-500);
  try {
    fs.writeFileSync(file, JSON.stringify(all));
  } catch {}
}

// Stops what of the record still runs (same pid and the same start time). Returns how many.
export function killRecorded(file) {
  let kept = [];
  try {
    kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  if (!kept.length) return 0;
  const live = new Map(parseTree(powershell(PS_TREE)).map((p) => [p.pid, p.created]));
  let n = 0;
  for (const p of kept) {
    if (p.pid === process.pid || live.get(p.pid) !== p.created) continue;
    killTree(p.pid);
    n++;
  }
  return n;
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
