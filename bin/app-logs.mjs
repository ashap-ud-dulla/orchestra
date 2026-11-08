// The log copier for an app started with the Aspire AppHost: node bin/app-logs.mjs <ws> [<pid>]
// Aspire writes no per-service log files, but its DCP keeps each service's console in a session folder (deleted when
// the app stops). This copies that, line by line, into <ws>/.run-logs/<service>.log (api.log, primary.log, …), the
// files the "Test in the app" step watches, as run-stack.ps1 wrote them. bin/app.mjs starts it with the AppHost and
// app stop ends it; it also ends by itself when <pid> (the AppHost start) is gone.
import fs from 'node:fs';
import path from 'node:path';
import { dcpSessionFor } from '../lib/app.mjs';
import { dcpResources, dcpLine, logNameOf, logsDir } from '../lib/launcher.mjs';
import { sleep, alive } from '../lib/util.mjs';

const ws = process.argv[2];
const owner = Number(process.argv[3]) || 0;
if (!ws) {
  process.stderr.write('Error: name the workspace\n');
  process.exit(1);
}


let session = null;
let lastLook = 0;
let names = {}; // DCP id -> log name
const files = new Map(); // DCP file -> { pos, rest }

// New bytes of one DCP file, as whole lines (a half line waits for the rest).
function copy(file, logName) {
  const f = files.get(file) || { pos: 0, rest: '' };
  files.set(file, f);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < f.pos) Object.assign(f, { pos: 0, rest: '' });
  if (size === f.pos) return;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - f.pos);
    fs.readSync(fd, buf, 0, buf.length, f.pos);
    f.pos = size;
    const lines = (f.rest + buf.toString('utf8')).split('\n');
    f.rest = lines.pop();
    if (lines.length) fs.appendFileSync(path.join(logsDir(ws), `${logName}.log`), lines.map((l) => dcpLine(l.replace(/\r$/, ''))).join('\n') + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function pass() {
  if (!session || !fs.existsSync(session)) {
    // Finding the folder asks Windows about processes: not more than every 5 seconds.
    if (Date.now() - lastLook < 5000) return;
    lastLook = Date.now();
    const found = dcpSessionFor(ws);
    if (found !== session) {
      names = {};
      files.clear();
    }
    session = found;
    if (!session) return;
  }
  let list;
  try {
    list = fs.readdirSync(session);
  } catch {
    return;
  }
  if (list.some((n) => n.startsWith('resource-executable-') && !names[n.slice(20, -4)])) names = { ...names, ...dcpResources(session) };
  for (const n of list) {
    const m = n.match(/^(.+)_(out|err)$/);
    if (m && names[m[1]]) copy(path.join(session, n), logNameOf(names[m[1]]));
  }
}

fs.mkdirSync(logsDir(ws), { recursive: true });
for (;;) {
  pass();
  if (owner && !alive(owner)) {
    pass(); // the last lines
    process.exit(0);
  }
  await sleep(1000);
}
