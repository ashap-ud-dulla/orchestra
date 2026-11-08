// Pins: what the steps pane keeps in sight, and Claude's last replies.
import fsSync from 'node:fs';
import path from 'node:path';
import { readWhy, firstWords } from '../guard.mjs';
import { newId, runDir } from '../store.mjs';
import { MAX_PINS, MAX_REPLIES } from '../limits.mjs';
import { alive } from '../util.mjs';

// Adds a pin (newest last in the file; the pane shows it first). Returns it, or null when there is no text.
export function pushPin(run, { title, text, from }) {
  const body = String(text || '').replace(/\r\n/g, '\n').replace(/^\s*\n|\s+$/g, '').slice(0, 20000);
  if (!body.trim()) return null;
  const pin = { id: newId('pin'), title: String(title || '').trim().slice(0, 80) || firstWords(body), text: body, from, at: new Date().toISOString() };
  run.pins = [...(run.pins || []), pin].slice(-MAX_PINS);
  return pin;
}

// Removes pins. which: a number as the pane shows it (1 = newest), 'all', or nothing for the one the pane shows.
// Returns the removed pins.
export function dropPin(run, which) {
  const pins = run.pins || [];
  if (!pins.length) return [];
  if (which === 'all') {
    run.pins = [];
    return pins;
  }
  let id;
  if (which !== undefined && which !== null && which !== '') id = pins[pins.length - Number(which)]?.id;
  else id = paneShows(run) || pins.at(-1).id;
  const gone = pins.filter((p) => p.id === id);
  run.pins = pins.filter((p) => p.id !== id);
  return gone;
}

// The pin the steps pane shows now (the pane writes it to pane.json in the run's folder), while that pane runs.
export function paneShows(run) {
  try {
    const { pin: id, pid } = JSON.parse(fsSync.readFileSync(path.join(runDir(run.id), 'pane.json'), 'utf8'));
    if (!pid || !alive(pid)) return null;
    return (run.pins || []).some((p) => p.id === id) ? id : null;
  } catch {
    return null;
  }
}

// Claude's last answers, so `pin` and `pin 2` can keep one. The WHAT I DID AND WHY notes are left out.
export function keepReply(run, text) {
  const t = readWhy(text).text.trim() || String(text || '').trim();
  if (!t) return;
  run.replies = [t.slice(-20000), ...(run.replies || [])].slice(0, MAX_REPLIES);
}
