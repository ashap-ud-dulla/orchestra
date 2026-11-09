// Opens a run's terminal tab. Each run is a normal, interactive claude in its own Windows Terminal tab
// (all in one window named "orchestra"), so you answer questions and "Allow?" prompts there.
// The tab runs bin/launch.mjs, which gets from the runner how to start claude.
// ORCHESTRA_TERMINAL=none (tests) only returns the command; nothing opens.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.mjs';
import { TICKET_KEY } from './util.mjs';

export const WINDOW = 'orchestra';

// The run's key: the task its first step picked (intake), else its input's key: the text starts with it (ABC-123,
// "ABC-123 fix the row") or is a link with the key in its path (…/browse/ABC-123). A key inside free text ("same fix
// as ABC-122") does not count.
export const KEY_RE = new RegExp(`^${TICKET_KEY}$`);
const LEAD_KEY = new RegExp(`^(${TICKET_KEY})(?![\\w-])`);
const LINK_KEY = new RegExp(`^https?://\\S*?/(${TICKET_KEY})(?:[/?#]|$)`);
export function ticketKey(run) {
  if (run.task?.key) return run.task.key;
  const text = String(run.input?.text || '').trim();
  return text.match(LEAD_KEY)?.[1] || text.match(LINK_KEY)?.[1] || null;
}

// The tab is named after the run's ticket key (ABC-123), else after the first words of its text, cut at a word end.
// wt splits its command line at ";", so a title must not hold one.
export function tabTitle(run) {
  const key = ticketKey(run);
  if (key) return key;
  const text = String(run.input?.text || '').replace(/[;"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return run.templateName;
  if (text.length <= 32) return text;
  const cut = text.slice(0, 32);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : 32).replace(/[\s,.:-]+$/, '')}…`;
}

// With pane, the tab splits: claude on the left, the run's steps (orch watch) in a narrow pane on the right.
// The steps pane ends by itself when claude's side closes. Focus goes back to claude.
// --suppressApplicationTitle: the program in the tab cannot change its name (claude renames it from the conversation).
export function tabCommand(run, cwd, { pane = false, paneSize = 30 } = {}) {
  const launch = path.join(config.root, 'bin', 'launch.mjs');
  const title = tabTitle(run);
  const cmd = ['wt', '-w', WINDOW, 'new-tab', '--title', title, '--suppressApplicationTitle', '-d', cwd, process.execPath, launch, run.id, run.hookToken];
  if (!pane) return cmd;
  const orch = path.join(config.root, 'bin', 'orch.mjs');
  return [...cmd, ';', 'split-pane', '-V', '--size', String(Math.min(70, Math.max(15, Number(paneSize) || 30)) / 100), '--title', title, '--suppressApplicationTitle', '-d', cwd, process.execPath, orch, 'watch', run.id, ';', 'move-focus', 'left'];
}

// Returns the command it ran (or would run).
export function openTab(run, cwd, opts) {
  const cmd = tabCommand(run, cwd, opts);
  if (config.terminal === 'none') return cmd;
  const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {}); // reported by the launcher never calling back; the run page shows it
  child.unref();
  return cmd;
}
