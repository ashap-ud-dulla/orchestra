// What a run shipped: PR links (and what the pack reads, like an epic folder), read from its notes; the folders
// that may work on main.
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { pack } from '../pack.mjs';
import * as workspace from '../workspace.mjs';

// Folders that may commit on main locally (the pack's, in the solution folder and in the workspace). Pushing to main
// stays refused everywhere, except by the Wrap up step.
export function mainOkDirs(run) {
  return pack.mainOkDirs(config.solutionRoot, run.workspace?.ready ? run.workspace.dir : null);
}

// What is left after the run ships, read from the steps' replies: PR-create links, and what the pack reads (orch run
// shows them; the Wrap up step gets them).
export function keepShipInfo(run, text) {
  const ship = (run.ship ??= { prUrls: [] });
  // Only links for this run's own branches (a reply may quote another run's link); a run with no branch yet keeps all.
  const mine = new Set((run.workspace?.repos || []).map((r) => r.branch).filter(Boolean));
  // Bitbucket (…/pull-requests/new?source=…) and GitHub (…/pull/new/…, …/compare/…) create links.
  for (const url of String(text).match(/https?:\/\/[^\s<>()"'`\]]+\/(?:pull-requests\/new\?source=|pull\/new\/|compare\/)[^\s<>()"'`\]]+/g) || []) {
    const clean = url.replace(/[.,;:*_]+$/, '');
    const branch = prBranch(clean);
    if (mine.size && branch && !mine.has(branch)) continue;
    if (!ship.prUrls.includes(clean)) ship.prUrls.push(clean);
  }
  const notes = pack.shipFrom(String(text)) || {};
  if (Object.keys(notes).length) ship.notes = { ...ship.notes, ...notes };
}

// The branch a PR-create link is for: …/pull-requests/new?source=<branch>&…, …/pull/new/<branch>, …/compare/<base>...<branch>.
export function prBranch(url) {
  const m = /[?&]source=([^&#]+)/.exec(url) || /\/pull\/new\/([^?#]+)/.exec(url) || /\/compare\/(?:[^?#]*?\.\.\.)?([^?#]+)/.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/^refs\/heads\//, '');
  } catch {
    return m[1];
  }
}

export function safeFollow(run) {
  try {
    return workspace.followBranches(run);
  } catch (err) {
    return [`could not read the branches: ${err.message}`];
  }
}

// Claude's final reply in the turn that just ended: from the hook input, else the transcript.
// The transcript is JSON lines; the reply is the text after the last tool call or user message.
export function lastReply(body) {
  if (typeof body?.last_assistant_message === 'string') return body.last_assistant_message;
  let text = '';
  try {
    const st = fsSync.statSync(body.transcript_path);
    const fd = fsSync.openSync(body.transcript_path, 'r');
    const size = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(size);
    fsSync.readSync(fd, buf, 0, size, st.size - size);
    fsSync.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return '';
  }
  const parts = [];
  for (const line of text.split('\n').reverse()) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'user') break;
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    if (e.message.content.some((c) => c.type === 'tool_use')) break;
    const t = e.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t) parts.unshift(t);
  }
  return parts.join('\n');
}
