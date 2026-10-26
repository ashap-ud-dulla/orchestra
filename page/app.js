// Orchestra page: home board, templates, and the editor (skill menu + canvas + box settings + chat).
// Plain JS, no libraries. The server is the source of truth; live changes come in over SSE.
'use strict';

const state = {
  runs: new Map(),
  templates: [],
  skills: [],
  route: { name: 'board' },
  ed: null, // the open editor: { kind: 'run'|'template', id, tpl?, dirty?, sel, timeline, filter }
};

const SOURCES = { team: 'Team skills', mine: 'My ITP skills', global: 'My global skills', orchestra: 'Orchestra test skills' };
const NEEDS_YOU = new Set(['waiting', 'failed', 'stopped', 'draft']);

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
  if (name === 'run') {
    state.ed = { kind: 'run', id, sel: null, timeline: [], filter: '' };
    mountEditor();
    loadTimeline();
    return;
  }
  if (name === 'template') {
    let tpl;
    if (id === 'new') tpl = { id: '', name: 'New template', tracking: true, boxes: [] };
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

function renderBoard() {
  const runs = [...state.runs.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const cols = [
    ['Running', runs.filter((r) => r.status === 'running')],
    ['Needs you', runs.filter((r) => NEEDS_YOU.has(r.status))],
    ['Done', runs.filter((r) => r.status === 'done').slice(0, 50)],
  ];
  $('#view').innerHTML = `<div class="board">${cols.map(([title, list]) => `
    <section class="col">
      <h3><span>${title}</span><span>${list.length}</span></h3>
      <div class="cards">${list.map(card).join('') || '<div class="empty">Nothing here.</div>'}</div>
    </section>`).join('')}</div>`;
}

function card(r) {
  const label = (id) => r.boxes.find((b) => b.id === id)?.label || id;
  const working = r.boxes.find((b) => b.status === 'running');
  let why = '';
  if (r.status === 'waiting') why = `<div class="why">Waiting for you after “${esc(label(r.waitingAfter))}”</div>`;
  else if (r.status === 'failed') why = `<div class="why bad">${esc((r.error || 'Failed').slice(0, 160))}</div>`;
  else if (r.status === 'stopped') why = '<div class="why">Stopped by you</div>';
  else if (r.status === 'draft') why = '<div class="why">Draft: check the boxes, then press Start</div>';
  else if (working) why = `<div class="why muted">Working on “${esc(working.label)}”</div>`;
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
        <button data-start="${esc(t.id)}">Start…</button>
      </div>`).join('') || '<div class="empty">No templates yet.</div>'}</div>
  </div>`;
}

async function loadTemplates() {
  state.templates = await api('GET', '/api/templates').catch(() => []);
}

// ---------- editor ----------

function edRun() {
  return state.ed?.kind === 'run' ? state.runs.get(state.ed.id) : null;
}

function edBoxes() {
  return state.ed.kind === 'run' ? edRun()?.boxes || [] : state.ed.tpl.boxes;
}

// Finished and working boxes are locked at the front of a run.
function lockedCount() {
  if (state.ed.kind !== 'run') return 0;
  return edBoxes().filter((b) => b.status === 'done' || b.status === 'running').length;
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
      <div class="canvas" id="canvas"></div>
      <div class="inspector" id="inspector"></div>
    </section>
    ${isRun ? `<aside class="chat">
      <div class="log" id="chat-log"></div>
      <form class="send" id="chat-form">
        <textarea name="text" rows="3" placeholder="Message the run's AI. Ctrl+Enter sends."></textarea>
        <div class="row"><span class="muted small grow" id="chat-hint"></span><button class="primary">Send</button></div>
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
  const list = state.skills.filter((s) => !f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f));
  const editable = canEdit();
  $('.skills').classList.toggle('locked', !editable);
  const groups = Object.entries(SOURCES).map(([src, title]) => [title, list.filter((s) => s.source === src)]).filter(([, l]) => l.length);
  $('#skill-list').innerHTML = groups.map(([title, l]) => `
    <h3 class="group-title">${esc(title)}</h3>
    ${l.map((s) => `<div class="skill" draggable="${editable}" data-skill="${esc(s.name)}" title="${esc(s.description)}">
      <div class="grow"><div class="name">${esc(s.name)}</div><div class="desc">${esc(s.description)}</div></div>
      <button class="small" data-add="${esc(s.name)}" ${editable ? '' : 'disabled'} title="Add at the end">+</button>
    </div>`).join('')}`).join('') || '<div class="empty">No skills match.</div>';
}

function renderHead() {
  const el = $('#head');
  if (state.ed.kind === 'template') {
    const t = state.ed.tpl;
    el.innerHTML = `
      <div class="row"><a href="#/templates" class="muted">← Templates</a></div>
      <div class="row">
        <input id="tpl-name" value="${esc(t.name)}" style="min-width:260px;font-weight:600">
        <label class="check"><input type="checkbox" id="tpl-tracking" ${t.tracking !== false ? 'checked' : ''}> Tracking on</label>
        <span class="grow"></span>
        <span class="muted small">${state.ed.dirty ? 'Not saved' : 'Saved'}</span>
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
      <span class="muted small">${money(r.cost)} · started ${ago(r.createdAt)} · ${esc(r.id)}</span>
      <span class="grow"></span>
      ${r.status === 'draft' ? act('resume', 'Start', 'primary') : ''}
      ${r.status === 'waiting' ? act('resume', 'Continue', 'primary') : ''}
      ${['stopped', 'failed'].includes(r.status) ? act('resume', 'Resume', 'primary') : ''}
      ${r.status === 'running' ? act('stop', 'Stop') : ''}
      ${act('save-as-template', 'Save as template')}
      ${r.status !== 'running' ? act('delete-run', 'Delete', 'danger') : ''}
    </div>
    ${r.input?.text ? `<div class="input">${esc(r.input.text)}</div>` : ''}
    ${r.status === 'waiting' ? `<div class="small" style="color:var(--wait)">Waiting for you after “${esc(waitBox?.label || r.waitingAfter)}”. Check its result, then press Continue.</div>` : ''}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}`;
}

function renderCanvas() {
  const boxes = edBoxes();
  const run = edRun();
  const locked = lockedCount();
  const editable = canEdit();
  const link = (i) => `<div class="link" data-drop="${i}" ${editable && i >= locked ? 'data-drop-ok="1"' : ''}></div>`;
  const node = (b, i) => {
    const movable = editable && i >= locked;
    const gate = run?.status === 'waiting' && run.waitingAfter === b.id;
    const status = run ? b.status : '';
    return `<div class="node ${esc(status)} ${gate ? 'gate' : ''} ${state.ed.sel === b.id ? 'sel' : ''}" data-box="${esc(b.id)}" draggable="${movable}">
      ${b.waitAfter ? '<span class="pause" title="Waits for you after this box">wait</span>' : ''}
      <div class="label">${esc(b.label || b.skill)}</div>
      <div class="skillname">/${esc(b.skill)}${b.args ? ' ' + esc(b.args.slice(0, 40)) : ''}</div>
      <div class="foot">${run ? `<span class="chip ${esc(gate ? 'waiting' : status)}">${esc(gate ? 'your turn' : status)}</span><span>${b.cost ? money(b.cost) : ''}${b.attempts > 1 ? ` · try ${b.attempts}` : ''}</span>` : '<span></span>'}</div>
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
      <button class="small" data-act="move-left" ${free && i > locked ? '' : 'disabled'}>← Move</button>
      <button class="small" data-act="move-right" ${free && i < edBoxes().length - 1 ? '' : 'disabled'}>Move →</button>
      <button class="small danger" data-act="remove-box" ${free ? '' : 'disabled'}>Remove</button>
    </div>
    <div class="grid">
      <label>Label <input data-field="label" value="${esc(b.label || '')}" ${soft ? '' : 'disabled'}></label>
      <label>Skill <input value="/${esc(b.skill)}" disabled></label>
      <label class="wide">Extra text for the skill <textarea data-field="args" rows="2" ${free ? '' : 'disabled'} placeholder="Added after /${esc(b.skill)}">${esc(b.args || '')}</textarea></label>
      <label class="check wide"><input type="checkbox" data-field="waitAfter" ${b.waitAfter ? 'checked' : ''} ${soft ? '' : 'disabled'}> Wait for me after this box</label>
    </div>
    ${run ? `
      <div class="row small muted" style="margin:10px 0 6px">
        <span class="chip ${esc(b.status)}">${esc(b.status)}</span>
        ${b.attempts ? `<span>try ${b.attempts}</span>` : ''}
        ${b.cost ? `<span>${money(b.cost)}</span><span>${tokens(b.tokens)}</span>` : ''}
        ${b.durationMs != null ? `<span>${duration(b.durationMs)}</span>` : ''}
      </div>
      ${b.note ? `<div class="small muted">${esc(b.note)}</div>` : ''}
      ${b.error ? `<h3>Error</h3><pre class="err">${esc(b.error)}</pre>` : ''}
      ${b.summary ? `<h3>Result</h3><pre>${esc(b.summary)}</pre>` : ''}` : ''}`;
}

function renderChat() {
  const run = edRun();
  const log = $('#chat-log');
  if (!log || !run) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const label = (id) => (id ? run.boxes.find((b) => b.id === id)?.label || id : 'chat');
  const items = state.ed.timeline.map((e) => ({ at: e.at, html: e.kind === 'log'
    ? `<div class="ev note">${esc(e.text)}</div>`
    : `<div class="ev ${e.kind === 'text' ? 'text' : ''}"><span class="tag">${esc(label(e.boxId))}</span>${esc(e.text)}</div>` }));
  for (const m of run.chat || []) {
    const status = m.status === 'queued' ? 'waits for the current box to end' : m.status === 'working' ? 'the AI is answering…' : '';
    items.push({ at: m.at, html: `<div class="bubble you">${esc(m.text)}${status ? `<div class="meta">${status}</div>` : ''}</div>` });
    if (m.status === 'answered' || m.status === 'failed') {
      items.push({ at: m.answeredAt || m.at, html: `<div class="bubble ai">${esc(m.reply || '')}${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}<div class="meta">${money(m.cost)}</div></div>` });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  log.innerHTML = items.map((x) => x.html).join('') || '<div class="empty">Live activity and your chat with the run show here.</div>';
  if (nearBottom) log.scrollTop = log.scrollHeight;
  const working = run.boxes.find((b) => b.status === 'running');
  $('#chat-hint').textContent = working ? `Busy with “${working.label}”. Your message is sent when it ends.` : run.sessionId ? 'Talks to the same AI session as the boxes.' : 'Starts the session if no box has run yet.';
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
  const plain = boxes.map(({ id, skill, label, args, waitAfter }) => ({ id, skill, label, args: args || '', waitAfter: !!waitAfter }));
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
    case 'delete-run':
      if (!confirm('Delete this run and its files?')) return;
      return api('DELETE', `/api/runs/${encodeURIComponent(run.id)}`).then(() => (location.hash = '#/')).catch(fail);
    case 'save-as-template': {
      const n = prompt('Name for the new template:', `${run.templateName} (copy)`);
      if (!n) return;
      await loadTemplates();
      const id = slug(n, new Set(state.templates.map((t) => t.id)));
      const boxes = run.boxes.map(({ id, skill, label, args, waitAfter }) => ({ id, skill, label, args, waitAfter }));
      return api('PUT', `/api/templates/${id}`, { id, name: n, tracking: run.tracking, boxes })
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
    case 'delete-template':
      if (!confirm(`Delete template “${ed.tpl.name}”? Runs made from it stay.`)) return;
      return api('DELETE', `/api/templates/${ed.tpl.id}`).then(() => (location.hash = '#/templates')).catch(fail);
    case 'move-left':
    case 'move-right': {
      const i = edBoxes().findIndex((b) => b.id === ed.sel);
      return moveBox(ed.sel, name === 'move-left' ? i - 1 : i + 2);
    }
    case 'remove-box': {
      const boxes = edBoxes().filter((b) => b.id !== ed.sel);
      ed.sel = null;
      return commitBoxes(boxes);
    }
  }
}

async function openStart(templateId) {
  await loadTemplates();
  const dlg = $('#start-dialog');
  const sel = $('select[name=templateId]', dlg);
  sel.innerHTML = state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (templateId) sel.value = templateId;
  $('textarea[name=text]', dlg).value = '';
  dlg.showModal();
}

$('#start-dialog').addEventListener('close', async (e) => {
  const dlg = e.target;
  if (!['start', 'draft'].includes(dlg.returnValue)) return;
  const f = new FormData($('#start-form'));
  try {
    const run = await api('POST', '/api/runs', { templateId: f.get('templateId'), input: { text: f.get('text') }, start: dlg.returnValue === 'start' });
    state.runs.set(run.id, run);
    location.hash = `#/run/${encodeURIComponent(run.id)}`;
  } catch (err) {
    fail(err);
  }
});

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
  if (!state.ed) return;
  const field = e.target.dataset?.field;
  if (field) return updateSelected(field, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
});

// Template name and tracking: update in place, so a click on Save right after typing is not lost.
document.addEventListener('input', (e) => {
  if (state.ed?.kind !== 'template' || !['tpl-name', 'tpl-tracking'].includes(e.target.id)) return;
  state.ed.tpl.name = $('#tpl-name').value.trim() || 'Untitled';
  state.ed.tpl.tracking = $('#tpl-tracking').checked;
  state.ed.dirty = true;
  $('[data-act=save-template]').disabled = false;
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
    state.runs.clear();
    for (const r of JSON.parse(e.data).runs) state.runs.set(r.id, r);
    if (state.route.name === 'board') renderBoard();
    if (state.ed?.kind === 'run') {
      refreshEditor();
      loadTimeline(); // catch up on what happened while disconnected
    }
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
  state.skills = await api('GET', '/api/skills').catch(() => []);
  window.addEventListener('hashchange', onRoute);
  connect();
  await onRoute();
})();
