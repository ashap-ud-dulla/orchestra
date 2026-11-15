// The steps pane in a run's tab (orch watch): the steps, the pinned text, keys and mouse.
import fs from 'node:fs';
import path from 'node:path';
import { withRunner } from './runner.mjs';
import { isSafeId, runDir } from './store.mjs';
import { upgradeRun } from './upgrade.mjs';
import { tabTitle, showTitle } from './terminal.mjs';
import { fail } from './cli/args.mjs';
import { money, dur, why, stepFlags } from './format.mjs';
import { findRun } from './cli/find.mjs';
import { likelyNext } from './run/steps.mjs';

// ---------- watch: the steps pane in a run's tab ----------

export const ICONS = { done: ['✓', 32], running: ['●', 33], question: ['?', 36], approval: ['?', 36], failed: ['✗', 31], skipped: ['↷', 2] };

export const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;

// The pinned step needs at least this many lines; with less room the steps fold up.
export const MIN_PIN_ROWS = 6;

// Screen columns of one character: wide (CJK, emoji like ✅ ❌ 🚀) take 2, joiners and variation marks 0.
export function charCols(ch) {
  const c = ch.codePointAt(0);
  if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x300 && c <= 0x36f)) return 0;
  if (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f000 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd) || [0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f,
      0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705,
      0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c,
      0x2b50, 0x2b55].includes(c) || (c >= 0x2648 && c <= 0x2653)
  ) return 2;
  return 1;
}

export const cols = (s) => Array.from(String(s)).reduce((n, ch) => n + charCols(ch), 0);

// The start of s that fits in w columns (never splits a character). Returns [head, rest].
export function cutCols(s, w) {
  const chars = Array.from(String(s));
  let n = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const c = charCols(chars[i]);
    if (n + c > w) break;
    n += c;
  }
  if (i === 0 && chars.length) i = 1; // a wide character in a 1-column space: show it rather than loop
  return [chars.slice(0, i).join(''), chars.slice(i).join('')];
}

// Word-wraps one line to w columns; `lead` starts the later lines (a list item's hanging indent). Long words are cut.
export function wrapLine(text, w, lead = '') {
  const out = [];
  let line = '';
  for (const word of String(text).split(/(\s+)/)) {
    if (!word) continue;
    if (cols(line + word) <= w) {
      line += word;
      continue;
    }
    if (line.trim()) out.push(line.trimEnd());
    line = /^\s+$/.test(word) ? lead : lead + word;
    while (cols(line) > w) {
      const [head, rest] = cutCols(line, w);
      out.push(head);
      line = lead + rest;
    }
  }
  if (line.trim() || !out.length) out.push(line.trimEnd());
  return out;
}

// A pin's text as pane lines: wrapped, lists keep their indent, light markdown (# headings bold, code dim,
// ** and ` marks dropped; __ stays, as in __init__).
export function pinLines(text, width) {
  const w = Math.max(4, width);
  const out = [];
  let code = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      code = !code;
      continue;
    }
    if (code) {
      let rest = line;
      do {
        const [head, more] = cutCols(rest, w);
        out.push(paint(2, head));
        rest = more;
      } while (rest);
      continue;
    }
    const plain = line.replace(/\*\*|`/g, '');
    const head = /^\s*#{1,6}\s+(.*)$/.exec(plain);
    if (head) {
      out.push(...wrapLine(head[1], w).map((l) => paint(1, l)));
      continue;
    }
    const item = /^(\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+)/.exec(plain);
    out.push(...wrapLine(plain, w, item ? ' '.repeat(Math.min(item[1].length, Math.floor(w / 3))) : ''));
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out;
}

// One screen of the pane: the run, its steps (done / working now / to come), what it needs, and the pinned step.
// rows = 0 means no limit (orch watch --once without --rows). view = { pin: 1-based, newest first; scroll }.
// Returns { lines, pin (the shown pin's id), scroll (clamped), page (pin lines per screen) }.
export function watchFrame(r, width, rows = 0, view = { pin: 1, scroll: 0 }) {
  const w = Math.max(4, width - 1);
  const fit = (s) => (cols(s) > w ? cutCols(s, w - 1)[0] + '…' : s);
  const wrap = (s) => wrapLine(String(s).replace(/\s+/g, ' ').trim(), w - 2).map((l) => `  ${l}`);
  const pins = (r.pins || []).slice().reverse();
  // A line that starts with a colored icon: the icon painted, the rest as is.
  const iconLine = (icon, color, text) => {
    const t = fit(`${icon} ${text}`);
    return t.startsWith(icon) ? paint(color, icon) + t.slice(icon.length) : t;
  };
  const stepLine = (b, i) => {
    const [icon, color] = ICONS[b.status] || ['○', 2];
    const flags = stepFlags(b, { short: true });
    const time = b.status === 'running' && b.startedAt ? dur(Date.now() - Date.parse(b.startedAt)) : b.status === 'done' ? dur(b.durationMs) : '';
    const text = `${i + 1} ${b.label}${flags ? `  ${flags}` : ''}${time ? `  ${time}` : ''}`;
    return b.status === 'pending' ? paint(2, fit(`${icon} ${text}`)) : iconLine(icon, color, text);
  };
  // A guided run: the guide's steps likely to come, grey (not picked yet).
  const likely = likelyNext(r).map((s) => s.label);
  // The steps folded (always, while a pin shows): done ones in one line, the one now, and one grey line for the rest.
  const folded = () => {
    const cur = r.steps.findIndex((b) => b.status !== 'done' && b.status !== 'skipped');
    const nextLine = (labels) => (labels.length ? [paint(2, fit(`· next: ${labels.join(' · ')}`))] : []);
    if (cur < 0) return [iconLine('✓', 32, `all ${r.steps.length} steps done`), ...nextLine(likely)];
    const out = [];
    const skippedN = r.steps.slice(0, cur).filter((b) => b.status === 'skipped').length;
    if (cur > 0) out.push(iconLine('✓', 32, `1–${cur} done${skippedN ? ` (${skippedN} skipped)` : ''}`));
    out.push(stepLine(r.steps[cur], cur));
    return [...out, ...nextLine([...r.steps.slice(cur + 1).map((b) => b.label), ...likely])];
  };
  const head = (steps, about = 5, now = 99) => {
    const out = [paint(1, fit(tabTitle(r)))];
    if (r.about) out.push(...wrap(r.about).slice(0, about).map((l) => l.slice(2)));
    // A run started with no template has only its first step until you agree on the steps: say so, not "New run".
    const picking = !r.templateId && r.steps.length === 1;
    out.push(paint(2, fit(picking ? 'Picking the task and the steps' : r.templateName)), fit(`${r.status} · ${money(r.cost)}`), '', ...steps);
    out.push('', 'Now:', ...wrap(why(r)).slice(0, now));
    if (r.status === 'needs-you' && r.needsYouWhy === 'question') out.push('', paint('1;33', fit('Answer the question on the left.')));
    else if (r.status === 'failed' && r.session?.open) out.push('', paint('1;33', fit('Answer the question on the left.')));
    else if (r.status === 'waiting' && r.hold) out.push('', paint('1;33', fit('On hold. Type next on the left to go on.')));
    else if (r.status === 'waiting' || r.status === 'needs-you') out.push('', paint('1;33', fit('Type next, redo or skip on the left.')));
    return out;
  };

  let top = head([...r.steps.map(stepLine), ...likely.map((l) => paint(2, fit(`· ${l}`)))]);
  if (!pins.length) {
    const hint = paint(2, fit('Type pin on the left to keep'));
    const hint2 = paint(2, fit("Claude's last answer here."));
    if (!rows || top.length + 3 <= rows) top.push('', hint, hint2);
    return { lines: rows ? top.slice(0, rows) : top, pin: null, scroll: 0, page: 0 };
  }
  // Pinned step: a title line, the text, a hint line. It gets the room it needs, up to MIN_PIN_ROWS, before the steps
  // fold up (and, in a very short pane, get cut).
  const n = Math.min(Math.max(1, view.pin || 1), pins.length);
  const pin = pins[n - 1];
  const body = pinLines(pin.text, w);
  const need = 3 + Math.min(MIN_PIN_ROWS, body.length); // the gap, the title, the text, the hint
  // A pin gets the room: the steps always fold, and "Now" keeps two lines.
  top = head(folded(), 3, 2);
  if (rows && top.length + need > rows) top = head(folded(), 2, 1);
  if (rows && top.length + need > rows) top = top.slice(0, Math.max(1, rows - need));
  const page = rows ? Math.max(1, rows - top.length - 3) : body.length;
  const scroll = Math.min(Math.max(0, view.scroll || 0), Math.max(0, body.length - page));
  const label = ` Pinned${pins.length > 1 ? ` ${n}/${pins.length}` : ''} · ${pin.title} `;
  const title = paint(36, fit(`──${label}${'─'.repeat(Math.max(0, w - cols(label) - 2))}`));
  const shown = body.slice(scroll, scroll + page);
  const more = body.length > page;
  const hint = [more && (scroll + page < body.length ? `↓ ${body.length - scroll - page} more` : 'end'), more && '↑↓ scroll', pins.length > 1 && '←→ pins']
    .filter(Boolean)
    .join(' · ');
  const lines = [...top, '', title, ...shown]; // an empty line keeps the pin apart from the steps and the hint
  if (rows && hint) while (lines.length < rows - 1) lines.push('');
  if (hint) lines.push(paint(2, fit(hint)));
  return { lines: rows ? lines.slice(0, rows) : lines, pin: pin.id, scroll, page };
}

// Redraws the pane every 2 seconds from the run's file (no lock: it only reads), and at once on a key.
// Keys (click the pane first): ↑ ↓ PgUp PgDn Home End and the mouse wheel (sent as ↑ ↓) scroll the pin; ← → show older / newer pins.
// It writes the pin it shows to pane.json, so `unpin` in the tab removes that one.
// Ends when the run's tab closes, so the split pane closes with it. --once prints one screen (--rows/--cols/--pin/--scroll).
export async function watch(ref, once, size = {}) {
  let id = ref;
  if (!isSafeId(id) || !fs.existsSync(path.join(runDir(id), 'state.json'))) id = await withRunner((r) => findRun(r, ref).id);
  const file = path.join(runDir(id), 'state.json');
  const read = () => {
    try {
      return upgradeRun(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      return e.code === 'ENOENT' ? 'gone' : null;
    }
  };
  if (once) {
    const r = read();
    if (r === 'gone') return console.log('This run was deleted.');
    if (!r) fail('could not read the run');
    return console.log(watchFrame(r, size.cols || process.stdout.columns || 40, size.rows || 0, { pin: size.pin, scroll: size.scroll }).lines.join('\n'));
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  const view = { pin: 1, scroll: 0, pinId: null, seen: null, page: 1, count: 0 };
  const paneFile = path.join(runDir(id), 'pane.json');
  let r = null;
  const draw = () => {
    if (!r) return;
    showTitle(r);
    const pins = (r.pins || []).slice().reverse();
    // A pin not seen before shows at once; otherwise the pane stays on the pin it shows, even as numbers move
    // (an unpin of another pin does not move it).
    const fresh = view.seen && pins.some((p) => !view.seen.has(p.id));
    view.seen = new Set(pins.map((p) => p.id));
    if (fresh) Object.assign(view, { pin: 1, scroll: 0, pinId: null });
    else if (view.pinId) {
      const at = pins.findIndex((p) => p.id === view.pinId);
      if (at >= 0) view.pin = at + 1;
      else view.scroll = 0;
    }
    view.count = pins.length;
    const f = watchFrame(r, process.stdout.columns || 40, process.stdout.rows || 0, view);
    view.scroll = f.scroll;
    view.page = f.page;
    if (f.pin !== view.pinId) {
      view.pinId = f.pin;
      try {
        fs.writeFileSync(paneFile, JSON.stringify({ pin: f.pin, pid: process.pid }));
      } catch {}
    }
    process.stdout.write('\x1b[H' + f.lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  };
  // The wheel: Node's raw mode on Windows drops mouse events, so mouse reporting (?1000h) never reaches us (checked:
  // only keys arrived). On the alternate screen with "alternate scroll" (?1049h ?1007h), Windows Terminal sends the
  // wheel as ↑ ↓ keys, which scroll the pin. No mouse reporting also means a plain drag selects text.
  const WHEEL = '\x1b[?1049h\x1b[?1007h';
  const NO_WHEEL = '\x1b[?1007l\x1b[?1049l';
  const tty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(`${tty ? NO_WHEEL : ''}\x1b[?7h\x1b[?25h`);
    if (tty) process.stdin.setRawMode(false);
    try {
      // No pane: `unpin` takes the newest pin. (Only this pane's note: a second `orch watch` may still run.)
      if (JSON.parse(fs.readFileSync(paneFile, 'utf8')).pid === process.pid) fs.rmSync(paneFile, { force: true });
    } catch {}
  };
  // Hide the cursor; no line wrap, so a line too wide for the pane is cut instead of pushing the screen down.
  process.stdout.write('\x1b[?25l\x1b[?7l');
  if (tty) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(WHEEL); // the wheel comes as ↑ ↓ keys
    const scrollBy = (d) => {
      view.scroll = Math.max(0, view.scroll + d);
      draw();
    };
    const KEYS = {
      '\x1b[A': () => scrollBy(-1), k: () => scrollBy(-1),
      '\x1b[B': () => scrollBy(1), j: () => scrollBy(1),
      '\x1b[5~': () => scrollBy(-Math.max(1, view.page - 1)),
      '\x1b[6~': () => scrollBy(Math.max(1, view.page - 1)), ' ': () => scrollBy(Math.max(1, view.page - 1)),
      '\x1b[H': () => scrollBy(-1e9), '\x1b[1~': () => scrollBy(-1e9), '\x1bOH': () => scrollBy(-1e9),
      '\x1b[F': () => scrollBy(1e9), '\x1b[4~': () => scrollBy(1e9), '\x1bOF': () => scrollBy(1e9),
      '\x1b[D': () => showPin(1), h: () => showPin(1), // older
      '\x1b[C': () => showPin(-1), l: () => showPin(-1), // newer
    };
    const showPin = (d) => {
      const next = Math.min(Math.max(1, view.pin + d), Math.max(1, view.count));
      if (next === view.pin) return;
      Object.assign(view, { pin: next, scroll: 0, pinId: null });
      draw();
    };
    process.stdin.on('data', (buf) => {
      const s = buf.toString('utf8');
      if (s.includes('\x03')) {
        restore();
        process.exit(0);
      }
      for (const k of s.match(/\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-Z]|[\s\S]/g) || []) KEYS[k]?.();
    });
  }
  process.on('exit', restore);
  process.stdout.on('resize', draw);
  // The run file is read and the pane drawn again only when the file changed, or every 30 s (times like "5 min").
  let seenAt = 0;
  let drawnAt = 0;
  for (;;) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    const changed = !r || !mtime || mtime !== seenAt || Date.now() - drawnAt > 30000;
    const now = changed ? read() : r;
    if (now === 'gone') {
      restore();
      return console.log('This run was deleted.');
    }
    if (now) {
      if (changed) {
        r = now;
        seenAt = mtime;
        drawnAt = Date.now();
        draw();
      }
      const s = r.session;
      const gone = !s?.open || (s.pid ? !alive(s.pid) : Date.now() - Date.parse(s.openedAt || 0) > 3 * 60 * 1000);
      if (gone) return restore();
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}
