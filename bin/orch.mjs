// Orchestra's command line: node bin/orch.mjs <command> [args] [--json]
// The /orchestra skill calls this; you can too. Plain text by default, --json for programs.
// Every command takes the Orchestra lock for a moment and lets go (see lib/lock.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { withRunner, gb } from '../lib/runner.mjs';
import { listTemplates, getTemplate, saveTemplate, deleteTemplate, validateTemplate, isSafeId, runDir, WRAP_UP_SKILL } from '../lib/store.mjs';
import { scanSkills } from '../lib/skills-scan.mjs';
import { setMark, offProblems, OFF_HELP } from '../lib/tracking.mjs';
import { computeStats } from '../lib/stats.mjs';
import { listSuggestions, decide, markApplied, cleanChange, getInstructions, saveInstructions } from '../lib/learn.mjs';
import { listRepos, size as workspaceSize } from '../lib/workspace.mjs';
import { tabTitle, ticketKey } from '../lib/terminal.mjs';
import { config } from '../lib/config.mjs';

const HELP = `Orchestra commands (node bin/orch.mjs <command>):
  status                                  what is working and what needs you
  runs [--all]                            the board: every run, needs-you first
  run <run>                               one run: its steps, notes, activity, PR links
  start <template> <ticket>... [--text "job"] [--repos api,webclient|none] [--base api=origin/x] [--draft]
                                          one run per ticket or quoted job text (or one run for --text)
  reopen <run>|all                        reopen a stopped run's tab (same conversation); starts a draft
  stop <run>                              close a run's tab, or take it out of the queue
  clean <run> [--force]                   free its space: stop what runs from its folder, remove the folder and its
                                          Claude conversation files (branches, notes and stats stay)
  clean --done | --stale [--force]        every finished run whose tab is closed | every run left alone 7+ days
  disk                                    the space each run folder takes
  delete <run> [--force]                  remove the run completely (it also leaves Stats)
  boxes <run> --set '<json list>'         change the steps of a run that has not finished
  timeline <run> [--limit N]              the run's log and activity
  app [release <run>]                     who has the app, who waits for it, whose code it serves
  about <run> ["text"]                  what the ticket is about (the run says it by itself; set it by hand here)
  watch <run> [--once]                  the run's steps and pins, redrawn live (the pane on the right of its tab)
  pin <run> ["text"] [--title "…"]       pin text to the run's pane (no text: show its pins in full)
  unpin <run> [N|all]                    remove pin N as the pane numbers it (1 = newest; none: the one it shows)
  lessons <run>                           look for lessons in a run now
  templates                               list templates
  template show <id>
  template new <id> <first-skill> --name "Name" [--tracking on|off] [--repos api,webclient]
  template copy <id> <new-id> [--name "Name"]
  template set <id> name="…" tracking=on|off repos=api,webclient model=… effort=…
  template add <id> <skill> [--at N] [--label "…"] [--args "…"] [--wait] [--app] [--explain] [--fresh] [--model m] [--effort e]
  template box <id> <box> label="…" args="…" wait=on|off app=on|off explain=on|off fresh=on|off model=… effort=…
                                          fresh: the step starts a new conversation (cheaper; it gets the story so far)
                                          model: opus|sonnet|haiku|fable|<id>|none · effort: low|medium|high|xhigh|max|
                                          ultracode (many helpers, costly)|none. A step with none keeps the one before.
  template move <id> <box> <position>
  template remove <id> <box>
  template save <id> --json '<template>'
  template delete <id>
  skills [search]                         find skills (name, description, tracking mark)
  skill-mark <skill> auto|writes|clean    correct a skill's tracking mark
  repos                                   the ITP repos a run can use
  suggestions [--all]                     lessons waiting for your yes or no
  suggestion <id> accept|reject|apply [--text "…"] [--apply] [--change '<json>'] [--template <id>]
                                          accept a workflow change with --apply to change its template now
  rules [--set "…" | --add "…"]           your rules (every run follows them)
  stats                                   spend, templates, skills, recent runs
  settings [max=N] [learn=on|off] [pane=on|off] [panesize=15..70]   panesize: the pane's width, % of the tab
A <run> is a Jira key (ITP2-14852), words from its name ("sweden row"), or the end of its id.`;

// ---------- parsing ----------

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && VALUE_OPTS.has(k)) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
const VALUE_OPTS = new Set(['rows', 'cols', 'pin', 'scroll', 'title', 'text', 'repos', 'base', 'set', 'add', 'name', 'tracking', 'at', 'label', 'args', 'json-in', 'limit', 'change', 'template', 'model', 'effort']);

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

// key=value words: name="My flow" wait=on
function pairs(words) {
  const out = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 1) fail(`expected key=value, got "${w}"`);
    out[w.slice(0, i).toLowerCase()] = w.slice(i + 1);
  }
  return out;
}

function onOff(v, what) {
  if (v === true || v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  fail(`${what} must be on or off`);
}

// ---------- text output ----------

function table(rows, cols) {
  if (!rows.length) return '(none)';
  const cells = rows.map((r) => cols.map(([, get]) => String(get(r) ?? '')));
  const width = cols.map(([h], i) => Math.min(60, Math.max(h.length, ...cells.map((c) => c[i].length))));
  const line = (vals) => vals.map((v, i) => (v.length > width[i] ? v.slice(0, width[i] - 1) + '…' : v.padEnd(width[i]))).join('  ').trimEnd();
  return [line(cols.map(([h]) => h)), line(width.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

const money = (n) => `$${(n || 0).toFixed(2)}`;

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function dur(ms) {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const NEEDS_YOU = new Set(['needs-you', 'waiting', 'failed', 'stopped']);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const unmark = (t) => String(t || '').replace(/\n?ORCHESTRA:(DONE|FAILED)\s*$/, '').trim();

const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

// What the run is waiting for, in a few words (the board card's line).
// app: the runner's appState() (who has the app, who waits); without it, read from the run alone.
function why(r, app) {
  const label = (id) => r.boxes.find((b) => b.id === id)?.label || id;
  const working = r.boxes.find((b) => b.status === 'running');
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
  const next = r.boxes.find((b) => b.status === 'pending');
  if (r.status === 'running' && next?.note) return next.note; // for example waiting for the app
  return '';
}

function step(r) {
  const n = r.boxes.length;
  const i = r.boxes.findIndex((b) => b.status !== 'done');
  if (i < 0) return `${n}/${n}`;
  return `${i + 1}/${n} ${r.boxes[i].label}`;
}

const order = (r) => (NEEDS_YOU.has(r.status) && !(r.status === 'stopped' && r.cleanedAt) ? 0 : r.status === 'running' ? 1 : r.status === 'queued' ? 2 : r.status === 'draft' ? 3 : 4);

function board(runs, all, app) {
  let list = [...runs].sort((a, b) => order(a) - order(b) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // Cleaned runs leave the board (they stay in Stats and runs --all).
  if (!all) list = list.filter((r) => !r.cleanedAt);
  const text = table(list, [
    ['Run', (r) => tabTitle(r)],
    ['About', (r) => short(r.about || '', 45)],
    ['Status', (r) => r.status],
    ['Step', step],
    ['Cost', (r) => money(r.cost)],
    ['Updated', (r) => ago(r.updatedAt)],
    ['What now', (r) => short(why(r, app), 70)],
    ['Id', (r) => r.id.slice(-6)],
  ]);
  const hidden = runs.length - list.length;
  return hidden > 0 ? `${text}\n(${hidden} cleaned run${hidden > 1 ? 's' : ''} hidden: runs --all)` : text;
}

// clean: { stale, finished } from the runner: runs whose folders could go.
function statusLine(runs, settings, app, clean) {
  const n = (s) => runs.filter((r) => r.status === s).length;
  const needs = runs.filter((r) => ['needs-you', 'waiting', 'failed'].includes(r.status));
  const parts = [`${n('running')} running (of ${settings.maxRunning} at once)`, `${needs.length} need you`, `${n('queued')} queued`];
  const stopped = runs.filter((r) => r.status === 'stopped' && !r.cleanedAt && r.sessionId);
  if (stopped.length) parts.push(`${stopped.length} stopped (reopen all)`);
  const lines = [`Orchestra · ${parts.join(' · ')}`];
  if (app && (app.holder || app.line.length)) lines.push(appLine(app));
  for (const r of needs) lines.push(`  ! ${tabTitle(r)}: ${short(why(r, app), 110)}`);
  if (clean?.finished.length) lines.push(`Finished, folder still there: ${clean.finished.map(tabTitle).join(', ')} (clean them: clean --done; sizes: disk)`);
  if (clean?.stale.length) lines.push(`Left alone 7+ days: ${clean.stale.map((r) => `${tabTitle(r)} (${r.status})`).join(', ')} (clean them: clean --stale)`);
  return lines.join('\n');
}

// App: ITP2-14877 has it · next: ITP2-14929, ITP2-14878
function appLine(app) {
  const has = app.holder ? `${app.holder.title} has it${app.holder.waitingForYou ? ' (waiting for you: type next there to hand it on)' : ''}` : 'free';
  return `App: ${has}${app.line.length ? ` · next: ${app.line.map((x) => x.title).join(', ')}` : ''}`;
}

// Whose code the app serves (written by bin/app.mjs start).
function serving() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'app.json'), 'utf8'));
  } catch {
    return null;
  }
}

function runDetail(r, timeline, app) {
  const out = [];
  out.push(`${tabTitle(r)} · ${r.templateName} · ${r.status} · ${money(r.cost)} · started ${ago(r.createdAt)} · ${r.id}`);
  if (r.tracking === false) out.push('Tracking is OFF: no Teamspace calls, no vault (ITPKV) writes.');
  if (r.input?.text) out.push(`Input: ${short(r.input.text.replace(/\s+/g, ' '), 300)}`);
  if (r.about) out.push(`About: ${r.about}`);
  out.push(`Now: ${why(r, app)}`);
  const repos = r.workspace?.repos || r.repoPlan || [];
  if (repos.length) {
    const where = r.cleanedAt ? 'cleaned up (worktrees removed)' : r.workspace?.ready ? r.workspace.dir : 'made when the run starts';
    out.push(`Workspace: ${where} · ${repos.map((p) => `${p.token} ${p.branch ? `on ${p.branch}` : `(no branch yet, from ${p.base})`}`).join(' · ')}`);
  }
  out.push(`Tab: ${r.session?.open ? 'open (the "orchestra" Windows Terminal window)' : r.sessionId ? 'closed' : 'not opened yet'}`);
  out.push('', 'Steps:');
  r.boxes.forEach((b, i) => {
    const flags = [b.waitAfter && 'wait after', b.usesApp && 'uses app', b.walkthrough && 'explain', b.fresh && 'new conversation', modelTag(b)].filter(Boolean).join(', ');
    out.push(`  ${i + 1}. ${b.label} (/${b.skill}${b.args ? ` ${short(b.args, 40)}` : ''}) · ${b.status}${b.cost ? ` · ${money(b.cost)}` : ''}${b.durationMs ? ` · ${dur(b.durationMs)}` : ''}${flags ? ` · ${flags}` : ''}`);
    if (b.note) out.push(`     note: ${b.note}`);
    if (b.error) out.push(`     error: ${short(b.error, 300)}`);
    if (b.didWhy) out.push(...b.didWhy.split('\n').filter(Boolean).slice(0, 6).map((l) => `     ${l.trim()}`));
  });
  if (r.pins?.length) out.push('', `Pinned: ${r.pins.length} (${r.pins.slice().reverse().map((p, i) => `${i + 1}. ${p.title}`).join(' · ')}). In full: orch pin ${ticketKey(r) || r.id}`);
  const s = r.ship;
  if (s?.prUrls?.length || s?.epicFolder) {
    out.push('', 'Shipped:');
    out.push(...s.prUrls.map((u) => `  - PR: ${u}`));
    if (s.epicFolder) out.push(`  - Epic: ${s.epicFolder}`);
    out.push(r.boxes.some((b) => b.skill === WRAP_UP_SKILL)
      ? '  The Wrap up step pushes the vault, closes the epic and pushes the ITP files, as you pick.'
      : `  This run has no Wrap up step. To add it: orch boxes ${ticketKey(r) || r.id} --set '<json list>'.`);
  }
  if (r.learn) out.push('', `Lessons: ${r.learn.status === 'working' ? 'looking…' : r.learn.status === 'failed' ? `failed (${r.learn.error})` : `${r.learn.count} suggested (${money(r.learn.cost)})`}`);
  const recent = timeline.slice(-12);
  if (recent.length) {
    out.push('', 'Recent activity:');
    for (const e of recent) out.push(`  ${e.at.slice(11, 16)} ${e.kind === 'log' ? '' : `[${e.kind}] `}${short(unmark(e.text).replace(/\s+/g, ' '), 150)}`);
  }
  return out.join('\n');
}

// ---------- finding things ----------

// A run by id, end of id, or Jira key (the newest run with that key).
// Order: the exact id; a Jira key (the newest run of that ticket); the end of an id; else words from the run's name,
// About line or text, when they fit exactly one run.
function findRun(runner, ref) {
  if (!ref) fail('name a run: a Jira key, words from its name, or the end of its id');
  const runs = runner.list();
  const exact = runs.find((r) => r.id === ref);
  if (exact) return exact;
  const key = String(ref).toUpperCase();
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    const byKey = runs.filter((r) => ticketKey(r) === key);
    if (byKey.length) return byKey[0];
    fail(`no run for ticket ${key}`, 404); // a key never matches a free text that only mentions it
  }
  const byEnd = runs.filter((r) => r.id.endsWith(ref));
  if (byEnd.length === 1) return byEnd[0];
  if (byEnd.length > 1) fail(`"${ref}" matches ${byEnd.length} runs; give more of the id`);
  const words = String(ref).toLowerCase().split(/\s+/).filter(Boolean);
  const byWords = runs.filter((r) => {
    const text = `${tabTitle(r)} ${r.about || ''} ${r.input?.text || ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  if (byWords.length === 1) return byWords[0];
  if (byWords.length > 1) fail(`"${ref}" fits ${byWords.length} runs: ${byWords.map((r) => `${tabTitle(r)} (${r.id.slice(-6)})`).join(', ')}. Give more words or the id end.`, 409);
  fail(`run not found: ${ref}`, 404);
}

async function findTemplate(ref) {
  if (!ref) fail('name a template');
  if (isSafeId(ref)) {
    const t = await getTemplate(ref);
    if (t) return t;
  }
  const all = await listTemplates();
  const low = String(ref).toLowerCase();
  const hits = all.filter((t) => t.name.toLowerCase() === low);
  if (hits.length === 1) return hits[0];
  const part = all.filter((t) => t.id.includes(low) || t.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (part.length > 1) fail(`"${ref}" matches several templates: ${part.map((t) => t.id).join(', ')}`);
  fail(`template not found: ${ref}`, 404);
}

function slug(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 50) || 'box';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// Saves a template after the same checks the page made: valid, and no Teamspace/vault skills with tracking off.
async function storeTemplate(t) {
  const errors = validateTemplate(t);
  if (errors.length) fail(errors.join('; '));
  if (t.tracking === false) {
    const problems = offProblems(t.boxes, await scanSkills());
    if (problems.length) fail(`${problems.join('; ')}. ${OFF_HELP.replace('on the Skills page', 'with skill-mark')}`, 409);
  }
  return saveTemplate(t);
}

function templateText(t) {
  const flags = (b) => [b.waitAfter && 'wait after', b.usesApp && 'uses app', b.walkthrough && 'explain', b.fresh && 'new conversation', modelTag(b)].filter(Boolean).join(', ');
  return [
    `${t.name} (${t.id}) · tracking ${t.tracking === false ? 'off' : 'on'}${t.repos?.length ? ` · repos ${t.repos.join(', ')}` : ''}${modelTag(t) ? ` · default ${modelTag(t)}` : ''}`,
    ...t.boxes.map((b, i) => `  ${i + 1}. ${b.label || b.skill} [${b.id}] /${b.skill}${b.args ? ` ${b.args}` : ''}${flags(b) ? ` · ${flags(b)}` : ''}`),
  ].join('\n');
}

function boxFlags(box, o) {
  if (o.label !== undefined) box.label = String(o.label).slice(0, 80);
  if (o.args !== undefined) box.args = String(o.args).slice(0, 2000);
  if (o.wait !== undefined) box.waitAfter = onOff(o.wait, 'wait');
  if (o.app !== undefined) box.usesApp = onOff(o.app, 'app');
  if (o.explain !== undefined) box.walkthrough = onOff(o.explain, 'explain');
  if (o.fresh !== undefined) box.fresh = onOff(o.fresh, 'fresh');
  modelFlags(box, o);
  return box;
}

// model=opus effort=high on a step or a template; none (or off) takes it away. The template save checks the values.
function modelFlags(x, o) {
  for (const k of ['model', 'effort']) {
    if (o[k] === undefined) continue;
    const v = String(o[k]).trim().toLowerCase();
    if (v === 'none' || v === 'off' || !v) delete x[k];
    else x[k] = v;
  }
}

// "opus, effort high" for a step; ultracode is said to cost a lot.
function modelTag(b) {
  return [b.model, b.effort && (b.effort === 'ultracode' ? 'ultracode (many helpers, costly)' : `effort ${b.effort}`)].filter(Boolean).join(', ');
}

// ---------- lessons that change a template ----------

// A workflow suggestion's change, as the template command that makes it.
function changeArgs(c, templateId) {
  const q = (v) => (/\s|"/.test(v) ? JSON.stringify(v) : v);
  switch (c.op) {
    case 'box': {
      const set = ['wait', 'app', 'explain', 'fresh', 'model', 'effort', 'args', 'label'].filter((k) => c[k] !== undefined).map((k) => `${k}=${c[k]}`);
      return { pos: ['box', templateId, c.box, ...set], shown: ['box', templateId, c.box, ...set.map((w) => w.replace(/=(.*)/s, (m, v) => `=${q(v)}`))] };
    }
    case 'add': {
      const opt = { at: c.at, label: c.label, args: c.args, wait: c.wait };
      for (const k of Object.keys(opt)) if (opt[k] === undefined) delete opt[k];
      const flags = Object.entries(opt).map(([k, v]) => (k === 'wait' ? (v === 'on' ? '--wait' : '') : `--${k} ${q(String(v))}`)).filter(Boolean);
      return { pos: ['add', templateId, c.skill], opt, shown: ['add', templateId, c.skill, ...flags] };
    }
    case 'remove':
      return { pos: ['remove', templateId, c.box], shown: ['remove', templateId, c.box] };
    case 'move':
      return { pos: ['move', templateId, c.box, String(c.to)], shown: ['move', templateId, c.box, String(c.to)] };
  }
  fail('unknown change');
}

function changeCommand(c, templateId) {
  return `template ${changeArgs(c, templateId).shown.join(' ')}`;
}

function notApplied(list) {
  return list.filter((s) => s.kind === 'workflow' && s.status === 'accepted' && !s.appliedAt);
}

// Makes an accepted workflow change in its template. --change '<json>' gives or corrects the change;
// --template <id> names the template when the one it came from was renamed.
async function applySuggestion(r, s, opt) {
  let change = s.change;
  if (typeof opt.change === 'string') {
    try {
      change = cleanChange(JSON.parse(opt.change));
    } catch {
      change = null;
    }
    if (!change) fail(`that change is not one Orchestra knows. Example: --change '{"op":"box","box":"plan","args":"show the full plan"}'`);
  }
  if (!change) fail(`no exact change was saved for this lesson. Give it: suggestion ${s.id} apply --change '{"op":"box","box":"<step>","wait":"on"}'`);
  const want = typeof opt.template === 'string' ? opt.template : s.templateId;
  let t;
  try {
    t = await findTemplate(want);
  } catch (err) {
    if (err.status === 404) fail(`template ${want} is not there any more (renamed?). Name it: suggestion ${s.id} apply --template <id>`, 404);
    throw err;
  }
  const { pos, opt: o = {} } = changeArgs(change, t.id);
  const res = await commands.template(r, { pos, opt: o });
  await markApplied(s.id, { change, templateId: t.id });
  return { json: { ...s, change, appliedTo: t.id }, text: `accepted and applied: ${s.text}\n${res.text}` };
}

// ---------- commands ----------

const commands = {
  async status(r) {
    const runs = r.list();
    const clean = { stale: r.staleRuns(), finished: r.finishedUncleaned() };
    return { json: { settings: r.getSettings(), runs, clean: { stale: clean.stale.map((x) => x.id), finished: clean.finished.map((x) => x.id) } }, text: statusLine(runs, r.getSettings(), r.appState(), clean) };
  },

  async runs(r, { opt }) {
    const runs = r.list();
    return { json: runs, text: board(runs, !!opt.all, r.appState()) };
  },

  async run(r, { pos }) {
    const run = findRun(r, pos[0]);
    return { json: run, text: runDetail(run, await r.timeline(run.id, 60), r.appState()) };
  },

  async timeline(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const list = await r.timeline(run.id, Number(opt.limit) || 400);
    return { json: list, text: list.map((e) => `${e.at.slice(0, 16).replace('T', ' ')} ${e.kind === 'log' ? '' : `[${e.kind}] `}${unmark(e.text)}`).join('\n') || '(nothing yet)' };
  },

  async start(r, { pos, opt }) {
    const [tplRef, ...inputs] = pos;
    const template = await findTemplate(tplRef);
    let repos;
    if (opt.repos === 'none') repos = [];
    else if (typeof opt.repos === 'string') repos = opt.repos.split(',').map((token) => ({ token: token.trim() })).filter((x) => x.token);
    if (typeof opt.base === 'string') {
      repos ??= (template.repos || []).map((token) => ({ token }));
      for (const pair of opt.base.split(',')) {
        const [token, base] = pair.split('=');
        const repo = repos.find((x) => x.token === token);
        if (!repo || !base) fail(`--base must be repo=branch for a repo of this run (got "${pair}")`);
        repo.base = base;
      }
    }
    const start = !opt.draft;
    let runs;
    if (typeof opt.text === 'string') runs = [await r.createRun({ templateId: template.id, input: { text: opt.text }, start, repos })];
    else if (inputs.length === 1) runs = [await r.createRun({ templateId: template.id, input: { text: inputs[0] }, start, repos })];
    else if (inputs.length) runs = await r.createRuns({ templateId: template.id, inputs, start, repos });
    else fail('give at least one ticket (or --text "the job")');
    const max = r.getSettings().maxRunning;
    const text = [
      `${start ? 'Started' : 'Made as draft'}: ${runs.length} run${runs.length > 1 ? 's' : ''} of "${template.name}" (${template.boxes.length} steps).`,
      ...runs.map((x) => `  ${tabTitle(x)} · ${x.id}`),
      start ? `Each opens its own tab in the "orchestra" Windows Terminal window. ${max} work at once; the rest wait in the queue and start by themselves.` : 'Change the steps with: boxes <run> --set …, then: reopen <run> to start.',
    ].join('\n');
    return { json: runs.length === 1 && inputs.length <= 1 ? runs[0] : runs, text };
  },

  async reopen(r, { pos }) {
    if (pos[0] === 'all') {
      const list = r.list().filter((x) => x.status === 'stopped' && x.sessionId && !x.cleanedAt && !x.session?.open);
      const done = [];
      for (const run of list) done.push(await r.resume(run.id));
      return { json: done, text: done.length ? `Reopening ${done.length} run${done.length > 1 ? 's' : ''}: ${done.map(tabTitle).join(', ')}. Each tab opens on its own conversation; type next or redo there.` : 'No stopped runs to reopen.' };
    }
    const run = findRun(r, pos[0]);
    const was = run.status;
    const out = await r.resume(run.id);
    return { json: out, text: was === 'draft' ? `${tabTitle(out)} started.` : `${tabTitle(out)} is ${out.status}. Its tab opens on the same conversation; type next to go on, redo to run the step again.` };
  },

  async stop(r, { pos }) {
    const run = findRun(r, pos[0]);
    const out = await r.stop(run.id);
    return { json: out, text: `${tabTitle(out)} is ${out.status}.` };
  },

  // clean <run>: now. clean --done / --stale: every finished run (tab closed) / every run left alone 7+ days.
  // (Runs with a Wrap up step clean themselves when their tab closes, if you said so in that step.)
  async clean(r, { pos, opt }) {
    let list;
    if (opt.done) list = r.finishedUncleaned();
    else if (opt.stale) list = r.staleRuns();
    else list = [findRun(r, pos[0])];
    if (!list.length) return { json: [], text: 'Nothing to clean up.' };
    const results = [];
    for (const run of list) {
      try {
        const out = await r.cleanUp(run.id, { force: !!opt.force, auto: !!opt.auto, merged: !!opt.merged });
        results.push({ id: run.id, title: tabTitle(run), cleaned: !!out.cleanedAt, freed: out.freed || 0, kept: !!out.cleanupKept });
      } catch (err) {
        if (list.length === 1) throw err;
        results.push({ id: run.id, title: tabTitle(run), error: err.message });
      }
    }
    const line = (x) => (x.error ? `${x.title}: not cleaned: ${x.error}` : x.kept ? `${x.title}: kept (uncommitted work)` : x.cleaned ? `${x.title}: cleaned · ${gb(x.freed)} freed` : `${x.title}: nothing to clean up`);
    const total = results.reduce((s, x) => s + (x.freed || 0), 0);
    const text = [...results.map(line), results.length > 1 ? `Freed ${gb(total)} in all.` : '', 'Branches, notes and stats stay.'].filter(Boolean).join('\n');
    return { json: list.length === 1 && !opt.done && !opt.stale ? r.get(list[0].id) : results, text };
  },

  // The space each run folder takes (links not followed), and the total.
  async disk(r) {
    const list = r.list().filter((x) => x.workspace?.ready && !x.cleanedAt);
    const sizes = await r.outside(() => Promise.all(list.map(async (x) => ({ id: x.id, title: tabTitle(x), status: x.status, folder: x.workspace.dir, bytes: await workspaceSize(x.workspace.dir) }))));
    const total = sizes.reduce((s, x) => s + x.bytes, 0);
    const text = sizes.length
      ? `${table(sizes, [['Run', (x) => x.title], ['Status', (x) => x.status], ['Folder', (x) => x.folder], ['Size', (x) => gb(x.bytes)]])}\nTotal: ${gb(total)}. Clean one: clean <run> · all finished: clean --done`
      : 'No run folders.';
    return { json: { runs: sizes, total }, text };
  },

  async delete(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const out = await r.deleteRun(run.id, { force: !!opt.force });
    return { json: out, text: `${tabTitle(run)} deleted (its branches stay).` };
  },

  async pin(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const text = pos.slice(1).join(' ');
    if (!text) {
      const pins = (run.pins || []).slice().reverse();
      const body = pins.map((p, i) => [`── ${i + 1}. ${p.title} (${p.from === 'claude' ? 'pinned by Claude' : p.from === 'answer' ? "Claude's answer, pinned by you" : 'your note'}, ${ago(p.at)}) ──`, p.text, ''].join('\n'));
      return { json: { pins }, text: pins.length ? body.join('\n').trimEnd() : "(no pins: type pin in the run's tab to keep Claude's last answer in its pane)" };
    }
    const out = await r.addPin(run.id, { text, title: typeof opt.title === 'string' ? opt.title : '', from: 'you' });
    return { json: { pins: out.pins }, text: `${tabTitle(out)}: pinned "${out.pins.at(-1).title}" (${out.pins.length} pin${out.pins.length > 1 ? 's' : ''}).` };
  },

  async unpin(r, { pos }) {
    const run = findRun(r, pos[0]);
    const which = pos[1];
    if (which !== undefined && which !== 'all' && !/^\d+$/.test(which)) fail('unpin takes a pin number (1 = newest) or all');
    const { run: out, removed } = await r.removePin(run.id, which);
    return { json: { pins: out.pins, removed }, text: `${tabTitle(out)}: unpinned ${removed.map((p) => `"${p.title}"`).join(', ')} (${out.pins.length} left).` };
  },

  async about(r, { pos }) {
    const run = findRun(r, pos[0]);
    if (pos.length < 2) return { json: { about: run.about || null }, text: run.about || '(not known yet: the run says it once it reads the ticket)' };
    const out = await r.setAbout(run.id, pos.slice(1).join(' '));
    return { json: out, text: `${tabTitle(out)}: ${out.about || '(cleared)'}` };
  },

  // Who has the app, who waits for it, and whose code it serves. `app release <run>` takes it from a run.
  async app(r, { pos }) {
    if (pos[0] === 'release') {
      const run = findRun(r, pos[1]);
      const out = await r.appRelease(run.id);
      return { json: out, text: `${tabTitle(run)} let go of the app.\n${appLine(out)}` };
    }
    if (pos[0]) fail('app [release <run>]');
    const app = r.appState();
    const s = serving();
    const text = [
      appLine(app),
      s ? `Serving: ${s.title}'s code from ${s.workspace}${s.branches ? ` (${s.branches})` : ''}, since ${ago(s.startedAt)}` : 'Serving: not started by Orchestra',
      'Runs take the app in their "Test in the app" step (node bin/app.mjs). Stop it: node bin/app.mjs stop',
    ].join('\n');
    return { json: { ...app, serving: s }, text };
  },

  async boxes(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    if (typeof opt.set !== 'string') fail('give the new steps with --set \'[{"id":…,"skill":…}]\'');
    let list;
    try {
      list = JSON.parse(opt.set);
    } catch {
      fail('--set must be a JSON list');
    }
    const out = await r.updateBoxes(run.id, list);
    return { json: out, text: runDetail(out, []) };
  },

  async lessons(r, { pos, opt }) {
    const run = findRun(r, pos[0]);
    const out = await r.learn(run.id, { auto: !!opt.auto });
    return { json: out, text: `${tabTitle(out)}: ${out.learn?.status === 'done' ? `${out.learn.count} lesson${out.learn.count === 1 ? '' : 's'} suggested. See: suggestions` : out.learn?.error || 'nothing to learn from'}` };
  },

  async learn(r, args) {
    return commands.lessons(r, args); // the name hooks use
  },

  async tick() {
    return { json: { ok: true }, text: 'ok' };
  },

  async templates() {
    const list = await listTemplates();
    return { json: list, text: table(list, [['Id', (t) => t.id], ['Name', (t) => t.name], ['Tracking', (t) => (t.tracking === false ? 'off' : 'on')], ['Steps', (t) => t.boxes.map((b) => b.label || b.skill).join(' > ')]]) };
  },

  async template(r, { pos, opt }) {
    const [sub, ref, ...rest] = pos;
    const save = async (t, said) => {
      const saved = await storeTemplate(t);
      return { json: saved, text: `${said}\n${templateText(saved)}` };
    };
    switch (sub) {
      case 'show': {
        const t = await findTemplate(ref);
        return { json: t, text: templateText(t) };
      }
      case 'new': {
        if (!isSafeId(ref)) fail('the id must be letters, digits, - or _ (for example jira-to-pr)');
        if (await getTemplate(ref)) fail(`template ${ref} already exists`, 409);
        // A template needs a step; the first one can come with --skill, else it is added next.
        const t = { id: ref, name: String(opt.name || ref), tracking: opt.tracking === undefined ? true : onOff(opt.tracking, 'tracking'), repos: typeof opt.repos === 'string' ? opt.repos.split(',').filter(Boolean) : [], boxes: [] };
        if (typeof opt.skill === 'string' || rest[0]) {
          const skill = opt.skill || rest[0];
          t.boxes.push(boxFlags({ id: slug(skill, new Set()), skill, label: skill, args: '' }, opt));
        } else fail('give the first step: template new <id> <skill> --name "…"');
        return save(t, 'Template made.');
      }
      case 'copy': {
        const t = await findTemplate(ref);
        const id = rest[0];
        if (!isSafeId(id)) fail('give the new id: template copy <id> <new-id>');
        if (await getTemplate(id)) fail(`template ${id} already exists`, 409);
        return save({ ...structuredClone(t), id, name: String(opt.name || `${t.name} (copy)`) }, 'Template copied.');
      }
      case 'set': {
        const t = await findTemplate(ref);
        const p = pairs(rest);
        if (p.name !== undefined) t.name = p.name;
        if (p.tracking !== undefined) t.tracking = onOff(p.tracking, 'tracking');
        if (p.repos !== undefined) t.repos = p.repos === 'none' ? [] : p.repos.split(',').filter(Boolean);
        modelFlags(t, p);
        return save(t, 'Template changed.');
      }
      case 'add': {
        const t = await findTemplate(ref);
        const skill = rest[0];
        if (!skill) fail('name the skill to add');
        if (!(await scanSkills()).some((s) => s.name === skill)) fail(`no skill named ${skill}. Find one with: skills <words>`, 404);
        const box = boxFlags({ id: slug(opt.label || skill, new Set(t.boxes.map((b) => b.id))), skill, label: skill, args: '' }, opt);
        const at = opt.at === undefined ? t.boxes.length : Math.max(0, Math.min(t.boxes.length, Number(opt.at) - 1));
        t.boxes.splice(at, 0, box);
        return save(t, `Added ${skill} at step ${at + 1}.`);
      }
      case 'box': {
        const t = await findTemplate(ref);
        const b = t.boxes.find((x) => x.id === rest[0] || x.label === rest[0]);
        if (!b) fail(`no step ${rest[0]} in ${t.id}`, 404);
        boxFlags(b, pairs(rest.slice(1)));
        return save(t, `Step ${b.id} changed.`);
      }
      case 'move': {
        const t = await findTemplate(ref);
        const from = t.boxes.findIndex((x) => x.id === rest[0] || x.label === rest[0]);
        if (from < 0) fail(`no step ${rest[0]} in ${t.id}`, 404);
        const to = Math.max(0, Math.min(t.boxes.length - 1, Number(rest[1]) - 1));
        if (!Number.isInteger(to)) fail('give the new position as a number');
        const [b] = t.boxes.splice(from, 1);
        t.boxes.splice(to, 0, b);
        return save(t, `Moved ${b.id} to step ${to + 1}.`);
      }
      case 'remove': {
        const t = await findTemplate(ref);
        const i = t.boxes.findIndex((x) => x.id === rest[0] || x.label === rest[0]);
        if (i < 0) fail(`no step ${rest[0]} in ${t.id}`, 404);
        const [b] = t.boxes.splice(i, 1);
        return save(t, `Removed ${b.id}.`);
      }
      case 'save': {
        let t;
        try {
          t = JSON.parse(opt['json-in'] ?? opt.json);
        } catch {
          fail('give the template as --json-in \'{…}\'');
        }
        return save({ ...t, id: ref }, 'Template saved.');
      }
      case 'delete': {
        const t = await findTemplate(ref);
        await deleteTemplate(t.id);
        return { json: { ok: true }, text: `Template ${t.id} deleted. Runs made from it stay.` };
      }
      default:
        fail('template show|new|copy|set|add|box|move|remove|save|delete');
    }
  },

  async skills(r, { pos }) {
    const words = pos.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
    const list = (await scanSkills()).filter((s) => words.every((w) => `${s.name} ${s.description || ''}`.toLowerCase().includes(w)));
    return {
      json: list,
      text: table(list, [['Skill', (s) => s.name], ['From', (s) => s.source], ['Writes to Teamspace/vault', (s) => (s.tracks ? `yes${s.mark ? ' (your mark)' : ''}` : s.mark === 'clean' ? 'no (your mark)' : 'no')], ['What it does', (s) => short((s.description || '').replace(/\s+/g, ' '), 90)]]),
    };
  },

  async 'skill-mark'(r, { pos }) {
    await setMark(pos[0], pos[1]);
    const s = (await scanSkills()).find((x) => x.name === pos[0]);
    return { json: s, text: `${pos[0]}: ${s?.tracks ? 'counts as writing to Teamspace or the vault' : 'counts as clean'} (${pos[1]}).` };
  },

  async repos() {
    const list = listRepos({ fresh: true });
    return { json: list, text: table(list, [['Repo', (x) => x.token], ['Folder', (x) => x.dir], ['Cloned', (x) => (x.cloned ? 'yes' : 'no')], ['Starts from', (x) => x.defaultBase || '']]) };
  },

  async suggestions(r, { opt }) {
    const all = await listSuggestions();
    const list = opt.all ? all : all.filter((s) => s.status === 'new');
    const line = (s) => `[${s.id}] ${s.kind === 'rule' ? 'Rule' : 'Workflow'}: ${s.text}\n    why: ${s.why || ''}${s.templateName ? `  (from ${s.templateName}: ${s.input || ''})` : ''}${opt.all ? `  · ${s.status}${s.appliedAt ? `, applied to ${s.appliedTo}` : ''}` : ''}`
      + (s.kind === 'workflow' && !s.appliedAt && s.status !== 'rejected' ? `\n    change: ${s.change ? changeCommand(s.change, s.templateId) : '(none saved; give it with --change)'}` : '');
    // Accepted workflow changes that never reached their template: listed until they do.
    const owed = opt.all ? [] : notApplied(all);
    const text = [list.length ? list.map(line).join('\n') : 'No lessons waiting.'];
    if (owed.length) text.push('', 'Accepted, not in the template yet (apply: suggestion <id> apply):', ...owed.map(line));
    return { json: list, text: text.join('\n') };
  },

  // accept | reject | apply. A workflow change reaches its template only with --apply (or apply later).
  async suggestion(r, { pos, opt }) {
    const [id, action] = pos;
    if (action === 'apply') {
      let s = (await listSuggestions()).find((x) => x.id === id) || fail('suggestion not found', 404);
      if (s.kind !== 'workflow') fail('only a workflow change can be applied; a rule works once accepted');
      if (s.status === 'rejected') fail('this suggestion was rejected', 409);
      if (s.status === 'new') s = await decide(id, { action: 'accept', text: typeof opt.text === 'string' ? opt.text : undefined });
      return applySuggestion(r, s, opt);
    }
    const s = await decide(id, { action, text: typeof opt.text === 'string' ? opt.text : undefined });
    if (s.kind === 'workflow' && s.status === 'accepted') {
      if (opt.apply) return applySuggestion(r, s, opt);
      const how = s.change ? `The change: ${changeCommand(s.change, s.templateId)}\nApply it: suggestion ${s.id} apply` : `No exact change was saved. Apply it with: suggestion ${s.id} apply --change '{"op":"box","box":"<step>","wait":"on"}'`;
      return { json: s, text: `accepted: ${s.text}\nNot in the template yet. ${how}` };
    }
    return { json: s, text: `${s.status}: ${s.text}${s.status === 'accepted' && s.kind === 'rule' ? ' (added to your rules)' : ''}` };
  },

  async rules(r, { opt }) {
    if (typeof opt.set === 'string') await saveInstructions(opt.set);
    if (typeof opt.add === 'string') {
      const now = await getInstructions();
      await saveInstructions(`${now.replace(/\s*$/, '')}${now.trim() ? '\n' : ''}- ${opt.add.trim()}\n`);
    }
    const text = await getInstructions();
    return { json: { text }, text: text.trim() || '(no rules yet)' };
  },

  async stats(r) {
    const s = computeStats(r.list());
    const t = s.totals;
    const text = [
      `Runs: ${t.runs} (${t.done} done, ${t.failed} failed) · spend ${money(t.cost)} (7 days ${money(t.cost7d)}, today ${money(t.costToday)}). Costs are estimates at API prices.`,
      'Runs before 2026-11-01 may show the cost before a reopen twice (fixed since).',
      '',
      'Templates:',
      table(s.templates, [['Template', (x) => x.name], ['Runs', (x) => x.runs], ['Done', (x) => x.done], ['Failed', (x) => x.failed], ['Spend', (x) => money(x.cost)], ['Avg per done run', (x) => money(x.avgCost)], ['Avg AI time', (x) => dur(x.avgWorkMs)]]),
      '',
      'Skills (most failures first):',
      table(s.skills.slice(0, 15), [['Skill', (x) => x.skill], ['Ran', (x) => x.boxes], ['Tries', (x) => x.tries], ['Failed', (x) => x.failures], ['Avg cost', (x) => money(x.avgCost)], ['Avg time', (x) => dur(x.avgMs)], ['Last error', (x) => short(x.lastError || '', 50)]]),
      '',
      'Recent runs:',
      table(s.history.slice(0, 10), [['When', (x) => ago(x.createdAt)], ['Template', (x) => x.templateName], ['Input', (x) => short(x.input.replace(/\s+/g, ' '), 40)], ['Status', (x) => x.status], ['Cost', (x) => money(x.cost)]]),
    ].join('\n');
    return { json: s, text };
  },

  async settings(r, { pos }) {
    const p = pairs(pos);
    const patch = {};
    if (p.max !== undefined) patch.maxRunning = Number(p.max);
    if (p.learn !== undefined) patch.learn = onOff(p.learn, 'learn');
    if (p.cleanup !== undefined) fail('clean-up happens only when you say so now: clean <run>, clean --done, or clean --stale');
    if (p.pane !== undefined) patch.pane = onOff(p.pane, 'pane');
    if (p.panesize !== undefined) patch.paneSize = Number(String(p.panesize).replace(/%$/, ''));
    const s = Object.keys(patch).length ? await r.setSettings(patch) : r.getSettings();
    return { json: s, text: `Runs working at once: ${s.maxRunning} · lessons after each run: ${s.learn !== false ? 'on' : 'off'} · steps pane in run tabs: ${s.pane !== false ? `on (${s.paneSize || 30}% wide)` : 'off'}` };
  },

  async help() {
    return { json: { help: HELP }, text: HELP };
  },
};

// ---------- watch: the steps pane in a run's tab ----------

const ICONS = { done: ['✓', 32], running: ['●', 33], question: ['?', 36], approval: ['?', 36], failed: ['✗', 31] };
const paint = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
// The pinned box needs at least this many lines; with less room the steps fold up.
const MIN_PIN_ROWS = 6;

// Screen columns of one character: wide (CJK, emoji like ✅ ❌ 🚀) take 2, joiners and variation marks 0.
function charCols(ch) {
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
const cols = (s) => Array.from(String(s)).reduce((n, ch) => n + charCols(ch), 0);
// The start of s that fits in w columns (never splits a character). Returns [head, rest].
function cutCols(s, w) {
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
function wrapLine(text, w, lead = '') {
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
function pinLines(text, width) {
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

// One screen of the pane: the run, its steps (done / working now / to come), what it needs, and the pinned box.
// rows = 0 means no limit (orch watch --once without --rows). view = { pin: 1-based, newest first; scroll }.
// Returns { lines, pin (the shown pin's id), scroll (clamped), page (pin lines per screen) }.
function watchFrame(r, width, rows = 0, view = { pin: 1, scroll: 0 }) {
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
    const flags = [b.waitAfter && 'wait', b.usesApp && 'app', b.walkthrough && 'explain', b.fresh && 'fresh', b.model, b.effort].filter(Boolean).join(' ');
    const time = b.status === 'running' && b.startedAt ? dur(Date.now() - Date.parse(b.startedAt)) : b.status === 'done' ? dur(b.durationMs) : '';
    const text = `${i + 1} ${b.label}${flags ? `  ${flags}` : ''}${time ? `  ${time}` : ''}`;
    return b.status === 'pending' ? paint(2, fit(`${icon} ${text}`)) : iconLine(icon, color, text);
  };
  // The steps folded: done ones in one line, the current one and the next two.
  const folded = () => {
    const cur = r.boxes.findIndex((b) => b.status !== 'done');
    if (cur < 0) return [iconLine('✓', 32, `all ${r.boxes.length} steps done`)];
    const out = [];
    if (cur > 0) out.push(iconLine('✓', 32, `1–${cur} done`));
    r.boxes.slice(cur, cur + 3).forEach((b, k) => out.push(stepLine(b, cur + k)));
    const rest = r.boxes.length - cur - 3;
    if (rest > 0) out.push(paint(2, fit(`○ +${rest} more`)));
    return out;
  };
  const head = (steps, about = 5, now = 99) => {
    const out = [paint(1, fit(tabTitle(r)))];
    if (r.about) out.push(...wrap(r.about).slice(0, about).map((l) => l.slice(2)));
    out.push(paint(2, fit(r.templateName)), fit(`${r.status} · ${money(r.cost)}`), '', ...steps);
    out.push('', 'Now:', ...wrap(why(r)).slice(0, now));
    if (r.status === 'waiting' || r.status === 'needs-you') out.push('', paint(36, fit('Type next or redo on the left.')));
    return out;
  };

  let top = head(r.boxes.map(stepLine));
  if (!pins.length) {
    const hint = paint(2, fit('Type pin on the left to keep'));
    const hint2 = paint(2, fit("Claude's last answer here."));
    if (!rows || top.length + 3 <= rows) top.push('', hint, hint2);
    return { lines: rows ? top.slice(0, rows) : top, pin: null, scroll: 0, page: 0 };
  }
  // Pinned box: a title line, the text, a hint line. It gets the room it needs, up to MIN_PIN_ROWS, before the steps
  // fold up (and, in a very short pane, get cut).
  const n = Math.min(Math.max(1, view.pin || 1), pins.length);
  const pin = pins[n - 1];
  const body = pinLines(pin.text, w);
  const need = 2 + Math.min(MIN_PIN_ROWS, body.length);
  if (rows && top.length + need > rows) top = head(folded(), 2, 3);
  if (rows && top.length + need > rows) top = top.slice(0, Math.max(1, rows - need));
  const page = rows ? Math.max(1, rows - top.length - 2) : body.length;
  const scroll = Math.min(Math.max(0, view.scroll || 0), Math.max(0, body.length - page));
  const label = ` Pinned${pins.length > 1 ? ` ${n}/${pins.length}` : ''} · ${pin.title} `;
  const title = paint(36, fit(`──${label}${'─'.repeat(Math.max(0, w - cols(label) - 2))}`));
  const shown = body.slice(scroll, scroll + page);
  const more = body.length > page;
  const hint = [more && (scroll + page < body.length ? `↓ ${body.length - scroll - page} more` : 'end'), more && '↑↓ scroll', pins.length > 1 && '←→ pins']
    .filter(Boolean)
    .join(' · ');
  const lines = [...top, title, ...shown];
  if (rows && hint) while (lines.length < rows - 1) lines.push('');
  if (hint) lines.push(paint(2, fit(hint)));
  return { lines: rows ? lines.slice(0, rows) : lines, pin: pin.id, scroll, page };
}

// Redraws the pane every 2 seconds from the run's file (no lock: it only reads), and at once on a key.
// Keys (click the pane first): ↑ ↓ PgUp PgDn Home End and the mouse wheel scroll the pin; ← → show older / newer pins.
// It writes the pin it shows to pane.json, so `unpin` in the tab removes that one.
// Ends when the run's tab closes, so the split pane closes with it. --once prints one screen (--rows/--cols/--pin/--scroll).
async function watch(ref, once, size = {}) {
  let id = ref;
  if (!isSafeId(id) || !fs.existsSync(path.join(runDir(id), 'state.json'))) id = await withRunner((r) => findRun(r, ref).id);
  const file = path.join(runDir(id), 'state.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const MOUSE = '\x1b[?1000h\x1b[?1006h';
  const NO_MOUSE = '\x1b[?1000l\x1b[?1006l';
  const tty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(`${tty ? NO_MOUSE : ''}\x1b[?7h\x1b[?25h`);
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
    process.stdout.write(MOUSE); // the wheel comes as mouse events (select text with Shift + drag)
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
      // Mouse wheel (SGR): ESC [ < 64 ; x ; y M is up, 65 is down. Clicks are left alone.
      for (const m of s.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) {
        if (m[1] === '64') scrollBy(-3);
        else if (m[1] === '65') scrollBy(3);
      }
      const rest = s.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '');
      for (const k of rest.match(/\x1b\[[\d;]*[~A-Za-z]|\x1bO[A-Z]|[\s\S]/g) || []) KEYS[k]?.();
    });
  }
  process.on('exit', restore);
  process.stdout.on('resize', draw);
  for (;;) {
    const now = read();
    if (now === 'gone') {
      restore();
      return console.log('This run was deleted.');
    }
    if (now) {
      r = now;
      draw();
      const s = r.session;
      const gone = !s?.open || (s.pid ? !alive(s.pid) : Date.now() - Date.parse(s.openedAt || 0) > 3 * 60 * 1000);
      if (gone) return restore();
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}

// ---------- main ----------

const { pos, opt } = parse(process.argv.slice(2));
const name = pos.shift() || 'status';
const json = opt.json === true;
const cmd = commands[name];
try {
  if (name === 'watch') {
    await watch(pos[0] || fail('name a run to watch'), !!opt.once, { rows: Number(opt.rows) || 0, cols: Number(opt.cols) || 0, pin: Number(opt.pin) || 1, scroll: Number(opt.scroll) || 0 });
    process.exit(0);
  }
  if (!cmd) fail(`unknown command: ${name}\n\n${HELP}`);
  const out = await withRunner((r) => cmd(r, { pos, opt }));
  process.stdout.write((json ? JSON.stringify(out.json, null, 1) : out.text) + '\n');
  process.exit(0);
} catch (err) {
  const msg = err.message || String(err);
  if (json) process.stdout.write(JSON.stringify({ error: msg, status: err.status || 500, uncommitted: err.uncommitted }) + '\n');
  else process.stderr.write(`Error: ${msg}\n`);
  process.exit(err.status === 404 ? 4 : err.status === 409 ? 3 : 1);
}
