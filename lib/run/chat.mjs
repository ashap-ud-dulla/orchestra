// What you typed in a run's tab (lessons are found from it) and Claude's last answers (for `pin 2`). They live
// next to the run file, not in it, so state.json stays small and every save stays cheap.
// chat.jsonl: one line per message, only added to. replies.json: the last MAX_REPLIES answers, newest first.
// Runs saved before kept both inside state.json (run.chat, run.replies): they are still read.
import fs from 'node:fs';
import path from 'node:path';
import { runDir, appendLine } from '../store.mjs';
import { MAX_REPLIES } from '../limits.mjs';

const chatFile = (run) => path.join(runDir(run.id), 'chat.jsonl');
const repliesFile = (run) => path.join(runDir(run.id), 'replies.json');

export function addChat(run, entry) {
  try {
    appendLine(chatFile(run), JSON.stringify(entry));
  } catch {}
}

export function readChat(run) {
  const out = Array.isArray(run.chat) ? [...run.chat] : [];
  try {
    for (const l of fs.readFileSync(chatFile(run), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
  } catch {}
  return out;
}

export function readReplies(run) {
  try {
    const list = JSON.parse(fs.readFileSync(repliesFile(run), 'utf8'));
    if (Array.isArray(list)) return list;
  } catch {}
  return Array.isArray(run.replies) ? run.replies : [];
}

export function addReply(run, text) {
  const list = [text, ...readReplies(run)].slice(0, MAX_REPLIES);
  try {
    fs.mkdirSync(runDir(run.id), { recursive: true });
    const tmp = `${repliesFile(run)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, repliesFile(run));
    delete run.replies; // moved out of the run file
  } catch {}
}
