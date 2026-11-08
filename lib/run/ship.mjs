// What a run shipped: PR links and the epic, read from its notes; the vault folders.
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { pack } from '../pack.mjs';
import * as workspace from '../workspace.mjs';

// Folders that may commit on main locally (the pack's: ITP's vault, ITPKV, in the ITP folder and in the workspace).
// Pushing to main stays refused everywhere.
export function vaultDirs(run) {
  return pack.mainOkDirs(config.itpRoot, run.workspace?.ready ? run.workspace.dir : null);
}

// What is left after the run ships, read from the steps' replies: the PR-create links finalize-epic
// prints, and the epic folder its close-epic.sh command names (orch run shows them; the Wrap up step gets them).
export function keepShipInfo(run, text) {
  const ship = (run.ship ??= { prUrls: [], epicFolder: null });
  // Bitbucket (…/pull-requests/new?source=…) and GitHub (…/pull/new/…, …/compare/…) create links.
  for (const url of String(text).match(/https?:\/\/[^\s<>()"'`\]]+\/(?:pull-requests\/new\?source=|pull\/new\/|compare\/)[^\s<>()"'`\]]+/g) || []) {
    const clean = url.replace(/[.,;:*_]+$/, '');
    if (!ship.prUrls.includes(clean)) ship.prUrls.push(clean);
  }
  const folder = String(text).match(/close-epic\.sh\s+([A-Za-z0-9][\w.-]*)/);
  if (folder) ship.epicFolder = folder[1];
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
