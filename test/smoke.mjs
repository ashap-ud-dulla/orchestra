// End-to-end tests. Run: node test/smoke.mjs
// No terminal opens (ORCHESTRA_TERMINAL=none): the tests send the hook messages a real terminal
// session sends (bin/hook.mjs), use the orch command, and check what Orchestra does with them. The fake claude is used by the lesson-finder.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/skills-scan.mjs';
import { childEnv, guardEnv, lastReply } from '../lib/runner.mjs';
import { check, readMark, readWhy } from '../lib/guard.mjs';
import { detect } from '../lib/tracking.mjs';
import { computeStats } from '../lib/stats.mjs';
import { material, parseSuggestions } from '../lib/learn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
const dataDir = path.join(tmp, 'data');
const runsDir = path.join(tmp, 'runs');
fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'test/fixtures/demo-hello-recap.json'), path.join(dataDir, 'templates/demo-hello-recap.json'));

// There is no server: every call is a short process (the orch command, a hook, the launcher's runner call).
// They all get this env; tests that need another ITP folder change it with useEnv.
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^ORCHESTRA_/.test(k)) delete e[k];
  return e;
})();
let env;
function useEnv(extra = {}) {
  env = { ...baseEnv, ORCHESTRA_DATA_DIR: dataDir, ORCHESTRA_RUNS_DIR: runsDir, ORCHESTRA_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), ORCHESTRA_NOTIFY: '0', ORCHESTRA_TERMINAL: 'none', ORCHESTRA_CLAUDE_PROJECTS: path.join(tmp, 'claude-projects'), ...extra };
}
useEnv();

function proc(args, { input = '', extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

// node bin/orch.mjs ... --json, as { status, body } (status 200, or the error's status).
async function orch(...args) {
  const r = await proc([path.join(ROOT, 'bin/orch.mjs'), ...args, '--json']);
  let body;
  try {
    body = JSON.parse(r.out);
  } catch {
    throw new Error(`orch ${args.join(' ')}: not JSON: ${r.out} ${r.err}`);
  }
  return { status: r.code === 0 ? 200 : body.status || 500, body };
}
const orchText = (...args) => proc([path.join(ROOT, 'bin/orch.mjs'), ...args]);

// The calls the tests used to make to the server, done with the orch command.
async function api(method, url, body = {}) {
  const m = (re) => re.exec(url);
  let x;
  const yes = (v) => (v ? 'on' : 'off');
  const repoArgs = (repos) => {
    if (!repos) return [];
    const out = ['--repos', repos.length ? repos.map((r) => r.token).join(',') : 'none'];
    const bases = repos.filter((r) => r.base).map((r) => `${r.token}=${r.base}`);
    return bases.length ? [...out, '--base', bases.join(',')] : out;
  };
  if (method === 'GET' && url === '/api/runs') return orch('runs', '--all');
  if (method === 'GET' && url === '/api/stats') return orch('stats');
  if (method === 'GET' && url === '/api/skills') return orch('skills');
  if (method === 'GET' && url === '/api/templates') return orch('templates');
  if (method === 'GET' && url === '/api/repos') return orch('repos');
  if (method === 'GET' && url === '/api/suggestions') return orch('suggestions', '--all');
  if (method === 'GET' && url === '/api/instructions') return orch('rules');
  if (method === 'PUT' && url === '/api/instructions') return orch('rules', '--set', body.text);
  if (method === 'PUT' && url === '/api/settings') {
    const words = [];
    if (body.maxRunning !== undefined) words.push(`max=${body.maxRunning}`);
    for (const k of ['learn']) if (body[k] !== undefined) words.push(`${k}=${typeof body[k] === 'boolean' ? yes(body[k]) : body[k]}`);
    return orch('settings', ...words);
  }
  if (method === 'POST' && url === '/api/runs') return orch('start', body.templateId ?? '', '--text', body.input?.text ?? '', ...(body.start === false ? ['--draft'] : []), ...repoArgs(body.repos));
  if (method === 'POST' && url === '/api/runs/batch') {
    const r = await orch('start', body.templateId, ...body.inputs, ...(body.start === false ? ['--draft'] : []), ...repoArgs(body.repos));
    if (r.status === 200 && !Array.isArray(r.body)) r.body = [r.body];
    return r;
  }
  if ((x = m(/^\/api\/templates\/([^/]+)$/))) {
    const id = decodeURIComponent(x[1]);
    if (method === 'GET') return orch('template', 'show', id);
    if (method === 'PUT') return orch('template', 'save', id, '--json-in', JSON.stringify(body));
    if (method === 'DELETE') return orch('template', 'delete', id);
  }
  if ((x = m(/^\/api\/skill-marks\/([^/]+)$/))) {
    const r = await orch('skill-mark', decodeURIComponent(x[1]), body.mark);
    return r.status === 200 ? orch('skills') : r;
  }
  if ((x = m(/^\/api\/suggestions\/([^/]+)$/))) return orch('suggestion', x[1], body.action, ...(body.text !== undefined ? ['--text', body.text] : []));
  if ((x = m(/^\/api\/runs\/([^/?]+)(\?force=1)?$/))) {
    const id = decodeURIComponent(x[1]);
    if (method === 'GET') return orch('run', id);
    if (method === 'DELETE') return orch('delete', id, ...(x[2] ? ['--force'] : []));
  }
  if ((x = m(/^\/api\/runs\/([^/]+)\/(\w[\w-]*)(\?force=1)?$/))) {
    const [, id, what, force] = x;
    const f = force ? ['--force'] : [];
    if (what === 'timeline') return orch('timeline', id);
    if (what === 'boxes') return orch('boxes', id, '--set', JSON.stringify(body.boxes));
    if (what === 'stop') return orch('stop', id);
    if (what === 'resume') return orch('reopen', id);
    if (what === 'clean-up') return orch('clean', id, ...f);
    if (what === 'learn') return orch('lessons', id);
  }
  throw new Error(`no orch command for ${method} ${url}`);
}

// The launcher's calls to the runner.
async function runnerCall(method, args) {
  const r = await proc([path.join(ROOT, 'test/runner-call.mjs'), method, JSON.stringify(args)]);
  const body = JSON.parse(r.out);
  return { status: r.code === 0 ? 200 : body.status, body };
}

// A stand-in for the in-tab launcher process: alive until the run is stopped (which ends it).
const sleepers = [];
function fakeLauncher() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  sleepers.push(p);
  return p.pid;
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const getRun = async (id) => (await api('GET', `/api/runs/${id}`)).body;
const waitStatus = (id, status, ms) => waitFor(async () => ((await getRun(id)).status === status ? getRun(id) : null), `run ${id} to be ${status}`, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the run's terminal session sends.
// A Claude hook call from the run's session: bin/hook.mjs with the session's env.
async function hook(run, event, body = {}, token = run.hookToken) {
  const r = await proc([path.join(ROOT, 'bin/hook.mjs'), event], { input: JSON.stringify(body), extraEnv: { ORCHESTRA_RUN_ID: run.id, ORCHESTRA_HOOK_TOKEN: token } });
  if (event === 'status') return { status: 200, body: { line: r.out } };
  return { status: 200, body: r.out.trim() ? { output: JSON.parse(r.out) } : {} };
}
const launch = (run, pid = '', token = run.hookToken) => runnerCall('launchSpec', [run.id, token, pid]);
const done = (text) => ({ last_assistant_message: `${text}\n\nWHAT I DID AND WHY:\n- I did ${text}, because the box asked.\nORCHESTRA:DONE` });
const say = (text) => ({ last_assistant_message: text });
const context = (r) => r.body.output?.hookSpecificOutput?.additionalContext || '';
const logs = async (run) => (await api('GET', `/api/runs/${run.id}/timeline`)).body.filter((e) => e.kind === 'log').map((e) => e.text);

// Makes a run (with these boxes, if given), starts it, and waits for its terminal session.
async function startRun(boxes, { input = 'demo', templateId = 'demo-hello-recap' } = {}) {
  const { body: d } = await api('POST', '/api/runs', { templateId, input: { text: input }, start: false });
  if (boxes) assert.equal((await api('PUT', `/api/runs/${d.id}/boxes`, { boxes })).status, 200);
  assert.equal((await api('POST', `/api/runs/${d.id}/resume`)).status, 200);
  const run = await waitFor(async () => {
    const r = await getRun(d.id);
    return r.session?.open ? r : null;
  }, 'the terminal session to open');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  return getRun(d.id);
}
const close = (run) => api('POST', `/api/runs/${run.id}/stop`);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- parts ----

test('frontmatter: plain, quoted and folded values', () => {
  const fm = parseFrontmatter('---\nname: "x-skill"\ndescription: >\n  line one\n  line two\nother: y\n---\nbody');
  assert.equal(fm.name, 'x-skill');
  assert.equal(fm.description, 'line one line two');
  assert.equal(fm.other, 'y');
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('frontmatter: YAML escapes, BOM and multi-line plain values', () => {
  const fm = parseFrontmatter("﻿---\nname: x\na: 'it''s'\nb: \"say \\\"hi\\\"\"\nc: first part\n  second part\nd: z\n---\n");
  assert.equal(fm.name, 'x');
  assert.equal(fm.a, "it's");
  assert.equal(fm.b, 'say "hi"');
  assert.equal(fm.c, 'first part second part');
  assert.equal(fm.d, 'z');
});

test('child claude gets no API key and no parent-session variables', () => {
  const env = childEnv({ X: '1' }, { base: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_GIT_BASH_PATH: 'keep', ORCHESTRA_TRACKING: 'on' } });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ORCHESTRA_TRACKING, undefined, 'Orchestra decides it per run, never inherited');
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'keep', 'user settings stay');
  assert.equal(env.X, '1');
});

test('guard: push and PR need your OK; main and --no-verify are always refused', () => {
  const v = (command, allow = false) => check('Bash', { command }, { ORCHESTRA_ALLOW_PUSH: allow ? '1' : '0' });
  for (const c of ['git push', 'git push -u origin feature/x', 'cd repo && git -C x push origin y', 'gh pr create --fill']) {
    assert.equal(v(c)?.needsApproval, true, c);
    assert.equal(v(c, true), null, `${c} when allowed`);
  }
  for (const c of ['git push origin main', 'git push origin HEAD:main', 'git push origin feature/x --no-verify', 'git checkout main', 'git switch main']) {
    assert.equal(v(c, true)?.needsApproval, false, `${c} refused always`);
  }
  for (const c of ['git status', 'git log origin/main', 'git merge-base HEAD origin/main', 'git checkout main -- file.txt', 'echo push', 'git commit -m "push later"']) {
    assert.equal(v(c), null, c);
  }
  assert.equal(check('PowerShell', { command: 'git push origin x' }, {})?.needsApproval, true);
  assert.equal(check('Read', { file_path: 'x' }, {}), null);
});

test('guard hook: a push gets Claude\'s Allow prompt; a push to main is refused', () => {
  const run = (command) => spawnSync(process.execPath, [path.join(ROOT, 'lib/guard-hook.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, ORCHESTRA_ALLOW_PUSH: '1' } });
  const ask = run('git push -u origin epics/x');
  assert.equal(ask.status, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask', 'asked even though the session allows pushes');
  const main = run('git push origin main');
  assert.equal(main.status, 2);
  assert.match(main.stderr, /main branch/);
  assert.equal(run('git status').status, 0);
});

test('guard: reply markers are found on the last line and removed', () => {
  assert.deepEqual(readMark('All set.\n\n**ORCHESTRA:DONE**\n'), { mark: 'ORCHESTRA:DONE', text: 'All set.' });
  assert.equal(readMark('Cannot.\n`ORCHESTRA:FAILED`').mark, 'ORCHESTRA:FAILED');
  assert.equal(readMark('I wrote ORCHESTRA:DONE in a file.\nStill going.').mark, null);
  assert.deepEqual(readWhy('Done.\n\n## What I did and why\n- a, because b'), { text: 'Done.', why: '- a, because b' });
  assert.equal(readWhy('No note here.').why, null);
});

test('the reply is read from the transcript when the hook does not send it', () => {
  const file = path.join(tmp, 'transcript.jsonl');
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: 'user', message: { content: 'go' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'All good.' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ORCHESTRA:DONE' }] } }),
  ].join('\n'));
  assert.equal(lastReply({ transcript_path: file }), 'All good.\nORCHESTRA:DONE');
  assert.equal(lastReply({ last_assistant_message: 'given' }), 'given');
  assert.equal(lastReply({ transcript_path: path.join(tmp, 'nope.jsonl') }), '');
});

test('git hooks: push waits for Approve, main is refused, the repo hook still runs', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-git-'));
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: path.join(t, 'work'), encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra } });
  try {
    spawnSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: t });
    spawnSync('git', ['clone', '-q', 'remote.git', 'work'], { cwd: t });
    fs.writeFileSync(path.join(t, 'work', 'a'), 'a');
    git(['checkout', '-q', '-b', 'main']);
    git(['add', 'a']);
    assert.equal(git(['commit', '-qm', 'a']).status, 0);
    assert.equal(git(['push', '-q', 'origin', 'main']).status, 0, 'no guard yet');
    git(['checkout', '-q', '-b', 'feature/x']);
    const guard = (allow) => ({ ...guardEnv(t, allow), ORCHESTRA_RUN_DIR: t });
    fs.writeFileSync(path.join(t, 'work', 'b'), 'b');
    git(['add', 'b']);
    assert.equal(git(['commit', '-qm', 'b'], guard(false)).status, 0, 'commit on the work branch is fine');
    const blocked = git(['push', '-q', 'origin', 'feature/x'], guard(false));
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /needs the user's Approve/);
    assert.equal(git(['push', '-q', 'origin', 'feature/x'], guard(true)).status, 0, 'allowed when the session allows pushes');
    assert.match(git(['push', '-q', 'origin', 'feature/x:main'], guard(true)).stderr, /main branch is refused/);
    git(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(t, 'work', 'c'), 'c');
    git(['add', 'c']);
    assert.match(git(['commit', '-qm', 'c'], guard(false)).stderr, /main branch is refused/);
    // The vault is committed on main by design: allowed there, and only there. Pushing it to main is still refused.
    const vault = { ...guard(true), ORCHESTRA_MAIN_OK: `C:/elsewhere/ITPKV\n${path.join(t, 'work')}` };
    assert.match(git(['commit', '-qm', 'c'], { ...guard(false), ORCHESTRA_MAIN_OK: 'C:/elsewhere/ITPKV' }).stderr, /main branch is refused/);
    assert.equal(git(['commit', '-qm', 'c'], vault).status, 0, 'a vault commit on main');
    assert.match(git(['push', '-q', 'origin', 'main'], vault).stderr, /main branch is refused/);
    assert.equal(check('Bash', { command: 'git -C ITPKV checkout main' }, {}), null, 'the vault may stay on main');
    assert.ok(check('Bash', { command: 'git -C ITP-API checkout main' }, {}));
    git(['checkout', '-q', 'feature/x']);
    fs.writeFileSync(path.join(t, 'work', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho REPO-HOOK-RAN >&2\n', { mode: 0o755 });
    fs.writeFileSync(path.join(t, 'work', 'd'), 'd');
    git(['add', 'd']);
    const own = git(['commit', '-qm', 'd'], guard(false));
    assert.equal(own.status, 0);
    assert.match(own.stderr, /REPO-HOOK-RAN/);
  } finally {
    fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('wrap up: only while its step works may the ITP folder commit Execution/ files on main and push them', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-itp-'));
  const itp = path.join(t, 'itp');
  const run = path.join(t, 'run');
  fs.mkdirSync(run);
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: itp, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra } });
  const env = (more = {}) => ({ ...guardEnv(run, true), ORCHESTRA_ITP_ROOT: itp.replace(/\\/g, '/'), ...more });
  const flag = (on) => (on ? fs.writeFileSync(path.join(run, 'wrap-up.ok'), 'x') : fs.rmSync(path.join(run, 'wrap-up.ok'), { force: true }));
  try {
    spawnSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: t });
    spawnSync('git', ['clone', '-q', 'remote.git', 'itp'], { cwd: t });
    git(['checkout', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(itp, 'Execution'));
    fs.writeFileSync(path.join(itp, 'Execution', 'e.json'), '{}');
    git(['add', '.']);
    assert.match(git(['commit', '-qm', 'e'], env()).stderr, /main branch is refused/, 'not outside Wrap up');
    flag(true);
    assert.equal(git(['commit', '-qm', 'e'], env()).status, 0, 'an Execution file on main, in Wrap up');
    fs.writeFileSync(path.join(itp, 'other.txt'), 'x');
    git(['add', 'other.txt']);
    assert.match(git(['commit', '-qm', 'o'], env()).stderr, /only Execution\/ files may be committed/);
    git(['reset', '-q', 'other.txt']);
    assert.equal(git(['push', '-q', 'origin', 'main'], env()).status, 0, 'pushed to main in Wrap up');
    flag(false);
    fs.writeFileSync(path.join(itp, 'Execution', 'f.json'), '{}');
    git(['add', 'Execution/f.json']);
    assert.match(git(['commit', '-qm', 'f'], env()).stderr, /main branch is refused/, 'refused again after it');
    // The vault pushes to main only in Wrap up too.
    const vault = env({ ORCHESTRA_ITP_ROOT: 'C:/elsewhere', ORCHESTRA_MAIN_OK: itp });
    assert.equal(git(['commit', '-qm', 'f'], vault).status, 0, 'a vault commit on main');
    assert.match(git(['push', '-q', 'origin', 'main'], vault).stderr, /main branch is refused/);
    flag(true);
    assert.equal(git(['push', '-q', 'origin', 'main'], vault).status, 0, 'the vault push in Wrap up');
    // The Claude guard: the same, and the run's own folder is out of reach.
    const g = { ORCHESTRA_RUN_DIR: run, ORCHESTRA_ITP_ROOT: 'C:/Work/ITP' };
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP push origin main' }, g)?.needsApproval, true);
    assert.equal(check('Bash', { command: 'git -C "C:\\Work\\ITP" push origin main' }, g)?.needsApproval, true);
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP/ITP-API push origin main' }, g)?.needsApproval, false, 'a repo inside ITP is not ITP');
    assert.equal(check('Write', { file_path: path.join(run, 'state.json') }, g)?.needsApproval, false);
    assert.equal(check('Bash', { command: 'touch "$ORCHESTRA_RUN_DIR/wrap-up.ok"' }, g)?.needsApproval, false);
    // A tab opened before ORCHESTRA_ITP_ROOT existed: the flag tells where the ITP folder is.
    fs.writeFileSync(path.join(run, 'wrap-up.ok'), itp.replace(/\\/g, '/'));
    const old = { ...guardEnv(run, true), ORCHESTRA_ITP_ROOT: '' };
    fs.writeFileSync(path.join(itp, 'Execution', 'g.json'), '{}');
    git(['add', 'Execution/g.json']);
    assert.equal(git(['commit', '-qm', 'g'], old).status, 0, 'an old tab commits Execution files in Wrap up');
    assert.equal(git(['push', '-q', 'origin', 'main'], old).status, 0, 'and pushes them');
    assert.equal(check('Bash', { command: `git -C ${itp.replace(/\\/g, '/')} push origin main` }, { ORCHESTRA_RUN_DIR: run })?.needsApproval, true);
    flag(false);
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP push origin main' }, g)?.needsApproval, false, 'refused outside Wrap up');
  } finally {
    fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('skills list includes Orchestra test skills and team skills', async () => {
  const { body } = await api('GET', '/api/skills');
  const names = body.map((s) => s.name);
  assert.ok(names.includes('orchestra-hello') && names.includes('orchestra-recap'));
  if (fs.existsSync('C:\\Workstation\\Workspace\\ITP\\.claude\\skills\\review-changes')) {
    assert.equal(body.find((s) => s.name === 'review-changes')?.source, 'team');
  }
  assert.ok(!names.some((n) => n.startsWith('_')), 'folders starting with _ are skipped');
  // Many runs stay open in these tests; give them room.
  assert.equal((await api('PUT', '/api/settings', { maxRunning: 20 })).status, 200);
});

// ---- the terminal session ----

test('a run opens a terminal tab; its launcher gets the session, the hooks and the first box', async () => {
  const run = await startRun(null, { input: 'Bappy' });
  const cmd = run.session.command;
  assert.deepEqual(cmd.slice(0, 4), ['wt', '-w', 'orchestra', 'new-tab']);
  assert.ok(cmd.includes(path.join(ROOT, 'bin', 'launch.mjs')) && cmd.includes(run.id) && cmd.includes(run.hookToken));
  assert.ok(!cmd.some((c) => /^http/.test(c)), 'no server address');
  assert.equal(run.boxes[0].status, 'running');

  // The tab splits: the steps pane (orch watch) on the right, focus back on claude.
  const split = cmd.indexOf('split-pane');
  assert.ok(split > 0 && cmd[split - 1] === ';', 'a split pane');
  assert.deepEqual(cmd.slice(-6), [path.join(ROOT, 'bin', 'orch.mjs'), 'watch', run.id, ';', 'move-focus', 'left']);
  const pane = await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once']);
  assert.equal(pane.code, 0, pane.err);
  const shown = pane.out.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(shown, /● 1 Say hello/);
  assert.match(shown, /○ 2 /);
  assert.match(shown, /Now:\s+working on "Say hello"/);

  assert.equal((await launch(run, '', 'wrong')).status, 403);
  const pid = fakeLauncher();
  const { status, body: spec } = await launch(run, pid);
  assert.equal(status, 200);
  const a = spec.args;
  assert.equal(a[a.indexOf('--resume') + 1], run.sessionId, 'the session started, so it resumes');
  assert.equal(a.at(-1), '/orchestra-hello Bappy', 'the first box, with the run input');
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  for (const e of ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) assert.ok(settings.hooks[e], e);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 1800, 'the Stop hook may wait for the app');
  assert.match(settings.statusLine.command, /bin\/hook\.mjs" status$/);
  const rules = a[a.indexOf('--append-system-prompt') + 1];
  assert.match(rules, /ORCHESTRA:DONE/);
  assert.match(rules, /Tracking is OFF/, 'the demo template has tracking off');
  assert.equal(a[a.indexOf('--add-dir') + 1], 'C:/Workstation/Workspace/ITP', 'the real ITP folder, behind the links');
  assert.ok(a[a.indexOf('--add-dir') + 2].startsWith('--'), '--add-dir takes several folders: a flag must follow it, not the prompt');
  assert.equal(spec.env.ORCHESTRA_RUN_ID, run.id);
  assert.equal(spec.env.ORCHESTRA_HOOK_TOKEN, run.hookToken);
  assert.equal(spec.env.ORCHESTRA_ALLOW_PUSH, '1', 'git lets pushes through; Claude asks you first');
  assert.equal(spec.env.ITP_REGISTRY_OFF, '1');
  assert.match(spec.env.GIT_CONFIG_VALUE_0 || Object.values(spec.env).join(' '), /git-hooks/);
  assert.equal((await getRun(run.id)).session.pid, pid);
  assert.ok(!(await launch(run)).body.args.includes('/orchestra-hello Bappy'), 'the first box is given once');
  await close(run);
});

test('models: a step with another model or effort restarts claude on the same conversation; costs carry over', async () => {
  // A template default, one step that overrides it, checked values, and ultracode said to be costly.
  assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'model-demo')).code, 0);
  assert.equal((await orchText('template', 'set', 'model-demo', 'model=opus', 'effort=high')).code, 0);
  assert.equal((await orchText('template', 'box', 'model-demo', 'recap', 'model=sonnet')).code, 0);
  assert.match((await orchText('template', 'box', 'model-demo', 'recap', 'model=GPT 4!')).err, /model must be opus, sonnet/);
  assert.match((await orchText('template', 'box', 'model-demo', 'recap', 'effort=huge')).err, /effort must be low, medium/);
  assert.match((await orchText('template', 'box', 'model-demo', 'hello', 'effort=ultracode')).out, /hello[^\n]*ultracode \(many helpers, costly\)/);
  const shown = (await orchText('template', 'box', 'model-demo', 'hello', 'effort=none')).out;
  assert.match(shown, /default opus, effort high/);
  assert.match(shown, /2\. Recap [^\n]*sonnet/);
  assert.doesNotMatch(shown, /ultracode/);

  const run = await startRun(null, { templateId: 'model-demo' });
  assert.deepEqual(run.boxes.map((b) => [b.model, b.effort]), [['opus', 'high'], ['sonnet', 'high']], 'the template fills the steps that name none');
  const { body: spec } = await launch(run, fakeLauncher());
  const a = spec.args;
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'high');
  const set = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual(set.enabledMcpjsonServers, ['opensearch', 'jira', 'bitbucket', 'mongodb', 'mongodb-app', 'mongodb-global'], 'the servers runs use, with no prompt');
  assert.ok(set.disabledMcpjsonServers.includes('FM-MCP') && set.disabledMcpServers.includes('FM-MCP'), 'a lighter session');
  assert.equal(set.enabledPlugins['cowork-plugin-management@synced'], false);
  assert.equal(set.enableArtifact, false);
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1', 'no helper-agent workflows unless the step asks for ultracode');
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_CRON, '1');
  assert.match((await hook(run, 'status', { model: { display_name: 'Opus 5.5' }, cost: { total_cost_usd: 0.05 } })).body.line, /Say hello · Opus 5\.5 · \$0\.05/);

  // Recap wants sonnet: no block (claude ends its turn), the restart flag is set, the box is started.
  assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {});
  let now = await getRun(run.id);
  assert.deepEqual(now.boxes.map((b) => b.status), ['done', 'running']);
  assert.equal(now.restart.model, 'sonnet');
  assert.ok(fs.existsSync(path.join(runsDir, run.id, 'restart.ok')));
  // claude ending now is the launcher's doing: the session stays open and the run keeps working.
  await hook(run, 'SessionEnd', { reason: 'other' });
  now = await getRun(run.id);
  assert.equal(now.session.open, true);
  assert.equal(now.status, 'running');

  const { status, body: again } = await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  assert.equal(status, 200);
  const b = again.args;
  assert.equal(b[b.indexOf('--resume') + 1], run.sessionId, 'the same conversation');
  assert.equal(b[b.indexOf('--model') + 1], 'sonnet');
  assert.equal(b[b.indexOf('--effort') + 1], 'high');
  assert.match(b.at(-1), /run the skill \/orchestra-recap/, 'the step comes as the first prompt');
  now = await getRun(run.id);
  assert.equal(now.restart, null);
  assert.ok(!fs.existsSync(path.join(runsDir, run.id, 'restart.ok')));
  assert.equal((await runnerCall('relaunchSpec', [run.id, run.hookToken, 1])).status, 409, 'only when asked');
  // The resumed claude goes on from its saved total: 0 before it restored it (skipped), then the running total.
  await hook(run, 'status', { cost: { total_cost_usd: 0 } });
  assert.equal((await getRun(run.id)).cost, 0.05, 'never back to 0');
  await hook(run, 'status', { cost: { total_cost_usd: 0.07 } });
  assert.equal((await getRun(run.id)).cost, 0.07, 'not counted twice');
  assert.equal((await getRun(run.id)).boxes[1].cost || 0, 0);
  assert.match((await logs(run)).join('\n'), /restarted claude with sonnet · effort high/);
  assert.deepEqual((await hook(run, 'Stop', done('recap'))).body, {});
  assert.equal((await getRun(run.id)).status, 'done');
  await close(run);
  assert.equal((await orchText('template', 'delete', 'model-demo')).code, 0);
});

test('models: next or redo onto a step with another model restarts too; the same model does not', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello', waitAfter: true },
    { id: 'recap', skill: 'orchestra-recap', label: 'Recap', model: 'sonnet' },
  ]);
  const { body: spec } = await launch(run, fakeLauncher());
  assert.ok(!spec.args.includes('--model'), 'a step with no model: claude starts with your default');
  await hook(run, 'Stop', done('hello'));
  assert.equal((await getRun(run.id)).status, 'waiting');
  const r = await hook(run, 'UserPromptSubmit', { prompt: 'next' });
  assert.equal(r.body.output.decision, 'block', 'the old claude does not start the step');
  assert.match(r.body.output.reason, /restarts this tab with sonnet for "Recap"/);
  await runnerCall('relaunchSpec', [run.id, run.hookToken, (await getRun(run.id)).session.pid]);
  // redo of the step that runs now: same model, no restart.
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'redo' })), /run this step again/);
  assert.equal((await getRun(run.id)).restart, null);
  await close(run);
});

test('models: the launcher stops claude and starts it again in the same tab with the next step\'s model', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello' },
    { id: 'recap', skill: 'orchestra-recap', label: 'Recap', model: 'sonnet', effort: 'low' },
  ]);
  const log = path.join(tmp, `tab-${run.id}.log`);
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const tab = spawn(process.execPath, [path.join(ROOT, 'bin/launch.mjs'), run.id, run.hookToken], {
    env: { ...env, ORCHESTRA_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude-tab.mjs'), FAKE_TAB_LOG: log, ORCHESTRA_RESTART_GRACE_MS: '100' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  tab.stdout.on('data', (d) => (out += d));
  try {
    await waitFor(() => lines().length === 1, 'claude to start');
    assert.ok(!lines()[0].args.includes('--model'));
    await hook(run, 'Stop', done('hello'));
    await waitFor(() => lines().length === 2, 'claude to start again');
    const [first, second] = lines();
    assert.equal(second.args[second.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(second.args[second.args.indexOf('--effort') + 1], 'low');
    assert.match(second.args.at(-1), /\/orchestra-recap/);
    assert.equal(tab.exitCode, null, 'the same launcher, so the same tab');
    await waitFor(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 'the first claude to be stopped');
    assert.match(out, /runs with sonnet\. Restarting claude on the same conversation/);
    const now = await getRun(run.id);
    assert.equal(now.session.open, true);
    assert.equal(now.status, 'running');
  } finally {
    await close(run);
    await waitFor(() => tab.exitCode !== null, 'the tab to close', 10000).catch(() => tab.kill());
    for (const l of lines()) try { process.kill(l.pid); } catch {}
  }
});

test('fresh: a step starts a new conversation with the story so far; the cost goes on; clean-up forgets both', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello' },
    { id: 'recap', skill: 'orchestra-recap', label: 'Recap', fresh: true, effort: 'ultracode' },
  ]);
  const first = run.sessionId;
  await launch(run, fakeLauncher());
  await hook(run, 'status', { cost: { total_cost_usd: 0.05 } });
  assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {}, 'no block: this conversation ends its turn');
  assert.equal((await getRun(run.id)).restart.fresh, true);
  const { body: spec } = await runnerCall('relaunchSpec', [run.id, run.hookToken, (await getRun(run.id)).session.pid]);
  const a = spec.args;
  assert.ok(!a.includes('--resume'), 'not the old conversation');
  const second = a[a.indexOf('--session-id') + 1];
  assert.ok(second && second !== first, 'a new conversation');
  const prompt = a.at(-1);
  assert.match(prompt, /continues an Orchestra run in a new conversation/);
  assert.match(prompt, /Say hello \(\/orchestra-hello\): - I did hello, because the box asked\./, 'what the step before did');
  assert.match(prompt, /run the skill \/orchestra-recap/);
  assert.equal(a[a.indexOf('--effort') + 1], 'ultracode');
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_WORKFLOWS, undefined, 'an ultracode step gets its helper agents');
  await hook(run, 'SessionStart', { session_id: second, source: 'startup' });
  // The new conversation counts from 0; the run adds it to the one before.
  await hook(run, 'status', { cost: { total_cost_usd: 0.02 } });
  let now = await getRun(run.id);
  assert.equal(now.cost, 0.07);
  assert.deepEqual(now.sessionIds, [first]);
  assert.equal(now.sessionId, second);
  assert.match((await logs(run)).join('\n'), /started a new conversation · effort ultracode/);
  await hook(run, 'Stop', done('recap'));
  assert.equal((await getRun(run.id)).boxes[1].cost, 0.02);

  // Clean-up removes both conversations' files.
  const proj = path.join(tmp, 'claude-projects', 'C--o-9');
  fs.mkdirSync(proj, { recursive: true });
  for (const id of [first, second]) fs.writeFileSync(path.join(proj, `${id}.jsonl`), '{}\n');
  await close(run);
  assert.equal((await api('POST', `/api/runs/${run.id}/clean-up`)).status, 200);
  for (const id of [first, second]) assert.ok(!fs.existsSync(path.join(proj, `${id}.jsonl`)), `conversation ${id} forgotten`);
});

test('a finished step moves on by itself; the last one ends the run; costs come from the status line', async () => {
  const run = await startRun();
  assert.match((await hook(run, 'status', { cost: { total_cost_usd: 0.05 } })).body.line, /Orchestra · Say hello · \$0\.05/);
  const r1 = await hook(run, 'Stop', done('hello'));
  assert.equal(r1.body.output.decision, 'block');
  assert.match(r1.body.output.reason, /run the skill \/orchestra-recap/);
  let now = await getRun(run.id);
  assert.deepEqual(now.boxes.map((b) => b.status), ['done', 'running']);
  assert.equal(now.boxes[0].summary, 'hello');
  assert.equal(now.boxes[0].didWhy, '- I did hello, because the box asked.');
  assert.equal(now.boxes[0].cost, 0.05);
  await hook(run, 'status', { cost: { total_cost_usd: 0.08 } });
  assert.deepEqual((await hook(run, 'Stop', done('recap'))).body, {}, 'the last box: Claude may stop');
  now = await getRun(run.id);
  assert.equal(now.status, 'done');
  assert.equal(now.boxes[1].cost, 0.03);
  assert.equal(now.cost, 0.08);
  const { body: tpl } = await api('GET', '/api/templates/demo-hello-recap');
  assert.equal(tpl.boxes[0].status, undefined, 'the template stays the same');
  await close(run);
});

test('the run says what its ticket is about; the steps pane, run and board show it', async () => {
  const run = await startRun(null, { input: 'ITP2-777' });
  const rules = (await launch(run, fakeLauncher())).body.args;
  assert.match(rules[rules.indexOf('--append-system-prompt') + 1], /ORCHESTRA:ABOUT:/, 'asked in the system prompt');
  // The ABOUT line sits above the DONE line: the step still counts as done.
  await hook(run, 'Stop', done('hello\n**ORCHESTRA:ABOUT: Fix the login page - the button must show for new users.**'));
  let now = await getRun(run.id);
  assert.equal(now.about, 'Fix the login page - the button must show for new users.');
  assert.deepEqual(now.boxes.map((b) => b.status), ['done', 'running']);
  assert.ok(!now.boxes[0].summary.includes('ORCHESTRA:ABOUT'), 'the line is taken out of the step summary');
  assert.equal(context(await hook(run, 'UserPromptSubmit', { prompt: 'thanks' })), '', 'known: no more asking');
  await hook(run, 'Stop', done('hello\nORCHESTRA:ABOUT: something else'));
  assert.equal((await getRun(run.id)).about, now.about, 'said once; a later line does not replace it');

  const pane = await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once']);
  assert.match(pane.out, /ITP2-777[^\n]*\n[^\n]*Fix the login page/);
  assert.match((await proc([path.join(ROOT, 'bin/orch.mjs'), 'run', run.id])).out, /About: Fix the login page/);
  assert.match((await proc([path.join(ROOT, 'bin/orch.mjs'), 'runs'])).out, /Fix the login page/);
  assert.equal((await orch('about', run.id, 'Set by hand')).body.about, 'Set by hand');
  assert.equal((await orch('about', run.id)).body.about, 'Set by hand');
  await close(run);
});

test('pins: Claude pins steps, you pin answers and notes; the pane shows and scrolls them', async () => {
  const run = await startRun();
  const rules = (await launch(run, fakeLauncher())).body.args;
  assert.match(rules[rules.indexOf('--append-system-prompt') + 1], /ORCHESTRA:PIN <short title>/, 'asked in the system prompt');
  const blocked = (r) => (r.body.output?.decision === 'block' ? r.body.output.reason : null);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'pin' })), /no answer from Claude/);

  // Claude pins: the block leaves the reply's marker lines, the step still counts as done.
  const steps = ['1. Open **Pillar 2** → GIR', '2. Pick form type `GIR`, year 2025', ...Array.from({ length: 30 }, (_, i) => `${i + 3}. check row ${i + 3} shows a total that is not zero, and the long line wraps in the narrow pane`)];
  const block = `**ORCHESTRA:PIN Test steps**\n${steps.join('\n')}\nORCHESTRA:END`;
  await hook(run, 'Stop', say(`Ready to test.\n${block}\nTell me what fails.\n\nWHAT I DID AND WHY:\n- planned the test\nORCHESTRA:DONE`));
  await hook(run, 'Stop', say(`Here they are again:\n${block}`));
  let now = await getRun(run.id);
  assert.deepEqual(now.boxes.map((b) => b.status), ['done', 'running']);
  assert.equal(now.pins.length, 1, 'the same steps again are not pinned twice');
  assert.equal(now.pins[0].title, 'Test steps');
  assert.equal(now.pins[0].from, 'claude');
  assert.match(now.pins[0].text, /^1\. Open \*\*Pillar 2\*\* → GIR\n2\./);
  assert.ok(!now.boxes[0].summary.includes('ORCHESTRA:PIN') && now.boxes[0].summary.includes('Open'), 'the markers go, the steps stay');

  // You pin Claude's last answer (the prompt is not sent), and the one before; and a note.
  await hook(run, 'Stop', say('Use client Demo-3 and year 2025.\n\nWHAT I DID AND WHY:\n- notes'));
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'pin' })), /pinned "Use client Demo-3 and year 2025\." .*2 pins/);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'PIN 2' })), /pinned "Here they are again:/);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'pin: login as admin, then F12' })), /4 pins/);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'pin 9' })), /no answer 9 back/);
  for (const talk of ['pin the lodash version please', 'pin all', 'unpin: why?', 'pinned?']) {
    assert.equal(blocked(await hook(run, 'UserPromptSubmit', { prompt: talk })), null, `"${talk}" is talk`);
  }
  now = await getRun(run.id);
  assert.deepEqual(now.pins.map((p) => p.from), ['claude', 'answer', 'answer', 'you']);
  assert.ok(!now.pins[1].text.includes('WHAT I DID'), 'the notes are left out');
  const said = now.chat.map((m) => m.text);
  assert.ok(!said.some((t) => /^pin( \d+|:.*)?$/i.test(t)), 'pin words are not talk');
  assert.ok(said.includes('pin the lodash version please'), 'talk stays talk');

  // The pane: newest first, the steps fold to make room, the pin scrolls, ← → pick another pin.
  const pane = async (...a) => (await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once', ...a])).out;
  let out = await pane('--rows', '24', '--cols', '40', '--pin', '4');
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 24, 'fits the pane');
  assert.ok(lines.every((l) => l.replace(/\x1b\[[\d;]*m/g, '').length <= 39), 'no line is wider than the pane');
  assert.match(out, /Pinned 4\/4 · Test steps/);
  assert.match(out, /1\. Open Pillar 2 → GIR/, 'markdown marks dropped');
  assert.match(out, /↓ \d+ more/);
  assert.match(out, /←→ pins/);
  out = await pane('--rows', '24', '--cols', '40', '--pin', '4', '--scroll', '999');
  assert.match(out, /32\. check row 32/);
  assert.match(out, /end · ↑↓ scroll · ←→ pins/);
  assert.match(await pane('--rows', '24', '--cols', '40'), /Pinned 1\/4 · login as admin/);
  assert.match(await pane('--pin', '4'), /2\. Pick form[\s\S]*32\. check row 32/, 'no --rows: every line');

  // unpin: the one a running pane shows (pane.json), a number, all. A note from a pane that is gone does not count.
  const paneNote = path.join(runsDir, run.id, 'pane.json');
  fs.writeFileSync(paneNote, JSON.stringify({ pin: now.pins[1].id, pid: 999999 }));
  await orch('pin', run.id, 'throwaway');
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'unpin' })), /unpinned "throwaway"/, 'no pane: the newest');
  fs.writeFileSync(paneNote, JSON.stringify({ pin: now.pins[1].id, pid: process.pid }));
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'unpin' })), /unpinned "Use client Demo-3/);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'unpin 7' })), /no pin 7 \(there are 3\)/);
  assert.equal((await orch('unpin', run.id, '1')).body.removed[0].from, 'you');
  assert.equal((await orch('pin', run.id, 'Global DB, project P2-Demo', '--title', 'Data')).body.pins.at(-1).title, 'Data');
  assert.match((await orchText('pin', run.id)).out, /── 1\. Data \(your note[\s\S]*Global DB, project P2-Demo[\s\S]*── 3\. Test steps \(pinned by Claude/);
  assert.match((await orchText('run', run.id)).out, /Pinned: 3 \(1. Data · 2. Here they are again/);
  assert.match(blocked(await hook(run, 'UserPromptSubmit', { prompt: 'Unpin ALL' })), /all 3 pins/);
  assert.match(await pane(), /Type pin on the left/);
  assert.equal((await orch('unpin', run.id)).status, 400);

  // A block with no END line stops at the FAILED line; the step still fails.
  await hook(run, 'Stop', say('ORCHESTRA:PIN Try it\n1. click Save\nORCHESTRA:FAILED'));
  now = await getRun(run.id);
  assert.equal(now.pins.at(-1).text, '1. click Save');
  assert.equal(now.boxes[1].status, 'failed');

  // Wide characters (✅ takes 2 columns) and narrow panes: no line is wider than the pane; __init__ stays.
  await orch('pin', run.id, `${'✅ build ok, '.repeat(8)}call __init__ and https://example.com/${'x'.repeat(80)}`);
  const width = (s) => Array.from(s.replace(/\x1b\[[\d;]*m/g, '')).reduce((n, ch) => n + (/[✅❌]/.test(ch) ? 2 : 1), 0);
  for (const c of [12, 21, 40]) {
    out = await pane('--rows', '14', '--cols', String(c));
    const ls = out.replace(/\n$/, '').split('\n');
    assert.ok(ls.length <= 14, `${c} cols: fits the rows`);
    assert.ok(ls.every((l) => width(l) <= c - 1), `${c} cols: no line wider than the pane:\n${ls.filter((l) => width(l) > c - 1).join('\n')}`);
  }
  assert.match(await pane('--cols', '200'), /call __init__ and/);
  await close(run);
});

test('the pane width is a setting', async () => {
  assert.equal((await orch('settings', 'panesize=45')).body.paneSize, 45);
  assert.equal((await orch('settings', 'panesize=90')).status, 400);
  const run = await startRun();
  const cmd = (await getRun(run.id)).session.command;
  assert.equal(cmd[cmd.indexOf('--size') + 1], '0.45');
  await orch('settings', 'panesize=30');
  await close(run);
});

test('no marker: the run needs you; FAILED fails; redo runs the box again; next skips it', async () => {
  const run = await startRun();
  await hook(run, 'Stop', say('Which color do you like? I suggest blue.'));
  let now = await getRun(run.id);
  assert.equal(now.status, 'needs-you');
  assert.match(now.asks, /Which color/);
  assert.equal(now.boxes[0].status, 'running', 'the box goes on with your answer');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'blue' })), /^Once you know what this run's ticket/, 'only the ABOUT ask');
  now = await getRun(run.id);
  assert.equal(now.status, 'running');
  assert.equal(now.chat.at(-1).text, 'blue', 'kept for the lessons');

  await hook(run, 'Stop', say('The file is locked.\nORCHESTRA:FAILED'));
  now = await getRun(run.id);
  assert.equal(now.status, 'failed');
  assert.equal(now.boxes[0].failures, 1);
  assert.match(now.boxes[0].error, /locked/);
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'redo' })), /run this step again.*\/orchestra-hello/);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.boxes[0].status, now.boxes[0].attempts], ['running', 'running', 2]);

  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-recap/);
  now = await getRun(run.id);
  assert.equal(now.boxes[0].note, 'marked done by you (next)');
  assert.equal(now.boxes[1].status, 'running');
  await hook(run, 'Stop', done('recap'));
  assert.equal((await getRun(run.id)).status, 'done');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /All steps .* are done/);
  await close(run);
});

// ---- the app, one run at a time (bin/app.mjs) ----

const APP_PORTS = 'api=47811,web=47812';
const appEnv = (run) => ({
  ORCHESTRA_RUN_ID: run.id,
  ORCHESTRA_HOOK_TOKEN: run.hookToken,
  ORCHESTRA_APP_PORTS: APP_PORTS,
  ORCHESTRA_APP_START: JSON.stringify([process.execPath, path.join(ROOT, 'test/fake-app.mjs'), '{ws}']),
  ORCHESTRA_APP_BUILD: JSON.stringify([process.execPath, '-e', 'console.log("built")']),
});
const app = (run, ...args) => proc([path.join(ROOT, 'bin/app.mjs'), ...args], { extraEnv: run ? appEnv(run) : { ORCHESTRA_APP_PORTS: APP_PORTS } });
const appUp = async () => {
  try {
    return (await fetch('http://localhost:47811/health')).ok;
  } catch {
    return false;
  }
};

test('app: runs wait in line for the app; it is held until next; a closed tab hands it on', async () => {
  const a = await startRun([{ id: 'test', skill: 'orchestra-hello', label: 'Test in the app', waitAfter: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  const b = await startRun();
  const c = await startRun();
  try {
    assert.match((await app(a, 'take', '--minutes', '0')).out, /You have the app/);
    const tb = await app(b, 'take', '--minutes', '0');
    assert.equal(tb.code, 3, 'not yet: run take again');
    assert.match(tb.out, /1st in line .*has it/);
    assert.match((await app(c, 'take', '--minutes', '0')).out, /2nd in line/);
    assert.match((await proc([path.join(ROOT, 'bin/orch.mjs'), 'status'])).out, /App: demo has it · next: demo, demo/);
    assert.match((await proc([path.join(ROOT, 'bin/orch.mjs'), 'runs'])).out, /waiting for the app: 1st in line/);

    // A's step ends and waits for you: A keeps the app.
    await hook(a, 'Stop', done('tested'));
    assert.equal((await getRun(a.id)).status, 'waiting');
    assert.equal((await app(b, 'take', '--minutes', '0')).code, 3, 'still held while A waits for you');
    // next hands it on, to the first in line (B), not C.
    await hook(a, 'UserPromptSubmit', { prompt: 'next' });
    assert.equal((await app(c, 'take', '--minutes', '0')).code, 3, 'C is 2nd: B goes first');
    assert.match((await app(b, 'take', '--minutes', '0')).out, /You have the app/);
    // B's tab closes: C gets it.
    await close(b);
    assert.match((await app(c, 'take', '--minutes', '0')).out, /You have the app/);
    // Only a run that has the app may start it; a run with no working step may not take it.
    const noApp = await app(a, 'start');
    assert.notEqual(noApp.code, 0);
    assert.match(noApp.err, /does not have the app/);
  } finally {
    for (const r of [a, b, c]) await close(r);
  }
});

test('app: start stops the app of the run before, starts this run\'s, and leaves an app it did not start alone', async () => {
  const a = await startRun();
  const b = await startRun();
  let mine;
  try {
    assert.match((await app(a, 'build')).out, /built/);
    await app(a, 'take', '--minutes', '0');
    const s1 = await app(a, 'start', '--minutes', '0.5');
    assert.equal(s1.code, 0, s1.err + s1.out);
    assert.match(s1.out, /The app is up/);
    const first = JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8'));
    assert.equal(first.runId, a.id);
    assert.match((await proc([path.join(ROOT, 'bin/orch.mjs'), 'app'])).out, /Serving: demo's code from/);

    // A lets go; B takes it and starts its own: A's app is stopped first.
    await app(a, 'release');
    assert.match((await app(b, 'take', '--minutes', '0')).out, /You have the app/);
    const s2 = await app(b, 'start', '--minutes', '0.5');
    assert.equal(s2.code, 0, s2.err + s2.out);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8')).runId, b.id);
    assert.ok(first.pids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }), "A's app is gone");

    // An app Orchestra did not start (your own) is not stopped without --force.
    assert.match((await app(null, 'stop')).out, /stopped/);
    assert.equal(await appUp(), false);
    mine = spawn(process.execPath, [path.join(ROOT, 'test/fake-app.mjs'), 'my-own-checkout'], { env: { ...env, ORCHESTRA_APP_PORTS: APP_PORTS }, stdio: 'ignore' });
    await waitFor(appUp, 'your own app to start');
    const refused = await app(b, 'start', '--minutes', '0.5');
    assert.equal(refused.code, 5);
    assert.match(refused.out, /did not start it/);
    assert.equal(await appUp(), true, 'your app still runs');
    const forced = await app(b, 'start', '--force', '--minutes', '0.5');
    assert.equal(forced.code, 0, forced.err + forced.out);
    assert.equal(mine.exitCode !== null || mine.signalCode !== null || !(() => { try { process.kill(mine.pid, 0); return true; } catch { return false; } })(), true, 'stopped after ok');
  } finally {
    await app(null, 'stop', '--force');
    mine?.kill();
    for (const r of [a, b]) await close(r);
  }
});

test('a "wait for me" box stops the run; next goes on; you are notified', async () => {
  const run = await startRun([{ id: 'hello', skill: 'orchestra-hello', waitAfter: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {}, 'Claude stops at the gate');
  let now = await getRun(run.id);
  assert.equal(now.status, 'waiting');
  assert.equal(now.waitingAfter, 'hello');
  assert.ok((await logs(run)).includes('notification (off): is waiting for you: type next in its terminal'));
  assert.equal((await api('POST', `/api/runs/${run.id}/resume`)).status, 409, 'the browser points you to the terminal');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-recap/);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.boxes[1].status], ['running', 'running']);
  await close(run);
});

test('a box with "explain" ticked gets a code walk-through before the next box', async () => {
  const run = await startRun([{ id: 'hello', skill: 'orchestra-hello', walkthrough: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  const r = await hook(run, 'Stop', done('hello'));
  assert.match(r.body.output.reason, /walk me through the code/);
  assert.match((await hook(run, 'Stop', say('a.cs:1 uses a guard clause.\nORCHESTRA:DONE'))).body.output.reason, /\/orchestra-recap/);
  assert.equal((await getRun(run.id)).boxes[1].status, 'running');
  await close(run);
});

test('an Allow prompt makes the run need you; the tool running makes it work again', async () => {
  const run = await startRun();
  await hook(run, 'Notification', { message: 'Claude needs your permission to use Bash' });
  let now = await getRun(run.id);
  assert.deepEqual([now.status, now.note], ['needs-you', 'Claude needs your permission to use Bash']);
  await hook(run, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  now = await getRun(run.id);
  assert.equal(now.status, 'running');
  const { body: tl } = await api('GET', `/api/runs/${run.id}/timeline`);
  assert.ok(tl.some((e) => e.kind === 'tool' && e.text === 'Bash: ls'), 'live activity');
  assert.ok(tl.some((e) => e.kind === 'log'));
  await close(run);
});

test('a closed tab stops the run; Reopen resumes the same session; a restart notices a gone tab', async () => {
  const run = await startRun();
  await hook(run, 'status', { cost: { total_cost_usd: 0.05 } });
  await hook(run, 'Stop', done('hello'));
  await hook(run, 'SessionEnd', { reason: 'exit' });
  let now = await getRun(run.id);
  assert.deepEqual([now.status, now.session.open], ['stopped', false]);
  assert.match(now.boxes[1].note, /terminal closed/);
  await runnerCall('onClosed', [run.id, run.hookToken]); // the launcher too: nothing more happens
  assert.equal((await api('POST', `/api/runs/${run.id}/resume`)).status, 200);
  now = await waitFor(async () => ((await getRun(run.id)).session?.open ? getRun(run.id) : null), 'the reopened session');
  assert.equal(now.status, 'needs-you');
  assert.match(now.note, /Reopened on the same session/);
  const spec = (await launch(now, fakeLauncher())).body;
  assert.equal(spec.args[spec.args.indexOf('--resume') + 1], run.sessionId);
  assert.ok(!spec.args.includes('/orchestra-recap'), 'no prompt: you type next or redo');
  // The resumed conversation reports its running total (0.05 before, 0.06 now): counted once.
  await hook(now, 'status', { cost: { total_cost_usd: 0.06 } });
  assert.equal((await getRun(run.id)).cost, 0.06);
  assert.match(context(await hook(now, 'UserPromptSubmit', { prompt: 'redo' })), /\/orchestra-recap/);

  // A launcher that is gone (pid 999999 is not alive): the next command shows the run as stopped.
  await launch(now, 999999);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.session.open], ['stopped', false]);
});

test('a run saved by the old background mode becomes a stopped run that reopens its session', async () => {
  const id = 'run-20200101000000-old000';
  fs.mkdirSync(path.join(runsDir, id), { recursive: true });
  fs.writeFileSync(path.join(runsDir, id, 'state.json'), JSON.stringify({
    id, templateId: 'demo-hello-recap', templateName: 'Old', tracking: true, input: { text: 'old' }, status: 'question', sessionId: 'old-session',
    cwd: path.join(runsDir, id, 'work'), repoPlan: [], workspace: null, chat: [], cost: 0.5, createdAt: '2020-01-01T00:00:00Z',
    boxes: [{ id: 'hello', skill: 'orchestra-hello', label: 'Say hello', status: 'question', pid: 5 }, { id: 'recap', skill: 'orchestra-recap', label: 'Recap', status: 'pending' }],
  }));
  const old = await getRun(id);
  assert.equal(old.status, 'stopped');
  assert.equal(old.boxes[0].status, 'running');
  assert.ok(old.hookToken);
  await api('POST', `/api/runs/${id}/resume`);
  const now = await waitFor(async () => ((await getRun(id)).session?.open ? getRun(id) : null), 'the reopened session');
  const spec = (await launch(now)).body;
  assert.equal(spec.args[spec.args.indexOf('--resume') + 1], 'old-session', 'the same conversation');
  assert.equal(now.status, 'needs-you');
  await close(now);
});

test('hooks need the run token; Stop ends the session; delete waits for it', async () => {
  const run = await startRun();
  assert.deepEqual((await hook(run, 'Stop', done('x'), 'nope')).body, {}, 'a wrong token changes nothing');
  assert.deepEqual((await hook(run, 'Stop', done('x'), '')).body, {});
  assert.equal((await getRun(run.id)).boxes[0].status, 'running');
  assert.ok((await logs(run)).some((t) => /hook Stop failed: wrong run token/.test(t)));
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 409, 'its tab is open');
  assert.equal((await close(run)).body.status, 'stopped');
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 200);
  assert.equal((await api('GET', `/api/runs/${run.id}`)).status, 404);
});

test('the queue: only the limit works at once, first in first out; a queued run can be taken out', async () => {
  await api('PUT', '/api/settings', { maxRunning: 1 });
  try {
    for (const r of (await api('GET', '/api/runs')).body) if (r.status === 'running') await close(r);
    const a = await startRun();
    const ids = [];
    for (const t of ['q1', 'q2']) ids.push((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: t } })).body.id);
    assert.deepEqual(await Promise.all(ids.map(async (id) => (await getRun(id)).status)), ['queued', 'queued']);
    assert.equal((await api('POST', `/api/runs/${ids[1]}/stop`)).body.status, 'stopped', 'taken out of the queue');
    // A run that waits for you frees its slot.
    await hook(a, 'Stop', say('A question?'));
    await waitStatus(ids[0], 'running');
    assert.equal((await getRun(ids[1])).status, 'stopped');
    await close(await getRun(ids[0]));
    await close(a);
  } finally {
    await api('PUT', '/api/settings', { maxRunning: 20 });
  }
});

test('several Jira tickets at once: one run each, in order; each tab is named after its ticket', async () => {
  await api('PUT', '/api/settings', { maxRunning: 1 });
  try {
    // A run still opening its tab cannot be stopped yet: wait for its session first.
    for (const r of (await api('GET', '/api/runs')).body) {
      if (r.status === 'running') await close(await waitFor(async () => ((await getRun(r.id)).session?.open ? getRun(r.id) : null), 'an older run to open'));
    }
    const batch = (inputs, extra = {}) => api('POST', '/api/runs/batch', { templateId: 'demo-hello-recap', inputs, ...extra });
    // A bad list makes no runs at all.
    const before = (await api('GET', '/api/runs')).body.length;
    assert.equal((await batch(['ITP2-1', 'ITP2-1'])).status, 400, 'twice');
    assert.equal((await batch([' ', ''])).status, 400, 'empty');
    assert.equal((await batch(Array.from({ length: 21 }, (_, i) => `ITP2-${i}`))).status, 400, 'too many');
    assert.equal((await batch(['ITP2-1'], { templateId: 'nope' })).status, 404);
    assert.equal((await api('GET', '/api/runs')).body.length, before);

    const { status, body: runs } = await batch(['ITP2-14852', ' ITP2-14853 ', 'Fix the CbC legend']);
    assert.equal(status, 200);
    assert.deepEqual(runs.map((r) => r.input.text), ['ITP2-14852', 'ITP2-14853', 'Fix the CbC legend']);
    const first = await waitFor(async () => ((await getRun(runs[0].id)).session?.open ? getRun(runs[0].id) : null), 'the first run to open its tab');
    assert.deepEqual([(await getRun(runs[1].id)).status, (await getRun(runs[2].id)).status], ['queued', 'queued'], 'the rest wait their turn, in order');
    const spec = (await launch(first)).body;
    assert.equal(spec.title, 'ITP2-14852', 'the tab is the Jira key');
    assert.equal(spec.args[spec.args.indexOf('--name') + 1], 'ITP2-14852');
    assert.equal(spec.args.at(-1), '/orchestra-hello ITP2-14852');
    for (const r of runs) {
      const cur = await getRun(r.id);
      if (cur.status === 'queued') await api('POST', `/api/runs/${r.id}/stop`);
      else await close(cur);
    }
    // No Jira key: the old "<template>: <input>" name.
    await api('PUT', '/api/settings', { maxRunning: 20 });
    const third = await waitFor(async () => {
      await api('POST', `/api/runs/${runs[2].id}/resume`);
      const r = await getRun(runs[2].id);
      return r.session?.open ? r : null;
    }, 'the third run to open its tab');
    assert.equal((await launch(third)).body.title, 'Fix the CbC legend', 'a text run is named after its words');
    await close(third);
    for (const r of runs) await api('DELETE', `/api/runs/${r.id}`);
  } finally {
    await api('PUT', '/api/settings', { maxRunning: 20 });
  }
});

test('app lock: a box that starts the app waits in the Stop hook until the app is free', async () => {
  const a = await startRun([{ id: 'app', skill: 'orchestra-hello', usesApp: true }]);
  const b = await startRun([{ id: 'hello', skill: 'orchestra-hello' }, { id: 'app', skill: 'orchestra-recap', usesApp: true }]);
  let answered = null;
  const bStop = hook(b, 'Stop', done('hello')).then((r) => (answered = r));
  await waitFor(async () => /Waiting for the app/.test((await getRun(b.id)).boxes[1].note || ''), 'run b to wait for the app');
  await sleep(300);
  assert.equal(answered, null, 'the Stop hook is still waiting');
  await hook(a, 'Stop', done('app work'));
  await bStop;
  assert.match(answered.body.output.reason, /\/orchestra-recap/);
  assert.equal((await getRun(b.id)).boxes[1].status, 'running');

  // A run whose first box needs the app stays in the queue while another run has it.
  const { body: c } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'c' }, start: false });
  await api('PUT', `/api/runs/${c.id}/boxes`, { boxes: [{ id: 'app', skill: 'orchestra-hello', usesApp: true }] });
  await api('POST', `/api/runs/${c.id}/resume`);
  await sleep(300);
  assert.equal((await getRun(c.id)).status, 'queued');
  await hook(b, 'Stop', done('app work'));
  await waitFor(async () => (await getRun(c.id)).session?.open, 'run c to start once the app is free');
  for (const r of [a, b, c]) await close(r);
});

// ---- workspaces ----

function makeFakeItp() {
  const root = path.join(tmp, 'itp');
  const sh = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'common.sh'), [
    'ITP_ROOT="${ITP_ROOT:-$(pwd)}"',
    'API_REPO="${API_REPO:-$ITP_ROOT/ITP-API}"',
    'repo_dir_for() {',
    '  case "$1" in',
    '    api)            printf \'%s\' "$API_REPO" ;;',
    '    itp-workspace)  printf \'%s\' "$ITP_ROOT" ;;',
    '    *) return 1 ;;',
    '  esac',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'hello.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fake ITP\n');
  fs.mkdirSync(path.join(root, 'ITPKV'));
  fs.writeFileSync(path.join(root, 'ITPKV', 'note.md'), 'vault\n');
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls:*)"]}}\n');
  sh(['init', '-q', '--bare', 'api-remote.git'], tmp);
  sh(['clone', '-q', path.join(tmp, 'api-remote.git'), 'ITP-API'], root);
  const api = path.join(root, 'ITP-API');
  fs.writeFileSync(path.join(api, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(api, 'app.cs'), 'class A {}\n');
  sh(['checkout', '-q', '-b', 'development/mission'], api);
  sh(['add', '.'], api);
  sh(['commit', '-qm', 'start'], api);
  sh(['push', '-q', '-u', 'origin', 'development/mission'], api);
  fs.mkdirSync(path.join(api, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(api, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  return { root, api, worktrees: path.join(tmp, 'wt') };
}
const gitIn = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@f', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@f' } });

test('workspace: worktrees start from the latest dev code with no branch; the branch the skill makes is followed', async () => {
  const itp = makeFakeItp();
  useEnv({ ORCHESTRA_ITP_ROOT: itp.root, ORCHESTRA_WORKTREES_DIR: itp.worktrees });
  await api('PUT', '/api/settings', { maxRunning: 20 });
  const { body: repos } = await api('GET', '/api/repos');
  assert.deepEqual(repos.map((r) => r.token), ['api'], 'the ITP workspace repo itself is never offered');
  assert.equal(repos[0].defaultBase, 'origin/development/mission');
  const tpl = { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], boxes: [{ id: 'hello', skill: 'orchestra-hello' }] };
  assert.equal((await api('PUT', '/api/templates/ws-demo', tpl)).status, 200);
  try {
    const run = await startRun(null, { templateId: 'ws-demo', input: 'PROJ-9 fix it' });
    assert.deepEqual(run.repoPlan.map((p) => [p.token, p.base, p.branch]), [['api', 'origin/development/mission', null]], 'no branch is picked at the start');
    const ws = run.workspace.dir;
    const wt = path.join(ws, 'ITP-API');
    assert.equal(gitIn(wt, ['branch', '--show-current']).stdout.trim(), '', 'no branch yet');
    assert.equal(gitIn(itp.api, ['branch', '--show-current']).stdout.trim(), 'development/mission', 'your checkout is not switched');
    assert.ok(fs.lstatSync(path.join(ws, 'scripts')).isSymbolicLink(), 'folders are linked');
    assert.ok(fs.lstatSync(path.join(ws, 'ITPKV')).isSymbolicLink());
    assert.ok(!fs.lstatSync(path.join(ws, 'CLAUDE.md')).isSymbolicLink(), 'files are copied');
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), 'node_modules is shared, not reinstalled');
    // .claude is a real folder: "don't ask again" answers land here, not in the ITP repo.
    assert.ok(!fs.lstatSync(path.join(ws, '.claude')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(ws, '.claude', 'skills')).isSymbolicLink());
    assert.match(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'), /Bash\(ls:\*\)/, 'starts from your ITP answers');

    const spec = (await launch(run)).body;
    assert.equal(path.resolve(spec.cwd), path.resolve(ws), 'claude starts in the workspace');
    const dirs = spec.args.slice(spec.args.indexOf('--add-dir') + 1, spec.args.findIndex((x, i) => i > spec.args.indexOf('--add-dir') && x.startsWith('--')));
    assert.ok(dirs.some((d) => path.resolve(d) === path.resolve(wt)), 'the worktree is added, so its own .claude/skills load');
    assert.equal(path.resolve(spec.env.ITP_ROOT), path.resolve(ws));
    assert.equal(spec.env.ITP_BRANCH_OVERRIDE, undefined, 'ITP scripts use the epic branch');
    assert.match(spec.env.ITP_REPO_DIRS, /^api=.*ITP-API$/);
    assert.match(spec.env.ORCHESTRA_PROTECT, /ITP-API$/, 'your own checkout is protected');
    assert.match(spec.args[spec.args.indexOf('--append-system-prompt') + 1], /ITP-API \(the latest development\/mission, no branch yet\)/);

    // The skill makes its branch and commits; Orchestra follows.
    gitIn(wt, ['switch', '-q', '-c', 'epics/lyra-ITP-E-07-demo']);
    fs.writeFileSync(path.join(wt, 'work.txt'), 'x');
    gitIn(wt, ['add', 'work.txt']);
    gitIn(wt, ['commit', '-qm', 'epic work']);
    await hook(run, 'Stop', done('hello'));
    const fin = await getRun(run.id);
    assert.equal(fin.status, 'done');
    assert.equal(fin.workspace.repos[0].branch, 'epics/lyra-ITP-E-07-demo');
    assert.ok((await logs(run)).includes('api: now on branch epics/lyra-ITP-E-07-demo'));

    // Closing keeps this run's "don't ask again" answers for the next runs; the ITP file stays as it was.
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(dotnet build:*)"]}}');
    await hook(run, 'SessionEnd', {});
    assert.match(fs.readFileSync(path.join(dataDir, 'claude-local-settings.json'), 'utf8'), /dotnet build/);
    assert.match(fs.readFileSync(path.join(itp.root, '.claude', 'settings.local.json'), 'utf8'), /Bash\(ls:\*\)/);

    // A bad starting point, or an unknown repo, is refused.
    assert.equal((await api('POST', '/api/runs', { templateId: 'ws-demo', input: { text: 'x' }, repos: [{ token: 'api', base: 'a..b' }] })).status, 400);
    assert.equal((await api('POST', '/api/runs', { templateId: 'ws-demo', input: { text: 'x' }, repos: [{ token: 'nope' }] })).status, 400);

    // Uncommitted work blocks a delete, unless you say so. Deleting never touches your real files.
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'not committed');
    assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 409);
    assert.equal((await api('DELETE', `/api/runs/${run.id}?force=1`)).status, 200);
    assert.equal(fs.existsSync(ws), false, 'the workspace is gone');
    assert.ok(fs.existsSync(path.join(itp.api, 'node_modules', 'left-pad', 'index.js')), 'real node_modules kept');
    assert.ok(fs.existsSync(path.join(itp.root, 'scripts', 'hello.sh')), 'real scripts kept');
    assert.ok(fs.existsSync(path.join(itp.root, 'ITPKV', 'note.md')), 'real vault kept');
    assert.ok(fs.existsSync(path.join(itp.root, '.claude', 'skills', 'x', 'SKILL.md')), 'real .claude kept');
    assert.equal(gitIn(itp.api, ['show-ref', '--verify', '--quiet', 'refs/heads/epics/lyra-ITP-E-07-demo']).status, 0, 'the branch is kept');
  } finally {
    await api('DELETE', '/api/templates/ws-demo');
  }
});

test('clean up: only when you say; it stops what runs from the folder, frees the space and the conversation; the run, branches and stats stay', async () => {
  await api('PUT', '/api/settings', { maxRunning: 20 });
  await api('PUT', '/api/templates/ws-demo', { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], boxes: [{ id: 'hello', skill: 'orchestra-hello' }] });
  await api('PUT', '/api/templates/ws-wrap', { id: 'ws-wrap', name: 'Wrap demo', repos: ['api'], boxes: [{ id: 'hello', skill: 'orchestra-hello', waitAfter: true }, { id: 'wrap', skill: 'orchestra-wrap-up', label: 'Wrap up' }] });
  const projects = path.join(tmp, 'claude-projects', 'C--o-test');
  fs.mkdirSync(projects, { recursive: true });
  let sleeper;
  try {
    const run = await startRun(null, { templateId: 'ws-demo', input: 'ship it' });
    const ws = run.workspace.dir;
    const wt = path.join(ws, 'ITP-API');
    gitIn(wt, ['switch', '-q', '-c', 'epics/lyra-ITP-E-08-ship']);
    fs.writeFileSync(path.join(wt, 'ship.txt'), 'x');
    gitIn(wt, ['add', 'ship.txt']);
    gitIn(wt, ['commit', '-qm', 'ship work']);
    const report = 'Create PR: https://bitbucket.org/orbitax/itp-api/pull-requests/new?source=epics/lyra-ITP-E-08-ship.\n'
      + 'After the merge: `bash scripts/close-epic.sh 2026-10-27-ITP-E-08-ship`, or `bash scripts/close-epic.sh <epic-folder> --target x`.';
    await hook(run, 'Stop', done(report));
    const fin = await getRun(run.id);
    assert.deepEqual(fin.ship, { prUrls: ['https://bitbucket.org/orbitax/itp-api/pull-requests/new?source=epics/lyra-ITP-E-08-ship'], epicFolder: '2026-10-27-ITP-E-08-ship' }, 'the PR link and the epic folder for the Wrap up step');
    assert.equal((await api('POST', `/api/runs/${run.id}/clean-up`)).status, 409, 'its tab is open');

    // Closing the tab cleans nothing: clean-up happens when you say so.
    await close(run);
    assert.equal((await getRun(run.id)).cleanedAt, undefined);
    assert.ok(fs.existsSync(ws));
    assert.match((await orchText('status')).out, /Finished, folder still there: ship it/);
    assert.match((await orchText('disk')).out, /ship it\s+done\s+.*\d+ (KB|MB)/);

    // Uncommitted work asks first.
    fs.writeFileSync(path.join(wt, 'wip.txt'), 'not committed');
    assert.equal((await api('POST', `/api/runs/${run.id}/clean-up`)).status, 409, 'uncommitted work asks first');

    // A process running from the folder, and the conversation files: both go with --force.
    sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(wt, 'held')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(projects, `${run.sessionId}.jsonl`), 'x'.repeat(5000));
    fs.mkdirSync(path.join(projects, run.sessionId));
    const cleanedNow = await orchText('clean', run.id, '--force');
    assert.match(cleanedNow.out, /ship it: cleaned · \d+ KB freed/);
    await waitFor(() => sleeper.exitCode !== null || sleeper.signalCode !== null, 'the process in the folder to be stopped');
    const cleaned = await getRun(run.id);
    assert.equal(fs.existsSync(ws), false, 'the folder is gone');
    assert.equal(fs.existsSync(path.join(projects, `${run.sessionId}.jsonl`)), false, 'the conversation file is gone');
    assert.equal(fs.existsSync(path.join(projects, run.sessionId)), false, 'and its folder');
    assert.ok(cleaned.cleanedAt && cleaned.workspace.ready === false && cleaned.freed >= 5000);
    assert.equal(cleaned.status, 'done', 'the run stays');
    assert.equal(gitIn(path.join(tmp, 'itp', 'ITP-API'), ['log', '-1', '--format=%s', 'epics/lyra-ITP-E-08-ship']).stdout.trim(), 'ship work', 'the branch stays');
    assert.ok(!gitIn(path.join(tmp, 'itp', 'ITP-API'), ['worktree', 'list']).stdout.includes(ws), 'git keeps no record of the folder');
    assert.ok((await api('GET', '/api/stats')).body.history.some((h) => h.id === run.id), 'and so do its stats');
    assert.doesNotMatch((await orchText('runs')).out, /ship it/, 'a cleaned run leaves the board');
    assert.match((await orchText('runs', '--all')).out, /ship it/, 'and stays in runs --all');

    // Wrap up, the last step: you type next when ready; pushes to main (vault, ITP folder) only while it works;
    // "not yet" waits for next; done means "clean when the tab closes", and closing it cleans up.
    const run2 = await startRun(null, { templateId: 'ws-wrap', input: 'merged one' });
    const flag = path.join(runsDir, run2.id, 'wrap-up.ok');
    const genv = { ORCHESTRA_RUN_DIR: path.join(runsDir, run2.id), ORCHESTRA_ITP_ROOT: 'C:/Work/ITP' };
    gitIn(path.join(run2.workspace.dir, 'ITP-API'), ['switch', '-q', '-c', 'epics/lyra-ITP-E-09-merged']); // no new commit: merged already
    await hook(run2, 'Stop', done('Create PR: https://bitbucket.org/orbitax/itp-api/pull-requests/new?source=epics/lyra-ITP-E-09-merged\n`bash scripts/close-epic.sh 2026-10-28-ITP-E-09-merged`'));
    assert.equal((await getRun(run2.id)).status, 'waiting', 'it waits for you before Wrap up');
    assert.equal(fs.existsSync(flag), false);
    assert.equal(check('Bash', { command: 'cd ITPKV && git push origin main' }, genv)?.needsApproval, false, 'no vault push before Wrap up');
    const wrapAsk = context(await hook(run2, 'UserPromptSubmit', { prompt: 'next' }));
    assert.match(wrapAsk, /\/orchestra-wrap-up/);
    assert.match(wrapAsk, /Epic folder: 2026-10-28-ITP-E-09-merged/);
    assert.match(wrapAsk, /Pull requests: https:\/\/bitbucket\.org\/orbitax\/itp-api/);
    assert.ok(fs.existsSync(flag), 'the flag is there while Wrap up works');
    assert.equal(check('Bash', { command: 'cd ITPKV && git push origin main' }, genv)?.needsApproval, true, 'the vault push asks you');
    assert.equal(check('Bash', { command: 'git -C ITP-API push origin main' }, genv)?.needsApproval, false, 'a code repo never pushes main');
    const spec = (await launch(await getRun(run2.id), fakeLauncher())).body;
    assert.equal(spec.env.ORCHESTRA_ITP_ROOT, path.join(tmp, 'itp').replace(/\\/g, '/'));
    await hook(run2, 'Stop', { last_assistant_message: 'Type next when you are ready, and I run the wrap-up again.' });
    assert.equal((await getRun(run2.id)).status, 'needs-you', 'not yet');
    assert.match(context(await hook(run2, 'UserPromptSubmit', { prompt: 'next' })), /ready to wrap up now[\s\S]*\/orchestra-wrap-up/, 'next runs Wrap up again');
    await hook(run2, 'Stop', done('pushed the vault, closed the epic'));
    const wrapped = await getRun(run2.id);
    assert.deepEqual([wrapped.status, wrapped.cleanWhenClosed], ['done', true]);
    assert.match(wrapped.note, /Close this tab/);
    assert.equal(fs.existsSync(flag), false, 'the flag goes with the step');
    await close(wrapped);
    await waitFor(async () => (await getRun(run2.id)).cleanedAt, 'the clean-up after the Wrap up tab closed');
    assert.equal(fs.existsSync(run2.workspace.dir), false);
    assert.equal(gitIn(path.join(tmp, 'itp', 'ITP-API'), ['branch', '--list', 'epics/lyra-ITP-E-09-merged']).stdout.trim(), '', 'the merged branch is deleted');
    assert.equal((await api('DELETE', `/api/runs/${run2.id}`)).status, 200, 'a cleaned-up run can still be deleted');

    // A clean-up by itself that fails is tried once, not again on every orch command; `orch clean` still works.
    const run8 = await startRun(null, { templateId: 'ws-wrap', input: 'stuck clean' });
    await hook(run8, 'Stop', done('hello'));
    await hook(run8, 'UserPromptSubmit', { prompt: 'next' });
    await hook(run8, 'Stop', done('wrapped'));
    const stray = path.join(run8.workspace.dir, 'stray-link');
    fs.symlinkSync(path.join(tmp, 'itp'), stray, 'junction'); // not in its links list: the clean-up refuses
    await close(await getRun(run8.id));
    const failedLine = (lines) => lines.filter((t) => /could not clean up: refusing to delete/.test(t)).length;
    await waitFor(async () => failedLine(await logs(run8)) === 1, 'the failed clean-up to be logged');
    await waitFor(async () => !(await getRun(run8.id)).cleaning, 'the failed clean-up to end');
    for (let i = 0; i < 3; i++) await orchText('status');
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(failedLine(await logs(run8)), 1, 'not tried again on every command');
    assert.ok((await getRun(run8.id)).autoCleanFailedAt);
    fs.rmSync(stray, { recursive: false, force: true });
    assert.match((await orchText('clean', run8.id)).out, /stuck clean: cleaned/, 'you can still clean it now');
    assert.equal((await getRun(run8.id)).autoCleanFailedAt, undefined);
    assert.equal((await api('DELETE', `/api/runs/${run8.id}`)).status, 200);

    // Wrap up with "Keep the folder": closing the tab cleans nothing.
    const run5 = await startRun(null, { templateId: 'ws-wrap', input: 'keep me' });
    await hook(run5, 'Stop', done('hello'));
    await hook(run5, 'UserPromptSubmit', { prompt: 'next' });
    await hook(run5, 'Stop', { last_assistant_message: 'Kept it.\n\nWHAT I DID AND WHY:\n- You chose to keep the folder.\nORCHESTRA:KEEP\nORCHESTRA:DONE' });
    const kept = await getRun(run5.id);
    assert.deepEqual([kept.status, kept.cleanWhenClosed], ['done', false]);
    assert.match(kept.note, /folder stays/);
    await close(kept);
    assert.ok(fs.existsSync(kept.workspace.dir), 'kept');
    assert.match((await orchText('status')).out, /Finished, folder still there: keep me/);

    // A run finished before Wrap up was in its template: the step is added at the end, and next starts it.
    const run6 = await startRun(null, { templateId: 'ws-demo', input: 'add later' });
    await hook(run6, 'Stop', done('hello'));
    assert.equal((await getRun(run6.id)).status, 'done');
    assert.equal((await orch('boxes', run6.id, '--set', '[{"id":"other","skill":"orchestra-hello"},{"id":"wrap","skill":"orchestra-wrap-up"}]')).status, 409, 'a finished step stays');
    assert.equal((await orch('boxes', run6.id, '--set', '[{"id":"hello","skill":"orchestra-hello"},{"id":"wrap","skill":"orchestra-wrap-up","label":"Wrap up"}]')).status, 200);
    assert.equal((await getRun(run6.id)).status, 'waiting');
    assert.match(context(await hook(run6, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-wrap-up/);
    await close(run6);
    assert.equal((await api('DELETE', `/api/runs/${run6.id}`)).status, 200);

    // Left alone 7+ days: listed in status, cleaned with clean --stale. A cleaned run cannot be reopened.
    const run3 = await startRun(null, { templateId: 'ws-demo', input: 'half done' });
    await close(run3);
    const file = path.join(runsDir, run3.id, 'state.json');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    old.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString();
    fs.writeFileSync(file, JSON.stringify(old));
    assert.match((await orchText('status')).out, /Left alone 7\+ days: half done \(stopped\)/);
    assert.match((await orchText('clean', '--stale')).out, /half done: cleaned/);
    assert.equal((await api('POST', `/api/runs/${run3.id}/resume`)).status, 409, 'its worktrees are gone');

    // clean --done: every finished run whose tab is closed.
    const run4 = await startRun(null, { templateId: 'ws-demo', input: 'all finished' });
    await hook(run4, 'Stop', done('hello'));
    await close(run4);
    assert.match((await orchText('clean', '--done')).out, /all finished: cleaned/);

    // A worktree an earlier try removed, whose empty folder stayed: git says "not a working tree"; the folder still goes.
    const run7 = await startRun(null, { templateId: 'ws-demo', input: 'half removed' });
    await hook(run7, 'Stop', done('hello'));
    await close(run7);
    const wt7 = path.join(run7.workspace.dir, 'ITP-API');
    gitIn(path.join(tmp, 'itp', 'ITP-API'), ['worktree', 'remove', '--force', wt7]);
    fs.mkdirSync(wt7);
    const cleaned7 = await orchText('clean', run7.id);
    assert.match(cleaned7.out, /half removed: cleaned/, cleaned7.err);
    assert.equal(fs.existsSync(run7.workspace.dir), false, 'the folder is gone');
    assert.equal((await api('DELETE', `/api/runs/${run7.id}`)).status, 200);
    assert.equal((await orch('settings', 'cleanup=on')).status, 400, 'no clean-up by itself any more');
    assert.doesNotMatch((await orchText('help')).out, /after-merge/, 'the reopen path is gone');
    for (const r of [run, run3, run4, run5]) assert.equal((await api('DELETE', `/api/runs/${r.id}`)).status, 200);
  } finally {
    sleeper?.kill();
    await api('DELETE', '/api/templates/ws-demo');
    await api('DELETE', '/api/templates/ws-wrap');
  }
});

test('workspace: commits made with no branch are saved on orchestra/<run id>', async () => {
  const itp = { api: path.join(tmp, 'itp', 'ITP-API') };
  await api('PUT', '/api/templates/ws-demo', { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], boxes: [{ id: 'hello', skill: 'orchestra-hello' }] });
  try {
    const run = await startRun(null, { templateId: 'ws-demo', input: 'loose' });
    const wt = path.join(run.workspace.dir, 'ITP-API');
    fs.writeFileSync(path.join(wt, 'loose.txt'), 'x');
    gitIn(wt, ['add', 'loose.txt']);
    gitIn(wt, ['commit', '-qm', 'loose work']);
    await hook(run, 'Stop', done('hello'));
    const safe = `orchestra/${run.id}`;
    assert.equal((await getRun(run.id)).workspace.repos[0].branch, safe);
    assert.equal(gitIn(wt, ['branch', '--show-current']).stdout.trim(), safe);
    assert.ok((await logs(run)).some((t) => /1 commit was made with no branch\. Saved on orchestra\//.test(t)));
    await close(run);
    assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 200, 'nothing uncommitted: no force needed');
    assert.equal(gitIn(itp.api, ['log', '-1', '--format=%s', safe]).stdout.trim(), 'loose work', 'the commit survives the delete');
  } finally {
    await api('DELETE', '/api/templates/ws-demo');
    useEnv();
    await api('PUT', '/api/settings', { maxRunning: 20 });
  }
});

test('guard: edits in your own checkout of a run repo are blocked', () => {
  const env = { ORCHESTRA_PROTECT: 'C:/Work/ITP/ITP-API' };
  assert.equal(check('Write', { file_path: 'C:\\Work\\ITP\\ITP-API\\src\\a.cs' }, env)?.needsApproval, false);
  assert.equal(check('Edit', { file_path: 'C:/Work/ITP/ITP-API-Tools/a.cs' }, env), null, 'a different folder');
  assert.equal(check('Edit', { file_path: 'C:/o/0/ITP-API/a.cs' }, env), null, 'the run worktree');
  assert.equal(check('Bash', { command: 'cd /c/Work/ITP/ITP-API && dotnet build' }, env)?.needsApproval, false);
  assert.equal(check('Bash', { command: 'cd ITP-API && dotnet build' }, env), null);
});

// ---- tracking ----

test('tracking: a skill is marked only for real signs of writing, not for a mention', () => {
  assert.deepEqual(detect('Read the Teamspace ticket and the ITPKV notes.'), []);
  assert.ok(detect('Then run `bash scripts/close-epic.sh <epic>`.').length);
  assert.ok(detect('code="$(registry_call PUT /api/epics/x/board)"').length);
  assert.ok(detect('"<WS>/Orbitax-Teamspace/backend/teamspace.exe" register-epic x').length);
  assert.ok(detect('It writes the plan into ITPKV/Execution.').length);
  assert.deepEqual(detect('registry_call GET /api/features'), [], 'a read is not a write');
});

test('guard: tracking OFF blocks Teamspace and vault writes, and allows vault reads', () => {
  const off = { ORCHESTRA_TRACKING: 'off', ORCHESTRA_ALLOW_PUSH: '1' };
  const v = (tool, input) => check(tool, typeof input === 'string' ? { command: input } : input, off);
  for (const c of ['bash scripts/close-epic.sh E-1', '"C:/o/0/Orbitax-Teamspace/backend/teamspace.exe" register-epic x', 'teamspace register-epic x',
    'source scripts/lib/common.sh && registry_call POST /x', 'curl https://teamspace.orbitax.com/api', 'bash scripts/sync-vault.sh', 'ITP_REGISTRY_OFF=0 bash x.sh',
    'echo hi > ITPKV/a.md', 'mkdir -p "$VAULT_DIR/E-1"', 'cp a.md ITPKV/x/', 'git -C ITPKV commit -m x', 'cd ITPKV && git add . && git commit -m x']) {
    assert.equal(v('Bash', c)?.needsApproval, false, c);
  }
  assert.ok(v('PowerShell', 'Set-Content -Path C:\\o\\0\\ITPKV\\x.md -Value hi'));
  assert.ok(v('Write', { file_path: 'C:\\o\\0\\ITPKV\\x.md' }));
  assert.ok(v('mcp__teamspace__create_ticket', {}));
  for (const c of ['cat ITPKV/E-1/manifest.json', 'grep -ri teamspace ITPKV/docs | head', 'cp ITPKV/t.md ./out.md', 'ls "$VAULT_DIR"', 'git status']) {
    assert.equal(v('Bash', c), null, c);
  }
  assert.equal(v('Write', { file_path: 'C:/o/0/ITP-API/a.cs' }), null);
  assert.equal(check('Bash', { command: 'bash scripts/close-epic.sh E-1' }, { ORCHESTRA_TRACKING: 'on' }), null, 'tracking on: allowed');
});

test('tracking OFF turns ITP scripts away from Teamspace', () => {
  assert.equal(guardEnv('x', false, false).ITP_REGISTRY_OFF, '1');
  assert.equal(guardEnv('x', false, false).ORCHESTRA_TRACKING, 'off');
  assert.equal(guardEnv('x', false, true).ITP_REGISTRY_OFF, undefined);
});

test('tracking OFF: marked skills are refused; your mark changes what is refused', async () => {
  const mark = (name, m) => api('PUT', `/api/skill-marks/${name}`, { mark: m });
  // The demo template has tracking OFF. Mark its second skill as one that writes.
  const marked = await mark('orchestra-recap', 'writes');
  assert.equal(marked.status, 200);
  const recap = marked.body.find((s) => s.name === 'orchestra-recap');
  assert.deepEqual([recap.tracks, recap.tracksAuto, recap.mark], [true, false, 'writes']);
  assert.equal((await mark('orchestra-recap', 'nonsense')).status, 400);

  const { body: tpl } = await api('GET', '/api/templates/demo-hello-recap');
  const saved = await api('PUT', '/api/templates/tracking-copy', { ...tpl, id: 'tracking-copy' });
  assert.equal(saved.status, 409, 'a tracking-OFF template may not hold it');
  assert.match(saved.body.error, /orchestra-recap.*Teamspace or the vault/);
  assert.equal((await api('PUT', '/api/templates/tracking-copy', { ...tpl, id: 'tracking-copy', tracking: true })).status, 200, 'with tracking on it may');

  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x' } })).status, 409, 'start refused');
  const { status, body: draft } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x' }, start: false });
  assert.equal(status, 200, 'a draft is made, so you can remove the box');
  assert.equal((await api('POST', `/api/runs/${draft.id}/resume`)).status, 409);
  const hello = [{ id: 'hello', skill: 'orchestra-hello' }];
  assert.equal((await api('PUT', `/api/runs/${draft.id}/boxes`, { boxes: hello })).status, 200);
  assert.equal((await api('PUT', `/api/runs/${draft.id}/boxes`, { boxes: [...hello, { id: 'recap', skill: 'orchestra-recap' }] })).status, 409, 'it cannot be added back');
  await api('POST', `/api/runs/${draft.id}/resume`);
  const run = await waitFor(async () => ((await getRun(draft.id)).session?.open ? getRun(draft.id) : null), 'the session');
  const spec = (await launch(run)).body;
  assert.deepEqual([spec.env.ORCHESTRA_TRACKING, spec.env.ITP_REGISTRY_OFF], ['off', '1']);
  await close(run);

  // Back to the guess: the recap skill has no sign of writing, so the template runs again.
  const back = await mark('orchestra-recap', 'auto');
  assert.equal(back.body.find((s) => s.name === 'orchestra-recap').tracks, false);
  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'y' } })).status, 200);
  const on = await startRun(null, { templateId: 'tracking-copy', input: 'z' });
  const onSpec = (await launch(on)).body;
  assert.deepEqual([onSpec.env.ORCHESTRA_TRACKING, onSpec.env.ITP_REGISTRY_OFF], ['on', undefined]);
  assert.doesNotMatch(onSpec.args[onSpec.args.indexOf('--append-system-prompt') + 1], /Tracking is OFF/);
  await close(on);
  for (const r of (await api('GET', '/api/runs')).body) if (r.session?.open) await close(r);
  await api('DELETE', '/api/templates/tracking-copy');
});

test('tracking OFF: a box whose skill is marked while the run works fails before it starts', async () => {
  const run = await startRun();
  try {
    await api('PUT', '/api/skill-marks/orchestra-recap', { mark: 'writes' });
    assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {}, 'no next step is given');
    const now = await getRun(run.id);
    assert.equal(now.status, 'failed');
    assert.deepEqual(now.boxes.map((b) => b.status), ['done', 'failed']);
    assert.match(now.boxes[1].error, /writes to Teamspace or the vault/);
  } finally {
    await api('PUT', '/api/skill-marks/orchestra-recap', { mark: 'auto' });
    await close(run);
  }
});

// ---- stats and lessons ----

test('stats: spend, per-template and per-skill numbers, and the history', async () => {
  const runs = [
    { id: 'r1', templateId: 't', templateName: 'T', status: 'done', cost: 0.5, createdAt: new Date().toISOString(), input: { text: 'a' },
      boxes: [{ skill: 'x', attempts: 2, failures: 1, status: 'done', cost: 0.3, durationMs: 1000, error: null }, { skill: 'y', attempts: 1, status: 'done', cost: 0.2, durationMs: 3000 }] },
    { id: 'r2', templateId: 't', templateName: 'T', status: 'failed', cost: 0.1, createdAt: '2020-01-01T00:00:00Z', input: { text: 'b' },
      boxes: [{ skill: 'x', attempts: 1, status: 'failed', cost: 0.1, error: 'boom', endedAt: '2020-01-01T00:01:00Z' }, { skill: 'y', attempts: 0, status: 'pending', cost: 0 }] },
  ];
  const s = computeStats(runs);
  assert.deepEqual([s.totals.runs, s.totals.done, s.totals.failed, s.totals.cost, s.totals.costToday], [2, 1, 1, 0.6, 0.5]);
  assert.deepEqual(s.templates[0], { id: 't', name: 'T', runs: 2, done: 1, failed: 1, cost: 0.6, avgCost: 0.5, avgWorkMs: 4000 });
  const x = s.skills.find((k) => k.skill === 'x');
  assert.deepEqual([x.boxes, x.tries, x.failures, x.done, x.avgMs, x.lastError, x.lastErrorRun], [2, 3, 2, 1, 1000, 'boom', 'r2']);
  assert.equal(s.skills[0].skill, 'x', 'most failures first');
  assert.equal(s.skills.find((k) => k.skill === 'y').boxes, 1, 'a box that never ran is left out');
  assert.deepEqual(s.history.map((r) => r.id), ['r1', 'r2']);
  const { status, body } = await api('GET', '/api/stats');
  assert.equal(status, 200);
  assert.ok(body.totals.runs > 0 && body.history.length === body.totals.runs);
});

test('learn: what a run teaches is read from your words and its failures', () => {
  const run = { templateName: 'T', boxes: [{ id: 'a', label: 'A', skill: 'x', status: 'done', attempts: 2, failures: 1, error: 'boom' }],
    chat: [{ kind: 'you', text: 'blue' }, { text: 'hurry up' }] };
  const m = material(run);
  assert.match(m, /chat: blue/);
  assert.match(m, /chat: hurry up/);
  assert.match(m, /failed 1 time\(s\)\. Last error: boom/);
  assert.equal(material({ boxes: [{ id: 'a', label: 'A', skill: 'x', status: 'done', attempts: 1 }], chat: [] }), '');
  assert.deepEqual(parseSuggestions('```json\n{"rules":[{"text":" r ","why":"w"},{"nope":1}],"workflow":[{"text":"c"}]}\n```'),
    [{ kind: 'rule', text: 'r', why: 'w' }, { kind: 'workflow', text: 'c', why: '', change: null }]);
  // A workflow change keeps only an exact change Orchestra knows how to make.
  const [w] = parseSuggestions('{"workflow":[{"text":"c","change":{"op":"box","box":"plan","wait":true,"args":" show it ","bad":1}}]}');
  assert.deepEqual(w.change, { op: 'box', box: 'plan', wait: 'on', args: 'show it' });
  assert.equal(parseSuggestions('{"workflow":[{"text":"c","change":{"op":"box","box":"plan"}}]}')[0].change, null, 'a change that changes nothing');
  assert.equal(parseSuggestions('{"workflow":[{"text":"c","change":{"op":"drop","box":"../x"}}]}')[0].change, null);
  assert.deepEqual(parseSuggestions('{"workflow":[{"text":"c","change":{"op":"add","skill":"x-y","at":"2","wait":"on"}}]}')[0].change, { op: 'add', skill: 'x-y', at: 2, wait: 'on' });
  assert.throws(() => parseSuggestions('no json here'));
});

test('learn: after a run you talked to, lessons are suggested; an accepted rule reaches later runs', async () => {
  const run = await startRun();
  await hook(run, 'UserPromptSubmit', { prompt: 'Use blue please.' });
  await hook(run, 'Stop', done('hello'));
  await hook(run, 'Stop', done('recap'));
  const fin = await waitFor(async () => ((await getRun(run.id)).learn?.status === 'done' ? getRun(run.id) : null), 'the lessons');
  assert.equal(fin.learn.count, 2, 'one rule and one workflow change; the empty one is dropped');
  assert.equal(fin.learn.auto, true);
  assert.equal(fin.cost, 0.01, 'the lesson call counts in the run cost');
  const learnCall = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'learn', 'fake-calls.log'), 'utf8').trim());
  assert.equal(learnCall.resumed, false, 'a fresh session, not the run');
  assert.match(learnCall.noTools, /Bash.*Edit.*Write/);
  const list = (await api('GET', '/api/suggestions')).body.filter((s) => s.runId === run.id);
  const rule = list.find((s) => s.kind === 'rule');
  const flow = list.find((s) => s.kind === 'workflow');
  assert.equal(rule.text, 'Use blue for buttons.');
  assert.equal(flow.templateId, 'demo-hello-recap');

  assert.equal((await api('POST', `/api/suggestions/${rule.id}`, { action: 'accept', text: 'Use blue for all buttons.' })).status, 200);
  assert.equal((await api('POST', `/api/suggestions/${rule.id}`, { action: 'reject' })).status, 409, 'decided once');
  assert.deepEqual(flow.change, { op: 'box', box: 'hello', wait: 'on' });
  assert.match((await orchText('suggestions')).out, /change: template box demo-hello-recap hello wait=on/);
  // Accepted without --apply: only marked, and listed as not in the template yet.
  assert.match((await orchText('suggestion', flow.id, 'accept')).out, /Not in the template yet[^]*template box demo-hello-recap hello wait=on[^]*suggestion \S+ apply/);
  assert.equal((await api('GET', '/api/templates/demo-hello-recap')).body.boxes[0].waitAfter, false, 'accept alone changes nothing');
  assert.match((await orchText('suggestions')).out, new RegExp(`Accepted, not in the template yet[^]*${flow.id}`));
  assert.equal((await api('POST', `/api/suggestions/${flow.id}`, { action: 'maybe' })).status, 400);
  // Apply: to a template that is gone, a hint; to the named one (a copy, so other tests keep the demo as is), the change.
  const gone = await orchText('suggestion', flow.id, 'apply', '--template', 'nope');
  assert.notEqual(gone.code, 0);
  assert.match(gone.err + gone.out, /not there any more[^]*--template/);
  assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'lesson-copy')).code, 0);
  assert.match((await orchText('suggestion', flow.id, 'apply', '--template', 'lesson-copy')).out, /accepted and applied[^]*Step hello changed/);
  assert.equal((await api('GET', '/api/templates/lesson-copy')).body.boxes[0].waitAfter, true);
  assert.doesNotMatch((await orchText('suggestions')).out, /Accepted, not in the template yet/);
  assert.match((await orchText('suggestions', '--all')).out, /applied to lesson-copy/);
  // A rule cannot be applied; a change can be given by hand (old lessons have none).
  assert.match((await orchText('suggestion', rule.id, 'apply')).err, /only a workflow change/);
  assert.equal((await orchText('template', 'delete', 'lesson-copy')).code, 0);
  assert.match((await api('GET', '/api/instructions')).body.text, /^- Use blue for all buttons\.\n$/);

  // The next run follows the rule. It had nothing to learn from, so no lesson call is made.
  const next = await startRun(null, { input: 'next' });
  const spec = (await launch(next)).body;
  assert.match(spec.args[spec.args.indexOf('--append-system-prompt') + 1], /The user's own rules[^]*Use blue for all buttons/);
  await hook(next, 'Stop', done('hello'));
  await hook(next, 'Stop', done('recap'));
  await sleep(300);
  assert.equal((await getRun(next.id)).learn, undefined);
  // On demand it runs anyway.
  assert.equal((await api('POST', `/api/runs/${next.id}/learn`)).status, 200);
  await waitFor(async () => (await getRun(next.id)).learn?.status === 'done', 'lessons on demand');
  assert.equal((await api('PUT', '/api/instructions', { text: '' })).status, 200);
  assert.equal((await api('PUT', '/api/settings', { learn: 'maybe' })).status, 400);
  await close(run);
  await close(next);
});

// ---- the orch command, the lock, and old tabs ----

test('orch: broken template files are skipped; bad input is refused', async () => {
  fs.writeFileSync(path.join(dataDir, 'templates/broken.json'), '{"boxes": 1}');
  const { status, body } = await api('GET', '/api/templates');
  assert.equal(status, 200);
  assert.deepEqual(body.map((t) => t.id), ['demo-hello-recap']);
  fs.rmSync(path.join(dataDir, 'templates/broken.json'));
  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x'.repeat(9000) } })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', boxes: [] })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', boxes: [{ id: 'a', skill: 'bad skill!' }] })).status, 400);
  assert.equal((await api('PUT', '/api/templates/..%2Fx', { name: 'x', boxes: [{ id: 'a', skill: 'orchestra-hello' }] })).status, 400);
  assert.equal((await api('GET', '/api/runs/..%2Fx')).status, 404);
  assert.equal((await api('POST', '/api/runs', { templateId: 'nope' })).status, 404);
  assert.equal((await api('PUT', '/api/settings', { learn: 'maybe' })).status, 400);
  const unknown = await orchText('fly');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /unknown command: fly[^]*Orchestra commands/);
});

test('orch: a template is built step by step, as Claude does it when you talk', async () => {
  const t = (...a) => orch('template', ...a);
  assert.equal((await t('new', 'talk-demo', 'orchestra-hello', '--name', 'Talk demo', '--tracking', 'off')).status, 200);
  assert.equal((await t('new', 'talk-demo', 'orchestra-hello')).status, 409, 'the id is taken');
  assert.equal((await t('add', 'talk-demo', 'no-such-skill')).status, 404);
  await t('add', 'talk-demo', 'orchestra-recap', '--wait', '--label', 'Recap it');
  await t('add', 'talk-demo', 'orchestra-hello', '--at', '1', '--args', 'twice');
  let { body: tpl } = await t('show', 'Talk demo');
  assert.deepEqual(tpl.boxes.map((b) => [b.id, b.skill, !!b.waitAfter]), [['orchestra-hello-2', 'orchestra-hello', false], ['orchestra-hello', 'orchestra-hello', false], ['recap-it', 'orchestra-recap', true]]);
  assert.equal(tpl.boxes[0].args, 'twice');
  await t('move', 'talk-demo', 'recap-it', '1');
  await t('box', 'talk-demo', 'recap-it', 'wait=off', 'explain=on', 'label=Short recap');
  await t('remove', 'talk-demo', 'orchestra-hello-2');
  await t('set', 'talk-demo', 'name=Talk demo 2', 'tracking=on');
  ({ body: tpl } = await t('show', 'talk-demo'));
  assert.deepEqual(tpl.boxes.map((b) => b.id), ['recap-it', 'orchestra-hello']);
  assert.deepEqual([tpl.boxes[0].label, tpl.boxes[0].waitAfter, tpl.boxes[0].walkthrough, tpl.name, tpl.tracking], ['Short recap', false, true, 'Talk demo 2', true]);
  assert.equal((await t('copy', 'talk-demo', 'talk-copy')).body.name, 'Talk demo 2 (copy)');
  assert.equal((await t('box', 'talk-demo', 'recap-it', 'wait=maybe')).status, 400);
  const text = await orchText('template', 'show', 'talk-demo');
  assert.match(text.out, /1\. Short recap \[recap-it\] \/orchestra-recap · explain/);
  for (const id of ['talk-demo', 'talk-copy']) assert.equal((await t('delete', id)).status, 200);
  assert.equal((await t('show', 'talk-demo')).status, 404);
});

test('orch: runs are found by Jira key; status, board and run read plainly', async () => {
  const run = await startRun(null, { input: 'https://orbitax.atlassian.net/browse/ITP2-31337' });
  await hook(run, 'Stop', say('Which repo should I use?'));
  const status = await orchText('status');
  assert.match(status.out, /^Orchestra · \d+ running \(of 20 at once\) · \d+ need you/);
  assert.match(status.out, /! ITP2-31337: needs you in its tab: Which repo should I use\?/);
  const board = await orchText('runs');
  assert.match(board.out.split('\n')[0], /^Run\s+About\s+Status\s+Step\s+Cost/);
  assert.match(board.out, /ITP2-31337\s+needs-you\s+1\/2 Say hello/);
  const detail = await orchText('run', 'itp2-31337');
  assert.match(detail.out, /^ITP2-31337 · Demo/);
  assert.match(detail.out, /1\. Say hello \(\/orchestra-hello\) · running/);
  assert.equal((await orch('run', run.id.slice(-6))).body.id, run.id, 'the end of the id works too');
  await close(run);
  assert.ok(['queued', 'needs-you'].includes((await orch('reopen', 'ITP2-31337')).body.status), 'reopened (it may have started already)');
  await waitFor(async () => (await getRun(run.id)).session?.open, 'the reopened tab');
  await close(await getRun(run.id));
  const all = await orch('reopen', 'all');
  assert.ok(all.body.some((r) => r.id === run.id), 'reopen all: every stopped run with a session');
  await waitFor(async () => (await getRun(run.id)).session?.open, 'the tab again');
  await close(await getRun(run.id));
});

test('orch: free-text runs get a short name from their words and are found by words; a key inside text does not name them', async () => {
  const draft = async (text) => (await orch('start', 'demo-hello-recap', '--text', text, '--draft')).body;
  const sweden = await draft('Same fix as ITP2-14877, but for the Sweden row; make it a fixed cell');
  const norway = await draft('Add a Norway export button');
  const keyed = await draft('ITP2-40001 fix the row');
  try {
    const title = (await orchText('run', sweden.id)).out.split(' · ')[0];
    assert.equal(title, 'Same fix as ITP2-14877, but for…', 'the first words, cut at a word end');
    assert.equal((await orchText('run', keyed.id)).out.split(' · ')[0], 'ITP2-40001', 'the text starts with the key');
    assert.equal((await orch('run', 'ITP2-14877')).status, 404, 'a key inside free text does not find the run');
    assert.equal((await orch('run', 'sweden row')).body.id, sweden.id, 'found by words');
    assert.equal((await orch('run', 'NORWAY')).body.id, norway.id, 'case does not matter');
    const both = await orch('run', 'row');
    assert.equal(both.status, 409);
    assert.match(both.body.error, /fits \d+ runs: /);
    assert.ok(both.body.error.includes('Same fix') && both.body.error.includes('ITP2-40001'), 'it lists the runs that fit');
  } finally {
    for (const r of [sweden, norway, keyed]) await orch('delete', r.id);
  }
});

test('lock: a lock left by a dead process is taken over; many hooks at once lose nothing', async () => {
  fs.mkdirSync(path.join(runsDir, '.lock'), { recursive: true });
  fs.writeFileSync(path.join(runsDir, '.lock', 'owner.json'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal((await orch('status')).status, 200, 'the stale lock did not block');
  const run = await startRun();
  await Promise.all(Array.from({ length: 12 }, (_, i) => hook(run, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: `echo ${i}` } })));
  const tl = (await api('GET', `/api/runs/${run.id}/timeline`)).body.filter((e) => e.kind === 'tool');
  assert.equal(tl.length, 12);
  await Promise.all([hook(run, 'UserPromptSubmit', { prompt: 'one' }), hook(run, 'UserPromptSubmit', { prompt: 'two' }), hook(run, 'status', { cost: { total_cost_usd: 0.2 } })]);
  const now = await getRun(run.id);
  assert.deepEqual(now.chat.map((m) => m.text).sort(), ['one', 'two'], 'no save overwrote another');
  assert.equal(now.cost, 0.2);
  assert.ok(!fs.existsSync(path.join(runsDir, '.lock')), 'the lock is let go');
  await close(run);
});

test('a tab opened by the old server version still works with no server', async () => {
  const run = await startRun();
  const r = await proc([path.join(ROOT, 'lib/session-hook.mjs'), 'Stop'], { input: JSON.stringify(done('hello')), extraEnv: { ORCHESTRA_URL: 'http://127.0.0.1:9', ORCHESTRA_RUN_ID: run.id, ORCHESTRA_HOOK_TOKEN: run.hookToken } });
  assert.match(JSON.parse(r.out).reason, /\/orchestra-recap/);
  assert.equal((await getRun(run.id)).boxes[1].status, 'running');
  await close(run);
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err.stack}`);
    }
  }
} finally {
  for (const p of sleepers) p.kill();
  await new Promise((r) => setTimeout(r, 1500)); // background jobs (tick, lessons) end
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
