// App slots: each run tests in its own copy of the ITP app, side by side, instead of waiting in line for the one app.
//
// A slot = one stack of the team's itp-stacks skill (<ITP>/.claude/skills/itp-stacks/stacks.ps1: own ports, RabbitMQ
// vhost, Redis, Centrifugo prefix, the run's own build) on its own Mongo: a Docker volume copied from the "golden"
// copy of your Local DB (indexes kept, so no 13-minute index build). The ITP repo is never changed: Orchestra only
// calls stacks.ps1 and Docker.
//
// Measured on this setup (2026-11-19): master copy 28 min for 11 GB (once, and when you refresh it); master copy -> slot
// 62 s; a stack up in ~2-2.5 min (~5 min the first time, when it builds the run's web page); ~2 GB RAM while it runs.
//
// A slot lives as long as its run: made at the run's first test, stopped between steps (0 RAM, data kept), dropped
// when the run is cleaned or deleted. settings `stacks` = how many slots may RUN at once (0 = slots off: the one
// shared app, as before). Stopped slots take only disk; a new one is refused when the disk is short.
//
// State: data/slots.json { golden, refreshing, slots: { <runId>: slot }, want: { <runId>: at } }, changed under the
// Orchestra lock; slow work (copies, stacks.ps1) runs with the lock let go.
// Tests: ORCHESTRA_DOCKER / ORCHESTRA_STACKS (JSON command lists) stand in for Docker and stacks.ps1.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from '../../../lib/config.mjs';
import { withLock } from '../../../lib/lock.mjs';
import { alive, sleep } from '../../../lib/util.mjs';
import { norm } from '../../../lib/app.mjs';

const MONGO_IMAGE = 'mongo:7.0';
const TOOL_IMAGE = 'alpine:3.20';
const GOLDEN_OLD_DAYS = 7; // orch status nudges after this
const DISK_MARGIN_GB = 10; // free disk kept besides a new slot's copy
const SLOT_MONGO_PORTS = [27260, 27299];
const SLOT_CACHE_GB = '1'; // each slot's Mongo cache: three slots must fit Docker's memory
// The services a slot starts when the step names none (Mission and Outsider only on ask), and each one's project.
export const DEFAULT_SERVICES = ['api', 'primary', 'secondary', 'webclient'];
const PROJECTS = {
  api: 'Orbitax.Platform.Api',
  primary: 'Orbitax.PrimaryPlatform.Consumer',
  secondary: 'Orbitax.SecondaryPlatform.Consumer',
  mission: 'Orbitax.MissionPlatform.Consumer',
  outsider: 'Orbitax.Outsider.Api',
  spreadsheet: 'Orbitax.Spreadsheet.Job',
};
export const SERVICES = [...Object.keys(PROJECTS), 'webclient'];

const FILE = () => path.join(config.dataDir, 'slots.json');
const GOLDEN_LOG = () => path.join(config.dataDir, 'golden-refresh.log');
const say = (s) => process.stdout.write(s + '\n');
const fake = () => !!process.env.ORCHESTRA_STACKS;

export class SlotError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------- state ----------

export function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return { golden: null, refreshing: null, slots: {}, want: {}, ...s };
  } catch {
    return { golden: null, refreshing: null, slots: {}, want: {} };
  }
}

function writeState(s) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
  fs.renameSync(tmp, FILE());
}

// Changes the state under the Orchestra lock: fn(state) edits it in place and returns what the caller needs.
export async function edit(fn) {
  return withLock(async () => {
    const s = readState();
    const out = await fn(s);
    writeState(s);
    return out;
  });
}

// ---------- settings ----------

// How many slots may run at once; 0 = slots off.
export function maxOf(settings) {
  const n = Number(settings?.stacks);
  return Number.isInteger(n) && n >= 0 ? n : 3;
}

// Read straight from settings.json: lib/store.mjs loads the pack, so the pack must not load it (a load-time loop).
export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function maxSlots() {
  return maxOf(readSettings());
}

// ---------- Docker and stacks.ps1 ----------

function dockerExe() {
  if (process.env.ORCHESTRA_DOCKER) return JSON.parse(process.env.ORCHESTRA_DOCKER);
  const onPath = spawnSync('where', ['docker'], { encoding: 'utf8', windowsHide: true });
  if (onPath.status === 0 && onPath.stdout.trim()) return ['docker'];
  // Docker Desktop's own folder: a process started before the install has no docker on its PATH.
  return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')];
}

// Docker's own folder on PATH too: a process started before Docker was installed lacks it, and docker then cannot find
// its credential helper (docker-credential-desktop), so every image download fails.
function dockerEnv() {
  const [exe] = dockerExe();
  const dir = path.isAbsolute(exe) ? path.dirname(exe) : path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin');
  return { ...process.env, PATH: `${process.env.PATH};${dir}` };
}

export function docker(args, { timeout = 120000 } = {}) {
  const [exe, ...pre] = dockerExe();
  const r = spawnSync(exe, [...pre, ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: dockerEnv() });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

// Long Docker work (copies): runs without blocking, so the lock's heartbeat and Ctrl+C keep working.
function dockerLong(args, { logTo } = {}) {
  const [exe, ...pre] = dockerExe();
  return new Promise((resolve) => {
    const child = spawn(exe, [...pre, ...args], { windowsHide: true, env: dockerEnv() });
    let out = '';
    const take = (d) => {
      out += d;
      if (logTo) fs.appendFileSync(logTo, d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => resolve({ ok: false, out: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

export function dockerProblem() {
  const r = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 30000 });
  if (r.ok) return null;
  if (/not recognized|ENOENT|cannot find/i.test(r.err)) return 'Docker is not installed on this PC (install Docker Desktop)';
  return 'Docker is not running: start Docker Desktop and wait until it says "Engine running"';
}

export function stacksScript() {
  return config.solutionRoot ? path.join(config.solutionRoot, '.claude', 'skills', 'itp-stacks', 'stacks.ps1') : null;
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Runs stacks.ps1 with its words (PowerShell syntax, so -Only a,b is a list), printing its output as it comes.
// Returns { ok, out }.
function stacks(words, { quiet = false } = {}) {
  let exe;
  let args;
  if (fake()) [exe, ...args] = [...JSON.parse(process.env.ORCHESTRA_STACKS), ...words];
  else {
    const script = stacksScript();
    exe = 'powershell';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ${psQuote(script)} ${words.join(' ')}; exit $LASTEXITCODE`];
  }
  const env = { ...dockerEnv(), ITP_WORKSPACE: config.solutionRoot || '' };
  return new Promise((resolve) => {
    const child = spawn(exe, args, { env, windowsHide: true });
    let out = '';
    const take = (d) => {
      const t = String(d);
      out += t;
      if (!quiet) process.stdout.write(t.replace(/\r\n/g, '\n'));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => resolve({ ok: false, out: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out }));
  });
}

// The stack's ports, as itp-stacks gives them (stack n: web 9000+n, api 50544+10n).
export const portsOf = (n) => ({ web: 9000 + n, api: 50544 + 10 * n });
export const webUrl = (slot) => (slot?.n ? `http://localhost:${portsOf(slot.n).web}` : null);

async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

// Whether the slot's app runs now: its api port answers (any answer), or it is still being started by a live process.
export async function isRunning(slot) {
  if (!slot) return false;
  if (slot.state === 'starting') return !!slot.pid && alive(slot.pid) && Date.now() - Date.parse(slot.at) < 45 * 60000;
  if (slot.state !== 'up' || !slot.n) return false;
  if (fake()) return true;
  return answers(portsOf(slot.n).api);
}

// ---------- the images, the disk, the memory ----------

// The images stacks.ps1 starts (read from its scripts) and the ones Orchestra uses, pulled once. Windows PowerShell
// takes docker's "Unable to find image" note as an error, so a first start would fail without this.
function neededImages() {
  const dir = stacksScript() && path.dirname(stacksScript());
  const found = new Set([MONGO_IMAGE, TOOL_IMAGE]);
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ps1'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/['"]((?:centrifugo|redis|mongo)[\w./-]*:[\w.-]+)['"]/g)) found.add(m[1]);
    }
  } catch {}
  return [...found];
}

export function pullImages() {
  const pulled = [];
  for (const image of neededImages()) {
    if (docker(['image', 'inspect', image, '--format', '{{.Id}}']).ok) continue;
    say(`  downloading ${image} (once) …`);
    const r = docker(['pull', '-q', image], { timeout: 600000 });
    if (!r.ok) throw new SlotError(`could not download ${image}: ${r.err || r.out}`);
    pulled.push(image);
  }
  return pulled;
}

// Docker's VM keeps the file cache of a big copy (23 GB once); this hands it back to Windows.
function dropVmCache() {
  if (fake()) return;
  docker(['run', '--rm', '--privileged', TOOL_IMAGE, 'sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches'], { timeout: 60000 });
}

// Free GB on the drive that holds Docker's data (Docker Desktop keeps it under %LOCALAPPDATA%).
export function freeDiskGb() {
  try {
    const where = process.env.ORCHESTRA_DOCKER_DATA || process.env.LOCALAPPDATA || config.dataDir;
    const s = fs.statfsSync(where);
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return Infinity;
  }
}

function volumeGb(volume) {
  const r = docker(['run', '--rm', '-v', `${volume}:/v:ro`, TOOL_IMAGE, 'du', '-sk', '/v'], { timeout: 300000 });
  const kb = Number(r.out.split(/\s+/)[0]);
  return r.ok && kb ? Math.round((kb / 1e6) * 10) / 10 : null;
}

async function freeMongoPort(taken) {
  const used = new Set(taken);
  for (const line of docker(['ps', '-a', '--format', '{{.Ports}}']).out.split('\n')) for (const m of line.matchAll(/:(\d+)->/g)) used.add(Number(m[1]));
  for (let p = SLOT_MONGO_PORTS[0]; p <= SLOT_MONGO_PORTS[1]; p++) {
    if (used.has(p)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer().once('error', () => resolve(false)).listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new SlotError(`no free port for a slot's Mongo between ${SLOT_MONGO_PORTS[0]} and ${SLOT_MONGO_PORTS[1]}`);
}

async function mongoReady(container, seconds = 90) {
  if (fake()) return true;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (docker(['exec', container, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'], { timeout: 20000 }).out.endsWith('1')) return true;
    await sleep(2000);
  }
  return false;
}

// ---------- the master copy ----------

// The master copy as recorded, or the one a first trial left (volume orch-mongo-golden), adopted.
export function golden(s = readState()) {
  if (s.golden?.volume) return s.golden;
  if (fake()) return null;
  const r = docker(['volume', 'inspect', 'orch-mongo-golden', '--format', '{{.CreatedAt}}']);
  if (!r.ok) return null;
  const at = Date.parse(r.out);
  return { volume: 'orch-mongo-golden', at: new Date(Number.isNaN(at) ? Date.now() : at).toISOString(), adopted: true };
}

// Saves an adopted master copy (with its size) once, so orch status, which reads only the file, knows it.
export async function keepGolden() {
  const s = readState();
  if (s.golden?.volume) return s.golden;
  const g = golden(s);
  if (!g) return null;
  g.gb = volumeGb(g.volume);
  await edit((st) => (st.golden = st.golden?.volume ? st.golden : g));
  return g;
}

export const ageDays = (at) => Math.floor((Date.now() - Date.parse(at)) / 86400000);

// Where the master copy is read from: your Debug.json's Local DB connection (only its host and port are ever shown).
// Read only. localhost becomes host.docker.internal, since the copy runs inside Docker.
export function goldenSource() {
  if (process.env.ORCHESTRA_GOLDEN_SOURCE) return process.env.ORCHESTRA_GOLDEN_SOURCE;
  const file = process.env.ITP_DebugJsonPath || 'C:\\LocalStore\\Debug.json';
  let conn = 'mongodb://localhost:27017';
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => /\/\/\s*Local DB/i.test(l));
    if (start >= 0) {
      for (const l of lines.slice(start + 1)) {
        if (/\/\/\s*Global DB/i.test(l)) break;
        const m = /"MongodbConnection"\s*:\s*"([^"]+)"/.exec(l);
        if (m) {
          conn = m[1];
          break;
        }
      }
    }
  } catch {}
  return conn.replace(/\/\/([^/@]*@)?(localhost|127\.0\.0\.1)(?=[:/]|$)/, (_, auth) => `//${auth || ''}host.docker.internal`);
}

export const hostOf = (conn) => (/@?([^@/]+)(\/|$)/.exec(String(conn).replace(/^mongodb(\+srv)?:\/\//, ''))?.[1] || '?').replace(/^.*@/, '');

// Makes a new master copy in the background (it takes ~30 minutes); the slots keep using the old one until it is done.
export async function startGoldenRefresh(nodeArgs) {
  const problem = dockerProblem();
  if (problem) throw new SlotError(problem);
  return edit((s) => {
    if (s.refreshing && alive(s.refreshing.pid)) throw new SlotError(`a master copy is being made already (since ${new Date(s.refreshing.at).toTimeString().slice(0, 5)}): orch app master shows how far it is`);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(GOLDEN_LOG(), '');
    const child = spawn(process.execPath, nodeArgs, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    s.refreshing = { pid: child.pid, at: new Date().toISOString() };
    return s.refreshing;
  });
}

// The refresh itself (runs detached): fill a new volume from the Local DB, check it, then swap it in.
export async function goldenWork() {
  const log = (t) => fs.appendFileSync(GOLDEN_LOG(), `${new Date().toTimeString().slice(0, 8)} ${t}\n`);
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const volume = `orch-golden-${stamp}`;
  const filler = `orch-golden-fill-${stamp}`;
  let ok = false;
  try {
    pullImages();
    const source = goldenSource();
    log(`Copying your Local DB (${hostOf(source)}) into ${volume}. It only reads it.`);
    const port = await freeMongoPort([]);
    let r = docker(['run', '-d', '--name', filler, '--label', 'orchestra.golden=fill', '-p', `127.0.0.1:${port}:27017`, '-v', `${volume}:/data/db`, MONGO_IMAGE, '--wiredTigerCacheSizeGB', '2']);
    if (!r.ok) throw new Error(`could not start a Mongo for the copy: ${r.err}`);
    if (!(await mongoReady(filler))) throw new Error('the Mongo for the copy did not start');
    const pipe = `mongodump --uri='${source.replace(/'/g, '')}' --archive --numParallelCollections=4 | mongorestore --uri=mongodb://host.docker.internal:${port} --archive --numParallelCollections=4 --numInsertionWorkersPerCollection=4`;
    r = await dockerLong(['run', '--rm', MONGO_IMAGE, 'sh', '-c', `${pipe} 2>&1 | grep -E 'restored successfully|failed|error|Failed' | tail -5`], { logTo: GOLDEN_LOG() });
    const done = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed/.exec(r.out);
    if (!r.ok || !done) throw new Error('the copy did not finish (see the lines above)');
    if (Number(done[2]) > 0) throw new Error(`${done[2]} documents failed to copy; the old master copy stays`);
    docker(['stop', filler], { timeout: 120000 });
    docker(['rm', filler]);
    const gb = volumeGb(volume);
    let old = null;
    await edit((s) => {
      old = golden(s);
      s.golden = { volume, at: new Date().toISOString(), source: hostOf(source), docs: Number(done[1]), gb, minutes: Math.round((Date.now() - started) / 60000) };
      s.refreshing = null;
    });
    // The old copy goes once no slot copy reads it: copies take a minute, and run under the lock's record.
    if (old?.volume && old.volume !== volume) {
      await sleep(120000);
      const rm = docker(['volume', 'rm', old.volume]);
      log(rm.ok ? `Removed the old master copy ${old.volume}.` : `Kept the old master copy ${old.volume} (still in use): docker volume rm ${old.volume} later.`);
    }
    dropVmCache();
    log(`Done: ${done[1]} documents, ${gb ?? '?'} GB, in ${Math.round((Date.now() - started) / 60000)} min. New slots copy this one; slots made before keep their own data ("fresh data" takes the new one).`);
    ok = true;
  } catch (err) {
    log(`Failed: ${err.message}`);
    docker(['rm', '-f', filler]);
    docker(['volume', 'rm', volume]);
  } finally {
    if (!ok) await edit((s) => (s.refreshing = null));
  }
}

export function goldenText(s = readState()) {
  const g = golden(s);
  const lines = [];
  if (g) lines.push(`Master copy: from ${new Date(g.at).toDateString()} (${ageDays(g.at)} day${ageDays(g.at) === 1 ? '' : 's'} old)${g.gb ? `, ${g.gb} GB` : ''}${g.docs ? `, ${g.docs.toLocaleString('en')} documents` : ''}${g.source ? `, from ${g.source}` : ''}.`);
  else lines.push('Master copy: none yet. Make it once: orch app master refresh (about 30 minutes; your Local DB is only read).');
  if (s.refreshing) {
    const live = alive(s.refreshing.pid);
    let tail = [];
    try {
      tail = fs.readFileSync(GOLDEN_LOG(), 'utf8').trimEnd().split('\n').slice(-4);
    } catch {}
    lines.push(live ? `Making a new one since ${new Date(s.refreshing.at).toTimeString().slice(0, 5)} (about 30 minutes):` : 'The last refresh stopped:', ...tail.map((t) => `  ${t}`));
  } else if (g && ageDays(g.at) >= GOLDEN_OLD_DAYS) lines.push(`It is ${ageDays(g.at)} days old: orch app master refresh makes a new one from your Local DB (in the background, ~30 min).`);
  return lines.join('\n');
}

// ---------- one run's slot ----------

const slotName = (runId) => `orch-slot-${runId}`.replace(/[^\w.-]/g, '-');

// The services the run's code has built (a slot starts only those). webclient: the run has the web client checkout.
function builtServices(ws) {
  const apps = path.join(ws, 'ITP-API', 'Orbitax.Platform.Api', 'Applications');
  const out = new Set();
  for (const [svc, proj] of Object.entries(PROJECTS)) {
    const debug = path.join(apps, proj, 'bin', 'Debug');
    try {
      if (fs.readdirSync(debug).some((tfm) => fs.existsSync(path.join(debug, tfm, `${proj}.dll`)))) out.add(svc);
    } catch {}
  }
  if (fs.existsSync(path.join(ws, 'ITP-WebClient', 'angular.json'))) out.add('webclient');
  return out;
}

// When the run's build last changed (the newest service DLL), so a later start copies a new build only when needed.
function apiStamp(ws) {
  const apps = path.join(ws, 'ITP-API', 'Orbitax.Platform.Api', 'Applications');
  let newest = 0;
  for (const proj of Object.values(PROJECTS)) {
    const debug = path.join(apps, proj, 'bin', 'Debug');
    try {
      for (const tfm of fs.readdirSync(debug)) newest = Math.max(newest, fs.statSync(path.join(debug, tfm, `${proj}.dll`)).mtimeMs);
    } catch {}
  }
  return newest;
}

// The web client's source as it is now (commit + newest file under src), so the web page is rebuilt only after a change.
function webStamp(ws) {
  const dir = path.join(ws, 'ITP-WebClient');
  if (!fs.existsSync(dir)) return null;
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || '';
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {}
    }
  };
  walk(path.join(dir, 'src'));
  return `${head}:${Math.floor(newest)}`;
}

// The services to start: the slot's last ones (or the usual set), with --services/--with/--without, then only the
// built ones. A service asked for by name that is not built is an error (with the build line); one of the usual set
// is left out with a note.
export function pickServices(ws, slot, { services, withs = [], withouts = [] }) {
  const asked = services?.length ? services : slot?.services?.length ? slot.services : DEFAULT_SERVICES;
  let want = [...new Set([...asked, ...withs])].filter((x) => !withouts.includes(x));
  for (const x of want) if (!SERVICES.includes(x)) throw new SlotError(`no service "${x}". Services: ${SERVICES.join(', ')}`);
  if (fake()) return { list: want, notes: [] };
  const built = builtServices(ws);
  const named = new Set([...(services || []), ...withs]);
  const notes = [];
  const missing = want.filter((x) => !built.has(x));
  const hard = missing.filter((x) => named.has(x) && x !== 'webclient');
  if (hard.length) {
    const apps = path.join(ws, 'ITP-API', 'Orbitax.Platform.Api', 'Applications');
    throw new SlotError(`this run has no build of ${hard.join(', ')} yet. Build ${hard.length > 1 ? 'them' : 'it'} first:\n${hard.map((x) => `  dotnet build "${path.join(apps, PROJECTS[x], `${PROJECTS[x]}.csproj`)}" -m:4 -v q -nologo -clp:ErrorsOnly`).join('\n')}`);
  }
  if (missing.length) notes.push(`Left out (not built in this run): ${missing.join(', ')}.`);
  want = want.filter((x) => built.has(x));
  if (!want.includes('api')) throw new SlotError('this run has no build of the Platform API yet: run app build first');
  return { list: want, notes };
}

// Waits for room: at most `max` slots run at once, first come first served. Returns when this run may start.
async function waitForRoom(run, max, minutes) {
  const end = Date.now() + minutes * 60000;
  let lastPlace = null;
  for (;;) {
    const snap = readState();
    const others = Object.entries(snap.slots).filter(([id]) => id !== run.id);
    const live = new Set();
    await Promise.all(others.map(async ([id, sl]) => (await isRunning(sl)) && live.add(id)));
    const verdict = await edit((s) => {
      // Slots whose app is gone (a restart of the PC, a crash) are stopped, not running.
      for (const [id, sl] of Object.entries(s.slots)) if (id !== run.id && ['up', 'starting'].includes(sl.state) && !live.has(id)) sl.state = 'stopped';
      if (!s.want[run.id]) s.want[run.id] = new Date().toISOString();
      const ahead = Object.entries(s.want).filter(([id, at]) => id !== run.id && at < s.want[run.id] && !live.has(id)).length;
      if (live.size + ahead < max) {
        delete s.want[run.id];
        s.slots[run.id] = { ...(s.slots[run.id] || {}), state: 'starting', pid: process.pid, at: new Date().toISOString(), title: run.title, ws: run.ws };
        return { go: true };
      }
      return { go: false, place: ahead + 1, busy: [...live].map((id) => s.slots[id]?.title || id) };
    });
    if (verdict.go) return;
    if (verdict.place !== lastPlace) say(`Waiting for a slot: ${verdict.place === 1 ? '1st' : verdict.place === 2 ? '2nd' : `${verdict.place}th`} in line. ${max} run at once; running: ${verdict.busy.join(', ') || '-'}. (orch settings stacks=N changes how many.)`);
    lastPlace = verdict.place;
    if (Date.now() >= end) throw new SlotError('Still waiting for a slot. Run the same command again to keep your place.', 3);
    await sleep(5000);
  }
}

// Leaves the line (a wait that gave up keeps its place on purpose; this is for a stop or a drop).
async function leaveLine(runId) {
  await edit((s) => delete s.want[runId]);
}

// A slot's own Mongo: copied from the master copy when it has none (or when fresh), then running.
async function ensureMongo(run, slot, { fresh }) {
  const name = slotName(run.id);
  const exists = docker(['volume', 'inspect', name, '--format', '{{.Name}}']).ok;
  if (fresh && exists) {
    say('Fresh data: deleting this slot\'s data and copying the master copy again …');
    docker(['rm', '-f', name]);
    docker(['volume', 'rm', name]);
  }
  if (fresh || !exists) {
    const g = await keepGolden();
    if (!g) throw new SlotError('there is no master copy of your Local DB yet. Make it once: orch app master refresh (about 30 minutes, in the background; your Local DB is only read). Then run this again.');
    const need = (g.gb || 13) + DISK_MARGIN_GB;
    const free = freeDiskGb();
    if (free < need) {
      const stopped = Object.values(readState().slots).filter((x) => x.state === 'stopped' && x.title !== run.title).map((x) => x.title);
      throw new SlotError(`only ${Math.floor(free)} GB free on Docker's drive; a slot needs about ${Math.ceil(need)} GB.${stopped.length ? ` Stopped slots of other runs take space: ${stopped.join(', ')} (orch app slot <run> drop frees one; it deletes that run's slot data).` : ''}`);
    }
    say(`Copying the master copy (${new Date(g.at).toDateString()}${g.gb ? `, ${g.gb} GB` : ''}) into this run's own data (~1 min) …`);
    const t = Date.now();
    const r = await dockerLong(['run', '--rm', '-v', `${g.volume}:/from:ro`, '-v', `${name}:/to`, TOOL_IMAGE, 'sh', '-c', 'cp -a /from/. /to/']);
    if (!r.ok) {
      docker(['volume', 'rm', name]);
      throw new SlotError(`the copy failed: ${r.out.trim().slice(-300)}`);
    }
    say(`  copied in ${Math.round((Date.now() - t) / 1000)} s.`);
    dropVmCache();
    slot.dataAt = new Date().toISOString();
    slot.goldenAt = g.at;
  }
  const running = docker(['inspect', name, '--format', '{{.State.Running}}']);
  if (!running.ok) {
    slot.mongoPort = await freeMongoPort([]);
    const r = docker(['run', '-d', '--name', name, '--label', `orchestra.slot=${run.id}`, '-p', `127.0.0.1:${slot.mongoPort}:27017`, '-v', `${name}:/data/db`, MONGO_IMAGE, '--wiredTigerCacheSizeGB', SLOT_CACHE_GB]);
    if (!r.ok) throw new SlotError(`could not start the slot's Mongo: ${r.err}`);
  } else if (running.out !== 'true') {
    const r = docker(['start', name]);
    if (!r.ok) throw new SlotError(`could not start the slot's Mongo: ${r.err}`);
  }
  // `docker port` prints 127.0.0.1:27260.
  if (!slot.mongoPort) slot.mongoPort = Number(/:(\d+)\s*$/m.exec(docker(['port', name, '27017']).out)?.[1]) || null;
  if (!(await mongoReady(name))) throw new SlotError(`the slot's Mongo did not answer (docker logs ${name})`);
}

// Starts (or makes) the stack, retrying once when itp-stacks' memory check refuses while Docker gives memory back.
async function startStack(slot, ws, list, { refresh, rebuildWeb }) {
  const only = `-Only ${list.join(',')}`;
  const words = slot.n
    ? ['start', String(slot.n), only, ...(refresh ? ['-RefreshBin'] : []), ...(rebuildWeb ? ['-BuildWeb'] : [])]
    : ['new', '-Mongo', String(slot.mongoPort), only, '-ApiRepo', psQuote(path.join(ws, 'ITP-API')), ...(list.includes('webclient') ? ['-WebRepo', psQuote(path.join(ws, 'ITP-WebClient'))] : [])];
  for (let attempt = 1; ; attempt++) {
    const r = await stacks(words);
    const n = Number(/Stack (\d+) is up/.exec(r.out)?.[1]);
    if (r.ok && (slot.n || n)) return slot.n || n;
    if (attempt === 1 && /RAM available|committed/.test(r.out)) {
      say('Memory is short right now; giving Docker\'s cache back and trying once more in 30 s …');
      dropVmCache();
      await sleep(fake() ? 10 : 30000);
      continue;
    }
    throw new SlotError(`the stack did not start:\n${r.out.trim().split('\n').slice(-8).join('\n')}`);
  }
}

// app slot up: the run's own app, started (made first when it has none). Keeps its data unless fresh.
export async function up(run, { services, withs, withouts, fresh = false, minutes = 9 } = {}) {
  const max = await maxSlots();
  if (max === 0) throw new SlotError('app slots are off (orch settings stacks=0): use the one shared app (app take, then app start)');
  if (!fake()) {
    const problem = dockerProblem();
    if (problem) throw new SlotError(problem);
    if (!fs.existsSync(stacksScript())) throw new SlotError(`the itp-stacks skill is missing (${stacksScript()}): pull the ITP folder`);
  }
  if (!run.ws || !fs.existsSync(run.ws)) throw new SlotError(`this run has no workspace folder (${run.ws || 'none'})`);
  const before = readState().slots[run.id];
  const picked = pickServices(run.ws, before, { services, withs, withouts });
  for (const n of picked.notes) say(n);
  if (before && (await isRunning(before)) && !fresh) {
    const same = before.services?.join(',') === picked.list.join(',');
    if (same && before.apiStamp === apiStamp(run.ws) && before.webStamp === webStamp(run.ws)) {
      say(upText(before, 'is already up'));
      return before;
    }
    say('The slot runs older code or other services: restarting it …');
    await stacks(['stop', String(before.n)]);
  }
  if (!fake()) pullImages();
  await waitForRoom(run, max, minutes);
  const slot = { ...(readState().slots[run.id] || {}) };
  const t = Date.now();
  try {
    await ensureMongo(run, slot, { fresh });
    const aStamp = apiStamp(run.ws);
    const wStamp = webStamp(run.ws);
    const refresh = !!slot.n && slot.apiStamp !== aStamp;
    const rebuildWeb = !!slot.n && picked.list.includes('webclient') && slot.webStamp !== wStamp;
    if (refresh) say('The run\'s build changed since the last start: the slot takes the new build.');
    if (rebuildWeb) say('The web client changed since the last start: its page is rebuilt (about a minute).');
    say(`${slot.n ? `Starting slot ${slot.n}` : 'Making the slot'} (${picked.list.join(', ')}) …`);
    slot.n = await startStack(slot, run.ws, picked.list, { refresh, rebuildWeb });
    Object.assign(slot, { state: 'up', services: picked.list, apiStamp: aStamp, webStamp: wStamp, upAt: new Date().toISOString(), pid: null, title: run.title, ws: run.ws });
    await edit((s) => (s.slots[run.id] = { ...s.slots[run.id], ...slot }));
    say(upText(slot, `is up in ${Math.round((Date.now() - t) / 1000)} s`));
    return slot;
  } catch (err) {
    await edit((s) => {
      const sl = s.slots[run.id];
      if (!sl) return;
      Object.assign(sl, { ...slot, state: slot.n || docker(['volume', 'inspect', slotName(run.id)]).ok ? 'stopped' : 'broken', pid: null });
      if (sl.state === 'broken') delete s.slots[run.id];
    });
    throw err;
  }
}

export function upText(slot, how) {
  const p = portsOf(slot.n);
  return [
    `This run's app ${how}: ${webUrl(slot)}  (api http://localhost:${p.api}/api)`,
    `  Slot ${slot.n} · services: ${(slot.services || []).join(', ')} · data: its own copy of your Local DB (made ${slot.dataAt ? new Date(slot.dataAt).toDateString() : '?'}; master copy from ${slot.goldenAt ? new Date(slot.goldenAt).toDateString() : '?'})`,
    '  The page signs in by itself (your usual DummyToken user): no login, no IdP.',
    `  Logs: app slot logs [service]  ·  stop (keeps data): app slot stop  ·  clean data: app slot fresh`,
  ].join('\n');
}

// app slot stop: the slot's app and Mongo stop (RAM back); its data stays for the next test or for QA.
export async function stop(runId, { quiet = false } = {}) {
  const slot = readState().slots[runId];
  await leaveLine(runId);
  if (!slot) return null;
  if (slot.n) await stacks(['stop', String(slot.n)], { quiet });
  docker(['stop', slotName(runId)], { timeout: 120000 });
  await edit((s) => s.slots[runId] && Object.assign(s.slots[runId], { state: 'stopped', pid: null }));
  return `stopped its app slot ${slot.n ?? ''} (data kept)`.replace('  ', ' ');
}

// app slot drop: the stack, its Mongo and its data are deleted.
export async function drop(runId, { quiet = false } = {}) {
  const slot = readState().slots[runId];
  await leaveLine(runId);
  if (!slot) return null;
  if (slot.n) await stacks(['destroy', String(slot.n)], { quiet });
  docker(['rm', '-f', slotName(runId)]);
  docker(['volume', 'rm', slotName(runId)]);
  await edit((s) => delete s.slots[runId]);
  return `deleted its app slot ${slot.n ?? ''} and its data`.replace('  ', ' ');
}

export async function logs(runId, service = 'api', lines = 40) {
  const slot = readState().slots[runId];
  if (!slot?.n) throw new SlotError('this run has no slot yet: app slot up makes it');
  const file = path.join(config.solutionRoot || '', '.run-logs', `i${slot.n}`, `${service}.log`);
  if (!fs.existsSync(file)) throw new SlotError(`no ${service}.log for slot ${slot.n} (${file}). Services: ${(slot.services || []).join(', ')}`);
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

// The slot of the run whose workspace is dir.
export function slotOfDir(dir) {
  const s = readState();
  const hit = Object.entries(s.slots).find(([, sl]) => sl.ws && norm(sl.ws) === norm(dir));
  return hit ? { runId: hit[0], slot: hit[1] } : null;
}

// ---------- the board ----------

export async function listText(settings) {
  const s = readState();
  const max = maxOf(settings);
  const rows = await Promise.all(Object.entries(s.slots).map(async ([id, sl]) => ({ id, sl, live: await isRunning(sl) })));
  const lines = [`App slots: ${max === 0 ? 'off (orch settings stacks=N turns them on)' : `${rows.filter((r) => r.live).length} of ${max} running`} · ${Math.floor(freeDiskGb())} GB free on Docker's drive`];
  if (rows.length) {
    lines.push('Run                            Slot  State     Web                    Data from');
    for (const { sl, live } of rows) lines.push(`${String(sl.title || '?').slice(0, 30).padEnd(31)}${String(sl.n ?? '-').padEnd(6)}${(live ? 'running' : sl.state === 'starting' ? 'starting' : 'stopped').padEnd(10)}${(live && webUrl(sl) ? webUrl(sl) : '-').padEnd(23)}${sl.dataAt ? new Date(sl.dataAt).toDateString() : '-'}`);
  } else lines.push('No run has a slot yet. A "Test in the app" step makes one; orch app slot <run> up makes one by hand.');
  const waiting = Object.keys(s.want);
  if (waiting.length) lines.push(`Waiting for a slot: ${waiting.length}`);
  lines.push(goldenText(s));
  return lines.join('\n');
}

// One line for orch status: only what needs a look (an old or missing master copy, a refresh, runs waiting).
export function statusNote(settings) {
  if (maxOf(settings) === 0) return null;
  const s = readState();
  const g = s.golden;
  const out = [];
  const running = Object.values(s.slots).filter((x) => x.state === 'up' || x.state === 'starting').length;
  if (running || Object.keys(s.want).length) out.push(`App slots: ${running} of ${maxOf(settings)} running${Object.keys(s.want).length ? `, ${Object.keys(s.want).length} waiting` : ''} (orch app slots)`);
  if (s.refreshing && alive(s.refreshing.pid)) out.push('Master copy: a new one is being made (orch app master)');
  else if (g && ageDays(g.at) >= GOLDEN_OLD_DAYS) out.push(`Master copy is ${ageDays(g.at)} days old: orch app master refresh (~30 min, in the background)`);
  else if (!g) out.push('No master copy yet for app slots: orch app master refresh (~30 min, in the background)');
  return out.length ? out.join('\n') : null;
}
