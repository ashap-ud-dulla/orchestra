// Every orch command in one list: its words, its options, one line on what it does. The help, the option checks
// ("did you mean …?") and the parser all come from here, so they cannot disagree.
//
// Options are written key=value (wait=on, model=opus, force=yes). The old --key forms still work, unlisted.
// A yes/no option may also be a bare word where the list says so (runs all, clean done).

// v: takes a value · b: yes/no (key=yes|no, or --key) · o: on/off kept as written (--key alone: on)
const STEP_OPTS = { after: 'v', at: 'v', to: 'v', label: 'v', args: 'v', wait: 'o', app: 'o', explain: 'o', fresh: 'o', model: 'v', effort: 'v' };

export const COMMANDS = [
  { group: 'Runs' },
  { name: 'status', usage: 'status', about: 'what is working and what needs you' },
  { name: 'runs', usage: 'runs [all]', about: 'the board: every run, the ones that need you first (all: cleaned runs too)', opts: { all: 'b' }, words: ['all'] },
  { name: 'run', usage: 'run <run> [full=yes]', about: 'one run: what it does now and its steps (full: notes, PR links, activity)', opts: { full: 'b' } },
  { name: 'start', free: true, usage: 'start <template> <ticket or "job">... [repos=api,webclient|none] [base=api=origin/x] [draft=yes] [again=yes]', about: 'one run per ticket (or quoted job). again: a ticket that has a run already. draft: start it later with start <run>', opts: { text: 'v', repos: 'v', base: 'v', draft: 'b', again: 'b' } },
  { name: 'reopen', usage: 'reopen <run>|all', about: "reopen a stopped run's tab, on the same conversation" },
  { name: 'stop', usage: 'stop <run>', about: "close a run's tab, or take it out of the queue" },
  { name: 'next', usage: 'next|skip|redo <run>', about: 'the same as typing it in the run\'s tab (its claude restarts on the same conversation to get it)' },
  { name: 'skip', hidden: true },
  { name: 'redo', hidden: true },
  { name: 'go', free: true, usage: 'go <run> <step> [why]', about: 'go to any step. Back: it and the steps after it run again (what they did before stays as history). Forward: the steps between are skipped (a handover: go to wrap-up)' },
  { name: 'back', free: true, hidden: true },
  { name: 'jump', free: true, hidden: true },
  { name: 'model', usage: 'model <run> [opus|sonnet|…] [effort=high]', about: 'the model and effort of the step the run is on (this run only; none clears)', opts: { model: 'v', effort: 'v' } },
  { name: 'steps', usage: 'steps <run|template> [show]', about: 'the steps of a run or a template, and changing them:', opts: { ...STEP_OPTS, set: 'v' } },
  { usage: '  … add <skill> [after=<step>|at=N] [label=…] [wait=on] [app=on] [explain=on] [fresh=on] [model=…] [effort=…]' },
  { usage: '  … set <step> label=… args=… wait=on|off app=on|off explain=on|off fresh=on|off model=… effort=…' },
  { usage: '  … remove <step> · … move <step> to=N', about: 'a run keeps its finished steps; the template never changes with it' },
  { name: 'about', free: true, usage: 'about <run> ["text"]', about: 'what the ticket is about (the run says it by itself; set it here)' },
  { name: 'pin', free: true, usage: 'pin <run> ["text"] [title=…]', about: "pin text to the run's pane (no text: show its pins in full)", opts: { title: 'v' } },
  { name: 'unpin', usage: 'unpin <run> [N|all]', about: 'remove pin N as the pane numbers it (1 = newest)' },
  { name: 'watch', usage: 'watch <run> [once=yes]', about: "the run's steps and pins, redrawn live (the pane in its tab)", opts: { once: 'b', rows: 'v', cols: 'v', pin: 'v', scroll: 'v' } },
  { name: 'timeline', usage: 'timeline <run> [limit=N]', about: "the run's log and activity", opts: { limit: 'v' } },
  { name: 'clean', usage: 'clean <run>|done|stale [force=yes]', about: 'free the space: stop what runs from its folder, remove the folder and its conversations (branches, notes, stats stay). done: every finished run · stale: runs left alone 7+ days', opts: { force: 'b', done: 'b', stale: 'b', auto: 'b', merged: 'b' }, words: ['done', 'stale'] },
  { name: 'disk', usage: 'disk', about: 'the space each run folder takes' },
  { name: 'delete', usage: 'delete <run> [force=yes]', about: 'remove the run completely (it also leaves stats)', opts: { force: 'b' } },
  { name: 'lessons', usage: 'lessons <run>', about: 'look for lessons in a run now', opts: { auto: 'b' } },

  { group: 'The app' },
  { name: 'app', usage: 'app [status] | release <run>', about: 'who has the app, who waits for it, whose code it serves; release takes it from a run' },
  { usage: 'app start [services=a,b] [with=outsider] [without=mission] [force=yes]', about: 'the app for you, from your own checkout (refused while a run has it)' },
  { usage: 'app stop | restart | wait | logs [service]', about: 'your app' },

  { group: 'Templates and skills' },
  { name: 'templates', usage: 'templates', about: 'list templates' },
  { name: 'template', usage: 'template show|delete <id>', about: 'a template (its steps: steps <id>)', opts: { name: 'v', tracking: 'v', repos: 'v', model: 'v', effort: 'v', file: 'v', 'json-in': 'v', ...STEP_OPTS, skill: 'v' } },
  { usage: 'template new <id> <first-skill> [name=…] [tracking=on|off] [repos=api,webclient]' },
  { usage: 'template copy <id> <new-id> [name=…] · template set <id> name=… tracking=on|off repos=… model=… effort=…' },
  { usage: 'template save <id> file=<template.json>', about: 'a whole template from a file' },
  { name: 'skills', free: true, usage: 'skills [words]', about: 'find skills (name, what it does, tracking mark)' },
  { name: 'skill-mark', usage: 'skill-mark <skill> auto|writes|clean', about: "correct a skill's tracking mark" },
  { name: 'repos', usage: 'repos', about: 'the repos a run can use' },

  { group: 'Lessons, stats, settings' },
  { name: 'suggestions', usage: 'suggestions [all]', about: 'lessons waiting for your yes or no', opts: { all: 'b' }, words: ['all'] },
  { name: 'suggestion', usage: 'suggestion <id> accept|reject|apply [text=…] [apply=yes] [template=<id>]', about: 'decide on a lesson; apply=yes also changes its template now', opts: { text: 'v', apply: 'b', change: 'v', template: 'v' } },
  { name: 'rules', usage: 'rules [set="…" | add="…"]', about: 'your rules (every run follows them)', opts: { set: 'v', add: 'v' } },
  { name: 'stats', usage: 'stats', about: 'spend, templates, skills, recent runs' },
  { name: 'settings', usage: 'settings [max=N] [learn=on|off] [pane=on|off] [panesize=15..70] [launcher=apphost|runstack]', about: 'runs at once, lessons after runs, the steps pane, how the app starts', opts: { max: 'v', learn: 'v', pane: 'v', panesize: 'v', launcher: 'v', cleanup: 'v' } },
  { name: 'setup', usage: 'setup [solution=<folder>|none] [worktrees=<folder>] [email=…] [uninstall=yes]', about: 'first time on a PC, and after a pull: your solution folder (optional) and its pack, starter templates, skills, missing tools. uninstall: remove what it added', opts: { solution: 'v', itp: 'v', email: 'v', worktrees: 'v', uninstall: 'b' } },
  { name: 'help', usage: 'help', about: 'this list' },
  { name: 'tick', hidden: true },
  { name: 'learn', hidden: true, opts: { auto: 'b' } },
  { name: 'boxes', hidden: true, opts: { set: 'v' } },
];

const GLOBAL = { json: 'b' };
// Options whose value never has spaces (see parse: a quoted job like "repos=api is broken" stays text).
const NO_SPACES = new Set(['repos', 'base', 'draft', 'again', 'title', 'after', 'at', 'to', 'wait', 'app', 'explain', 'fresh', 'model', 'effort', 'force', 'full', 'all', 'json']);
export const BY_NAME = new Map(COMMANDS.filter((c) => c.name).map((c) => [c.name, c]));
// skip and redo take the same options as next.
for (const n of ['skip', 'redo']) Object.assign(BY_NAME.get(n), { opts: {} });

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

// The closest word (at most 2 letters off), for "did you mean …?".
export function closest(word, words) {
  const w = String(word || '').toLowerCase();
  let best = null;
  let bestD = 3;
  for (const c of words) {
    const d = distance(w, c.toLowerCase());
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length];
}
export const didYouMean = (word, words) => {
  const c = closest(word, words);
  return c ? ` Did you mean ${c}?` : '';
};

const yesNo = (v, key) => {
  if (v === true || /^(on|yes|true|1)$/i.test(v)) return true;
  if (/^(off|no|false|0)$/i.test(v)) return false;
  fail(`${key} must be yes or no (or on/off)`);
};

// Reads the command line: the command, its words (pos) and options (opt). Unknown options are refused.
// key=value words become options when the command knows the key; a word that looks like an option but is not one
// is refused with the command's options. --key and --key value (the old way) still work.
export function parse(argv) {
  const words = [...argv];
  let name = words[0] && !words[0].startsWith('--') ? words.shift() : 'status';
  const spec = BY_NAME.get(name);
  const known = { ...GLOBAL, ...(spec?.opts || {}) };
  const pos = [];
  const opt = {};
  const valid = () => Object.keys(spec?.opts || {}).filter((k) => !['auto', 'merged', 'set', 'json-in', 'skill', 'cleanup', 'text', 'change'].includes(k));
  const unknown = (key) => fail(`${name} has no option "${key}".${didYouMean(key, Object.keys(known))}${valid().length ? ` Its options: ${valid().join(', ')}.` : ''}`);
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    let key;
    let val;
    if (a.startsWith('--') && a.length > 2) {
      [key, val] = a.slice(2).split(/=(.*)/s);
      if (!(key in known)) {
        if (!spec) continue; // an unknown command: said below
        unknown(key);
      }
      if (val === undefined && known[key] === 'o') val = 'on';
      if (val === undefined && known[key] === 'v') {
        if (i + 1 < words.length && !words[i + 1].startsWith('--')) val = words[++i];
        else fail(`--${key} needs a value: ${key}=…`);
      }
    } else {
      const m = /^([a-z][a-z0-9-]{0,20})=(.*)$/is.exec(a);
      if (!m) {
        pos.push(a);
        continue;
      }
      key = m[1].toLowerCase();
      val = m[2];
      if (!(key in known)) {
        if (!spec) continue;
        // A command that takes text in words (a job, a note): "VAT=0 rows break" is text, not a wrong option.
        if (spec.free || /\s/.test(a)) {
          pos.push(a);
          continue;
        }
        unknown(key);
      }
      // A known key with text that has spaces, for a command that takes text and an option that never has spaces
      // ("repos=api is broken" as a job): text.
      if (spec?.free && /\s/.test(val) && NO_SPACES.has(key)) {
        pos.push(a);
        continue;
      }
    }
    opt[key] = known[key] === 'b' ? yesNo(val ?? true, key) : val;
  }
  // Bare words that stand for a yes/no option: runs all, clean done.
  for (const w of spec?.words || []) {
    const i = pos.findIndex((p) => p.toLowerCase() === w);
    if (i >= 0 && !(w === 'all' && name === 'reopen')) {
      pos.splice(i, 1);
      opt[w] = true;
    }
  }
  return { name, pos, opt };
}

// The help, from the list.
export function helpText() {
  const out = ['Orchestra commands. Type them after /orch (or: node bin/orch.mjs <command>). Options are key=value.'];
  const W = 44;
  const wrap = (text, width) => {
    const lines = [];
    let cur = '';
    for (const w of String(text).split(' ')) {
      if (cur && cur.length + 1 + w.length > width) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  for (const c of COMMANDS) {
    if (c.hidden) continue;
    if (c.group) {
      out.push('', `${c.group}:`);
      continue;
    }
    const about = c.about ? wrap(c.about, 70) : [];
    if (c.usage.length <= W - 3) {
      out.push(`  ${c.usage.padEnd(W - 2)}${about[0] || ''}`.trimEnd());
      for (const l of about.slice(1)) out.push(`${' '.repeat(W)}${l}`);
    } else {
      out.push(`  ${c.usage}`);
      for (const l of about) out.push(`${' '.repeat(W)}${l}`);
    }
  }
  out.push('', 'A <run> is a Jira key (ITP2-14852), words from its name ("sweden row"), or the end of its id.');
  out.push('In a run\'s tab: next · skip · redo · /orch go <step> [why] · /orch model opus effort=high · pin · unpin · /orch help');
  return out.join('\n');
}

// Commands a run's tab may show (/orch runs in a tab): they only read.
export const READ_ONLY = new Set(['status', 'runs', 'run', 'timeline', 'templates', 'skills', 'repos', 'suggestions', 'rules', 'stats']);

// The command names, for "unknown command".
export const commandNames = () => COMMANDS.filter((c) => c.name && !c.hidden).map((c) => c.name);
