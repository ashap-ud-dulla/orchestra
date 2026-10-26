// Orchestra page: home board, templates, and the editor (skill menu + canvas + box settings + chat).
// Plain JS, no libraries. The server is the source of truth; live changes come in over SSE.
'use strict';

const state = {
  runs: new Map(),
  templates: [],
  skills: [],
  repos: [], // ITP repos a run can get worktrees of
  settings: { maxRunning: 2 },
  copyFrom: null, // a template to open as "… (copy)" in the editor
  route: { name: 'board' },
  ed: null, // the open editor: { kind: 'run'|'template', id, tpl?, dirty?, sel, timeline, filter }
};

const SOURCES = { team: 'Team skills', mine: 'My ITP skills', global: 'My global skills', orchestra: 'Orchestra test skills' };
const NEEDS_YOU = new Set(['question', 'approval', 'waiting', 'failed', 'stopped', 'draft']);
// The marker lines the AI ends a reply with. Orchestra reads them; people do not need to see them.
const unmark = (t) => String(t ?? '').replace(/\n?[\s*`_]*ORCHESTRA:(?:QUESTION|APPROVAL)[\s*`_]*$/, '');
const pushes = (b) => [...new Set((b?.approval?.requests || []).map((r) => r.command))];

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${(n || 0).toFixed((n || 0) >= 1 ? 2 : 4)}`;
const tokens = (t) => (t ? `${(t.input || 0).toLocaleString()} in · ${(t.output || 0).toLocaleString()} out` : '');

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function duration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function fail(err) {
  alert(err.message || err);
}

// A safe, unique id made from a name: letters, digits, - and _.
function slug(name, taken) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 50) || 'box';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// ---------- routing ----------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'run' && parts[1]) return { name: 'run', id: parts[1] };
  if (parts[0] === 'template' && parts[1]) return { name: 'template', id: parts[1] };
  if (parts[0] === 'templates') return { name: 'templates' };
  if (parts[0] === 'skills') return { name: 'skills' };
  return { name: 'board' };
}

async function onRoute() {
  state.route = parseRoute();
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('on', a.dataset.nav === state.route.name || (a.dataset.nav === 'templates' && state.route.name === 'template'));
  }
  state.ed = null;
  const { name, id } = state.route;
  if (name === 'board') return renderBoard();
  if (name === 'templates') return renderTemplates();
  if (name === 'skills') return renderSkillMarks();
  if (name === 'run') {
    state.ed = { kind: 'run', id, sel: null, timeline: [], filter: '' };
    mountEditor();
    loadTimeline();
    return;
  }
  if (name === 'template') {
    let tpl;
    if (id === 'new' && state.copyFrom) {
      tpl = { ...structuredClone(state.copyFrom), id: '', name: `${state.copyFrom.name} (copy)` };
      state.copyFrom = null;
    } else if (id === 'new') tpl = { id: '', name: 'New template', tracking: true, boxes: [] };
    else {
      try {
        tpl = await api('GET', `/api/templates/${encodeURIComponent(id)}`);
      } catch (err) {
        $('#view').innerHTML = `<div class="page err">${esc(err.message)}</div>`;
        return;
      }
    }
    state.ed = { kind: 'template', id, tpl: structuredClone(tpl), dirty: id === 'new', sel: null, filter: '' };
    mountEditor();
  }
}

// ---------- board ----------

// Queued runs, next first. Same order as the server's queue.
function queue() {
  const t = (r) => r.queuedAt || r.createdAt;
  return [...state.runs.values()].filter((r) => r.status === 'queued').sort((a, b) => t(a).localeCompare(t(b)));
}

function renderBoard() {
  // Do not redraw while you change the limit, or the box loses your typing.
  if ($('#max-running') && document.activeElement === $('#max-running')) return;
  const runs = [...state.runs.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const cols = [
    ['Queued', queue()],
    ['Running', runs.filter((r) => r.status === 'running')],
    ['Needs you', runs.filter((r) => NEEDS_YOU.has(r.status))],
    ['Done', runs.filter((r) => r.status === 'done').slice(0, 50)],
  ];
  $('#view').innerHTML = `<div class="board-wrap">
    <div class="board-bar">
      <label class="check">Runs working at once <input type="number" id="max-running" min="1" max="20" value="${state.settings.maxRunning}"></label>
      <span class="muted small">More runs wait in Queued and start by themselves, oldest first. Runs that wait for you do not count.</span>
    </div>
    <div class="board">${cols.map(([title, list]) => `
    <section class="col">
      <h3><span>${title}</span><span>${list.length}</span></h3>
      <div class="cards">${list.map(card).join('') || '<div class="empty">Nothing here.</div>'}</div>
    </section>`).join('')}</div>
  </div>`;
}

function card(r) {
  const label = (id) => r.boxes.find((b) => b.id === id)?.label || id;
  const working = r.boxes.find((b) => b.status === 'running');
  let why = '';
  if (r.status === 'waiting') why = `<div class="why">Waiting for you after “${esc(label(r.waitingAfter))}”</div>`;
  else if (r.status === 'failed') why = `<div class="why bad">${esc((r.error || 'Failed').slice(0, 160))}</div>`;
  else if (r.status === 'stopped') why = '<div class="why">Stopped by you</div>';
  else if (r.status === 'question') why = `<div class="why">Asks you: ${esc(unmark(r.boxes.find((b) => b.status === 'question')?.question).slice(0, 140))}</div>`;
  else if (r.status === 'approval') why = `<div class="why">Wants to push: ${esc(pushes(r.boxes.find((b) => b.status === 'approval')).join('; ').slice(0, 140) || 'see the run')}</div>`;
  else if (r.status === 'draft') why = '<div class="why">Draft: check the boxes, then press Start</div>';
  else if (working) why = `<div class="why muted">Working on “${esc(working.label)}”</div>`;
  else if (r.status === 'queued') why = `<div class="why muted">Number ${queue().indexOf(r) + 1} in line</div>`;
  const queued = (r.chat || []).filter((m) => m.status === 'queued' || m.status === 'working').length;
  return `<a class="card" href="#/run/${encodeURIComponent(r.id)}">
    <div class="title"><span>${esc(r.templateName)}</span><span class="chip ${esc(r.status)}">${esc(r.status)}</span></div>
    <div class="input">${esc(r.input?.text || '(no input)')}</div>
    <div class="dots">${r.boxes.map((b) => `<span class="dot ${esc(b.status)}" title="${esc(b.label)}: ${esc(b.status)}"></span>`).join('')}</div>
    ${why}
    <div class="meta"><span>${money(r.cost)}${queued ? ` · ${queued} message${queued > 1 ? 's' : ''} waiting` : ''}</span><span>${ago(r.updatedAt)}</span></div>
  </a>`;
}

// ---------- templates ----------

async function renderTemplates() {
  await loadTemplates();
  $('#view').innerHTML = `<div class="page">
    <div class="row"><h1 class="grow">Templates</h1><a href="#/template/new"><button class="primary">New template</button></a></div>
    <div class="list">${state.templates.map((t) => `
      <div class="item">
        <div class="grow"><b>${esc(t.name)}</b><div class="muted small">${t.boxes.map((b) => esc(b.label || b.skill)).join(' → ')}</div></div>
        <span class="chip ${t.tracking === false ? 'draft' : 'done'}">tracking ${t.tracking === false ? 'off' : 'on'}</span>
        <a href="#/template/${encodeURIComponent(t.id)}"><button>Edit</button></a>
        <button data-act="duplicate-template" data-id="${esc(t.id)}">Duplicate</button>
        <button data-start="${esc(t.id)}">Start…</button>
      </div>`).join('') || '<div class="empty">No templates yet.</div>'}</div>
  </div>`;
}

async function loadTemplates() {
  state.templates = await api('GET', '/api/templates').catch(() => []);
}

// ---------- skills page: which skills write to Teamspace or the vault ----------

const skillFilter = { text: '', onlyWrites: false };

function renderSkillMarks() {
  // Do not redraw under the cursor while you type in the search box.
  if (document.activeElement?.id === 'marks-filter') return renderSkillMarkRows();
  $('#view').innerHTML = `<div class="page">
    <div class="row"><h1 class="grow">Skills</h1></div>
    <p class="muted small">A template with <b>tracking OFF</b> hides the skills marked “Writes” below, and its runs may not call Teamspace or write to the vault (ITPKV).
      Orchestra guesses the mark from each skill’s text. If a guess is wrong, pick your own mark. Your marks are saved in <code>data/skill-marks.json</code>.</p>
    <div class="row">
      <input type="search" id="marks-filter" placeholder="Find a skill" value="${esc(skillFilter.text)}">
      <label class="check"><input type="checkbox" id="marks-only" ${skillFilter.onlyWrites ? 'checked' : ''}> Only skills marked “Writes”</label>
      <span class="grow"></span><span class="muted small" id="marks-count"></span>
    </div>
    <div class="list" id="marks-list"></div>
  </div>`;
  renderSkillMarkRows();
}

function renderSkillMarkRows() {
  const el = $('#marks-list');
  if (!el) return;
  const f = skillFilter.text.toLowerCase();
  const list = state.skills.filter((s) => (!f || s.name.toLowerCase().includes(f)) && (!skillFilter.onlyWrites || s.tracks));
  $('#marks-count').textContent = `${state.skills.filter((s) => s.tracks).length} of ${state.skills.length} skills marked “Writes”`;
  el.innerHTML = list.map((s) => `
    <div class="item">
      <div class="grow"><b>/${esc(s.name)}</b> <span class="muted small">${esc(SOURCES[s.source] || s.source)}</span>
        <div class="muted small">Guess: ${s.tracksAuto ? `writes. It ${esc(s.why.join(', '))}.` : 'does not write (no sign found).'}</div></div>
      <span class="chip ${s.tracks ? 'failed' : 'done'}">${s.tracks ? 'writes' : 'clean'}</span>
      <select data-mark="${esc(s.name)}" title="Your mark">
        <option value="auto" ${!s.mark ? 'selected' : ''}>Use the guess</option>
        <option value="writes" ${s.mark === 'writes' ? 'selected' : ''}>Writes</option>
        <option value="clean" ${s.mark === 'clean' ? 'selected' : ''}>Does not write</option>
      </select>
    </div>`).join('') || '<div class="empty">No skills match.</div>';
}

// Tracking is OFF for the open template or run.
function trackingOff() {
  if (!state.ed) return false;
  return (state.ed.kind === 'run' ? edRun()?.tracking : state.ed.tpl.tracking) === false;
}

const tracksSkill = (name) => !!state.skills.find((s) => s.name === name)?.tracks;

// ---------- editor ----------

function edRun() {
  return state.ed?.kind === 'run' ? state.runs.get(state.ed.id) : null;
}

function edBoxes() {
  return state.ed.kind === 'run' ? edRun()?.boxes || [] : state.ed.tpl.boxes;
}

// Boxes that have started (finished, working, or waiting on you) are locked at the front of a run.
function lockedCount() {
  if (state.ed.kind !== 'run') return 0;
  return edBoxes().filter((b) => ['done', 'running', 'question', 'approval'].includes(b.status)).length;
}

function canEdit() {
  if (state.ed.kind !== 'run') return true;
  const run = edRun();
  return !!run && run.status !== 'done';
}

function mountEditor() {
  const isRun = state.ed.kind === 'run';
  $('#view').innerHTML = `<div class="editor ${isRun ? '' : 'no-chat'}">
    <aside class="skills">
      <div class="search"><input type="search" placeholder="Find a skill" id="skill-filter"></div>
      <div class="groups" id="skill-list"></div>
    </aside>
    <section class="center">
      <div class="head" id="head"></div>
      <div class="work">
        <div class="canvas" id="canvas"></div>
        <div class="inspector" id="inspector"></div>
      </div>
    </section>
    ${isRun ? `<aside class="chat">
      <div class="log" id="chat-log"></div>
      <form class="send" id="chat-form">
        <textarea name="text" rows="3" placeholder="Message the run's AI. Ctrl+Enter sends."></textarea>
        <div class="row"><span class="muted small grow" id="chat-hint"></span><button class="primary" id="chat-send">Send</button></div>
      </form>
    </aside>` : ''}
  </div>`;
  $('#skill-filter').addEventListener('input', (e) => {
    state.ed.filter = e.target.value.toLowerCase();
    renderSkills();
  });
  refreshEditor();
}

function refreshEditor() {
  if (!state.ed) return;
  if (state.ed.kind === 'run' && !edRun()) {
    $('#head').innerHTML = '<a href="#/">← Board</a><div class="err">This run was not found.</div>';
    return;
  }
  renderSkills();
  renderHead();
  renderCanvas();
  renderInspector();
  if (state.ed.kind === 'run') renderChat();
}

function renderSkills() {
  const f = state.ed.filter;
  const off = trackingOff();
  const hidden = off ? state.skills.filter((s) => s.tracks).length : 0;
  const list = state.skills.filter((s) => (!f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)) && !(off && s.tracks));
  const editable = canEdit();
  $('.skills').classList.toggle('locked', !editable);
  const groups = Object.entries(SOURCES).map(([src, title]) => [title, list.filter((s) => s.source === src)]).filter(([, l]) => l.length);
  const note = off ? `<div class="hidden-note small">Tracking is OFF: ${hidden} skill${hidden === 1 ? '' : 's'} that write to Teamspace or the vault are hidden. <a href="#/skills">Check the marks</a></div>` : '';
  $('#skill-list').innerHTML = note + (groups.map(([title, l]) => `
    <h3 class="group-title">${esc(title)}</h3>
    ${l.map((s) => `<div class="skill" draggable="${editable}" data-skill="${esc(s.name)}" title="${esc(s.description)}">
      <div class="grow"><div class="name">${esc(s.name)}${s.tracks ? ' <span class="tag-tracks" title="Writes to Teamspace or the vault. Hidden when tracking is OFF.">tracks</span>' : ''}</div><div class="desc">${esc(s.description)}</div></div>
      <button class="small" data-add="${esc(s.name)}" ${editable ? '' : 'disabled'} title="Add at the end">+</button>
    </div>`).join('')}`).join('') || '<div class="empty">No skills match.</div>');
}

function renderHead() {
  const el = $('#head');
  // Do not redraw under the cursor while you type a note.
  if (document.activeElement?.id === 'approval-note') return;
  if (state.ed.kind === 'template') {
    const t = state.ed.tpl;
    el.innerHTML = `
      <div class="row"><a href="#/templates" class="muted">← Templates</a></div>
      <div class="row">
        <input id="tpl-name" value="${esc(t.name)}" style="min-width:260px;font-weight:600">
        <label class="check" title="Off: this workflow's runs may not call Teamspace or write to the vault (ITPKV), and skills that do are hidden."><input type="checkbox" id="tpl-tracking" ${t.tracking !== false ? 'checked' : ''}> Tracking on</label>
        <span class="row small" title="Each run of this template gets a worktree of these repos. You can change them when you start a run.">Repos:
          ${cloned().map((r) => `<label class="check"><input type="checkbox" data-tpl-repo="${esc(r.token)}" ${(t.repos || []).includes(r.token) ? 'checked' : ''}> ${esc(r.token)}</label>`).join('') || '<span class="muted">none found</span>'}
        </span>
        <span class="grow"></span>
        <span class="muted small" id="tpl-saved">${state.ed.dirty ? 'Not saved' : 'Saved'}</span>
        <button class="primary" data-act="save-template" ${state.ed.dirty ? '' : 'disabled'}>Save</button>
        ${t.id ? `<button data-start="${esc(t.id)}">Start…</button><button class="danger" data-act="delete-template">Delete</button>` : ''}
      </div>`;
    return;
  }
  const r = edRun();
  const waitBox = r.boxes.find((b) => b.id === r.waitingAfter);
  const act = (a, label, cls = '') => `<button data-act="${a}" class="${cls}">${label}</button>`;
  el.innerHTML = `
    <div class="row"><a href="#/" class="muted">← Board</a></div>
    <div class="row">
      <h1>${esc(r.templateName)}</h1><span class="chip ${esc(r.status)}">${esc(r.status)}</span>
      ${r.tracking === false ? '<span class="chip draft" title="This run may not call Teamspace or write to the vault (ITPKV).">tracking off</span>' : ''}
      <span class="muted small">${money(r.cost)} · started ${ago(r.createdAt)} · ${esc(r.id)}</span>
      <span class="grow"></span>
      ${r.status === 'draft' ? act('resume', 'Start', 'primary') : ''}
      ${r.status === 'waiting' ? act('resume', 'Continue', 'primary') : ''}
      ${['stopped', 'failed'].includes(r.status) ? act('resume', 'Resume', 'primary') : ''}
      ${r.status === 'running' ? act('stop', 'Stop') : ''}
      ${r.status === 'queued' ? act('stop', 'Take out of queue') : ''}
      ${act('save-as-template', 'Save as template')}
      ${r.status !== 'running' ? act('delete-run', 'Delete', 'danger') : ''}
    </div>
    ${r.input?.text ? `<div class="input">${esc(r.input.text)}</div>` : ''}
    ${workspaceLine(r)}
    ${r.status === 'question' ? `<div class="callout">“${esc(r.boxes.find((b) => b.status === 'question')?.label)}” asks you something. Answer in the chat on the right. The box goes on with your answer.</div>` : ''}
    ${r.status === 'approval' ? approvalPanel(r) : ''}
    ${r.status === 'waiting' ? `<div class="small" style="color:var(--wait)">Waiting for you after “${esc(waitBox?.label || r.waitingAfter)}”. Check its result, then press Continue.</div>` : ''}
    ${r.status === 'queued' ? `<div class="small muted">Number ${queue().indexOf(r) + 1} in line. It starts by itself when a slot is free (${state.settings.maxRunning} at once).</div>` : ''}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}`;
}

function renderCanvas() {
  const boxes = edBoxes();
  const run = edRun();
  const locked = lockedCount();
  const editable = canEdit();
  const off = trackingOff();
  const link = (i) => `<div class="link" data-drop="${i}" ${editable && i >= locked ? 'data-drop-ok="1"' : ''}></div>`;
  const node = (b, i) => {
    const movable = editable && i >= locked;
    const gate = run?.status === 'waiting' && run.waitingAfter === b.id;
    const asks = b.status === 'question' || b.status === 'approval';
    const status = run ? b.status : '';
    // With tracking OFF, a box whose skill writes to Teamspace or the vault cannot run.
    const blocked = off && b.status !== 'done' && tracksSkill(b.skill);
    return `<div class="node ${esc(status)} ${gate || asks ? 'gate' : ''} ${blocked ? 'blocked' : ''} ${state.ed.sel === b.id ? 'sel' : ''}" data-box="${esc(b.id)}" draggable="${movable}" ${blocked ? 'title="Tracking is OFF and this skill writes to Teamspace or the vault"' : ''}>
      ${b.waitAfter || b.usesApp ? `<span class="pause">${[b.waitAfter && '<span title="Waits for you after this box">wait</span>', b.usesApp && '<span title="Starts the app; takes turns with other runs">app</span>'].filter(Boolean).join(' · ')}</span>` : ''}
      <div class="label">${esc(b.label || b.skill)}</div>
      <div class="skillname">/${esc(b.skill)}${b.args ? ' ' + esc(b.args.slice(0, 40)) : ''}</div>
      <div class="foot">${run ? `<span class="chip ${esc(gate ? 'waiting' : status)}">${esc(gate ? 'your turn' : b.status === 'approval' ? 'approve?' : status)}</span><span>${b.cost ? money(b.cost) : ''}${b.attempts > 1 ? ` · try ${b.attempts}` : ''}</span>` : '<span></span>'}</div>
    </div>`;
  };
  const end = run?.status === 'done' ? 'Done' : 'End';
  $('#canvas').innerHTML = `<div class="lane">
      <div class="node endpoint">Start</div>
      ${boxes.map((b, i) => link(i) + node(b, i)).join('')}
      ${link(boxes.length)}
      <div class="node endpoint">${end}</div>
    </div>
    <div class="hint">${editable ? 'Drag a skill from the left onto an arrow to add it. Drag a box to move it. Click a box for its settings.' : 'This run is finished. Its boxes are locked.'}</div>`;
}

function renderInspector() {
  const el = $('#inspector');
  const b = edBoxes().find((x) => x.id === state.ed.sel);
  // Do not redraw under the cursor while you type in it.
  if (b && el.dataset.box === b.id && el.contains(document.activeElement)) return;
  el.dataset.box = b?.id || '';
  if (!b) {
    el.innerHTML = `<div class="muted small">Click a box to see its settings${state.ed.kind === 'run' ? ' and its result' : ''}.</div>`;
    return;
  }
  const run = edRun();
  const i = edBoxes().indexOf(b);
  const locked = lockedCount();
  const free = canEdit() && i >= locked; // fully editable
  const soft = canEdit() && (free || b.status === 'running'); // label and "wait after" only
  el.innerHTML = `
    <div class="row" style="margin-bottom:10px"><h2 class="grow" style="margin:0">${esc(b.label || b.skill)}</h2>
      <button class="small" data-act="move-up" ${free && i > locked ? '' : 'disabled'}>↑ Move up</button>
      <button class="small" data-act="move-down" ${free && i < edBoxes().length - 1 ? '' : 'disabled'}>Move down ↓</button>
      <button class="small danger" data-act="remove-box" ${free ? '' : 'disabled'}>Remove</button>
    </div>
    <div class="grid">
      <label>Label <input data-field="label" value="${esc(b.label || '')}" ${soft ? '' : 'disabled'}></label>
      <label>Skill <input value="/${esc(b.skill)}" disabled></label>
      <label class="wide">Extra text for the skill <textarea data-field="args" rows="2" ${free ? '' : 'disabled'} placeholder="Added after /${esc(b.skill)}">${esc(b.args || '')}</textarea></label>
      <label class="check wide"><input type="checkbox" data-field="waitAfter" ${b.waitAfter ? 'checked' : ''} ${soft ? '' : 'disabled'}> Wait for me after this box</label>
      <label class="check wide"><input type="checkbox" data-field="usesApp" ${b.usesApp ? 'checked' : ''} ${soft ? '' : 'disabled'}> Starts the app to test it (takes turns with other runs)</label>
    </div>
    ${trackingOff() && b.status !== 'done' && tracksSkill(b.skill) ? `<div class="callout bad small"><div>Tracking is OFF, and /${esc(b.skill)} writes to Teamspace or the vault. This box cannot run. Remove it, turn tracking on, or <a href="#/skills">correct the skill’s mark</a>.</div></div>` : ''}
    ${run ? `
      <div class="row small muted" style="margin:10px 0 6px">
        <span class="chip ${esc(b.status)}">${esc(b.status)}</span>
        ${b.attempts ? `<span>try ${b.attempts}</span>` : ''}
        ${b.cost ? `<span>${money(b.cost)}</span><span>${tokens(b.tokens)}</span>` : ''}
        ${b.durationMs != null ? `<span>${duration(b.durationMs)}</span>` : ''}
      </div>
      ${b.note ? `<div class="small muted">${esc(b.note)}</div>` : ''}
      ${b.status === 'question' && b.question ? `<h3>It asks you</h3><pre>${esc(unmark(b.question))}</pre>` : ''}
      ${b.status === 'approval' ? `<h3>Wants to push</h3><pre>${esc(pushes(b).join('\n') || '(see its result)')}</pre>` : ''}
      ${(b.approvals || []).length ? `<h3>Your decisions</h3><pre>${esc(b.approvals.map((a) => `${a.ok ? 'Approved' : 'Not approved'}${a.note ? `: ${a.note}` : ''}`).join('\n'))}</pre>` : ''}
      ${b.error ? `<h3>Error</h3><pre class="err">${esc(b.error)}</pre>` : ''}
      ${b.summary && b.status !== 'question' ? `<h3>Result</h3><pre>${esc(b.summary)}</pre>` : ''}` : ''}`;
}

function renderChat() {
  const run = edRun();
  const log = $('#chat-log');
  if (!log || !run) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const label = (id) => (id ? run.boxes.find((b) => b.id === id)?.label || id : 'chat');
  const items = state.ed.timeline.map((e) => ({ at: e.at, html: e.kind === 'log'
    ? `<div class="ev note">${esc(e.text)}</div>`
    : `<div class="ev ${e.kind === 'text' ? 'text' : ''}"><span class="tag">${esc(label(e.boxId))}</span>${esc(unmark(e.text))}</div>` }));
  for (const m of run.chat || []) {
    const status = m.kind === 'answer' ? `your answer to “${label(m.boxId)}”` : m.kind === 'approval' ? `your decision on the push in “${label(m.boxId)}”`
      : m.status === 'queued' ? 'waits for the current box to end' : m.status === 'working' ? 'the AI is answering…' : '';
    items.push({ at: m.at, html: `<div class="bubble you">${esc(m.text)}${status ? `<div class="meta">${status}</div>` : ''}</div>` });
    if (m.status === 'answered' || m.status === 'failed') {
      items.push({ at: m.answeredAt || m.at, html: `<div class="bubble ai">${esc(m.reply || '')}${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}<div class="meta">${money(m.cost)}</div></div>` });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  log.innerHTML = items.map((x) => x.html).join('') || '<div class="empty">Live activity and your chat with the run show here.</div>';
  if (nearBottom) log.scrollTop = log.scrollHeight;
  const working = run.boxes.find((b) => b.status === 'running');
  const asking = run.boxes.find((b) => b.status === 'question');
  $('#chat-send').textContent = asking ? 'Answer' : 'Send';
  $('#chat-hint').textContent = asking ? `Your message is the answer to “${asking.label}”.` : working ? `Busy with “${working.label}”. Your message is sent when it ends.` : run.sessionId ? 'Talks to the same AI session as the boxes.' : 'Starts the session if no box has run yet.';
}

function approvalPanel(r) {
  const b = r.boxes.find((x) => x.status === 'approval');
  const list = pushes(b);
  return `<div class="callout">
    <b>“${esc(b?.label)}” wants to push.</b> Nothing is pushed until you approve. Read its result (click the box), then decide.
    ${list.length ? `<pre>${esc(list.join('\n'))}</pre>` : ''}
    <div class="row">
      <input id="approval-note" class="grow" placeholder="Note for the AI (optional)">
      <button class="primary" data-act="approve">Approve push</button>
      <button data-act="reject">Don't push</button>
    </div>
  </div>`;
}

async function loadTimeline() {
  const ed = state.ed;
  if (ed?.kind !== 'run') return;
  try {
    ed.timeline = await api('GET', `/api/runs/${encodeURIComponent(ed.id)}/timeline`);
  } catch {
    ed.timeline = [];
  }
  if (state.ed === ed) renderChat();
}

// ---------- editing boxes ----------

async function commitBoxes(boxes) {
  const plain = boxes.map(({ id, skill, label, args, waitAfter, usesApp }) => ({ id, skill, label, args: args || '', waitAfter: !!waitAfter, usesApp: !!usesApp }));
  if (state.ed.kind === 'template') {
    state.ed.tpl.boxes = plain;
    state.ed.dirty = true;
    refreshEditor();
    return;
  }
  try {
    const run = await api('PUT', `/api/runs/${encodeURIComponent(state.ed.id)}/boxes`, { boxes: plain });
    state.runs.set(run.id, run);
  } catch (err) {
    fail(err);
  }
  refreshEditor();
}

function addSkill(name, at) {
  if (!canEdit()) return;
  const boxes = [...edBoxes()];
  const taken = new Set(boxes.map((b) => b.id));
  const box = { id: slug(name, taken), skill: name, label: name, args: '', waitAfter: false };
  boxes.splice(at ?? boxes.length, 0, box);
  state.ed.sel = box.id;
  commitBoxes(boxes);
}

function moveBox(id, to) {
  const boxes = [...edBoxes()];
  const from = boxes.findIndex((b) => b.id === id);
  if (from < 0) return;
  const [b] = boxes.splice(from, 1);
  boxes.splice(to > from ? to - 1 : to, 0, b);
  commitBoxes(boxes);
}

function updateSelected(field, value) {
  const boxes = edBoxes().map((b) => (b.id === state.ed.sel ? { ...b, [field]: value } : b));
  commitBoxes(boxes);
}

// ---------- actions ----------

async function act(name, el) {
  const ed = state.ed;
  const run = edRun();
  switch (name) {
    case 'resume':
    case 'stop':
      return api('POST', `/api/runs/${encodeURIComponent(run.id)}/${name}`).catch(fail);
    case 'approve':
    case 'reject':
      return api('POST', `/api/runs/${encodeURIComponent(run.id)}/approve`, { ok: name === 'approve', note: $('#approval-note')?.value || '' }).catch(fail);
    case 'delete-run': {
      const ws = run.workspace ? ' Its workspace (worktrees) is removed too; the branches stay.' : '';
      if (!confirm(`Delete this run and its files?${ws}`)) return;
      const url = `/api/runs/${encodeURIComponent(run.id)}`;
      try {
        await api('DELETE', url);
      } catch (err) {
        if (!/uncommitted work/.test(err.message)) return fail(err);
        if (!confirm(`${err.message}\n\nThis work is lost if you delete. Delete anyway?`)) return;
        try {
          await api('DELETE', `${url}?force=1`);
        } catch (err2) {
          return fail(err2);
        }
      }
      location.hash = '#/';
      return;
    }
    case 'save-as-template': {
      const n = prompt('Name for the new template:', `${run.templateName} (copy)`);
      if (!n) return;
      await loadTemplates();
      const id = slug(n, new Set(state.templates.map((t) => t.id)));
      const boxes = run.boxes.map(({ id, skill, label, args, waitAfter, usesApp }) => ({ id, skill, label, args, waitAfter, usesApp: !!usesApp }));
      const repos = (run.repoPlan || []).map((p) => p.token);
      return api('PUT', `/api/templates/${id}`, { id, name: n, tracking: run.tracking, repos, boxes })
        .then(() => alert(`Saved as template “${n}”.`)).catch(fail);
    }
    case 'save-template': {
      const t = ed.tpl;
      if (!t.id) {
        await loadTemplates();
        t.id = slug(t.name, new Set(state.templates.map((x) => x.id)));
      }
      try {
        ed.tpl = await api('PUT', `/api/templates/${t.id}`, t);
        ed.dirty = false;
        if (ed.id !== t.id) {
          ed.id = t.id;
          history.replaceState(null, '', `#/template/${encodeURIComponent(t.id)}`);
        }
      } catch (err) {
        if (ed.id === 'new') t.id = '';
        fail(err);
      }
      return refreshEditor();
    }
    case 'duplicate-template':
      try {
        state.copyFrom = await api('GET', `/api/templates/${encodeURIComponent(el.dataset.id)}`);
        location.hash = '#/template/new';
      } catch (err) {
        fail(err);
      }
      return;
    case 'delete-template':
      if (!confirm(`Delete template “${ed.tpl.name}”? Runs made from it stay.`)) return;
      return api('DELETE', `/api/templates/${ed.tpl.id}`).then(() => (location.hash = '#/templates')).catch(fail);
    case 'move-up':
    case 'move-down': {
      const i = edBoxes().findIndex((b) => b.id === ed.sel);
      return moveBox(ed.sel, name === 'move-up' ? i - 1 : i + 2);
    }
    case 'remove-box': {
      const boxes = edBoxes().filter((b) => b.id !== ed.sel);
      ed.sel = null;
      return commitBoxes(boxes);
    }
  }
}

// The ITP repos that are cloned on this PC, so a run can get worktrees of them.
const cloned = () => state.repos.filter((r) => r.cloned);

// Same rule as the server: feature/<Jira key>, else a few words of the input.
function branchName(input) {
  const key = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(input || '')?.[0];
  if (key) return `feature/${key}`;
  const words = String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join('-');
  return words ? `feature/${words}` : '';
}

let startBranchTouched = false; // you typed your own branch name: stop filling it from the input

async function openStart(templateId) {
  await loadTemplates();
  const dlg = $('#start-dialog');
  const sel = $('select[name=templateId]', dlg);
  sel.innerHTML = state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (templateId) sel.value = templateId;
  $('textarea[name=text]', dlg).value = '';
  startBranchTouched = false;
  renderStartRepos();
  dlg.showModal();
}

// One line per repo: tick it to give the run a worktree, on a new or an existing branch.
function renderStartRepos() {
  const box = $('#start-repos');
  const repos = cloned();
  if (!repos.length) {
    box.innerHTML = '';
    return;
  }
  const tpl = state.templates.find((t) => t.id === $('select[name=templateId]').value);
  const picked = new Set(tpl?.repos || []);
  const name = branchName($('textarea[name=text]').value);
  box.innerHTML = `
    <div class="repo-plan">
      <label>New branch name (same in every repo) <input id="start-branch" value="${esc(name)}" placeholder="feature/PROJ-101"></label>
      ${repos.map((r) => `
        <div class="repo-row" data-token="${esc(r.token)}">
          <label class="check"><input type="checkbox" data-pick ${picked.has(r.token) ? 'checked' : ''}> <b>${esc(r.token)}</b> <span class="muted small">${esc(r.folder)}</span></label>
          <select data-mode><option value="new">new branch</option><option value="existing">existing branch</option></select>
          <span data-new class="small">from <input data-base value="${esc(r.defaultBase || '')}" size="26"></span>
          <span data-existing class="small" hidden><select data-existing-branch><option value="">loading…</option></select></span>
        </div>`).join('')}
      <div class="muted small">Ticked repos get their own worktree for this run. Your own checkouts are not switched. <code>main</code> is refused.</div>
    </div>`;
}

$('select[name=templateId]').addEventListener('change', renderStartRepos);
$('textarea[name=text]').addEventListener('input', (e) => {
  const b = $('#start-branch');
  if (b && !startBranchTouched) b.value = branchName(e.target.value);
});
$('#start-repos').addEventListener('input', (e) => {
  if (e.target.id === 'start-branch') startBranchTouched = true;
});
$('#start-repos').addEventListener('change', async (e) => {
  const row = e.target.closest('.repo-row');
  if (!row || !e.target.matches('[data-mode]')) return;
  const existing = e.target.value === 'existing';
  $('[data-new]', row).hidden = existing;
  $('[data-existing]', row).hidden = !existing;
  $('[data-pick]', row).checked = true;
  const sel = $('[data-existing-branch]', row);
  if (existing && sel.options.length <= 1 && !sel.dataset.loaded) {
    try {
      const { branches } = await api('GET', `/api/repos/${encodeURIComponent(row.dataset.token)}/branches`);
      // Branches checked out elsewhere are shown but cannot be picked.
      const free = branches.filter((b) => !b.inUse);
      sel.innerHTML = [...free, ...branches.filter((b) => b.inUse)].map((b) => `<option value="${esc(b.name)}" ${b.inUse ? 'disabled' : ''}>${esc(b.name)}${b.inUse ? ' (in use)' : ''}</option>`).join('') || '<option value="">no branches</option>';
      sel.dataset.loaded = '1';
    } catch (err) {
      sel.innerHTML = `<option value="">${esc(err.message)}</option>`;
    }
  }
});

function startRepos() {
  const branch = $('#start-branch')?.value.trim() || '';
  return [...document.querySelectorAll('#start-repos .repo-row')].filter((row) => $('[data-pick]', row).checked).map((row) => {
    const mode = $('[data-mode]', row).value;
    return mode === 'existing'
      ? { token: row.dataset.token, mode, branch: $('[data-existing-branch]', row).value }
      : { token: row.dataset.token, mode, branch, base: $('[data-base]', row).value.trim() };
  });
}

// The form stays open when the server says no, so nothing you typed is lost.
$('#start-form').addEventListener('submit', async (e) => {
  const how = e.submitter?.value;
  if (!['start', 'draft'].includes(how)) return; // Cancel closes the dialog
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { templateId: f.get('templateId'), input: { text: f.get('text') }, start: how === 'start' };
  if (cloned().length) body.repos = startRepos();
  try {
    const run = await api('POST', '/api/runs', body);
    state.runs.set(run.id, run);
    $('#start-dialog').close();
    location.hash = `#/run/${encodeURIComponent(run.id)}`;
  } catch (err) {
    fail(err);
  }
});

// Where the run works: its workspace, or what it will get when it starts.
function workspaceLine(r) {
  const repos = r.workspace?.repos || r.repoPlan || [];
  if (!repos.length) return '';
  const list = repos.map((p) => `${esc(p.token)} on <code>${esc(p.branch)}</code>${p.mode === 'new' && p.base ? ` <span class="muted">(new, from ${esc(p.base)})</span>` : ''}`).join(' · ');
  const where = r.workspace?.ready ? `Workspace <code>${esc(r.workspace.dir)}</code>` : 'Workspace is made when the run starts';
  return `<div class="small">${where}: ${list}</div>`;
}

// ---------- events ----------

$('#new-run').addEventListener('click', () => openStart());

document.addEventListener('click', (e) => {
  const start = e.target.closest('[data-start]');
  if (start) return openStart(start.dataset.start);
  const a = e.target.closest('[data-act]');
  if (a && !a.disabled) return act(a.dataset.act, a);
  const add = e.target.closest('[data-add]');
  if (add) return addSkill(add.dataset.add);
  const node = e.target.closest('.node[data-box]');
  if (node && state.ed) {
    state.ed.sel = state.ed.sel === node.dataset.box ? null : node.dataset.box;
    renderCanvas();
    renderInspector();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'max-running') {
    const el = e.target;
    api('PUT', '/api/settings', { maxRunning: Number(el.value) })
      .then((s) => (state.settings = s))
      .catch((err) => {
        el.value = state.settings.maxRunning;
        fail(err);
      })
      .finally(() => el.blur());
    return;
  }
  if (!state.ed) return;
  const field = e.target.dataset?.field;
  if (field) return updateSelected(field, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
});

// Template name, tracking and repos: update in place, so a click on Save right after typing is not lost.
document.addEventListener('input', (e) => {
  if (state.ed?.kind !== 'template' || !(['tpl-name', 'tpl-tracking'].includes(e.target.id) || e.target.dataset.tplRepo)) return;
  state.ed.tpl.name = $('#tpl-name').value.trim() || 'Untitled';
  state.ed.tpl.tracking = $('#tpl-tracking').checked;
  state.ed.tpl.repos = [...document.querySelectorAll('[data-tpl-repo]:checked')].map((x) => x.dataset.tplRepo);
  state.ed.dirty = true;
  $('[data-act=save-template]').disabled = false;
  $('#tpl-saved').textContent = 'Not saved';
  if (e.target.id === 'tpl-tracking') {
    renderSkills();
    renderCanvas();
    renderInspector();
  }
});

// Skills page: search, filter, and your marks.
document.addEventListener('input', (e) => {
  if (e.target.id === 'marks-filter') {
    skillFilter.text = e.target.value;
    renderSkillMarkRows();
  }
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'marks-only') {
    skillFilter.onlyWrites = e.target.checked;
    return renderSkillMarkRows();
  }
  const name = e.target.dataset?.mark;
  if (!name) return;
  try {
    state.skills = await api('PUT', `/api/skill-marks/${encodeURIComponent(name)}`, { mark: e.target.value });
  } catch (err) {
    fail(err);
  }
  renderSkillMarkRows();
});

document.addEventListener('keydown', (e) => {
  if (!state.ed?.sel) return;
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const btn = $('[data-act=remove-box]');
    if (btn && !btn.disabled) act('remove-box');
  } else if (e.key === 'Escape') {
    state.ed.sel = null;
    renderCanvas();
    renderInspector();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'chat-form') return;
  e.preventDefault();
  const ta = e.target.elements.text;
  const text = ta.value.trim();
  if (!text) return;
  try {
    const run = await api('POST', `/api/runs/${encodeURIComponent(state.ed.id)}/chat`, { text });
    state.runs.set(run.id, run);
    ta.value = '';
    renderChat();
  } catch (err) {
    fail(err);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest('#chat-form')) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// Drag and drop: skills from the menu, and boxes on the canvas, onto an arrow.
let drag = null;
document.addEventListener('dragstart', (e) => {
  const skill = e.target.closest?.('.skill[draggable=true]');
  const node = e.target.closest?.('.node[draggable=true]');
  if (skill) drag = { skill: skill.dataset.skill };
  else if (node) drag = { box: node.dataset.box };
  else return;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', drag.skill || drag.box);
  for (const l of document.querySelectorAll('.link[data-drop-ok]')) l.classList.add('drop-ok');
});
document.addEventListener('dragend', () => {
  drag = null;
  for (const l of document.querySelectorAll('.link')) l.classList.remove('drop-ok', 'drop-on');
});
document.addEventListener('dragover', (e) => {
  const l = e.target.closest?.('.link[data-drop-ok]');
  if (!drag || !l) return;
  e.preventDefault();
  for (const x of document.querySelectorAll('.link.drop-on')) if (x !== l) x.classList.remove('drop-on');
  l.classList.add('drop-on');
});
document.addEventListener('drop', (e) => {
  const l = e.target.closest?.('.link[data-drop-ok]');
  if (!drag || !l) return;
  e.preventDefault();
  const at = Number(l.dataset.drop);
  if (drag.skill) addSkill(drag.skill, at);
  else moveBox(drag.box, at);
  drag = null;
});

// ---------- live updates ----------

function connect() {
  const es = new EventSource('/api/events');
  const conn = $('#conn');
  es.onopen = () => conn.classList.add('on');
  es.onerror = () => conn.classList.remove('on'); // EventSource reconnects by itself
  es.addEventListener('hello', (e) => {
    const hello = JSON.parse(e.data);
    if (hello.settings) state.settings = hello.settings;
    state.runs.clear();
    for (const r of hello.runs) state.runs.set(r.id, r);
    if (state.route.name === 'board') renderBoard();
    if (state.ed?.kind === 'run') {
      refreshEditor();
      loadTimeline(); // catch up on what happened while disconnected
    }
  });
  es.addEventListener('skills', (e) => {
    state.skills = JSON.parse(e.data);
    if (state.route.name === 'skills') renderSkillMarkRows();
    else if (state.ed) refreshEditor();
  });
  es.addEventListener('settings', (e) => {
    state.settings = JSON.parse(e.data);
    if (state.route.name === 'board') renderBoard();
  });
  es.addEventListener('run', (e) => {
    const r = JSON.parse(e.data);
    state.runs.set(r.id, r);
    if (state.route.name === 'board') renderBoard();
    else if (state.ed?.kind === 'run' && state.ed.id === r.id) refreshEditor();
  });
  es.addEventListener('deleted', (e) => {
    const { id } = JSON.parse(e.data);
    state.runs.delete(id);
    if (state.route.name === 'board') renderBoard();
    else if (state.ed?.kind === 'run' && state.ed.id === id) location.hash = '#/';
  });
  const onLine = (kind) => (e) => {
    const d = JSON.parse(e.data);
    if (state.ed?.kind !== 'run' || state.ed.id !== d.runId) return;
    state.ed.timeline.push(kind === 'log' ? { at: d.at, kind: 'log', text: d.message } : d);
    if (state.ed.timeline.length > 600) state.ed.timeline.splice(0, 100);
    renderChat();
  };
  es.addEventListener('activity', onLine('activity'));
  es.addEventListener('log', onLine('log'));
}

// Keep "x min ago" fresh on the board.
setInterval(() => state.route.name === 'board' && renderBoard(), 30000);

(async function main() {
  [state.skills, state.repos] = await Promise.all([api('GET', '/api/skills').catch(() => []), api('GET', '/api/repos').catch(() => [])]);
  window.addEventListener('hashchange', onRoute);
  connect();
  await onRoute();
})();
