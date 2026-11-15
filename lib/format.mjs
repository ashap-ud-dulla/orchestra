// Text Orchestra shows: tables, times, money, the runs board, one run in detail, a template.
import fs from 'node:fs';
import path from 'node:path';
import { brokenRuns, WRAP_UP_SKILL } from './store.mjs';
import { modelText } from './model.mjs';
import { tabTitle, ticketKey } from './terminal.mjs';
import { config } from './config.mjs';
import { pack } from './pack.mjs';
import { ordinal } from './util.mjs';
import { PASSED, likelyNext } from './run/steps.mjs';
import { cols } from './pane.mjs';

// ---------- text output ----------

export function table(rows, cols) {
  if (!rows.length) return '(none)';
  const cells = rows.map((r) => cols.map(([, get]) => String(get(r) ?? '')));
  const width = cols.map(([h], i) => Math.min(60, Math.max(h.length, ...cells.map((c) => c[i].length))));
  const line = (vals) => vals.map((v, i) => (v.length > width[i] ? v.slice(0, width[i] - 1) + '…' : v.padEnd(width[i]))).join('  ').trimEnd();
  return [line(cols.map(([h]) => h)), line(width.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

export const money = (n) => `$${(n || 0).toFixed(2)}`;

export function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function dur(ms) {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const NEEDS_YOU = new Set(['needs-you', 'waiting', 'failed', 'stopped']);

// A run's status in plain words (the board, one run). JSON keeps the raw status.
const STATUS_WORDS = { 'needs-you': 'asks you', waiting: 'waits for next', stopped: 'tab closed', failed: 'failed', running: 'working', queued: 'in line', draft: 'draft', done: 'done' };
export function statusWord(r) {
  if (r.status === 'waiting' && r.appNext) return 'waits for the app';
  if (r.status === 'waiting' && r.slotNext) return 'waits for a slot';
  if (r.status === 'stopped' && r.cleanedAt) return 'cleaned up';
  if (r.status === 'running' && !r.session?.open) return 'starting';
  return STATUS_WORDS[r.status] || r.status;
}

export const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export const unmark = (t) => String(t || '').replace(/\n?ORCHESTRA:(DONE|FAILED)\s*$/, '').trim();

// What the run is waiting for, in a few words (the board card's line).
// app: the runner's appState() (who has the app, who waits); without it, read from the run alone.
export function why(r, app) {
  const label = (id) => r.steps.find((b) => b.id === id)?.label || id;
  const working = r.steps.find((b) => b.status === 'running');
  const hasApp = app ? app.holder?.id === r.id : !!r.appHeld;
  const place = app ? app.line.findIndex((x) => x.id === r.id) + 1 : 0;
  if (place) return `waiting for the app: ${ordinal(place)} in line${app.holder ? ` (${app.holder.title} has it)` : ''}`;
  if (!app && r.appWant) return 'waiting for the app';
  if (r.status === 'waiting' && hasApp) return `${r.note || `waiting after "${label(r.waitingAfter)}"`} · has the app until you type next`;
  if (r.status === 'waiting') return r.note || `waiting after "${label(r.waitingAfter)}": type next in its tab`;
  if (r.status === 'failed') return r.error || 'failed';
  if (r.status === 'stopped') return r.cleanedAt ? 'cleaned up' : 'tab closed: reopen it';
  if (r.status === 'needs-you') return `needs you in its tab${r.note || r.asks ? `: ${unmark(r.note || r.asks).replace(/\s+/g, ' ')}` : ''}`;
  if (r.status === 'draft') return 'draft: check the steps, then reopen to start';
  if (r.status === 'queued') return 'waiting for a free slot';
  if (r.status === 'done') return r.cleanedAt ? 'done, cleaned up' : r.session?.open ? 'done (tab still open)' : 'done';
  if (working) return `working on "${working.label}"${hasApp ? ' (has the app)' : ''}`;
  const next = r.steps.find((b) => b.status === 'pending');
  if (r.status === 'running' && next?.note) return next.note; // for example waiting for the app
  return '';
}

export function stepCol(r) {
  const n = r.steps.length;
  const i = r.steps.findIndex((b) => !PASSED.has(b.status));
  if (i < 0) return `${n}/${n}`;
  return `${i + 1}/${n} ${r.steps[i].label}`;
}

export const order = (r) => (NEEDS_YOU.has(r.status) && !(r.status === 'stopped' && r.cleanedAt) ? 0 : r.status === 'running' ? 1 : r.status === 'queued' ? 2 : r.status === 'draft' ? 3 : 4);

export function board(runs, all, app) {
  let list = [...runs].sort((a, b) => order(a) - order(b) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // Cleaned runs leave the board (they stay in Stats and runs --all).
  if (!all) list = list.filter((r) => !r.cleanedAt);
  const text = table(list, [
    ['Run', (r) => tabTitle(r)],
    ['About', (r) => short(r.about || '', 45)],
    ['Status', statusWord],
    ['Step', stepCol],
    ['Cost', (r) => money(r.cost)],
    ['Updated', (r) => ago(r.updatedAt)],
    ['What now', (r) => short(why(r, app), 70)],
    ['Id', (r) => r.id.slice(-6)],
  ]);
  const hidden = runs.length - list.length;
  return hidden > 0 ? `${text}\n(${hidden} cleaned run${hidden > 1 ? 's' : ''} hidden: runs --all)` : text;
}

// clean: { stale, finished } from the runner: runs whose folders could go.
export function statusLine(runs, settings, app, clean) {
  const n = (s) => runs.filter((r) => r.status === s).length;
  // Waiting for a slot or the app is Orchestra's doing, not yours.
  const needs = runs.filter((r) => ['needs-you', 'waiting', 'failed'].includes(r.status) && !r.slotNext && !r.appNext);
  const heavy = runs.filter((r) => r.session?.open && r.steps.some((s) => s.status === 'running' && s.heavy)).length;
  const inLine = runs.filter((r) => r.slotNext).length;
  const parts = [`${n('running')} working (${heavy} of ${settings.maxRunning} heavy slots${inLine ? `, ${inLine} in line` : ''})`, `${needs.length} need you`];
  if (n('queued')) parts.push(`${n('queued')} opening`);
  const stopped = runs.filter((r) => r.status === 'stopped' && !r.cleanedAt && r.sessionId);
  if (stopped.length) parts.push(`${stopped.length} stopped (reopen all)`);
  const lines = [`Orchestra · ${parts.join(' · ')}`];
  if (app && (app.holder || app.line.length)) lines.push(appLine(app));
  for (const r of needs) lines.push(`  ! ${tabTitle(r)}: ${short(why(r, app), 110)}`);
  if (clean?.finished.length) lines.push(`Finished, folder still there: ${clean.finished.map(tabTitle).join(', ')} (clean them: clean --done; sizes: disk)`);
  if (clean?.stale.length) lines.push(`Left alone 7+ days: ${clean.stale.map((r) => `${tabTitle(r)} (${r.status})`).join(', ')} (clean them: clean --stale)`);
  return lines.join('\n');
}

// App: ABC-12 has it · next: ABC-15, XYZ-3
export function appLine(app) {
  const has = app.holder?.you
    ? 'you have it (your own checkout; orch app stop frees it)'
    : app.holder ? `${app.holder.title} has it${app.holder.waitingForYou ? ' (waiting for you: type next there to hand it on)' : ''}` : 'free';
  return `App: ${has}${app.line.length ? ` · next: ${app.line.map((x) => x.title).join(', ')}` : ''}`;
}

// Whose code the app serves (written by bin/app.mjs start).
export function serving() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'app.json'), 'utf8'));
  } catch {
    return null;
  }
}

// One run. Short by default (what it does now, its steps); full: the notes of each step, PR links, lessons, activity.
export function runDetail(r, timeline, app, { full = true, usual = null } = {}) {
  const out = [];
  out.push(`${tabTitle(r)} · ${r.templateName} · ${statusWord(r)} · ${money(r.cost)} · started ${ago(r.createdAt)} · ${r.id}`);
  if (r.tracking === false) out.push(pack.trackingOffText);
  if (r.input?.text) out.push(`Input: ${short(r.input.text.replace(/\s+/g, ' '), 300)}`);
  if (r.about) out.push(`About: ${r.about}`);
  out.push(`Now: ${why(r, app)}`);
  const repos = r.workspace?.repos || r.repoPlan || [];
  if (repos.length) {
    const where = r.cleanedAt ? 'cleaned up (worktrees removed)' : r.workspace?.ready ? r.workspace.dir : 'made when the run starts';
    out.push(`Workspace: ${where} · ${repos.map((p) => `${p.token} ${p.branch ? `on ${p.branch}` : `(no branch yet, from ${p.base})`}`).join(' · ')}`);
  }
  out.push(`Tab: ${r.session?.open ? 'open (the "orchestra" Windows Terminal window)' : r.sessionId ? 'closed' : 'not opened yet'}`);
  out.push('', runSteps(r, { notes: full, usual }));
  if (!full) {
    if (r.pins?.length) out.push('', `Pinned: ${r.pins.length} (${r.pins.slice().reverse().map((p, i) => `${i + 1}. ${p.title}`).join(' · ')}). In full: pin ${ticketKey(r) || r.id}`);
    out.push('', `More (what each step did, PR links, activity): run ${ticketKey(r) || r.id.slice(-6)} full=yes`);
    return out.join('\n');
  }
  if (r.pins?.length) out.push('', `Pinned: ${r.pins.length} (${r.pins.slice().reverse().map((p, i) => `${i + 1}. ${p.title}`).join(' · ')}). In full: pin ${ticketKey(r) || r.id}`);
  const s = r.ship;
  if (s?.prUrls?.length || Object.keys(s?.notes || {}).length) {
    out.push('', 'Shipped:');
    out.push(...s.prUrls.map((u) => `  - PR: ${u}`));
    out.push(...Object.entries(s.notes || {}).map(([k, v]) => `  - ${k}: ${v}`));
    out.push(r.steps.some((b) => b.skill === WRAP_UP_SKILL)
      ? `  ${pack.wrapUpNote}`
      : `  This run has no Wrap up step. To add it: steps ${ticketKey(r) || r.id} add wrap-up label="Wrap up"`);
  }
  if (r.learn) out.push('', `Lessons: ${r.learn.status === 'working' ? 'looking…' : r.learn.status === 'failed' ? `failed (${r.learn.error})` : `${r.learn.count} suggested (${money(r.learn.cost)})`}`);
  const recent = timeline.slice(-12);
  if (recent.length) {
    out.push('', 'Recent activity:');
    for (const e of recent) out.push(`  ${e.at.slice(11, 16)} ${e.kind === 'log' ? '' : `[${e.kind}] `}${short(unmark(e.text).replace(/\s+/g, ' '), 150)}`);
  }
  return out.join('\n');
}

// The steps of a run, numbered. notes: what each finished step did and why. usual: per skill, its usual cost and AI
// time (orch stats), shown for the guide's likely next steps.
export function runSteps(r, { notes = false, usual = null } = {}) {
  const out = ['Steps:'];
  r.steps.forEach((b, i) => {
    const flags = stepFlags(b);
    out.push(`  ${i + 1}. ${b.label} (/${b.skill}${b.args ? ` ${short(b.args, 40)}` : ''}) · ${b.status}${b.cost ? ` · ${money(b.cost)}` : ''}${b.durationMs ? ` · ${dur(b.durationMs)}` : ''}${flags ? ` · ${flags}` : ''}`);
    if (b.note) out.push(`     note: ${b.note}`);
    if (b.error) out.push(`     error: ${short(b.error, 300)}`);
    if (notes && b.didWhy) out.push(...b.didWhy.split('\n').filter(Boolean).slice(0, 6).map((l) => `     ${l.trim()}`));
    // A step that ran again (orch go back): what its earlier tries did.
    for (const [k, t] of (b.tries || []).entries()) {
      out.push(`     try ${k + 1}: ${t.status}${t.cost ? ` · ${money(t.cost)}` : ''}${t.endedAt ? ` · ${ago(t.endedAt)}` : ''}`);
      if (notes && (t.didWhy || t.summary)) out.push(...String(t.didWhy || t.summary).split('\n').filter(Boolean).slice(0, 3).map((l) => `       ${l.trim()}`));
    }
  });
  // The steps add up to the run: what is left is talk between steps, and lessons.
  const steps = r.steps.reduce((s, b) => s + (b.cost || 0) + (b.tries || []).reduce((n, t) => n + (t.cost || 0), 0), 0);
  if ((r.cost || 0) - steps >= 0.01) out.push(`  Between steps (talk, lessons): ${money(r.cost - steps)}`);
  if (r.guide) {
    const likely = likelyNext(r);
    const cost = (s) => {
      const u = usual?.[s.skill];
      return u?.done ? `, usually ${money(u.avgCost)}${u.avgMs ? ` and ${dur(u.avgMs)} of AI time` : ''}` : '';
    };
    out.push(`Guide: ${r.guide.name} (steps are picked one at a time)`);
    out.push(likely.length ? `Likely next: ${likely.map((s) => `${s.id} (/${s.skill}${modelTag(s) ? `, ${modelTag(s)}` : ''}${cost(s)})`).join(' · ')}` : 'Likely next: nothing more in the guide');
  }
  return out.join('\n');
}

// A step's options in words: "wait after, uses app, opus, effort high". short: the pane's few words.
export function stepFlags(b, { short = false } = {}) {
  if (short) return [b.wait && 'wait', b.app && 'app', b.heavy && 'heavy', b.explain && 'explain', b.fresh && 'fresh', b.mcp && 'mcp', b.model, b.effort].filter(Boolean).join(' ');
  return [b.wait && 'wait after', b.app && 'uses app', b.heavy && 'heavy', b.explain && 'explain', b.fresh && 'new conversation', b.mcp && 'every MCP server', modelTag(b)].filter(Boolean).join(', ');
}

export function templateText(t) {
  const flags = (b) => stepFlags(b);
  return [
    `${t.name} (${t.id}) · tracking ${t.tracking === false ? 'off' : 'on'}${t.repos?.length ? ` · repos ${t.repos.join(', ')}` : ''}${modelTag(t) ? ` · default ${modelTag(t)}` : ''}`,
    ...t.steps.map((b, i) => `  ${i + 1}. ${b.label || b.skill} [${b.id}] /${b.skill}${b.args ? ` ${b.args}` : ''}${flags(b) ? ` · ${flags(b)}` : ''}`),
  ].join('\n');
}

// "opus, effort high" for a step; ultracode is said to cost a lot.
export const modelTag = (b) => modelText(b, { long: true });

// ---------- commands ----------

// Run files Orchestra could not read: named, never hidden (the file is kept as it is).
export function brokenText() {
  const list = brokenRuns();
  if (!list.length) return '';
  const lines = list.map((b) => `  ${b.id}: ${b.error}`);
  return ['', '', `Could not read ${list.length === 1 ? 'this run file' : 'these run files'} (kept as they are):`, ...lines].join('\n');
}
