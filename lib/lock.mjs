// One lock for all of Orchestra's state (runs, settings, suggestions). Many short processes share it:
// each hook call, each `orch` command, each launcher. The lock is a folder (mkdir is atomic), with an
// owner file holding the pid and the time. A lock whose owner is gone, or that is very old, is taken over.
// Slow work (worktrees, waiting for the app, asking claude) runs with the lock let go (Runner.outside).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

// Work under the lock is short; anything older than this was left by a crashed process.
const STALE_MS = 5 * 60 * 1000;

const dir = () => path.join(config.runsDir, '.lock');
let depth = 0; // the lock is re-entrant inside one process

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function stale() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir(), 'owner.json'), 'utf8'));
    return owner.pid !== process.pid && (!alive(owner.pid) || Date.now() - owner.at > STALE_MS);
  } catch {
    // No owner file yet: a process is between mkdir and writing it, unless the folder is old.
    try {
      return Date.now() - fs.statSync(dir()).mtimeMs > 10000;
    } catch {
      return false;
    }
  }
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
      fs.writeFileSync(path.join(dir(), 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      depth = 1;
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (stale()) {
      fs.rmSync(dir(), { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 25)));
  }
}

export function release() {
  if (depth === 0) return;
  if (--depth > 0) return;
  fs.rmSync(dir(), { recursive: true, force: true });
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
