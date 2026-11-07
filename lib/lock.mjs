// One lock for all of Orchestra's state (runs, settings, suggestions). Many short processes share it:
// each hook call, each `orch` command, each launcher. The lock is a folder (mkdir is atomic), with an
// owner file holding the pid, a token and the time. The holder refreshes the time while it holds the lock,
// so a lock whose time stops moving was left by a process that is gone, even when Windows has given its
// pid to another process. Slow work (worktrees, waiting for the app, asking claude) runs with the lock let go
// (Runner.outside).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// The holder writes its time this often; a lock not refreshed for STALE_MS is taken over.
const BEAT_MS = 15 * 1000;
const STALE_MS = 60 * 1000;
// Windows answers these while another process creates or removes the folder: busy, try again.
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

const dir = () => path.join(config.runsDir, '.lock');
const ownerFile = () => path.join(dir(), 'owner.json');
let depth = 0; // the lock is re-entrant inside one process
let token = null;
let beat = null;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function writeOwner() {
  fs.writeFileSync(ownerFile(), JSON.stringify({ pid: process.pid, token, at: Date.now() }));
}

function readOwner() {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
  } catch {
    return null;
  }
}

function stale() {
  const owner = readOwner();
  if (owner) return owner.token !== token && (!alive(owner.pid) || Date.now() - owner.at > STALE_MS);
  // No owner file yet: a process is between mkdir and writing it, unless the folder is old.
  try {
    return Date.now() - fs.statSync(dir()).mtimeMs > 10000;
  } catch {
    return false;
  }
}

// Takes a stale lock away: renaming is atomic, so when two processes try at once only one wins, and the
// loser simply tries mkdir again. The renamed folder is removed after.
function takeOver() {
  const gone = `${dir()}.gone-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(dir(), gone);
  } catch {
    return; // someone else took it over first
  }
  fs.rmSync(gone, { recursive: true, force: true });
}

// Waits up to ms for the lock. Returns false when it could not get it in time.
export async function acquire(ms = 60000) {
  if (depth > 0) {
    depth++;
    return true;
  }
  fs.mkdirSync(config.runsDir, { recursive: true });
  const end = Date.now() + ms;
  for (;;) {
    try {
      fs.mkdirSync(dir());
      token = crypto.randomUUID();
      writeOwner();
      depth = 1;
      beat = setInterval(() => {
        try {
          if (readOwner()?.token === token) writeOwner();
        } catch {}
      }, BEAT_MS);
      beat.unref();
      return true;
    } catch (err) {
      if (!BUSY.has(err.code)) throw err;
    }
    if (stale()) {
      takeOver();
      continue;
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 25)));
  }
}

export function release() {
  if (depth === 0) return;
  if (--depth > 0) return;
  clearInterval(beat);
  beat = null;
  // Only our own lock: if it was taken over (we were too slow), the folder is someone else's now.
  if (readOwner()?.token === token) fs.rmSync(dir(), { recursive: true, force: true });
  token = null;
}

export const held = () => depth > 0;

// Runs fn with the lock. Throws when the lock cannot be had in time.
export async function withLock(fn, ms) {
  if (!(await acquire(ms))) throw Object.assign(new Error('Orchestra is busy (another command holds its lock). Try again.'), { status: 503 });
  try {
    return await fn();
  } finally {
    release();
  }
}

// Gives the lock back for the duration of fn, then takes it again (whole: re-entrant depth kept).
export async function without(fn) {
  const saved = depth;
  if (saved === 0) return fn();
  depth = 1;
  release();
  try {
    return await fn();
  } finally {
    if (!(await acquire(30 * 60 * 1000))) throw new Error('could not take the Orchestra lock back');
    depth = saved;
  }
}
