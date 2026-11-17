// End-to-end tests. Run: node test/smoke.mjs
// No terminal opens (ORCHESTRA_TERMINAL=none): the tests send the hook messages a real terminal
// session sends (bin/hook.mjs), use the orch command, and check what Orchestra does with them. The fake claude is used by the lesson-finder.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter } from '../lib/skills-scan.mjs';
import { childEnv, guardEnv, lastReply } from '../lib/runner.mjs';
import { check as checkWith, readMark, readWhy } from '../lib/guard.mjs';
import { detect as detectWith } from '../lib/tracking.mjs';
import itpTracking from '../packs/itp/tracking.mjs';
// In this process the pack is not set up: the guard and the skill scan get the ITP pack's tracking by hand.
const detect = (text) => detectWith(text, itpTracking.signs);
const check = (tool, input, env) => checkWith(tool, input, env, itpTracking);
import { computeStats } from '../lib/stats.mjs';
import { material, parseSuggestions } from '../lib/learn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A test run that was cut off (Ctrl+C, a crash) never reaches its clean-up: the apps its runs started (fake-app.mjs)
// keep running and hold its folder. Each run stops what a test folder holds: the earlier runs' at the start (and
// removes their folders), its own at the end. So run one test run at a time (two at once would stop each other's).
function stopTestApps(dir) {
  const want = dir.replace(/\\/g, '/').toLowerCase();
  const out = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { '{0}\t{1}' -f $_.ProcessId, $_.CommandLine }`], { encoding: 'utf8', windowsHide: true }).stdout || '';
  for (const line of out.split('\n')) {
    const [pid, cmd = ''] = line.replace(/\r$/, '').split('\t');
    const c = cmd.replace(/\\/g, '/').toLowerCase();
    if (Number(pid) && c.includes('test/fake-app.mjs') && c.includes(want)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}
const OLD_TESTS = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('orchestra-test-')).map((n) => path.join(os.tmpdir(), n));
for (const dir of OLD_TESTS) {
  stopTestApps(path.basename(dir));
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {} // still busy: tried again next time
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
const dataDir = path.join(tmp, 'data');
const runsDir = path.join(tmp, 'runs');
fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'test/fixtures/demo-hello-recap.json'), path.join(dataDir, 'templates/demo-hello-recap.json'));

// There is no server: every call is a short process (the orch command, a hook, the launcher's runner call).
// They all get this env; tests that need another ITP folder change it with useEnv.
// Nothing of this PC leaks in: no Orchestra or Claude settings, no git config (a run tab sets GIT_CONFIG_*), and a
// git identity of its own.
const gitConfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(gitConfig, '[user]\n\tname = Orchestra Test\n\temail = test@example.com\n');
const baseEnv = (() => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(ORCHESTRA_|GIT_CONFIG|CLAUDE_)/.test(k)) delete e[k];
  return { ...e, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
})();
// The tests' own personal skills folder, with the test skills (orchestra-hello, orchestra-recap). Never this PC's.
const homeSkills = path.join(tmp, 'home-skills');
fs.cpSync(path.join(ROOT, 'test/skills'), homeSkills, { recursive: true });
// The ITP pack's Wrap up step, as setup installs it (templates in the tests use it).
fs.cpSync(path.join(ROOT, 'packs/itp/skills/wrap-up'), path.join(homeSkills, 'wrap-up'), { recursive: true });
let env;
// The tests never use this PC's ITP folder: one of their own, with one team skill (a test that needs repos makes a
// fake ITP with git repos).
const testItp = path.join(tmp, 'itp-base').replace(/\\/g, '/');
fs.mkdirSync(path.join(testItp, '.claude', 'skills', 'review-changes'), { recursive: true });
fs.writeFileSync(path.join(testItp, '.claude', 'skills', 'review-changes', 'SKILL.md'), '---\nname: review-changes\ndescription: a team skill\n---\nReview.\n');
function useEnv(extra = {}) {
  env = { ...baseEnv, ORCHESTRA_SOLUTION_ROOT: testItp, ORCHESTRA_DATA_DIR: dataDir, ORCHESTRA_RUNS_DIR: runsDir, ORCHESTRA_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), ORCHESTRA_NOTIFY: '0', ORCHESTRA_PACK: 'itp', ORCHESTRA_TERMINAL: 'none', ORCHESTRA_HOME_SKILLS: homeSkills, ORCHESTRA_USER_EMAIL: '', ORCHESTRA_CLAUDE_PROJECTS: path.join(tmp, 'claude-projects'), ...extra };
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
    if (what === 'steps') return orch('steps', id, '--set', JSON.stringify(body.steps));
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
// What was typed in a run's tab (lib/run/chat.mjs keeps it in chat.jsonl).
const chatOf = (run) => { try { return fs.readFileSync(path.join(runsDir, run.id, 'chat.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
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
const done = (text) => ({ last_assistant_message: `${text}\n\nWHAT I DID AND WHY:\n- I did ${text}, because the step asked.\nORCHESTRA:DONE` });
const say = (text) => ({ last_assistant_message: text });
const context = (r) => r.body.output?.hookSpecificOutput?.additionalContext || '';
const logs = async (run) => (await api('GET', `/api/runs/${run.id}/timeline`)).body.filter((e) => e.kind === 'log').map((e) => e.text);

// Makes a run (with these steps, if given), starts it, and waits for its terminal session.
async function startRun(steps, { input = 'demo', templateId = 'demo-hello-recap' } = {}) {
  const { body: d } = await api('POST', '/api/runs', { templateId, input: { text: input }, start: false });
  if (steps) assert.equal((await api('PUT', `/api/runs/${d.id}/steps`, { steps })).status, 200);
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

test('guard: push and PR need your OK, main too; --no-verify is always refused', () => {
  const v = (command, allow = false) => check('Bash', { command }, { ORCHESTRA_ALLOW_PUSH: allow ? '1' : '0' });
  for (const c of ['git push', 'git push -u origin feature/x', 'cd repo && git -C x push origin y', 'gh pr create --fill']) {
    assert.equal(v(c)?.needsApproval, true, c);
    assert.equal(v(c, true), null, `${c} when allowed`);
  }
  for (const c of ['git push origin main', 'git push origin HEAD:main']) {
    assert.equal(v(c)?.needsApproval, true, `${c} asks you`);
    assert.equal(v(c, true), null, `${c} when allowed`);
  }
  for (const c of ['git checkout main', 'git switch main']) assert.equal(v(c, true)?.needsApproval, true, `${c} asks you`);
  assert.equal(v('git push origin feature/x --no-verify', true)?.needsApproval, false, '--no-verify refused always');
  for (const c of ['git status', 'git log origin/main', 'git merge-base HEAD origin/main', 'git checkout main -- file.txt', 'echo push', 'git commit -m "push later"']) {
    assert.equal(v(c), null, c);
  }
  assert.equal(check('PowerShell', { command: 'git push origin x' }, {})?.needsApproval, true);
  assert.equal(check('Read', { file_path: 'x' }, {}), null);
});

test('guard hook: a push gets Claude\'s Allow prompt, a push to main too', () => {
  const run = (command) => spawnSync(process.execPath, [path.join(ROOT, 'lib/guard-hook.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, ORCHESTRA_ALLOW_PUSH: '1' } });
  const ask = run('git push -u origin epics/x');
  assert.equal(ask.status, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask', 'asked even though the session allows pushes');
  const main = run('git push origin main');
  assert.equal(main.status, 0);
  assert.equal(JSON.parse(main.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.match(JSON.parse(main.stdout).hookSpecificOutput.permissionDecisionReason, /main branch/);
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

test('git hooks: push waits for Approve, main too; the repo hook still runs', () => {
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
    assert.match(git(['push', '-q', 'origin', 'feature/x:main'], guard(false)).stderr, /needs the user's Approve/);
    assert.equal(git(['push', '-q', 'origin', 'feature/x:main'], guard(true)).status, 0, 'a push to main after your Allow');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', 'feature/x'], guard(false));
    fs.writeFileSync(path.join(t, 'work', 'c'), 'c');
    git(['add', 'c']);
    assert.equal(git(['commit', '-qm', 'c'], guard(false)).status, 0, 'a commit on main of a code repo is fine');
    // The vault is committed on main by design; it pushes to main only in Wrap up.
    const vault = { ...guard(true), ORCHESTRA_MAIN_OK: `C:/elsewhere/ITPKV\n${path.join(t, 'work')}` };
    fs.writeFileSync(path.join(t, 'work', 'c2'), 'c');
    git(['add', 'c2']);
    assert.equal(git(['commit', '-qm', 'c2'], vault).status, 0, 'a vault commit on main');
    assert.match(git(['push', '-q', 'origin', 'main'], vault).stderr, /only in the Wrap up step/);
    assert.equal(check('Bash', { command: 'git -C ITPKV checkout main' }, {}), null, 'the vault may stay on main');
    assert.equal(check('Bash', { command: 'git -C ITP-API checkout main' }, {})?.needsApproval, true, 'a code repo asks you');
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

test('wrap up: only while its step works may the pack\'s wrap-up folder commit its files on main and push them', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-itp-'));
  const itp = path.join(t, 'itp');
  const run = path.join(t, 'run');
  fs.mkdirSync(run);
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: itp, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra } });
  const env = (more = {}) => ({ ...guardEnv(run, true), ORCHESTRA_WRAPUP_DIRS: itp.replace(/\\/g, '/'), ORCHESTRA_WRAPUP_ONLY: '^Execution/', ...more });
  const flag = (on) => (on ? fs.writeFileSync(path.join(run, 'wrap-up.ok'), 'x') : fs.rmSync(path.join(run, 'wrap-up.ok'), { force: true }));
  try {
    spawnSync('git', ['init', '-q', '--bare', 'remote.git'], { cwd: t });
    spawnSync('git', ['clone', '-q', 'remote.git', 'itp'], { cwd: t });
    git(['checkout', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(itp, 'Execution'));
    fs.writeFileSync(path.join(itp, 'Execution', 'e.json'), '{}');
    git(['add', '.']);
    assert.match(git(['commit', '-qm', 'e'], env()).stderr, /only in the Wrap up step/, 'not outside Wrap up');
    flag(true);
    assert.equal(git(['commit', '-qm', 'e'], env()).status, 0, 'an Execution file on main, in Wrap up');
    fs.writeFileSync(path.join(itp, 'other.txt'), 'x');
    git(['add', 'other.txt']);
    assert.match(git(['commit', '-qm', 'o'], env()).stderr, /only files matching \^Execution\/ may be committed/);
    git(['reset', '-q', 'other.txt']);
    assert.equal(git(['push', '-q', 'origin', 'main'], env()).status, 0, 'pushed to main in Wrap up');
    flag(false);
    fs.writeFileSync(path.join(itp, 'Execution', 'f.json'), '{}');
    git(['add', 'Execution/f.json']);
    assert.match(git(['commit', '-qm', 'f'], env()).stderr, /only in the Wrap up step/, 'refused again after it');
    // The vault pushes to main only in Wrap up too.
    const vault = env({ ORCHESTRA_WRAPUP_DIRS: 'C:/elsewhere', ORCHESTRA_MAIN_OK: itp });
    assert.equal(git(['commit', '-qm', 'f'], vault).status, 0, 'a vault commit on main');
    assert.match(git(['push', '-q', 'origin', 'main'], vault).stderr, /only in the Wrap up step/);
    flag(true);
    assert.equal(git(['push', '-q', 'origin', 'main'], vault).status, 0, 'the vault push in Wrap up');
    // The Claude guard: the same, and the run's own folder is out of reach.
    const g = { ORCHESTRA_RUN_DIR: run, ORCHESTRA_WRAPUP_DIRS: 'C:/Work/ITP' };
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP push origin main' }, g)?.needsApproval, true);
    assert.equal(check('Bash', { command: 'git -C "C:\\Work\\ITP" push origin main' }, g)?.needsApproval, true);
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP/ITP-API push origin main' }, g)?.needsApproval, true, 'a code repo asks you');
    assert.equal(check('Write', { file_path: path.join(run, 'state.json') }, g)?.needsApproval, false);
    assert.equal(check('Bash', { command: 'touch "$ORCHESTRA_RUN_DIR/wrap-up.ok"' }, g)?.needsApproval, false);
    // The vault, named as the pack names it, may push in Wrap up too.
    assert.equal(check('Bash', { command: 'git -C ITPKV push origin main' }, { ORCHESTRA_RUN_DIR: run })?.needsApproval, true);
    // No pack: no place on main, so it only asks you.
    assert.equal(checkWith('Bash', { command: 'git -C ITPKV push origin main' }, { ORCHESTRA_RUN_DIR: run }, false)?.needsApproval, true);
    flag(false);
    assert.equal(check('Bash', { command: 'git -C ITPKV push origin main' }, { ORCHESTRA_RUN_DIR: run })?.needsApproval, false, 'the vault outside Wrap up');
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP/ITP-API push origin main' }, g)?.needsApproval, true, 'a code repo asks you outside Wrap up too');
    assert.equal(check('Bash', { command: 'git -C C:/Work/ITP push origin main' }, g)?.needsApproval, false, 'refused outside Wrap up');
  } finally {
    fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('skills list includes Orchestra test skills and team skills', async () => {
  const { body } = await api('GET', '/api/skills');
  const names = body.map((s) => s.name);
  assert.ok(names.includes('orchestra-hello') && names.includes('orchestra-recap'));
  assert.equal(body.find((s) => s.name === 'review-changes')?.source, 'team', 'a skill of the ITP folder');
  assert.ok(!names.some((n) => n.startsWith('_')), 'folders starting with _ are skipped');
});

// ---- the terminal session ----

test('a run opens a terminal tab; its launcher gets the session, the hooks and the first step', async () => {
  const run = await startRun(null, { input: 'Bappy' });
  const cmd = run.session.command;
  assert.deepEqual(cmd.slice(0, 4), ['wt', '-w', 'orchestra', 'new-tab']);
  assert.ok(cmd.includes(path.join(ROOT, 'bin', 'launch.mjs')) && cmd.includes(run.id) && cmd.includes(run.hookToken));
  assert.ok(!cmd.some((c) => /^http/.test(c)), 'no server address');
  assert.equal(run.steps[0].status, 'running');

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
  assert.equal(a.at(-1), '/orchestra-hello Bappy', 'the first step, with the run input');
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  for (const e of ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) assert.ok(settings.hooks[e], e);
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 1800, 'the Stop hook may wait for the app');
  assert.match(settings.statusLine.command, /bin\/hook\.mjs" status$/);
  const rules = a[a.indexOf('--append-system-prompt') + 1];
  assert.match(rules, /ORCHESTRA:DONE/);
  assert.match(rules, /Tracking is OFF/, 'the demo template has tracking off');
  assert.equal(a[a.indexOf('--add-dir') + 1].replace(/\\/g, '/'), testItp, 'the ITP folder from the setup, behind the links');
  assert.ok(a[a.indexOf('--add-dir') + 2].startsWith('--'), '--add-dir takes several folders: a flag must follow it, not the prompt');
  assert.equal(spec.env.ORCHESTRA_RUN_ID, run.id);
  assert.equal(spec.env.ORCHESTRA_HOOK_TOKEN, run.hookToken);
  assert.equal(spec.env.ORCHESTRA_ALLOW_PUSH, '1', 'git lets pushes through; Claude asks you first');
  assert.equal(spec.env.ITP_REGISTRY_OFF, '1');
  assert.match(spec.env.GIT_CONFIG_VALUE_0 || Object.values(spec.env).join(' '), /git-hooks/);
  assert.equal((await getRun(run.id)).session.pid, pid);
  assert.ok(!(await launch(run)).body.args.includes('/orchestra-hello Bappy'), 'the first step is given once');
  await close(run);
});

test('models: a step with another model or effort restarts claude on the same conversation; costs carry over', async () => {
  // A template default, one step that overrides it, checked values, and ultracode said to be costly.
  assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'model-demo')).code, 0);
  assert.equal((await orchText('template', 'set', 'model-demo', 'model=opus', 'effort=high')).code, 0);
  assert.equal((await orchText('template', 'step', 'model-demo', 'recap', 'model=sonnet')).code, 0);
  assert.match((await orchText("template", "step", "model-demo", "recap", "model=GPT 4!")).err, /"gpt 4!" is not a model or effort/);
  assert.match((await orchText('template', 'step', 'model-demo', 'recap', 'effort=huge')).err, /"huge" is not a model or effort. Did you mean high/);
  assert.match((await orchText('template', 'step', 'model-demo', 'hello', 'effort=ultracode')).out, /hello[^\n]*ultracode \(many helpers, costly\)/);
  const shown = (await orchText('template', 'step', 'model-demo', 'hello', 'effort=none')).out;
  assert.match(shown, /default opus, effort high/);
  assert.match(shown, /2\. Recap [^\n]*sonnet/);
  assert.doesNotMatch(shown, /ultracode/);

  const run = await startRun(null, { templateId: 'model-demo' });
  assert.deepEqual(run.steps.map((b) => [b.model, b.effort]), [['opus', 'high'], ['sonnet', 'high']], 'the template fills the steps that name none');
  const { body: spec } = await launch(run, fakeLauncher());
  const a = spec.args;
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'high');
  const set = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.deepEqual(set.enabledMcpjsonServers, ['jira', 'bitbucket'], 'the light servers runs use, with no prompt; the heavy ones only where used');
  assert.ok(set.disabledMcpjsonServers.includes('FM-MCP') && set.disabledMcpServers.includes('FM-MCP'), 'a lighter session');
  assert.ok(['mongodb', 'mongodb-app', 'mongodb-global', 'opensearch'].every((s) => set.disabledMcpjsonServers.includes(s)), 'Mongo and the log search stay off in this step');
  assert.equal(set.enabledPlugins['cowork-plugin-management@synced'], false);
  assert.equal(set.enableArtifact, false);
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1', 'no helper-agent workflows unless the step asks for ultracode');
  assert.equal(spec.env.CLAUDE_CODE_DISABLE_CRON, '1');
  assert.match((await hook(run, 'status', { model: { display_name: 'Opus 5.5' }, cost: { total_cost_usd: 0.05 } })).body.line, /Say hello · Opus 5\.5 · \$0\.05/);

  // Recap wants sonnet: no block (claude ends its turn), the restart flag is set, the step is started.
  assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {});
  let now = await getRun(run.id);
  assert.deepEqual(now.steps.map((b) => b.status), ['done', 'running']);
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
  assert.equal((await getRun(run.id)).steps[1].cost || 0, 0);
  assert.match((await logs(run)).join('\n'), /restarted claude with sonnet · effort high/);
  assert.deepEqual((await hook(run, 'Stop', done('recap'))).body, {});
  assert.equal((await getRun(run.id)).status, 'done');
  await close(run);
  assert.equal((await orchText('template', 'delete', 'model-demo')).code, 0);
});

test('models: next or redo onto a step with another model restarts too; the same model does not', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello', wait: true },
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

test('models: "/orchestra model" in the tab switches the step working now, on the same conversation, with no redo', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello', model: 'sonnet', effort: 'high', wait: true },
    { id: 'recap', skill: 'orchestra-recap', label: 'Recap', model: 'sonnet' },
  ]);
  await launch(run, fakeLauncher());
  const say = async (prompt) => (await hook(run, 'UserPromptSubmit', { prompt })).body.output;
  // Plain talk stays talk; /orch in the tab is always Orchestra's: a wrong word gets one line, never the skill.
  assert.equal((await say('model opus'))?.decision, undefined);
  assert.match((await say('/orchestra model ITP2-1 opus')).reason, /"itp2-1" is not a model or effort/);
  assert.match((await say('/orch model opsu')).reason, /Did you mean opus\?/);
  assert.match((await say('/orch effort hihg')).reason, /Did you mean high\?/);
  assert.match((await say('/orch frobnicate')).reason, /"\/orch frobnicate" is not a tab command\. .*In this tab: next/);
  assert.match((await say('/orch help')).reason, /next   go on with "Say hello"/);
  assert.match((await say('/orch steps')).reason, /1\. Say hello/);
  assert.match((await say('/orch runs')).reason, /^Orchestra:\nRun\s+About\s+Status/);
  assert.equal((await say('/orchestra effort'))?.decision, 'block', '"effort" alone shows');
  assert.match((await say('/orchestra model')).reason, /"Say hello" already runs with sonnet, effort high/);
  // Switch the working step: block (the old claude stops), same conversation, a "go on" prompt, not the step again.
  const o = await say('/orchestra model opus effort ultracode');
  assert.equal(o.decision, 'block');
  assert.match(o.reason, /restarts this tab with opus, ultracode for "Say hello"[\s\S]*costs a lot/);
  let now = await getRun(run.id);
  assert.deepEqual([now.steps[0].model, now.steps[0].effort, now.steps[0].status], ['opus', 'ultracode', 'running']);
  assert.equal(now.restart.fresh, false);
  assert.ok(fs.existsSync(path.join(runsDir, run.id, 'restart.ok')));
  assert.ok(!chatOf(now).some((m) => /^\/orchestra model opus effort/.test(m.text)), 'a tab command, not talk');
  const { body: again } = await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  const a = again.args;
  assert.equal(a[a.indexOf('--resume') + 1], run.sessionId, 'the same conversation');
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'ultracode');
  assert.equal(again.env.CLAUDE_CODE_DISABLE_WORKFLOWS, undefined, 'ultracode may use workflows');
  assert.match(a.at(-1), /go on with the step "Say hello" from where you were\. Do not start the step again/);
  assert.doesNotMatch(a.at(-1), /run the skill/);
  // The same again: nothing to restart.
  assert.match((await say('/orchestra effort ultracode')).reason, /already runs with opus, ultracode/);
  assert.equal((await getRun(run.id)).restart, null);
  // orch model changes the run only; the step working now switches when "/orchestra model" is typed in the tab.
  const cli = await orchText('model', run.id, 'sonnet', 'high');
  assert.equal(cli.code, 0);
  assert.match(cli.out, /"Say hello" \(working now\) runs with sonnet, effort high\.\nType "\/orch model" in its tab to switch now/);
  assert.equal((await getRun(run.id)).restart, null, 'never a restart from outside');
  assert.match((await orchText('model', run.id, 'gpt 4!')).err, /"gpt 4!" is not a model or effort/);
  assert.match((await say('/orchestra model')).reason, /restarts this tab with sonnet, effort high/);
  await runnerCall('relaunchSpec', [run.id, run.hookToken, (await getRun(run.id)).session.pid]);
  // Waiting after the step: the next step changes, with no restart; it starts with it on next.
  await hook(run, 'Stop', done('hello'));
  assert.equal((await getRun(run.id)).status, 'waiting');
  assert.match((await say('/orchestra model haiku')).reason, /"Recap" \(the next step\) will run with haiku\. It starts with it when you type next/);
  assert.equal((await getRun(run.id)).restart, null);
  assert.equal((await getRun(run.id)).steps[1].model, 'haiku');
  await close(run);
});

test('go back: "/orch go <step> why" runs the template\'s own step again (no copies), and the steps after it; the first try stays as history', async () => {
  const run = await startRun([
    { id: 'hello', skill: 'orchestra-hello', label: 'Say hello', wait: true },
    { id: 'recap', skill: 'orchestra-recap', label: 'Recap', wait: true },
    { id: 'last', skill: 'orchestra-hello', label: 'Last' },
  ]);
  await launch(run, fakeLauncher());
  const say = async (prompt) => (await hook(run, 'UserPromptSubmit', { prompt })).body.output;
  await hook(run, 'Stop', done('hello'));
  await say('next');
  await hook(run, 'Stop', done('recap'));
  assert.equal((await getRun(run.id)).status, 'waiting');
  // A name that fits no step: said, nothing changes.
  assert.match((await say('/orch go nothing')).reason, /no step "nothing". Steps: 1. Say hello \(done\) · 2\. Recap \(done\) · 3\. Last\./);
  // Back to step 1 with a why: steps 1 and 2 run again (no copies), step 1 starts on this conversation.
  const o = await say('/orch go say hello the greeting is wrong');
  assert.equal(o.decision, 'block');
  assert.match(o.reason, /went back to "Say hello" \(it and the 1 step after it run again\)\. It starts on this conversation/);
  let now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => `${s.id}:${s.status}`), ['hello:running', 'recap:pending', 'last:pending'], 'no copies');
  assert.equal(now.steps[0].tries.length, 1, 'the first try is kept');
  assert.match(now.steps[0].tries[0].didWhy, /I did hello/);
  assert.equal(now.steps[0].attempts, 2);
  assert.equal(now.steps[1].tries.length, 1);
  assert.equal(now.restart.fresh, false);
  assert.ok(!chatOf(now).some((m) => /^\/orch go/.test(m.text)), 'a tab command, not talk');
  const { body: spec } = await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  const p = spec.args.at(-1);
  assert.match(p, /step "Say hello": run the skill \/orchestra-hello/);
  assert.match(p, /went back to this step[\s\S]*Why the user went back: the greeting is wrong[\s\S]*- Recap \(\/orchestra-recap\): .*I did recap/);
  assert.match((await orchText('run', run.id, 'full=yes')).out, /1\. Say hello[^\n]*running[^]*try 1: done/);
  // `back` is another name for it.
  await hook(run, 'Stop', done('hello again'));
  assert.match((await say('/orch back 1')).reason, /went back to "Say hello"/);
  assert.equal((await getRun(run.id)).steps[0].tries.length, 2);
  await close(run);
});

test('go forward: jump to Wrap up for a handover; the steps between are skipped, Wrap up starts, may push the vault, and is told why', async () => {
  // Tracking on: the ITP Wrap up writes to the vault.
  if (!(await orch('template', 'show', 'go-demo')).body.id) {
    assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'go-demo')).code, 0);
    assert.equal((await orchText('template', 'set', 'go-demo', 'tracking=on')).code, 0);
  }
  const run = await startRun([
    { id: 'logs', skill: 'orchestra-hello', label: 'Find it', wait: true },
    { id: 'plan', skill: 'orchestra-recap', label: 'Plan' },
    { id: 'build', skill: 'orchestra-hello', label: 'Build' },
    { id: 'wrap', skill: 'wrap-up', label: 'Wrap up' },
  ], { templateId: 'go-demo' });
  await launch(run, fakeLauncher());
  await hook(run, 'Stop', done('found it'));
  const o = (await hook(run, 'UserPromptSubmit', { prompt: '/orch go wrap up handing over to Samiul' })).body.output;
  assert.match(o.reason, /went to "Wrap up" \(skipped: Plan, Build\)/);
  const now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.status), ['done', 'skipped', 'skipped', 'running']);
  assert.match(now.steps[1].note, /Skipped: you went to "Wrap up" \(handing over to Samiul\)/);
  assert.ok(fs.existsSync(path.join(runsDir, run.id, 'wrap-up.ok')), 'the vault may be pushed now (after Allow)');
  assert.match(now.launchPrompt, /\/wrap-up[^]*went straight to this step\. Steps skipped to get here \(not done\): Plan, Build\. Why: handing over to Samiul\. Do not do the skipped steps/);
  assert.match((await orchText('run', run.id)).out, /2\. Plan \(\/orchestra-recap\) · skipped[^]*Skipped: you went to/);
  assert.match((await orchText('runs')).out, /4\/4 Wrap up/);
  // Wrap up done: the run is done (the skipped steps are passed over).
  await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  await hook(run, 'Stop', done('handed over'));
  assert.equal((await getRun(run.id)).status, 'done');
  // And go can return to a skipped step later.
  const back = (await hook(run, 'UserPromptSubmit', { prompt: '/orch go plan we got the ticket back' })).body.output;
  assert.match(back.reason, /went back to "Plan"/);
  assert.deepEqual((await getRun(run.id)).steps.map((s) => s.status), ['done', 'running', 'pending', 'pending']);
  await close(run);
  fs.rmSync(path.join(dataDir, 'templates', 'go-demo.json'));
});

test('skills new: the solution\'s skills since you last looked; the first look keeps only this month\'s; seen marks them', async () => {
  const data = path.join(tmp, `seen-data-${Date.now()}`);
  const itp = path.join(tmp, `seen-itp-${Date.now()}`);
  const skill = (name, days) => {
    const dir = path.join(itp, '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} does a thing\n---\nBody.\n`);
    const t = new Date(Date.now() - days * 86400000);
    fs.utimesSync(file, t, t);
  };
  skill('old-one', 90);
  skill('fresh-one', 2);
  const env2 = { ORCHESTRA_DATA_DIR: data, ORCHESTRA_SOLUTION_ROOT: itp.replace(/\\/g, '/') };
  const run = async (...args) => JSON.parse((await proc([path.join(ROOT, 'bin/orch.mjs'), ...args, '--json'], { extraEnv: env2 })).out);
  fs.mkdirSync(data, { recursive: true });
  // The first look goes by the older of a SKILL.md's birth and change time.
  const first = (await run('skills', 'new')).map((s) => s.name);
  assert.ok(first.includes('fresh-one'), 'this month\'s skill is new');
  assert.ok(!first.includes('old-one'), 'an old skill counts as seen on the first look');
  await run('skills', 'seen', 'fresh-one');
  assert.ok(!(await run('skills', 'new')).some((s) => s.name === 'fresh-one'), 'seen by name');
  skill('brand-new', 0);
  assert.deepEqual((await run('skills', 'new')).map((s) => s.name).filter((n) => n === 'brand-new'), ['brand-new'], 'a skill that comes later is new');
  await run('skills', 'seen');
  assert.deepEqual(await run('skills', 'new'), [], 'all seen');
});

test('about: a title from the pick list shows at once; the run\'s own summary (said while it still asks) replaces it; yours stays', async () => {
  const { body: started } = await orch('start', 'demo-hello-recap', 'ABC-77');
  const run = await waitFor(async () => { const r = await getRun(started.id); return r.session?.open ? r : null; }, 'its tab to open');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  assert.equal((await orchText('about', 'ABC-77', 'Title from the list', 'soft=yes')).code, 0);
  assert.equal((await getRun(run.id)).about, 'Title from the list');
  // The first step has read the task and asks about the steps: no DONE yet, but the tab learns what it is.
  await hook(run, 'Stop', say('Here is the task. Go with these steps?\nORCHESTRA:TASK ABC-77 | Real title\nORCHESTRA:ABOUT: Real title — fix the legend'));
  let now = await getRun(run.id);
  assert.equal(now.about, 'Real title — fix the legend', 'the run\'s own summary replaces the stand-in');
  assert.ok(!now.aboutSoft);
  assert.deepEqual([now.task.key, now.task.title], ['ABC-77', 'Real title']);
  // One you set by hand is never replaced.
  assert.equal((await orchText('about', 'ABC-77', 'Mine')).code, 0);
  await hook(run, 'Stop', say('more\nORCHESTRA:ABOUT: Something else'));
  assert.equal((await getRun(run.id)).about, 'Mine');
  await close(run);
});

test('intake: a run started with nothing takes the key its first step picks (a work order); plain words in the tab move the run', async () => {
  // Start with nothing: one run, no task yet; its first step gets no words.
  const { body: d } = await orch('start', 'demo-hello-recap', 'draft=yes');
  assert.equal(d.input.text, '');
  assert.equal((await orchText('steps', d.id, 'set', 'hello', 'wait=on')).code, 0);
  assert.equal((await orchText('steps', d.id, 'add', 'orchestra-hello', 'label=Build')).code, 0);
  assert.equal((await orchText('start', d.id)).code, 0);
  const run = await waitFor(async () => { const r = await getRun(d.id); return r.session?.open ? r : null; }, 'the empty run to open');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  const spec = (await launch(await getRun(run.id), fakeLauncher())).body;
  assert.equal(spec.args.at(-1), '/orchestra-hello', 'the first step gets no task words');
  assert.match(spec.args[spec.args.indexOf('--append-system-prompt') + 1], /\.orchestra\/task\.md[^]*ORCHESTRA:DO <command>/);
  // The first step picks a work order: the run takes its key.
  await hook(run, 'Stop', done('picked it\nORCHESTRA:TASK TSP-W-001 | Export dashboards to a file'));
  let now = await getRun(run.id);
  assert.deepEqual(now.task && [now.task.key, now.task.title], ['TSP-W-001', 'Export dashboards to a file']);
  assert.equal((await orch('run', 'TSP-W-001')).body.id, run.id, 'found by the work order key');
  assert.match((await orchText('runs')).out, /TSP-W-001\s+Export dashboards/);
  assert.equal((await orchText('start', 'demo-hello-recap', 'TSP-W-002', 'draft=yes')).code, 0, 'a work order key is a key');
  // Plain words, passed on by Claude: a small one (pin) just happens.
  await hook(run, 'UserPromptSubmit', { prompt: 'keep that in the pane' });
  let out = (await hook(run, 'Stop', say('Here are the steps.\nORCHESTRA:DO pin'))).body.output;
  assert.match(out.systemMessage, /Orchestra pinned/);
  // An unknown one: the usage, shown to you.
  out = (await hook(run, 'Stop', say('Ok.\nORCHESTRA:DO frobnicate'))).body.output;
  assert.match(out.systemMessage, /is not a tab command/);
  // next, asked in words: Claude gets the next step as a new turn.
  out = (await hook(run, 'Stop', say('Going on.\nORCHESTRA:DO next'))).body.output;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /\/orchestra-recap/);
  // A big move after the user's yes: go forward, the step between is skipped, a restart starts it.
  out = (await hook(run, 'Stop', say('Ok, skipping to Build.\nORCHESTRA:DO go build handing over'))).body;
  assert.deepEqual(out, {});
  now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.status), ['done', 'skipped', 'running']);
  assert.ok(now.restart);
  await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  await hook(run, 'Stop', done('built\nORCHESTRA:DO go 1'));
  assert.deepEqual((await getRun(run.id)).steps.map((s) => s.status), ['done', 'skipped', 'done'], 'a DO that came with DONE is ignored');
  await close(run);
});

test('core: no ITP word in the core (lib, bin, skills, defaults); ITP lives only in packs/itp', () => {
  const ITP = /\bitp\w*|itpkv|teamspace|work.?orders?\b|apphost|aspire|debug\.json|orbitax|close-epic|registry_call|\bmission\b|\bvault\b|\bTSP-|run-stack|webclient|\bdotnet\b/i;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else String(fs.readFileSync(p, 'utf8')).split('\n').forEach((line, i) => ITP.test(line) && hits.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`));
    }
  };
  for (const d of ['lib', 'bin', 'skills', 'defaults']) walk(path.join(ROOT, d));
  assert.deepEqual(hits, [], 'move these into packs/itp (a pack field, or the pack\'s own files)');
});

test('mine: the pack lists the work you hold, read only, numbered, with the run each has', async () => {
  // A fake ITP helper: registry_call answers from files and logs every method it is asked for.
  const root = path.join(tmp, 'mine-itp');
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  const log = path.join(root, 'calls.log').replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'common.sh'), [
    `REGISTRY_BODY="${root.replace(/\\/g, '/')}/body.json"`,
    'registry_configured() { [[ -z "${NO_REG:-}" ]]; }',
    `registry_call() { echo "$1 $2" >> "${log}"; case "$2" in`,
    `  /api/me) printf '%s' '{"id":"m-7","name":"Dev"}' > "$REGISTRY_BODY" ;;`,
    `  /api/members/m-7/working-on) printf '%s' '{"items":[{"woKey":"TSP-W-7","title":"Export dashboards","state":"In Progress"},{"woKey":"TSP-W-8","title":"Fix the legend","state":"Picked"}]}' > "$REGISTRY_BODY" ;;`,
    '  *) printf 404; return 0 ;; esac; printf 200; }',
    '',
  ].join('\n'));
  useEnv({ ORCHESTRA_SOLUTION_ROOT: root.replace(/\\/g, '/') });
  try {
    const draft = await orch('start', 'demo-hello-recap', 'TSP-W-8', 'draft=yes');
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const out = await orch('mine');
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.items.map((x) => [x.n, x.key, x.title, x.state, !!x.run]), [[1, 'TSP-W-7', 'Export dashboards', 'In Progress', false], [2, 'TSP-W-8', 'Fix the legend', 'Picked', true]]);
    assert.match((await orchText('mine')).out, /1\s+TSP-W-7\s+Export dashboards/);
    assert.deepEqual([...new Set(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0]))], ['GET'], 'read only');
    await orch('delete', draft.body.id);
    // Not configured: it says so, and lists nothing.
    const off = await proc([path.join(ROOT, 'bin/orch.mjs'), 'mine', '--json'], { extraEnv: { NO_REG: '1' } });
    assert.match(JSON.parse(off.out).problem, /not configured/);
  } finally {
    useEnv();
  }
  // No pack: nothing to list, said plainly.
  useEnv({ ORCHESTRA_PACK: 'none' });
  try {
    assert.match((await orch('mine')).body.problem, /no tracker list/);
  } finally {
    useEnv();
  }
});

test('no template: pasted keys each open a run whose first step picks the task and the steps, and puts them in with "this"', async () => {
  // intake, as setup installs it (the core version).
  fs.cpSync(path.join(ROOT, 'skills/intake'), path.join(homeSkills, 'intake'), { recursive: true });
  const out = await orch('start', 'ITP2-9101,', 'TSP-W-9102');
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const runs = out.body;
  assert.deepEqual(runs.map((r) => [r.input.text, r.templateId, r.steps.map((s) => s.skill).join()]), [['ITP2-9101', null, 'intake'], ['TSP-W-9102', null, 'intake']]);
  const run = await waitFor(async () => { const r = await getRun(runs[0].id); return r.session?.open ? r : null; }, 'its tab to open');
  await waitFor(async () => (await getRun(runs[1].id)).session?.open, 'every tab opens at once');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  const spec = (await launch(await getRun(run.id), fakeLauncher())).body;
  assert.equal(spec.args.at(-1), '/intake ITP2-9101');
  const settings = JSON.parse(spec.args[spec.args.indexOf('--settings') + 1]);
  assert.ok(settings.permissions.allow.some((r) => /orch\.mjs use this:\*\)$/.test(r)), 'its own-run commands need no Allow');
  assert.ok(!settings.permissions.allow.some((r) => /orch\.mjs (delete|clean|stop)/.test(r)));
  // "this" is the run of the tab: only with its own token.
  const asRun = (...a) => proc([path.join(ROOT, 'bin/orch.mjs'), ...a], { extraEnv: { ORCHESTRA_RUN_ID: run.id, ORCHESTRA_HOOK_TOKEN: run.hookToken } });
  assert.match((await orchText('use', 'this', 'demo-hello-recap')).err, /"this" works only inside a run's tab/);
  let r = await asRun('use', 'this', 'demo-hello-recap');
  assert.equal(r.code, 0, r.err);
  let now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.skill), ['intake', 'orchestra-hello', 'orchestra-recap']);
  assert.equal(now.templateId, 'demo-hello-recap');
  r = await asRun('steps', 'this', 'set', 'hello', 'heavy=on');
  assert.equal(r.code, 0, r.err);
  assert.equal((await getRun(run.id)).steps[1].heavy, true);
  r = await asRun('template', 'from', 'this', 'mine-from-run', 'name=Mine');
  assert.equal(r.code, 0, r.err);
  const saved = (await orch('template', 'show', 'mine-from-run')).body;
  assert.deepEqual([saved.name, saved.steps.map((s) => s.skill), saved.steps[0].heavy], ['Mine', ['orchestra-hello', 'orchestra-recap'], true]);
  fs.rmSync(path.join(dataDir, 'templates', 'mine-from-run.json'));
  // Heavy marks per skill.
  assert.equal((await orchText('skill-mark', 'orchestra-recap', 'light')).code, 0);
  assert.match((await orchText('skills', 'orchestra-recap')).out, /orchestra-recap\s+\S+\s+light/);
  // The first step ends: the run takes the key; the plan it chose is kept for the lessons; the next step starts.
  const end = await hook(run, 'Stop', done('picked\nORCHESTRA:TASK ITP2-9101 | Fix the row\nORCHESTRA:PLAN suggested: Say hello > Recap | chosen: Say hello > Recap > Extra'));
  now = await getRun(run.id);
  assert.deepEqual(now.plan && [now.plan.suggested, now.plan.chosen], ['Say hello > Recap', 'Say hello > Recap > Extra']);
  assert.match(end.body.output.reason, /\/orchestra-hello/);
  const { material } = await import('../lib/learn.mjs');
  assert.match(material(now), /suggested the steps Say hello > Recap; you changed them to Say hello > Recap > Extra/);
  for (const x of runs) await close(await getRun(x.id));
});

test('guided run: the template is only a guide; steps are picked one at a time (no wait gate); the pane shows what is likely next', async () => {
  fs.cpSync(path.join(ROOT, 'skills/intake'), path.join(homeSkills, 'intake'), { recursive: true });
  const body = (await orch('start', 'ITP2-9301')).body;
  const started = Array.isArray(body) ? body[0] : body;
  const run = await waitFor(async () => { const r = await getRun(started.id); return r.session?.open ? r : null; }, 'its tab to open');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  const rulesOf = (spec) => spec.args[spec.args.indexOf('--append-system-prompt') + 1];
  assert.match(rulesOf((await launch(await getRun(run.id), fakeLauncher())).body), /Never change the steps without asking/, 'no guide: the old rule');
  const asRun = (...a) => proc([path.join(ROOT, 'bin/orch.mjs'), ...a], { extraEnv: { ORCHESTRA_RUN_ID: run.id, ORCHESTRA_HOOK_TOKEN: run.hookToken } });
  const pane = async (...a) => (await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once', ...a])).out.replace(/\x1b\[[\d;]*m/g, '');

  // The guide: no steps go in; the run shows what is likely next.
  let r = await asRun('use', 'this', 'demo-hello-recap', 'guide=yes');
  assert.equal(r.code, 0, r.err);
  let now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.skill), ['intake']);
  assert.deepEqual([now.templateId, now.guide.steps.map((s) => s.id)], ['demo-hello-recap', ['hello', 'recap']]);
  assert.match((await asRun('run', 'this')).out, /Guide: Demo: hello then recap[\s\S]*Likely next: hello \(\/orchestra-hello[^\n]*· recap/);
  assert.match(await pane('--rows', '30', '--cols', '60'), /· Say hello\n· Recap/, 'no pin: grey lines');

  // A picked guide step keeps its settings, with no wait gate; a set keeps mcp.
  fs.writeFileSync(path.join(dataDir, 'templates', 'demo-hello-recap.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/demo-hello-recap.json'), 'utf8')), steps: [{ id: 'hello', skill: 'orchestra-hello', label: 'Say hello', wait: true, model: 'sonnet' }, { id: 'recap', skill: 'orchestra-recap', label: 'Recap' }] }));
  assert.equal((await asRun('use', 'this', 'demo-hello-recap', 'guide=yes')).code, 0);
  r = await asRun('steps', 'this', 'add', 'hello');
  assert.equal(r.code, 0, r.err);
  now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => [s.id, s.label, s.wait, s.model]), [['intake', 'Pick the task and the steps', false, 'opus'], ['hello', 'Say hello', false, 'sonnet']]);
  assert.equal((await asRun('steps', 'this', 'set', 'hello', 'mcp=on')).code, 0);
  assert.equal((await getRun(run.id)).steps[1].mcp, true, 'mcp stays on a step change');
  assert.match((await asRun('run', 'this')).out, /Likely next: recap/);

  // With a pin, the steps fold: the step now and one grey line; the pin gets the rest.
  await orch('pin', run.id, Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
  const out = await pane('--rows', '20', '--cols', '60');
  assert.match(out, /● 1 Pick the task[^\n]*\n· next: Say hello · Recap\n/, 'the step now, then the picked step and the guide\'s, grey');
  assert.ok(!/○/.test(out), 'no step lines to come');
  assert.ok(out.split('\n').filter((l) => /^line \d+/.test(l)).length >= 8, 'the pin has the room (12 steps would take no more)');

  // This claude started before the guide: the step's instruction carries the whole pick rule.
  // (hello wants sonnet: claude restarts with it, so the instruction is the restart's prompt.)
  await hook(run, 'Stop', done('picked the first step'));
  const told = (await getRun(run.id)).launchPrompt;
  assert.match(told, /\/orchestra-hello/);
  assert.match(told, /ask which step comes next with AskUserQuestion[\s\S]*Open items first/);
  // A claude that starts now has it in its rules; the instruction only reminds.
  const rules = rulesOf((await launch(await getRun(run.id), fakeLauncher())).body);
  assert.match(rules, /picks its steps one at a time/);
  assert.ok(!/Never change the steps without asking/.test(rules));
  // Nothing more picked: DONE ends the run.
  await hook(run, 'Stop', done('hello'));
  now = await getRun(run.id);
  assert.equal(now.status, 'done');
  // Wrap up may save the picked steps over the guide (replace keeps its name), or as a new template.
  assert.match((await orchText('template', 'from', run.id, 'demo-hello-recap')).err, /already exists \(replace=yes/);
  assert.equal((await orchText('template', 'from', run.id, 'demo-hello-recap', 'replace=yes')).code, 0);
  const saved = (await orch('template', 'show', 'demo-hello-recap')).body;
  assert.deepEqual([saved.name, saved.steps.map((s) => [s.id, s.wait])], ['Demo: hello then recap', [['hello', false]]]);
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/demo-hello-recap.json'), path.join(dataDir, 'templates/demo-hello-recap.json'));
  await close(now);
});

test('go from outside: a working run is refused; a waiting one starts at once; a step working now is skipped when you jump', async () => {
  const run = await startRun([{ id: 'a', skill: 'orchestra-hello', wait: true }, { id: 'b', skill: 'orchestra-recap' }, { id: 'c', skill: 'orchestra-hello' }]);
  await launch(run, fakeLauncher());
  assert.match((await orchText('go', run.id, 'c')).err, /it is working now/);
  // In the tab, a jump past the step working now skips it.
  const o = (await hook(run, 'UserPromptSubmit', { prompt: '/orch jump c' })).body.output;
  assert.match(o.reason, /went to "orchestra-hello" \(skipped: orchestra-hello, orchestra-recap\)/);
  let now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.status), ['skipped', 'skipped', 'running']);
  await runnerCall('relaunchSpec', [run.id, run.hookToken, now.session.pid]);
  await hook(run, 'Stop', done('c'));
  // From outside, on a finished run with its tab open: it starts at once.
  const out = await orchText('go', run.id, 'b', 'one more look');
  assert.equal(out.code, 0, out.err);
  now = await getRun(run.id);
  assert.deepEqual(now.steps.map((s) => s.status), ['skipped', 'running', 'pending']);
  assert.ok(now.restart, 'its claude restarts to start it');
  await close(run);
  // Tab closed: the run moves; the step starts when you reopen it and type next.
  const moved = await orchText('go', run.id, 'a');
  assert.match(moved.out, /went back to "orchestra-hello"[^]*Its tab is closed/);
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
    assert.match(out, /now with sonnet\. Restarting claude on the same conversation/);
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
  assert.match(prompt, /Say hello \(\/orchestra-hello\): - I did hello, because the step asked\./, 'what the step before did');
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
  assert.equal((await getRun(run.id)).steps[1].cost, 0.02);

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
  assert.deepEqual(now.steps.map((b) => b.status), ['done', 'running']);
  assert.equal(now.steps[0].summary, 'hello');
  assert.equal(now.steps[0].didWhy, '- I did hello, because the step asked.');
  assert.equal(now.steps[0].cost, 0.05);
  await hook(run, 'status', { cost: { total_cost_usd: 0.08 } });
  assert.deepEqual((await hook(run, 'Stop', done('recap'))).body, {}, 'the last step: Claude may stop');
  now = await getRun(run.id);
  assert.equal(now.status, 'done');
  assert.equal(now.steps[1].cost, 0.03);
  assert.equal(now.cost, 0.08);
  const { body: tpl } = await api('GET', '/api/templates/demo-hello-recap');
  assert.equal(tpl.steps[0].status, undefined, 'the template stays the same');
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
  assert.deepEqual(now.steps.map((b) => b.status), ['done', 'running']);
  assert.ok(!now.steps[0].summary.includes('ORCHESTRA:ABOUT'), 'the line is taken out of the step summary');
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
  assert.deepEqual(now.steps.map((b) => b.status), ['done', 'running']);
  assert.equal(now.pins.length, 1, 'the same steps again are not pinned twice');
  assert.equal(now.pins[0].title, 'Test steps');
  assert.equal(now.pins[0].from, 'claude');
  assert.match(now.pins[0].text, /^1\. Open \*\*Pillar 2\*\* → GIR\n2\./);
  assert.ok(!now.steps[0].summary.includes('ORCHESTRA:PIN') && now.steps[0].summary.includes('Open'), 'the markers go, the steps stay');

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
  const said = chatOf(now).map((m) => m.text);
  assert.ok(!said.some((t) => /^pin( \d+|:.*)?$/i.test(t)), 'pin words are not talk');
  assert.ok(said.includes('pin the lodash version please'), 'talk stays talk');

  // The pane: newest first, the steps fold to make room, the pin scrolls, ← → pick another pin.
  const pane = async (...a) => (await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once', ...a])).out;
  let out = await pane('--rows', '24', '--cols', '40', '--pin', '4');
  const lines = out.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 24, 'fits the pane');
  assert.ok(lines.every((l) => l.replace(/\x1b\[[\d;]*m/g, '').length <= 39), 'no line is wider than the pane');
  assert.match(out, /Pinned 4\/4 · Test steps/);
  assert.equal(lines[lines.findIndex((l) => /Pinned 4\/4/.test(l)) - 1], '', 'an empty line keeps the pin apart');
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
  assert.equal(now.steps[1].status, 'failed');

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

test('no marker: the run needs you; FAILED fails; redo runs the step again; next skips it', async () => {
  const run = await startRun();
  await hook(run, 'Stop', say('Which color do you like? I suggest blue.'));
  let now = await getRun(run.id);
  assert.equal(now.status, 'needs-you');
  assert.match(now.asks, /Which color/);
  assert.equal(now.steps[0].status, 'running', 'the step goes on with your answer');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'blue' })), /^Once you know what this run's ticket/, 'only the ABOUT ask');
  now = await getRun(run.id);
  assert.equal(now.status, 'running');
  assert.equal(chatOf(now).at(-1).text, 'blue', 'kept for the lessons');

  await hook(run, 'Stop', say('The file is locked.\nORCHESTRA:FAILED'));
  now = await getRun(run.id);
  assert.equal(now.status, 'failed');
  assert.equal(now.steps[0].failures, 1);
  assert.match(now.steps[0].error, /locked/);
  // next on a failed step does not move past it: it says redo or skip.
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /"Say hello" failed[\s\S]*redo[\s\S]*skip/);
  assert.equal((await getRun(run.id)).steps[0].status, 'failed');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'redo' })), /run this step again.*\/orchestra-hello/);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.steps[0].status, now.steps[0].attempts], ['running', 'running', 2]);

  // next on a step that has not said it is done goes on with it (never marks it done); skip moves past it.
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /go on with the step "Say hello" from where you stopped \(do not start it again\)/);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.steps[0].status, now.steps[1].status], ['running', 'running', 'pending']);
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'skip' })), /\/orchestra-recap/);
  now = await getRun(run.id);
  assert.equal(now.steps[0].note, 'skipped by you');
  assert.equal(now.steps[1].status, 'running');
  await hook(run, 'Stop', done('recap'));
  assert.equal((await getRun(run.id)).status, 'done');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /All steps .* are done/);
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'skip' })), /All steps .* are done/);
  await close(run);
});

// ---- the app, one run at a time (bin/app.mjs) ----

// Two ports that are free on this PC now, never fixed ones another program may hold.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const API_PORT = await freePort();
const WEB_PORT = await freePort();
const APP_PORTS = `api=${API_PORT},web=${WEB_PORT}`;
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
    return (await fetch(`http://localhost:${API_PORT}/health`)).ok;
  } catch {
    return false;
  }
};

test('app: runs wait in line for the app; it is held until next; a closed tab hands it on', async () => {
  const a = await startRun([{ id: 'test', skill: 'orchestra-hello', label: 'Test in the app', wait: true }, { id: 'recap', skill: 'orchestra-recap' }]);
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

test('app: a run waiting for you after a step may take the app (preqa); next lets go of it', async () => {
  const a = await startRun([{ id: 'review', skill: 'orchestra-hello', label: 'Review', wait: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  const b = await startRun();
  try {
    await hook(a, 'Stop', done('reviewed'));
    assert.equal((await getRun(a.id)).status, 'waiting');
    // You talk to Claude between steps (the status moves on, the run still waits after the step).
    await hook(a, 'UserPromptSubmit', { prompt: 'QA is here: start the app for preqa' });
    await hook(a, 'Notification', { message: 'Claude needs your permission' });
    assert.match((await app(a, 'take', '--minutes', '0')).out, /You have the app/, 'between steps, for QA');
    await hook(a, 'Stop', { last_assistant_message: 'The app is up for QA.' });
    assert.equal((await app(b, 'take', '--minutes', '0')).code, 3, 'held while A still waits for you');
    await hook(a, 'UserPromptSubmit', { prompt: 'next' });
    assert.match((await app(b, 'take', '--minutes', '0')).out, /You have the app/, 'next ended the waiting hold');
  } finally {
    for (const r of [a, b]) await close(r);
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

test('launcher: the AppHost gets the run\'s resource list, keeps your own settings, and leaves the brokers off when they run', async () => {
  const L = await import('../packs/itp/app/launcher.mjs');
  const saved = { start: process.env.ORCHESTRA_APP_START, mission: process.env.ITP_MissionApis };
  delete process.env.ORCHESTRA_APP_START;
  const ws = path.join(tmp, 'ws-apphost');
  const host = L.apphostDir(ws);
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, 'Orbitax.AppHost.csproj'), '<Project />');
  fs.writeFileSync(path.join(host, 'appsettings.local.json'), `{
  // mine
  "AppHost": { "SqaDatabase": false, "Url": "http://x//y", "Resources": {
    "webclient": { "enabled": true, "scriptName": "mine" }, // my script
    "platform": { "enabled": false, "env": { "A__B": "1" } },
    "website-api": { "enabled": true },
  } }
}`);
  try {
    process.env.ITP_MissionApis = '';
    assert.ok(!L.defaultServices('apphost', ws).includes('mission'), 'no Mission consumer on this branch');
    fs.mkdirSync(path.join(ws, 'ITP-API/Orbitax.Platform.Api/Applications/Orbitax.MissionPlatform.Consumer'), { recursive: true });
    const services = L.defaultServices('apphost', ws);
    assert.deepEqual(services, ['webclient', 'api', 'primary', 'secondary', 'spreadsheet', 'scheduler', 'mcp', 'idp', 'mission']);
    process.env.ITP_MissionApis = ',';
    assert.ok(!L.defaultServices('apphost', ws).includes('mission'), 'MissionApis="," keeps XatBot on Primary');
    assert.equal(L.missionOff(ws, ['api']), false, 'Debug.json already keeps XatBot on Primary: nothing to add');

    // Mission left off while MissionApis sends XatBot to it: each host this start runs gets ITP_MissionApis=",".
    process.env.ITP_MissionApis = '';
    const noMission = services.filter((s) => s !== 'mission');
    const offCmd = L.startCommand('apphost', ws, noMission, { brokersRunning: true });
    assert.equal(offCmd.env.ITP_MissionApis, ',', 'the AppHost gets it too');
    const offRes = JSON.parse(fs.readFileSync(path.join(host, 'appsettings.local.json'), 'utf8')).AppHost.Resources;
    assert.deepEqual(offRes.platform.env, { A__B: '1', ITP_MissionApis: ',' }, 'added beside your own env');
    assert.deepEqual([offRes.primary.env?.ITP_MissionApis, !!offRes.mission?.enabled, offRes['website-api'].env, offRes.redis.env], [',', false, undefined, undefined]);

    const cmd = L.startCommand('apphost', ws, services, { brokersRunning: true });
    assert.equal(cmd.env.ITP_MissionApis, undefined, 'Mission on: no override');
    assert.deepEqual([cmd.exe, ...cmd.args], ['dotnet', 'run', '--project', 'Applications/Orbitax.AppHost', '--launch-profile', 'http']);
    assert.equal(path.resolve(cmd.cwd).toLowerCase(), path.resolve(ws, 'ITP-API/Orbitax.Platform.Api').toLowerCase());
    assert.equal(cmd.env.ASPIRE_ALLOW_UNSECURED_TRANSPORT, 'true');
    const written = JSON.parse(fs.readFileSync(path.join(host, 'appsettings.local.json'), 'utf8'));
    const res = written.AppHost.Resources;
    for (const on of ['webclient', 'platform', 'primary', 'secondary', 'spreadsheetjob', 'scheduler', 'mcp-consumer', 'teamspace-agent', 'mission']) assert.equal(res[on].enabled, true, on);
    for (const off of ['redis', 'rabbitmq', 'website-api']) assert.equal(res[off].enabled, false, off);
    assert.equal(res.webclient.scriptName, 'mine', 'your webclient script is kept');
    assert.deepEqual(res.platform.env, { A__B: '1' }, 'your env is kept, the earlier start\'s "," is gone');
    assert.equal(res.primary.env, undefined, 'an env map Orchestra made is gone again');
    assert.equal(written.AppHost.Url, 'http://x//y', '// inside a string is not a comment');
    L.startCommand('apphost', ws, ['api'], { brokersRunning: false });
    const again = JSON.parse(fs.readFileSync(path.join(host, 'appsettings.local.json'), 'utf8')).AppHost.Resources;
    assert.deepEqual([again.redis.enabled, again.rabbitmq.enabled, again.webclient.enabled], [true, true, false], 'brokers on when nothing serves them');

    // The backup lives in Orchestra's data folder, never in the ITP repo; an old one in the repo moves out.
    const inRepo = path.join(host, 'appsettings.local.json.bak-orchestra');
    fs.writeFileSync(inRepo, '{"old":1}');
    // In a child with the tests' data folder (an import here would see this PC's data folder).
    const keep = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'packs/itp/app/launcher.mjs')).href)}).then((L) => console.log(L.keepSettingsBackup(${JSON.stringify(ws)})))`;
    const kept = await proc(['--input-type=module', '-e', keep]);
    const backup = kept.out.trim();
    assert.ok(!fs.existsSync(inRepo), 'nothing left in the repo');
    assert.ok(path.resolve(backup).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase()), backup + kept.err);
    assert.equal(fs.readFileSync(backup, 'utf8'), '{"old":1}', 'the older backup wins');
    await proc(['--input-type=module', '-e', keep]);
    assert.equal(fs.readFileSync(backup, 'utf8'), '{"old":1}', 'never overwritten');

    assert.equal(L.serviceName('Platform'), 'api');
    assert.equal(L.serviceName('spreadsheetjob'), 'spreadsheet');
    assert.throws(() => L.serviceName('nope'), /unknown service/);
    assert.deepEqual(L.unsupported('runstack', services), ['scheduler', 'mcp', 'idp', 'mission']);
    assert.throws(() => L.startCommand('runstack', ws, ['api']), /no run-stack\.ps1.*launcher=apphost/);
    assert.throws(() => L.startCommand('apphost', path.join(tmp, 'ws-old'), ['api']), /no Aspire AppHost.*launcher=runstack/);
    assert.deepEqual(L.restartCommand('apphost', ws, ['api']), { full: true });
    assert.match(L.restartCommand('runstack', ws, ['api', 'primary']).args.at(-1), /-Restart -Only api,primary$/);
  } finally {
    for (const [k, v] of [['ORCHESTRA_APP_START', saved.start], ['ITP_MissionApis', saved.mission]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('launcher: orch settings picks it; app start, restart and logs use it; stop also ends hosts with no port', async () => {
  assert.equal((await orch('settings')).body.launcher, 'apphost', 'the AppHost by default');
  assert.equal((await orch('settings', 'launcher=runstack')).body.launcher, 'runstack');
  assert.match((await orchText('settings')).out, /the app starts with: run-stack\.ps1/);
  assert.equal((await orch('settings', 'launcher=docker')).status, 400);
  await orch('settings', 'launcher=apphost');

  const a = await startRun();
  let jobless;
  try {
    await app(a, 'take', '--minutes', '0');
    const s1 = await app(a, 'start', '--services', 'webclient,platform', '--with', 'mission', '--minutes', '0.5');
    assert.equal(s1.code, 0, s1.err + s1.out);
    assert.match(s1.out, /with the Aspire AppHost/);
    assert.match(s1.out, /Mission consumer \(:50550\)/);
    const serving = JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8'));
    assert.deepEqual([serving.launcher, serving.services], ['apphost', ['webclient', 'api', 'mission']]);
    const ws = serving.workspace;
    fs.writeFileSync(path.join(ws, '.run-logs', 'api.log'), 'one\ntwo\nfail: boom\n');
    assert.match((await app(a, 'logs')).out, /api\.log/);
    assert.match((await app(a, 'logs', 'api', '--lines', '1')).out, /^fail: boom/);
    assert.notEqual((await app(a, 'logs', 'nope')).code, 0);

    // A restart (a custom start: the whole app again) keeps the services.
    const r = await app(a, 'restart', '--minutes', '0.5');
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Restarting the whole app/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8')).services, ['webclient', 'api', 'mission']);

    // A host with no port, from the run's folder (like the Spreadsheet Job): stop ends it too.
    jobless = spawn(process.execPath, [path.join(ROOT, 'test/fake-app.mjs'), path.join(ws, 'Orbitax.Spreadsheet.Job')], { env: { ...env, ORCHESTRA_APP_PORTS: '' }, stdio: 'ignore' });
    await new Promise((ok) => setTimeout(ok, 500));
    assert.match((await app(null, 'stop')).out, /stopped/);
    await waitFor(() => jobless.exitCode !== null || jobless.signalCode !== null, 'the host with no port to stop');
  } finally {
    await app(null, 'stop', '--force');
    jobless?.kill();
    await close(a);
  }
});

test('log copier: Aspire\'s per-service consoles become plain .run-logs/<service>.log files; stop ends the copier', async () => {
  const L = await import('../packs/itp/app/launcher.mjs');
  assert.equal(L.dcpLine('12 2026-11-03T11:25:24.801Z \x1b[40m\x1b[31mfail\x1b[39m\x1b[22m\x1b[49m: Boom[0]'), 'fail: Boom[0]');
  assert.deepEqual([L.logNameOf('platform'), L.logNameOf('spreadsheetjob'), L.logNameOf('mission'), L.logNameOf('website-api')], ['api', 'spreadsheet', 'mission', 'website-api']);

  const session = path.join(tmp, 'dcp-session');
  fs.mkdirSync(session, { recursive: true });
  const resource = (id, name) => fs.writeFileSync(path.join(session, `resource-executable-${id}.log`), `x\tinfo\tExecutableReconciler\tStarting process...\t{"Executable": "/${name}", "Cmd": "dotnet"}\n`);
  resource('aaa', 'platform-tntkkttu');
  resource('bbb', 'primary-fqwfnhzn');
  fs.writeFileSync(path.join(session, 'aaa_out'), '1 2026-11-03T11:25:24.801Z \x1b[32minfo\x1b[39m: started\n');
  fs.writeFileSync(path.join(session, 'bbb_err'), '');
  const run = await startRun();
  const extra = { ...appEnv(run), ORCHESTRA_DCP_SESSION: session };
  const appX = (...args) => proc([path.join(ROOT, 'bin/app.mjs'), ...args], { extraEnv: extra });
  try {
    await appX('take', '--minutes', '0');
    const s = await appX('start', '--minutes', '0.5');
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /dev IdP .* cannot start: no teamspace-agent folder/, 'a missing IdP is named');
    const serving = JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8'));
    assert.ok(!serving.services.includes('idp'), 'started without the IdP');
    const logs = path.join(serving.workspace, '.run-logs');
    await waitFor(() => fs.existsSync(path.join(logs, 'api.log')) && fs.readFileSync(path.join(logs, 'api.log'), 'utf8') === 'info: started\n', 'api.log from the copier');
    // Lines come as they are written, half lines wait for their end; a restarted service's new file is read too.
    fs.appendFileSync(path.join(session, 'aaa_out'), '2 2026-11-03T11:25:25.000Z fail: Boom\n3 2026-11-03T11:25:25.100Z half');
    fs.appendFileSync(path.join(session, 'bbb_err'), '1 2026-11-03T11:25:25.000Z Unhandled exception\n');
    resource('ccc', 'platform-tntkkttu');
    fs.writeFileSync(path.join(session, 'ccc_out'), '1 2026-11-03T11:26:00.000Z info: again\n');
    await waitFor(() => /again/.test(fs.readFileSync(path.join(logs, 'api.log'), 'utf8')), 'the new file');
    assert.equal(fs.readFileSync(path.join(logs, 'api.log'), 'utf8'), 'info: started\nfail: Boom\ninfo: again\n');
    assert.equal(fs.readFileSync(path.join(logs, 'primary.log'), 'utf8'), 'Unhandled exception\n');
    assert.match((await appX('logs')).out, /Live logs: .*\.run-logs\/api\.log/);
    const copier = serving.pids[1];
    assert.match((await app(null, 'stop')).out, /stopped/);
    await waitFor(() => { try { process.kill(copier, 0); return false; } catch { return true; } }, 'the copier to end');
  } finally {
    await app(null, 'stop', '--force');
    await close(run);
  }
});

test('app for you: orch app start serves your own checkout; runs wait for you; a run that has the app is never pushed out', async () => {
  const fake = { ORCHESTRA_APP_PORTS: APP_PORTS, ORCHESTRA_APP_START: appEnv({}).ORCHESTRA_APP_START };
  const you = (...args) => proc([path.join(ROOT, 'bin/orch.mjs'), 'app', ...args], { extraEnv: fake });
  const run = await startRun();
  try {
    const s = await you('start', '--minutes', '0.5');
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /Starting the app from .*itp-base/);
    assert.match(s.out, /The app is up/);
    const serving = JSON.parse(fs.readFileSync(path.join(dataDir, 'app.json'), 'utf8'));
    assert.deepEqual([serving.runId, serving.title], ['you', 'you (your checkout)']);
    assert.match((await you()).out, /App: you have it \(your own checkout/);
    assert.match((await you()).out, /Serving: your checkout from .*itp-base/);
    // A run that wants the app waits for you.
    const t = await app(run, 'take', '--minutes', '0');
    assert.equal(t.code, 3);
    assert.match(t.out, /the user runs their own app/);
    // Your app: restart and stop work; stop lets go, and the run gets it.
    assert.equal((await you('restart', '--minutes', '0.5')).code, 0);
    assert.match((await you('stop')).out, /stopped/);
    assert.equal(await appUp(), false);
    assert.ok(!fs.existsSync(path.join(dataDir, 'app-you.json')), 'you let go');
    assert.match((await app(run, 'take', '--minutes', '0')).out, /You have the app/);
    // Now the run has it: your start is refused, and says which run and what it does.
    const refused = await you('start', '--minutes', '0.5');
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /run demo has the app \(working in its step "Say hello"\)\. Wait until it lets go, or take it from the run: orch app release demo/);
    assert.equal(await appUp(), false, 'nothing started');
  } finally {
    await you('stop', '--force');
    await close(run);
  }
});

test('app: stop knows the AppHost\'s app as its own, though Aspire\'s DCP holds the ports and names only its temp folder', async () => {
  const session = path.join(tmp, 'dcp-owner-session');
  fs.mkdirSync(session, { recursive: true });
  const ws = path.join(tmp, 'ws-dcp');
  fs.mkdirSync(ws, { recursive: true });
  // Like dcp.exe run-controllers: listens on the app's ports; its command line has the session folder, not the workspace.
  const dcp = spawn(process.execPath, [path.join(ROOT, 'test/fake-app.mjs'), 'run-controllers', '--kubeconfig', path.join(session, 'kubeconfig')], { env: { ...env, ORCHESTRA_APP_PORTS: APP_PORTS }, stdio: 'ignore' });
  try {
    await waitFor(appUp, 'the fake DCP to listen');
    fs.writeFileSync(path.join(dataDir, 'app.json'), JSON.stringify({ runId: 'you', title: 'you (your checkout)', workspace: ws, launcher: 'apphost', services: [], pids: [], startedAt: new Date().toISOString() }));
    const stop = await proc([path.join(ROOT, 'bin/app.mjs'), 'stop'], { extraEnv: { ORCHESTRA_APP_PORTS: APP_PORTS, ORCHESTRA_DCP_SESSION: session } });
    assert.equal(stop.code, 0, stop.err + stop.out);
    assert.match(stop.out, /stopped/);
    await waitFor(async () => !(await appUp()), 'the ports to close');
  } finally {
    dcp.kill();
  }
});

test('app: your hold ends by itself once your app is gone', async () => {
  const yours = path.join(dataDir, 'app-you.json');
  const served = path.join(dataDir, 'app.json');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(yours, JSON.stringify({ at: new Date(Date.now() - 3600000).toISOString() }));
    fs.writeFileSync(served, JSON.stringify({ runId: 'you', title: 'you (your checkout)', workspace: tmp, pids: [sleeper.pid], startedAt: new Date().toISOString() }));
    assert.equal((await orch('app')).body.holder?.id, 'you', 'your app runs: you hold it');
    sleeper.kill();
    await waitFor(() => sleeper.exitCode !== null || sleeper.signalCode !== null, 'the app to end');
    assert.equal((await orch('app')).body.holder, null, 'your app is gone: the hold ends');
    assert.ok(!fs.existsSync(yours));
  } finally {
    sleeper.kill();
    fs.rmSync(yours, { force: true });
    fs.rmSync(served, { force: true });
  }
});

test('app: stop leaves an editor that has the folder open alone (only the app\'s own processes)', async () => {
  const { hostsIn } = await import('../packs/itp/app/procs.mjs');
  const ws = path.join(tmp, 'ws-editor');
  fs.mkdirSync(ws, { recursive: true });
  // An "editor" that names the folder and an Orbitax solution, and a host started with dotnet run from it.
  const editor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', path.join(ws, 'Orbitax.Platform.Api.slnx')], { stdio: 'ignore' });
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', 'dotnet', 'run', '--project', path.join(ws, 'Orbitax.Scheduler.Api.csproj')], { stdio: 'ignore' });
  try {
    await new Promise((ok) => setTimeout(ok, 500));
    const pids = hostsIn(ws).map((p) => p.pid);
    assert.ok(pids.includes(host.pid), 'the host is the app');
    assert.ok(!pids.includes(editor.pid), 'the editor is not');
  } finally {
    editor.kill();
    host.kill();
  }
});

test('app: health asks 127.0.0.1 first (the api listens on IPv4 only)', async () => {
  const v4 = spawn(process.execPath, [path.join(ROOT, 'test/fake-app.mjs'), 'v4'], { env: { ...env, ORCHESTRA_APP_PORTS: APP_PORTS, FAKE_APP_HOST: '127.0.0.1' }, stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok; } catch { return false; } }, 'the IPv4 app');
    assert.match((await app(null, 'status')).out, /Answers: api yes · web yes/);
  } finally {
    v4.kill();
  }
});

test('setup: a fresh clone learns the solution folder and its pack, gets the starter templates and its skills, and says what is missing', async () => {
  const home = path.join(tmp, 'fresh-home');
  const data = path.join(tmp, 'fresh-data');
  const runsAt = path.join(tmp, 'fresh-runs');
  const fresh = (...args) => proc([path.join(ROOT, 'bin/orch.mjs'), ...args], { extraEnv: { ORCHESTRA_DATA_DIR: data, ORCHESTRA_HOME_SKILLS: home, ORCHESTRA_SOLUTION_ROOT: '', ORCHESTRA_USER_EMAIL: '', ORCHESTRA_PACK: 'itp' } });
  const plain = (...args) => proc([path.join(ROOT, 'bin/orch.mjs'), ...args], { extraEnv: { ORCHESTRA_DATA_DIR: path.join(tmp, 'plain-data'), ORCHESTRA_HOME_SKILLS: path.join(tmp, 'plain-home'), ORCHESTRA_SOLUTION_ROOT: '', ORCHESTRA_USER_EMAIL: '', ORCHESTRA_PACK: '' } });
  const none = await plain('status');
  assert.notEqual(none.code, 0);
  assert.match(none.err, /Orchestra is not set up on this PC yet\. Run: node .*bin\/orch\.mjs setup solution=/);
  assert.match((await plain('setup', 'solution=' + path.join(tmp, 'no-such-folder'))).err, /there is no folder/);
  // No folder at all: it still works, with your own skills and no pack.
  const bare = await plain('setup', 'worktrees=' + runsAt);
  assert.equal(bare.code, 0, bare.err + bare.out);
  assert.match(bare.out, /Solution folder: none[^]*Pack: none[^]*Run folders go in: .*fresh-runs[^]*orch: installed/);
  assert.doesNotMatch(bare.out, /app-test/, 'no ITP skills without the ITP pack');
  assert.equal((await plain('status')).code, 0);
  assert.match((await plain('app')).err, /this solution has no app/);
  // The menu skill before it was /orch, installed by an older setup: removed (no run tab is open).
  fs.mkdirSync(path.join(home, 'orchestra'), { recursive: true });
  fs.writeFileSync(path.join(home, 'orchestra', '.orchestra-installed.json'), '{}');
  const s = await fresh('setup', 'solution=' + testItp, 'email=dev@example.com', 'worktrees=' + runsAt);
  assert.equal(s.code, 0, s.err + s.out);
  assert.match(s.out, /orchestra: old name, removed/);
  assert.ok(!fs.existsSync(path.join(home, 'orchestra')));
  assert.match(s.out, /Solution folder: .*itp-base[^]*Pack: itp/);
  assert.match(fs.readFileSync(path.join(home, 'orch', 'SKILL.md'), 'utf8'), /# The ITP part \(the ITP pack\)/, 'the pack adds its part to /orch');
  assert.match(s.out, /dev@example\.com/);
  assert.ok(fs.existsSync(path.join(data, 'templates', 'feature-template.json')), 'starter templates copied');
  const skill = fs.readFileSync(path.join(home, 'orch', 'SKILL.md'), 'utf8');
  assert.ok(!skill.includes('{{'), 'placeholders filled');
  assert.ok(skill.includes(`node ${ROOT.replace(/\\/g, '/')}/bin/orch.mjs`), 'names this clone');
  assert.ok(fs.existsSync(path.join(home, 'app-test', 'SKILL.md')));
  // Now it works, and a second setup changes nothing of yours.
  assert.equal((await fresh('status')).code, 0);
  fs.writeFileSync(path.join(data, 'templates', 'feature-template.json'), '{"mine": true}');
  fs.appendFileSync(path.join(home, 'orch', 'SKILL.md'), '\nmy edit\n');
  const again = await fresh('setup');
  assert.match(again.out, /orch: updated \(your changed copy: SKILL\.md\.bak-\d{4}-\d\d-\d\d\)/);
  assert.match(again.out, /app-test: up to date/);
  assert.equal(fs.readFileSync(path.join(data, 'templates', 'feature-template.json'), 'utf8'), '{"mine": true}', 'your template is kept');
  // A second hand edit the same day gets its own backup, never over the first.
  fs.appendFileSync(path.join(home, 'orch', 'SKILL.md'), '\nmy edit 2\n');
  assert.match((await fresh('setup')).out, /your changed copy: SKILL\.md\.bak-\d{4}-\d\d-\d\d-2\)/);
  // A copy setup installed itself (a pull changed the repo's text) is just replaced: no backup.
  const notes = JSON.parse(fs.readFileSync(path.join(home, 'orch', '.orchestra-installed.json'), 'utf8'));
  fs.writeFileSync(path.join(home, 'orch', 'SKILL.md'), 'older text from setup\n');
  notes['SKILL.md'] = (await import('node:crypto')).createHash('sha256').update('older text from setup\n').digest('hex');
  fs.writeFileSync(path.join(home, 'orch', '.orchestra-installed.json'), JSON.stringify(notes));
  assert.match((await fresh('setup')).out, /orch: updated\n/);
});

test('setup: installs the pack agents beside the skills, keeps hand edits, removes old ones, never touches yours', async () => {
  const home = path.join(tmp, 'agents-home');
  const agents = `${home}-agents`;
  const data = path.join(tmp, 'agents-data');
  const env = { ORCHESTRA_DATA_DIR: data, ORCHESTRA_HOME_SKILLS: home, ORCHESTRA_SOLUTION_ROOT: '', ORCHESTRA_USER_EMAIL: '', ORCHESTRA_PACK: 'itp' };
  const run = (...args) => proc([path.join(ROOT, 'bin/orch.mjs'), ...args], { extraEnv: env });
  // An agent of yours, there before Orchestra.
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'mine.md'), 'my own agent\n');
  const s = await run('setup', 'solution=' + testItp, 'worktrees=' + path.join(tmp, 'agents-runs'));
  assert.equal(s.code, 0, s.err + s.out);
  assert.match(s.out, /Agents \(installed in ~\/\.claude\/agents\):[^]*itp-research-runtime: installed[^]*itp-research-security: installed/);
  assert.match(fs.readFileSync(path.join(home, 'itp-research', 'SKILL.md'), 'utf8'), /^name: itp-research$/m, 'the pack skill that runs them');
  const runtime = fs.readFileSync(path.join(agents, 'itp-research-runtime.md'), 'utf8');
  assert.ok(!runtime.includes('{{'), 'placeholders filled');
  assert.ok(runtime.includes(testItp.replace(/\\/g, '/')), 'names the solution folder');
  assert.match(runtime, /^name: itp-research-runtime$/m);
  for (const f of fs.readdirSync(path.join(ROOT, 'packs/itp/agents'))) {
    const head = fs.readFileSync(path.join(ROOT, 'packs/itp/agents', f), 'utf8').split('---')[1];
    assert.match(head, new RegExp(`^name: ${f.replace(/\.md$/, '')}$`, 'm'), `${f}: its name matches the file`);
    assert.match(head, /^description: .+$/m, `${f}: has a description`);
    assert.match(head, /^model: (opus|sonnet)$/m, `${f}: names its model`);
  }
  // Again: nothing changes; a hand edit is kept as a backup before it is replaced.
  assert.match((await run('setup')).out, /itp-research-runtime: up to date/);
  fs.appendFileSync(path.join(agents, 'itp-research-business.md'), '\nmy edit\n');
  assert.match((await run('setup')).out, /itp-research-business: updated \(your changed copy: itp-research-business\.md\.bak-\d{4}-\d\d-\d\d\)/);
  assert.equal(fs.readFileSync(path.join(agents, 'itp-research-business.md'), 'utf8').includes('my edit'), false);
  // An agent setup installed that the pack no longer ships: removed.
  const notesFile = path.join(agents, '.orchestra-installed.json');
  const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
  fs.writeFileSync(path.join(agents, 'gone.md'), 'old agent\n');
  notes['gone.md'] = (await import('node:crypto')).createHash('sha256').update('old agent\n').digest('hex');
  fs.writeFileSync(notesFile, JSON.stringify(notes));
  assert.match((await run('setup')).out, /gone: not in this pack, removed/);
  assert.ok(!fs.existsSync(path.join(agents, 'gone.md')));
  assert.equal(fs.readFileSync(path.join(agents, 'mine.md'), 'utf8'), 'my own agent\n', 'yours is never touched');
  // Uninstall: Orchestra's agents go, yours stays.
  const off = await run('setup', 'uninstall=yes');
  assert.match(off.out, /agent itp-research-runtime/);
  assert.ok(!fs.existsSync(path.join(agents, 'itp-research-runtime.md')));
  assert.ok(!fs.existsSync(notesFile));
  assert.ok(fs.existsSync(path.join(agents, 'mine.md')));
  // No pack: no ITP agents.
  const plainHome = path.join(tmp, 'agents-plain-home');
  const plain = await proc([path.join(ROOT, 'bin/orch.mjs'), 'setup', 'worktrees=' + path.join(tmp, 'agents-runs')], { extraEnv: { ...env, ORCHESTRA_DATA_DIR: path.join(tmp, 'agents-plain-data'), ORCHESTRA_HOME_SKILLS: plainHome, ORCHESTRA_PACK: '' } });
  assert.equal(plain.code, 0, plain.err + plain.out);
  assert.doesNotMatch(plain.out, /itp-research/);
  assert.ok(!fs.existsSync(`${plainHome}-agents`));
});

test('a "wait for me" step stops the run; next goes on; you are notified', async () => {
  const run = await startRun([{ id: 'hello', skill: 'orchestra-hello', wait: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {}, 'Claude stops at the gate');
  let now = await getRun(run.id);
  assert.equal(now.status, 'waiting');
  assert.equal(now.waitingAfter, 'hello');
  // The pane: "Type next, redo or skip" has its own color (not the pin's cyan) and an empty line before the pin.
  await orch('pin', run.id, 'step one');
  const pane = (await proc([path.join(ROOT, 'bin/orch.mjs'), 'watch', run.id, '--once', '--rows', '30', '--cols', '40'])).out.split('\n');
  const hintAt = pane.findIndex((l) => l.includes('Type next, redo or skip'));
  assert.ok(pane[hintAt].startsWith('\x1b[1;33m'), 'bold yellow');
  assert.deepEqual([pane[hintAt + 1], /Pinned/.test(pane[hintAt + 2])], ['', true]);
  await orch('unpin', run.id, 'all');
  assert.ok((await logs(run)).includes('notification (off): is waiting for you: type next in its terminal'));
  assert.equal((await api('POST', `/api/runs/${run.id}/resume`)).status, 409, 'the browser points you to the terminal');
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-recap/);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.steps[1].status], ['running', 'running']);
  // Notifications only when you are needed: a plain reply no, a question yes, an Allow prompt yes, idle no.
  const toasts = async () => (await logs(run)).filter((t) => t.startsWith('notification')).length;
  const before = await toasts();
  await hook(run, 'Stop', say('I looked at the files. Going on.'));
  assert.equal(await toasts(), before, 'a plain reply: no notification');
  await hook(run, 'UserPromptSubmit', { prompt: 'ok' });
  await hook(run, 'Stop', say('Which repo should I use?\n\n1. api\n2. webclient'));
  assert.equal(await toasts(), before + 1, 'a question: one');
  await hook(run, 'UserPromptSubmit', { prompt: 'api' });
  await hook(run, 'Notification', { message: 'Claude needs your permission to use Bash' });
  assert.equal(await toasts(), before + 2, 'an Allow prompt: one');
  await hook(run, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  await hook(run, 'Notification', { message: 'Claude is waiting for your input' });
  assert.equal(await toasts(), before + 2, 'idle: none');
  await close(run);
});

test('a step with "explain" ticked gets a code walk-through before the next step', async () => {
  const run = await startRun([{ id: 'hello', skill: 'orchestra-hello', explain: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  const r = await hook(run, 'Stop', done('hello'));
  assert.match(r.body.output.reason, /walk me through the code/);
  assert.match((await hook(run, 'Stop', say('a.cs:1 uses a guard clause.\nORCHESTRA:DONE'))).body.output.reason, /\/orchestra-recap/);
  assert.equal((await getRun(run.id)).steps[1].status, 'running');
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
  assert.match(now.steps[1].note, /Cut off: the tab closed[\s\S]*next to go on with it, or redo/);
  await runnerCall('onClosed', [run.id, run.hookToken]); // the launcher too: nothing more happens
  assert.equal((await api('POST', `/api/runs/${run.id}/resume`)).status, 200);
  now = await waitFor(async () => ((await getRun(run.id)).session?.open ? getRun(run.id) : null), 'the reopened session');
  assert.equal(now.status, 'needs-you');
  assert.match(now.note, /Reopened on the same conversation\. Answer the question on the left \(or type next, redo or skip\)/);
  const spec = (await launch(now, fakeLauncher())).body;
  assert.equal(spec.args[spec.args.indexOf('--resume') + 1], run.sessionId);
  assert.ok(!spec.args.includes('/orchestra-recap'), 'the step is not started again by itself');
  // Claude asks how to go on, with a click: go on, start it again, or hold.
  assert.match(spec.args.at(-1), /reopened this tab[\s\S]*"Go on where it stopped" \(Recommended\) · "Start Recap again" · "Put the run on hold"[\s\S]*ORCHESTRA:DO redo[\s\S]*ORCHESTRA:DO hold/);
  // The resumed conversation reports its running total (0.05 before, 0.06 now): counted once.
  await hook(now, 'status', { cost: { total_cost_usd: 0.06 } });
  assert.equal((await getRun(run.id)).cost, 0.06);
  assert.match(context(await hook(now, 'UserPromptSubmit', { prompt: 'redo' })), /\/orchestra-recap/);

  // A launcher that is gone (pid 999999 is not alive): the next command shows the run as stopped.
  await launch(now, 999999);
  now = await getRun(run.id);
  assert.deepEqual([now.status, now.session.open], ['stopped', false]);
});

// A run file written straight to disk, for states that are hard to reach by hooks.
function writeRun(id, fields) {
  fs.mkdirSync(path.join(runsDir, id), { recursive: true });
  fs.writeFileSync(path.join(runsDir, id, 'state.json'), JSON.stringify({
    id, templateId: 'demo-hello-recap', templateName: 'Demo', tracking: true, input: { text: id }, hookToken: 'tok', chat: [], cost: 0,
    cwd: path.join(runsDir, id, 'work'), repoPlan: [], workspace: null, createdAt: new Date().toISOString(),
    steps: [{ id: 'hello', skill: 'orchestra-hello', label: 'Say hello', status: 'pending' }],
    ...fields,
  }));
}

test('safety: a run stuck starting fails with a reason; stop works on it; an unfinished workspace is cleaned', async () => {
  // Its starter ended (pid 999999 is not alive) before the tab opened.
  const id = 'run-20200101000000-stuck0';
  writeRun(id, { status: 'running', session: null, starting: { pid: 999999, at: Date.now() } });
  let now = await getRun(id);
  assert.equal(now.status, 'failed');
  assert.match(now.error, /never finished starting[\s\S]*Reopen it/);
  assert.equal(now.starting, undefined);
  // Old runs with no start mark and no tab are stuck too; stop takes them out.
  const old = 'run-20200101000000-stuck1';
  writeRun(old, { status: 'running', session: { open: false } });
  assert.equal((await getRun(old)).status, 'failed');
  // A start that is still going on (this test's own pid is alive) is left alone; stop still stops it.
  const live = 'run-20200101000000-stuck2';
  writeRun(live, { status: 'running', session: null, starting: { pid: process.pid, at: Date.now() - 25 * 60 * 1000 } });
  assert.equal((await getRun(live)).status, 'failed', 'started more than 20 minutes ago: stuck');
  writeRun(live, { status: 'running', session: null, starting: { pid: process.pid, at: Date.now() } });
  assert.equal((await getRun(live)).status, 'running');
  assert.equal((await api('POST', `/api/runs/${live}/stop`)).status, 200);
  assert.equal((await getRun(live)).status, 'running', 'its start is still going on: stop waits');
  writeRun(live, { status: 'running', session: { open: false }, starting: { pid: 999999, at: Date.now() } });
  assert.equal((await getRun(live)).status, 'failed');
  // A workspace whose build was cut off: clean-up removes its folder.
  const half = path.join(tmp, 'o-half');
  fs.mkdirSync(path.join(half, 'some-link-target'), { recursive: true });
  writeRun(id, { status: 'failed', session: null, workspace: { dir: half.replace(/\\/g, '/'), repos: [], ready: false } });
  assert.equal((await orch('clean', id)).status, 200);
  assert.ok(!fs.existsSync(half), 'the unfinished workspace is gone');
  for (const r of [id, old, live]) await orch('delete', r, '--force');
});

test('safety: a tab whose alive file stopped moving is gone, even when its pid lives on; broken run files are named', async () => {
  const id = 'run-20200101000000-alive0';
  // Its launcher pid is alive (this process: as if Windows reused it), but the alive file is 11 minutes old.
  writeRun(id, { status: 'needs-you', session: { open: true, pid: process.pid, openedAt: new Date(Date.now() - 3600000).toISOString() }, sessionId: 's1', sessionSeen: true });
  const beat = path.join(runsDir, id, 'tab-alive');
  fs.writeFileSync(beat, '1');
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(beat, old, old);
  let now = await getRun(id);
  assert.deepEqual([now.status, now.session.open], ['stopped', false]);
  // A fresh alive file keeps the tab open, whatever its pid says.
  writeRun(id, { status: 'needs-you', session: { open: true, pid: 999999, openedAt: new Date(Date.now() - 3600000).toISOString() }, sessionId: 's1', sessionSeen: true });
  fs.writeFileSync(beat, '1');
  now = await getRun(id);
  assert.equal(now.session.open, true);
  // Old for a minute, but its pid lives (a PC that just woke up): still open.
  writeRun(id, { status: 'needs-you', session: { open: true, pid: process.pid, openedAt: new Date(Date.now() - 3600000).toISOString() }, sessionId: 's1', sessionSeen: true });
  const min2 = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(beat, min2, min2);
  assert.equal((await getRun(id)).session.open, true);
  writeRun(id, { status: 'stopped', session: { open: false } });
  await orch('delete', id, '--force');
  // A run file that cannot be read is named on the board and in status, and is not lost.
  const bad = 'run-20200101000000-broke0';
  fs.mkdirSync(path.join(runsDir, bad), { recursive: true });
  fs.writeFileSync(path.join(runsDir, bad, 'state.json'), '{ not json');
  const board = await orchText('runs');
  assert.match(board.out, /Could not read this run file \(kept as they are\):\n {2}run-20200101000000-broke0: /);
  assert.match((await orchText('status')).out, /run-20200101000000-broke0/);
  assert.ok(fs.existsSync(path.join(runsDir, bad, 'state.json')));
  fs.rmSync(path.join(runsDir, bad), { recursive: true, force: true });
});

test('safety: claude from npm (claude.cmd) runs its script with node; a failed hook says so in the tab', async () => {
  const { claudeCommand, shimScript } = await import('../lib/claude-cmd.mjs');
  const { config } = await import('../lib/config.mjs');
  const { failedOutput: failedOutputFor } = await import('../lib/hook-handler.mjs');
  const bin = path.join(tmp, 'npm-bin');
  const cli = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  // What npm writes for a package's command (shortened).
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  assert.equal(shimScript(path.join(bin, 'claude.cmd')), cli);
  const was = config.claudeBin;
  try {
    config.claudeBin = path.join(bin, 'claude.cmd');
    assert.deepEqual(claudeCommand(['-p', 'hi']), { cmd: process.execPath, args: [cli, '-p', 'hi'] });
    config.claudeBin = path.join(bin, 'claude.exe');
    assert.deepEqual(claudeCommand(['x']), { cmd: path.join(bin, 'claude.exe'), args: ['x'] });
  } finally {
    config.claudeBin = was;
  }
  // When a hook fails, Orchestra's own words are blocked with the reason (they never reach Claude as talk).
  const err = new Error('Orchestra is busy');
  assert.match(failedOutputFor('UserPromptSubmit', { prompt: 'next' }, err).output.reason, /could not handle "next": Orchestra is busy\. Try again/);
  assert.equal(failedOutputFor('UserPromptSubmit', { prompt: '/orch back build' }, err).output.decision, 'block');
  assert.equal(failedOutputFor('UserPromptSubmit', { prompt: 'what is next?' }, err).output.decision, undefined, 'talk goes on to Claude');
  assert.match(failedOutputFor('Stop', {}, err).output.systemMessage, /could not move the run on/);
  assert.deepEqual(failedOutputFor('PostToolUse', {}, err), {});
});

test('safety: a lock whose holder stopped writing its time is taken over, even when the pid is alive', async () => {
  const lock = path.join(runsDir, '.lock');
  fs.mkdirSync(lock, { recursive: true });
  // This process is alive, but the time has not moved for 2 minutes: the holder is gone (its pid was reused).
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'gone', at: Date.now() - 120000 }));
  const t = Date.now();
  const r = await orchText('runs');
  assert.equal(r.code, 0, r.err);
  assert.ok(Date.now() - t < 10000, 'taken over at once');
  assert.ok(!fs.existsSync(path.join(lock, 'owner.json')) || JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).token !== 'gone');
});

test('hooks need the run token; Stop ends the session; delete waits for it', async () => {
  const run = await startRun();
  assert.deepEqual((await hook(run, 'Stop', done('x'), 'nope')).body, {}, 'a wrong token changes nothing');
  assert.deepEqual((await hook(run, 'Stop', done('x'), '')).body, {});
  assert.equal((await getRun(run.id)).steps[0].status, 'running');
  assert.ok((await logs(run)).some((t) => /hook Stop failed: wrong run token/.test(t)));
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 409, 'its tab is open');
  assert.equal((await close(run)).body.status, 'stopped');
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 200);
  assert.equal((await api('GET', `/api/runs/${run.id}`)).status, 404);
});

test('heavy steps: every run opens at once; only the limit of heavy steps work at once, first come first served', async () => {
  await api('PUT', '/api/settings', { maxRunning: 1 });
  try {
    for (const r of (await api('GET', '/api/runs')).body) if (r.status === 'running' && r.session?.open) await close(r);
    const a = await startRun([{ id: 'build', skill: 'orchestra-hello', heavy: true }]);
    assert.equal((await getRun(a.id)).steps[0].status, 'running', 'a heavy step works');
    // A second run opens at once and talks; only its heavy step waits for the slot.
    const b = await startRun([{ id: 'talk', skill: 'orchestra-recap' }, { id: 'build', skill: 'orchestra-hello', heavy: true }]);
    assert.equal((await getRun(b.id)).steps[0].status, 'running', 'a talking step never waits');
    const said = (await hook(b, 'Stop', done('talked'))).body.output;
    assert.match(said.systemMessage, /Waiting for a free slot: demo is doing heavy steps \(1 at a time\)\. "orchestra-hello" starts by itself/);
    let now = await getRun(b.id);
    assert.deepEqual([now.status, now.steps[1].status, now.slotNext.step], ['waiting', 'pending', 'build']);
    assert.match((await orchText('runs')).out, /waits for a slot/);
    // The slot frees up: b's heavy step starts by itself (its idle claude restarts on the same conversation).
    await hook(a, 'Stop', done('built'));
    now = await waitFor(async () => { const r = await getRun(b.id); return r.steps[1].status === 'running' ? r : null; }, 'b to start its heavy step');
    assert.ok(now.restart && now.slotNext === undefined);
    await close(await getRun(a.id));
    await close(now);
  } finally {
    await api('PUT', '/api/settings', { maxRunning: 20 });
  }
});

test('words: questions say the cause first; the step note says what is not done; PR links of other runs are left out; the pick shows usual costs', async () => {
  const { RUN_RULES } = await import('../lib/guard.mjs');
  assert.match(RUN_RULES, /Before each question, say the cause in 2 or 3 plain lines[\s\S]*never guessed/);
  assert.match(RUN_RULES, /Not done: \(what this step left open/);
  const { keepShipInfo, prBranch } = await import('../lib/run/ship.mjs');
  assert.equal(prBranch('https://bitbucket.org/o/api/pull-requests/new?source=feature%2FITP-1-a&t=1'), 'feature/ITP-1-a');
  assert.equal(prBranch('https://github.com/o/r/compare/main...feat/x'), 'feat/x');
  const run = { workspace: { repos: [{ token: 'api', branch: 'feature/ITP-1-a' }] } };
  keepShipInfo(run, 'Mine: https://bitbucket.org/o/api/pull-requests/new?source=feature/ITP-1-a&t=1 and the other run: https://bitbucket.org/o/api/pull-requests/new?source=feature/ITP-2-b&t=1');
  assert.deepEqual(run.ship.prUrls, ['https://bitbucket.org/o/api/pull-requests/new?source=feature/ITP-1-a&t=1']);
  const none = {};
  keepShipInfo(none, 'https://bitbucket.org/o/api/pull-requests/new?source=x&t=1');
  assert.equal(none.ship.prUrls.length, 1, 'a run with no branch yet keeps the link');
  const { runSteps } = await import('../lib/format.mjs');
  const g = { steps: [], cost: 0, guide: { id: 'g', name: 'G', steps: [{ id: 'plan', skill: 'plan-x', label: 'Plan', model: 'opus', effort: 'high' }] } };
  assert.match(runSteps(g, { usual: { 'plan-x': { done: 2, avgCost: 3, avgMs: 840000 } } }), /Likely next: plan \(\/plan-x, opus, effort high, usually \$3\.00 and 14 ?min of AI time\)/);
  const { pickRule } = await import('../lib/run/prompts.mjs');
  assert.match(pickRule(g), /"Put the run on hold"[\s\S]*ORCHESTRA:DO hold[\s\S]*usual cost and AI time/);
});

test('waiting fixes: a failed step asks with a click; redo with every slot taken waits its turn and starts by itself', async () => {
  await api('PUT', '/api/settings', { maxRunning: 1 });
  try {
    for (const r of (await api('GET', '/api/runs')).body) if (r.status === 'running' && r.session?.open) await close(r);
    const b = await startRun([{ id: 'build', skill: 'orchestra-hello', heavy: true }]);
    // A failed step gets one more turn: Claude asks what to do (a click), never "type redo".
    const failed = (await hook(b, 'Stop', say('The build broke.\nORCHESTRA:FAILED'))).body.output;
    assert.equal(failed.decision, 'block');
    assert.match(failed.reason, /failed[\s\S]*AskUserQuestion[\s\S]*"Run it again" \(Recommended[\s\S]*"Skip it"[\s\S]*ORCHESTRA:DO redo[\s\S]*ORCHESTRA:DO skip/);
    assert.equal((await getRun(b.id)).status, 'failed');
    // Another run takes the only heavy slot meanwhile.
    const a = await startRun([{ id: 'build', skill: 'orchestra-hello', heavy: true }]);
    assert.equal((await getRun(a.id)).steps[0].status, 'running');
    // The user clicked "Run it again": redo goes in line (no "type redo again"), its first try kept.
    const said = context(await hook(b, 'UserPromptSubmit', { prompt: 'redo' }));
    assert.match(said, /Waiting for a free slot[\s\S]*starts by itself[\s\S]*do not start the step yourself/);
    let now = await getRun(b.id);
    assert.deepEqual([now.status, now.steps[0].status, now.slotNext.step, now.steps[0].tries.length], ['waiting', 'pending', 'build', 1]);
    await hook(b, 'Stop', say('It waits for a free slot.'));
    assert.equal((await getRun(b.id)).steps[0].status, 'pending', 'not started while the slot is taken');
    // The slot frees up: b starts by itself, once.
    await hook(a, 'Stop', done('built'));
    now = await waitFor(async () => { const r = await getRun(b.id); return r.steps[0].status === 'running' ? r : null; }, 'b to start again');
    assert.ok(now.restart && !now.slotNext);
    assert.equal(now.steps[0].attempts, 2);
    await close(await getRun(a.id));
    await close(now);
  } finally {
    await api('PUT', '/api/settings', { maxRunning: 20 });
  }
});

test('hold: parks the run (a working step goes back, slot free); a picked hold ends the step first; next goes on', async () => {
  const run = await startRun();
  const r = await hook(run, 'UserPromptSubmit', { prompt: '/orch hold back tomorrow' });
  assert.match(r.body.output.reason, /put this run on hold \(back tomorrow\)[\s\S]*Type next to go on/);
  let now = await getRun(run.id);
  assert.deepEqual([now.status, now.hold.why, now.steps[0].status, now.steps[0].tries.length], ['waiting', 'back tomorrow', 'pending', 1]);
  assert.match(now.note, /On hold: back tomorrow\. Type next in its tab to go on with "Say hello"/);
  assert.match(context(await hook(now, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-hello/);
  now = await getRun(run.id);
  assert.ok(!now.hold && now.steps[0].status === 'running', 'next goes on; the hold ends');
  // The pick's "Put the run on hold": the step is done, then the run parks (the next step does not start).
  const out = (await hook(now, 'Stop', { last_assistant_message: 'Hello.\nORCHESTRA:DO hold lunch\n\nWHAT I DID AND WHY:\n- said hello\nNot done: nothing\nORCHESTRA:DONE' })).body.output;
  assert.match(out.systemMessage, /on hold \(lunch\)/);
  now = await getRun(run.id);
  assert.deepEqual([now.steps[0].status, now.steps[1].status, now.status, now.hold.why], ['done', 'pending', 'waiting', 'lunch']);
  // Reopened later: Claude asks to go on (a click), not a blank wait.
  await close(now);
  assert.equal((await api('POST', `/api/runs/${run.id}/resume`)).status, 200);
  now = await waitFor(async () => ((await getRun(run.id)).session?.open ? getRun(run.id) : null), 'the reopened session');
  const spec = (await launch(now, fakeLauncher())).body;
  assert.match(spec.args.at(-1), /"Go on with Recap" \(Recommended\) · "Keep it on hold"[\s\S]*ORCHESTRA:DO next/);
  await close(await getRun(run.id));
});

test('honest costs: a claude that counts from 0 again loses nothing; steps add up to the run; go back starts a step at $0; wait for you counts apart', async () => {
  const run = await startRun();
  await hook(run, 'status', { cost: { total_cost_usd: 1 } });
  await hook(run, 'Stop', done('hello'));
  // A resumed claude counts from 0 again: the run's cost never goes down.
  await hook(run, 'status', { cost: { total_cost_usd: 0.3 } });
  let now = await getRun(run.id);
  assert.equal(now.cost, 1.3);
  assert.ok((await logs(run)).some((t) => /counted from 0 again: \$1\.00 kept/.test(t)));
  // The step waits for the user: that time counts apart from the AI's time.
  await hook(run, 'Stop', say('Which one?'));
  await sleep(60);
  await hook(run, 'UserPromptSubmit', { prompt: 'the first' });
  await hook(run, 'Stop', done('recap'));
  now = await getRun(run.id);
  assert.deepEqual([now.steps[0].cost, now.steps[1].cost], [1, 0.3]);
  assert.equal(Math.round((now.steps[0].cost + now.steps[1].cost) * 100) / 100, now.sessionCost, 'the steps add up to the run');
  assert.ok(now.steps[1].youMs >= 50 && now.steps[1].youMs <= now.steps[1].durationMs);
  const stats = (await orch('stats')).body.skills.find((s) => s.skill === 'orchestra-recap');
  assert.ok(stats.avgYouMs > 0, 'stats show the wait for you apart'); // an average over every test run of the skill
  // Go back: the step starts again at $0; its first try keeps the cost (a skip later shows $0, not the old cost).
  await runnerCall('go', [run.id, 'hello again']);
  now = await getRun(run.id);
  assert.deepEqual([now.steps[0].cost, now.steps[0].tries[0].cost, now.steps[1].cost, now.steps[1].tries[0].cost], [0, 1, 0, 0.3]);
  assert.match((await orchText('run', run.id.slice(-6))).out, /try 1: done · \$1\.00/);
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
    assert.equal((await batch(Array.from({ length: 21 }, (_, i) => `ITP2-${i}`))).status, 400, 'too many');
    assert.equal((await batch(['ITP2-1'], { templateId: 'nope' })).status, 400, 'nope is not a template: a loose word');
    assert.equal((await api('GET', '/api/runs')).body.length, before);

    const { status, body: runs } = await batch(['ITP2-14852', ' ITP2-14853 ', 'Fix the CbC legend']);
    assert.equal(status, 200);
    assert.deepEqual(runs.map((r) => r.input.text), ['ITP2-14852', 'ITP2-14853', 'Fix the CbC legend']);
    const first = await waitFor(async () => ((await getRun(runs[0].id)).session?.open ? getRun(runs[0].id) : null), 'the first run to open its tab');
    await waitFor(async () => (await Promise.all(runs.map(async (r) => (await getRun(r.id)).session?.open))).every(Boolean), 'every tab to open at once');
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

test('app lock: a step that needs the app waits in line with its tab free, and starts by itself when the app is free', async () => {
  const a = await startRun([{ id: 'app', skill: 'orchestra-hello', app: true }]);
  const b = await startRun([{ id: 'hello', skill: 'orchestra-hello' }, { id: 'app', skill: 'orchestra-recap', app: true }]);
  // The Stop hook answers at once: no frozen tab.
  const answered = await hook(b, 'Stop', done('hello'));
  assert.match(answered.body.output.systemMessage, /Waiting for the app: run .* has it\. "orchestra-recap" starts by itself/);
  let now = await getRun(b.id);
  assert.deepEqual([now.status, now.steps[1].status, now.appNext.step], ['waiting', 'pending', 'app']);
  assert.match((await orchText('app')).out, /demo/, 'orch app lists it in line');
  // next while the app is busy: it says why, and keeps its place.
  assert.match(context(await hook(b, 'UserPromptSubmit', { prompt: 'next' })), /Waiting for the app/);
  // You talk to b while it waits: the app is let go, but b is not cut off mid-reply; it starts when its turn ends.
  await hook(b, 'UserPromptSubmit', { prompt: 'what did you find?' });
  await hook(a, 'Stop', done('app work'));
  assert.equal((await getRun(b.id)).steps[1].status, 'pending', 'not while you talk to it');
  assert.ok(!fs.existsSync(path.join(runsDir, b.id, 'restart.ok')));
  assert.match((await orchText('next', b.id)).err, /it is working now/, 'nor orch next from outside');
  // Its turn ends: b's step starts by itself, through a restart of its idle claude on the same conversation.
  await hook(b, 'Stop', say('I found the cause.'));
  now = await waitFor(async () => { const r = await getRun(b.id); return r.steps[1].status === 'running' ? r : null; }, 'b to start its app step');
  assert.ok(fs.existsSync(path.join(runsDir, b.id, 'restart.ok')), 'the launcher restarts its claude');
  assert.equal(now.appNext, undefined);
  const { body: spec } = await runnerCall('relaunchSpec', [b.id, b.hookToken, now.session.pid]);
  assert.match(spec.args.at(-1), /The app is free now\. .*\/orchestra-recap/);
  assert.equal(spec.args[spec.args.indexOf('--resume') + 1], b.sessionId, 'the same conversation');

  // A run whose first step needs the app stays in the queue while another run has it.
  const { body: c } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'c' }, start: false });
  await api('PUT', `/api/runs/${c.id}/steps`, { steps: [{ id: 'app', skill: 'orchestra-hello', app: true }] });
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
// The fake ITP folder, made once, and the env that points at it (so a workspace test can run alone).
let fakeItp = null;
function useFakeItp() {
  fakeItp ||= makeFakeItp();
  useEnv({ ORCHESTRA_SOLUTION_ROOT: fakeItp.root, ORCHESTRA_WORKTREES_DIR: fakeItp.worktrees });
  return fakeItp;
}
const gitIn = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@f', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@f' } });

test('workspace: worktrees start from the latest dev code with no branch; the branch the skill makes is followed', async () => {
  const itp = useFakeItp();
  await api('PUT', '/api/settings', { maxRunning: 20 });
  const { body: repos } = await api('GET', '/api/repos');
  assert.deepEqual(repos.map((r) => r.token), ['api'], 'the ITP workspace repo itself is never offered');
  assert.equal(repos[0].defaultBase, 'origin/development/mission');
  const tpl = { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], steps: [{ id: 'hello', skill: 'orchestra-hello' }] };
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

test('upgrade: a run and a template saved with the old words (boxes, waitAfter, orchestra-wrap-up) work, and save as version 2', async () => {
  // A template file from before: read as steps, the old skill name becomes the new one.
  fs.writeFileSync(path.join(dataDir, 'templates', 'old-shape.json'), JSON.stringify({ id: 'old-shape', name: 'Old shape',
    boxes: [{ id: 'hello', skill: 'orchestra-hello', label: 'Say hello', waitAfter: true, usesApp: false, walkthrough: false }, { id: 'wrap', skill: 'orchestra-wrap-up', label: 'Wrap up' }] }));
  const shown = (await orchText('template', 'show', 'old-shape')).out;
  assert.match(shown, /1\. Say hello \[hello\] \/orchestra-hello · wait after/);
  assert.match(shown, /2\. Wrap up \[wrap\] \/wrap-up/);
  const boxed = await orchText('template', 'box', 'old-shape', 'hello', 'wait=off');
  assert.equal(boxed.code, 0, `the old "template box" still works: ${boxed.err}`);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'templates', 'old-shape.json'), 'utf8'));
  assert.deepEqual([saved.version, !!saved.boxes, saved.steps.map((s) => s.skill), saved.steps[0].wait], [2, false, ['orchestra-hello', 'wrap-up'], false]);
  fs.rmSync(path.join(dataDir, 'templates', 'old-shape.json'));

  // A run file from before, mid-way: its tab goes on.
  const run = await startRun([{ id: 'hello', skill: 'orchestra-hello', wait: true }, { id: 'recap', skill: 'orchestra-recap' }]);
  await hook(run, 'Stop', done('hello'));
  const file = path.join(runsDir, run.id, 'state.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.version;
  old.boxes = old.steps.map(({ wait, app, explain, ...s }) => ({ ...s, waitAfter: wait, usesApp: app, walkthrough: explain }));
  delete old.steps;
  old.currentBox = old.currentStep;
  delete old.currentStep;
  old.chat = [{ id: 'msg-old', kind: 'you', text: 'said before', at: old.createdAt }];
  fs.writeFileSync(file, JSON.stringify(old));
  assert.match((await orchText('run', run.id)).out, /1\. orchestra-hello \(\/orchestra-hello\) · done[^\n]*wait after/);
  assert.match(context(await hook(run, 'UserPromptSubmit', { prompt: 'next' })), /\/orchestra-recap/, 'next goes on to the next step');
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([now.version, !!now.boxes, now.steps.length, now.currentStep], [2, false, 2, 'recap']);
  assert.deepEqual(now.chat.map((m) => m.text), ['said before'], 'old chat stays readable');
  assert.deepEqual(chatOf(now).map((m) => m.text), ['next'], 'new chat goes to chat.jsonl');
  await close(run);
});

test('parts: the Windows Terminal command line (a ; in the job, the pane size) and the hook\'s answer when Orchestra is busy', async () => {
  const { tabCommand, tabTitle } = await import('../lib/terminal.mjs');
  const run = { id: 'run-1', hookToken: 't', templateName: 'T', input: { text: 'Fix the legend; then "ship" it' } };
  assert.equal(tabTitle(run), 'Fix the legend then ship it', 'no ; (wt splits there) and no quotes in the title');
  const cmd = tabCommand(run, 'C:/o/1', { pane: true, paneSize: 99 });
  assert.deepEqual(cmd.filter((w) => w === ';').length, 2, 'only Orchestra\'s own separators');
  assert.equal(cmd[cmd.indexOf('--size') + 1], '0.7', 'the pane is 70% at most');
  assert.equal(tabCommand(run, 'C:/o/1', { pane: true, paneSize: 'x' })[cmd.indexOf('--size') + 1], '0.3');
  assert.ok(!tabCommand(run, 'C:/o/1').includes(';'), 'no pane: one command');
  assert.ok(!cmd.includes('--suppressApplicationTitle'), 'the tab name is Orchestra\'s to set (the mark)');
  // The tab's mark: needs you, in line (Orchestra's doing), done, or none while it works.
  const { tabMark, markedTitle } = await import('../lib/terminal.mjs');
  const r = (o) => ({ ...run, status: 'running', ...o });
  assert.equal(tabMark(r()), '', 'working: no mark');
  for (const status of ['needs-you', 'waiting', 'failed']) assert.equal(tabMark(r({ status })), '🔴', status);
  assert.equal(tabMark(r({ status: 'waiting', appNext: { step: 'x' } })), '⏳', 'its next step waits for the app');
  assert.equal(tabMark(r({ status: 'waiting', slotNext: { step: 'x' } })), '⏳', 'waits for a slot');
  assert.equal(tabMark(r({ status: 'needs-you', appWant: { step: 'x' } })), '⏳', 'the step waits in line for the app');
  assert.equal(tabMark(r({ status: 'needs-you', appWant: { step: 'x' }, appHeld: true })), '🔴', 'it has the app and asks you');
  assert.equal(markedTitle(r({ status: 'done' })), '✅ Fix the legend then ship it');
  // MCP servers per step: the heavy ones only in the skills that use them, all with mcp=on.
  const { mcpFor } = await import('../lib/run/prompts.mjs');
  assert.deepEqual(mcpFor({ skill: 'execute-epics' }), ['jira', 'bitbucket']);
  assert.deepEqual(mcpFor({ skill: 'app-test' }), ['jira', 'bitbucket', 'mongodb', 'mongodb-app', 'mongodb-global']);
  assert.deepEqual(mcpFor({ skill: 'bug-logs' }), ['opensearch', 'jira', 'bitbucket']);
  assert.equal(mcpFor({ skill: 'x', mcp: true }).length, 6, 'mcp=on: every server');
  // A step that needs a server the running claude did not start restarts it; one that needs fewer does not.
  const live = { session: { open: true }, model: 'opus', effort: 'high', mcpOn: ['jira', 'bitbucket'] };
  assert.equal((await runnerCall('wantsRestart', [live, { skill: 'app-test' }])).body, true, 'Test in the app gets Mongo');
  assert.equal((await runnerCall('wantsRestart', [live, { skill: 'execute-epics' }])).body, false);
  assert.equal((await runnerCall('wantsRestart', [{ ...live, mcpOn: mcpFor({ skill: 'app-test' }) }, { skill: 'review-changes' }])).body, false, 'fewer: no restart');
  assert.equal((await runnerCall('wantsRestart', [{ ...live, mcpOn: undefined }, { skill: 'app-test' }])).body, false, 'an older run started them all');
  // A hook that cannot get the lock never passes a tab word to Claude as talk.
  const { failedOutput } = await import('../lib/hook-handler.mjs');
  assert.match(failedOutput('UserPromptSubmit', { prompt: '/orch next' }, new Error('busy')).output.reason, /could not handle "\/orch next": busy/);
  assert.equal(failedOutput('UserPromptSubmit', { prompt: 'hello' }, new Error('busy')).output.decision, undefined, 'talk still reaches Claude');
  assert.deepEqual(failedOutput('PostToolUse', {}, new Error('busy')), {}, 'a lost activity line is quiet');
});

test('no pack: a one-repo project on master, a path with a space, a GitHub PR link, no app: setup, start, steps, wrap up', async () => {
  const solo = path.join(tmp, 'solo app');
  const origin = path.join(tmp, 'solo-origin.git');
  const g = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  fs.mkdirSync(solo, { recursive: true });
  g(['init', '-q', '--bare', '-b', 'master', origin], tmp);
  g(['init', '-q', '-b', 'master'], solo);
  fs.writeFileSync(path.join(solo, 'README.md'), '# solo\n');
  g(['add', '.'], solo);
  g(['commit', '-qm', 'start'], solo);
  g(['remote', 'add', 'origin', origin], solo);
  g(['push', '-q', '-u', 'origin', 'master'], solo);
  g(['remote', 'set-head', 'origin', 'master'], solo);
  const home = path.join(tmp, 'solo-home');
  fs.cpSync(path.join(ROOT, 'test/skills'), home, { recursive: true });
  useEnv({ ORCHESTRA_PACK: 'none', ORCHESTRA_SOLUTION_ROOT: '', ORCHESTRA_DATA_DIR: path.join(tmp, 'solo-data'), ORCHESTRA_HOME_SKILLS: home, ORCHESTRA_WORKTREES_DIR: path.join(tmp, 'solo-wt') });
  try {
    // Setup: the folder, no pack, the core starter.
    const s = await orchText('setup', `solution=${solo}`, `worktrees=${path.join(tmp, 'solo-wt')}`);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, /Pack: none[^]*orch-plan: installed[^]*wrap-up: installed/);
    assert.ok(fs.existsSync(path.join(tmp, 'solo-data', 'templates', 'plan-build-review.json')), 'the starter template');
    useEnv({ ORCHESTRA_PACK: 'none', ORCHESTRA_SOLUTION_ROOT: solo, ORCHESTRA_DATA_DIR: path.join(tmp, 'solo-data'), ORCHESTRA_HOME_SKILLS: home, ORCHESTRA_WORKTREES_DIR: path.join(tmp, 'solo-wt') });
    // The folder is the repo: one repo, from origin/master.
    const { body: repos } = await orch('repos');
    assert.deepEqual(repos.map((r) => [r.token, r.defaultBase]), [['solo-app', 'origin/master']]);
    assert.equal((await orchText('template', 'new', 'solo-flow', 'orchestra-hello', 'name=Solo', 'repos=solo-app')).code, 0);
    assert.equal((await orchText('steps', 'solo-flow', 'add', 'wrap-up', 'label=Wrap up')).code, 0);
    assert.match((await orchText('app')).err, /this solution has no app/);

    const run = await startRun(null, { templateId: 'solo-flow', input: 'Add a greeting' });
    const ws = run.workspace.dir;
    const wt = path.join(ws, 'solo app');
    assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'its worktree, in a folder with a space');
    assert.ok(!fs.existsSync(path.join(ws, 'README.md')), 'nothing of your checkout is linked in');
    // No ITP in the session: rules, MCP servers, env.
    const spec = (await launch(await getRun(run.id), fakeLauncher())).body;
    const rules = spec.args[spec.args.indexOf('--append-system-prompt') + 1];
    assert.doesNotMatch(rules, /ITPKV|Teamspace|ITP folder/);
    assert.match(rules, /main, master, or the remote's default branch/);
    const settings = JSON.parse(spec.args[spec.args.indexOf('--settings') + 1]);
    assert.deepEqual([settings.enabledMcpjsonServers, settings.disabledMcpjsonServers], [[], []]);
    assert.equal(spec.env.ORCHESTRA_PROTECT_DEFAULT, '1');
    assert.equal(spec.env.ITP_REGISTRY_OFF, undefined);
    // A push to master asks you, like any push: the guard and the git hooks.
    assert.equal(check('Bash', { command: 'git push origin master' }, { ...spec.env, ORCHESTRA_ALLOW_PUSH: '0' })?.needsApproval, true);
    g(['switch', '-q', '-c', 'orch/greeting'], wt);
    fs.writeFileSync(path.join(wt, 'hello.txt'), 'hi\n');
    g(['add', '.'], wt);
    g(['commit', '-qm', 'greeting'], wt);
    const push = spawnSync('git', ['push', 'origin', 'HEAD:master'], { cwd: wt, encoding: 'utf8', env: { ...process.env, ...spec.env, ORCHESTRA_ALLOW_PUSH: '0' } });
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /needs the user's Approve/);
    // A GitHub PR link is kept; the Wrap up step gets it, and no vault lines.
    const out = await hook(run, 'Stop', done('built. Open the PR: https://github.com/me/solo/pull/new/orch/greeting'));
    assert.deepEqual((await getRun(run.id)).ship.prUrls, ['https://github.com/me/solo/pull/new/orch/greeting']);
    assert.match(out.body.output.reason, /\/wrap-up[^]*Pull requests: https:\/\/github\.com\/me\/solo\/pull\/new\/orch\/greeting/);
    assert.doesNotMatch(out.body.output.reason, /ITPKV|vault/);
    await hook(run, 'Stop', done('wrapped up'));
    assert.equal((await getRun(run.id)).status, 'done');
    await close(run);
    assert.equal((await orchText('delete', run.id, 'force=yes')).code, 0);
  } finally {
    useEnv();
  }
});

test('clean up: only when you say; it stops what runs from the folder, frees the space and the conversation; the run, branches and stats stay', async () => {
  useFakeItp();
  await api('PUT', '/api/settings', { maxRunning: 20 });
  await api('PUT', '/api/templates/ws-demo', { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], steps: [{ id: 'hello', skill: 'orchestra-hello' }] });
  await api('PUT', '/api/templates/ws-wrap', { id: 'ws-wrap', name: 'Wrap demo', repos: ['api'], steps: [{ id: 'hello', skill: 'orchestra-hello', wait: true }, { id: 'wrap', skill: 'wrap-up', label: 'Wrap up' }] });
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
    assert.deepEqual(fin.ship, { prUrls: ['https://bitbucket.org/orbitax/itp-api/pull-requests/new?source=epics/lyra-ITP-E-08-ship'], notes: { 'Epic folder': '2026-10-27-ITP-E-08-ship' } }, 'the PR link and the epic folder for the Wrap up step');
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
    assert.ok(fs.existsSync(path.join(runsDir, 'archive', run.id, 'state.json')) && !fs.existsSync(path.join(runsDir, run.id)), 'its record moved to the archive');
    assert.match((await orchText('run', run.id)).out, /ship it/, 'orch run still shows it');

    // Wrap up, the last step: you type next when ready; pushes to main (vault, ITP folder) only while it works;
    // "not yet" waits for next; done means "clean when the tab closes", and closing it cleans up.
    const run2 = await startRun(null, { templateId: 'ws-wrap', input: 'merged one' });
    const flag = path.join(runsDir, run2.id, 'wrap-up.ok');
    const genv = { ORCHESTRA_RUN_DIR: path.join(runsDir, run2.id), ORCHESTRA_WRAPUP_DIRS: 'C:/Work/ITP' };
    gitIn(path.join(run2.workspace.dir, 'ITP-API'), ['switch', '-q', '-c', 'epics/lyra-ITP-E-09-merged']); // no new commit: merged already
    await hook(run2, 'Stop', done('Create PR: https://bitbucket.org/orbitax/itp-api/pull-requests/new?source=epics/lyra-ITP-E-09-merged\n`bash scripts/close-epic.sh 2026-10-28-ITP-E-09-merged`'));
    assert.equal((await getRun(run2.id)).status, 'waiting', 'it waits for you before Wrap up');
    assert.equal(fs.existsSync(flag), false);
    assert.equal(check('Bash', { command: 'cd ITPKV && git push origin main' }, genv)?.needsApproval, false, 'no vault push before Wrap up');
    const wrapAsk = context(await hook(run2, 'UserPromptSubmit', { prompt: 'next' }));
    assert.match(wrapAsk, /\/wrap-up/);
    assert.match(wrapAsk, /Epic folder: 2026-10-28-ITP-E-09-merged/);
    assert.match(wrapAsk, /Pull requests: https:\/\/bitbucket\.org\/orbitax\/itp-api/);
    assert.ok(fs.existsSync(flag), 'the flag is there while Wrap up works');
    assert.equal(check('Bash', { command: 'cd ITPKV && git push origin main' }, genv)?.needsApproval, true, 'the vault push asks you');
    assert.equal(check('Bash', { command: 'git -C ITP-API push origin main' }, genv)?.needsApproval, true, 'a code repo push to main asks you');
    const spec = (await launch(await getRun(run2.id), fakeLauncher())).body;
    assert.equal(spec.env.ORCHESTRA_WRAPUP_DIRS, path.join(tmp, 'itp').replace(/\\/g, '/'));
    assert.equal(spec.env.ORCHESTRA_WRAPUP_ONLY, '^Execution/');
    await hook(run2, 'Stop', { last_assistant_message: 'Type next when you are ready, and I run the wrap-up again.' });
    assert.equal((await getRun(run2.id)).status, 'needs-you', 'not yet');
    assert.match(context(await hook(run2, 'UserPromptSubmit', { prompt: 'next' })), /ready to wrap up now[\s\S]*\/wrap-up/, 'next runs Wrap up again');
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
    assert.equal((await orch('steps', run6.id, '--set', '[{"id":"other","skill":"orchestra-hello"},{"id":"wrap","skill":"wrap-up"}]')).status, 409, 'a finished step stays');
    assert.equal((await orch('steps', run6.id, '--set', '[{"id":"hello","skill":"orchestra-hello"},{"id":"wrap","skill":"wrap-up","label":"Wrap up"}]')).status, 200);
    assert.equal((await getRun(run6.id)).status, 'waiting');
    assert.match(context(await hook(run6, 'UserPromptSubmit', { prompt: 'next' })), /\/wrap-up/);
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
  await api('PUT', '/api/templates/ws-demo', { id: 'ws-demo', name: 'Workspace demo', repos: ['api'], steps: [{ id: 'hello', skill: 'orchestra-hello' }] });
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
  assert.equal(status, 200, 'a draft is made, so you can remove the step');
  assert.equal((await api('POST', `/api/runs/${draft.id}/resume`)).status, 409);
  const hello = [{ id: 'hello', skill: 'orchestra-hello' }];
  assert.equal((await api('PUT', `/api/runs/${draft.id}/steps`, { steps: hello })).status, 200);
  assert.equal((await api('PUT', `/api/runs/${draft.id}/steps`, { steps: [...hello, { id: 'recap', skill: 'orchestra-recap' }] })).status, 409, 'it cannot be added back');
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

test('tracking OFF: a step whose skill is marked while the run works fails before it starts', async () => {
  const run = await startRun();
  try {
    await api('PUT', '/api/skill-marks/orchestra-recap', { mark: 'writes' });
    assert.deepEqual((await hook(run, 'Stop', done('hello'))).body, {}, 'no next step is given');
    const now = await getRun(run.id);
    assert.equal(now.status, 'failed');
    assert.deepEqual(now.steps.map((b) => b.status), ['done', 'failed']);
    assert.match(now.steps[1].error, /writes to Teamspace or the vault/);
  } finally {
    await api('PUT', '/api/skill-marks/orchestra-recap', { mark: 'auto' });
    await close(run);
  }
});

// ---- stats and lessons ----

test('stats: spend, per-template and per-skill numbers, and the history', async () => {
  const runs = [
    { id: 'r1', templateId: 't', templateName: 'T', status: 'done', cost: 0.5, createdAt: new Date().toISOString(), input: { text: 'a' },
      steps: [{ skill: 'x', attempts: 2, failures: 1, status: 'done', cost: 0.3, durationMs: 1000, error: null }, { skill: 'y', attempts: 1, status: 'done', cost: 0.2, durationMs: 3000 }] },
    { id: 'r2', templateId: 't', templateName: 'T', status: 'failed', cost: 0.1, createdAt: '2020-01-01T00:00:00Z', input: { text: 'b' },
      steps: [{ skill: 'x', attempts: 1, status: 'failed', cost: 0.1, error: 'boom', endedAt: '2020-01-01T00:01:00Z' }, { skill: 'y', attempts: 0, status: 'pending', cost: 0 }] },
  ];
  const s = computeStats(runs);
  assert.deepEqual([s.totals.runs, s.totals.done, s.totals.failed, s.totals.cost, s.totals.costToday], [2, 1, 1, 0.6, 0.5]);
  assert.deepEqual(s.templates[0], { id: 't', name: 'T', runs: 2, done: 1, failed: 1, cost: 0.6, avgCost: 0.5, avgWorkMs: 4000 });
  const x = s.skills.find((k) => k.skill === 'x');
  assert.deepEqual([x.steps, x.tries, x.failures, x.done, x.avgMs, x.lastError, x.lastErrorRun], [2, 3, 2, 1, 1000, 'boom', 'r2']);
  assert.equal(s.skills[0].skill, 'x', 'most failures first');
  assert.equal(s.skills.find((k) => k.skill === 'y').steps, 1, 'a step that never ran is left out');
  assert.deepEqual(s.history.map((r) => r.id), ['r1', 'r2']);
  const { status, body } = await api('GET', '/api/stats');
  assert.equal(status, 200);
  assert.ok(body.totals.runs > 0 && body.history.length === body.totals.runs);
});

test('learn: what a run teaches is read from your words and its failures', () => {
  const run = { templateName: 'T', steps: [{ id: 'a', label: 'A', skill: 'x', status: 'done', attempts: 2, failures: 1, error: 'boom' }],
    chat: [{ kind: 'you', text: 'blue' }, { text: 'hurry up' }] };
  const m = material(run);
  assert.match(m, /chat: blue/);
  assert.match(m, /chat: hurry up/);
  assert.match(m, /failed 1 time\(s\)\. Last error: boom/);
  assert.equal(material({ steps: [{ id: 'a', label: 'A', skill: 'x', status: 'done', attempts: 1 }], chat: [] }), '');
  assert.deepEqual(parseSuggestions('```json\n{"rules":[{"text":" r ","why":"w"},{"nope":1}],"workflow":[{"text":"c"}]}\n```'),
    [{ kind: 'rule', text: 'r', why: 'w' }, { kind: 'workflow', text: 'c', why: '', change: null }]);
  // A workflow change keeps only an exact change Orchestra knows how to make.
  const [w] = parseSuggestions('{"workflow":[{"text":"c","change":{"op":"step","step":"plan","wait":true,"args":" show it ","bad":1}}]}');
  assert.deepEqual(w.change, { op: 'step', step: 'plan', wait: 'on', args: 'show it' });
  assert.equal(parseSuggestions('{"workflow":[{"text":"c","change":{"op":"step","step":"plan"}}]}')[0].change, null, 'a change that changes nothing');
  assert.equal(parseSuggestions('{"workflow":[{"text":"c","change":{"op":"drop","step":"../x"}}]}')[0].change, null);
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
  assert.deepEqual(flow.change, { op: 'step', step: 'hello', wait: 'on' });
  assert.match((await orchText('suggestions')).out, /change: steps demo-hello-recap set hello wait=on/);
  // Accepted without --apply: only marked, and listed as not in the template yet.
  assert.match((await orchText('suggestion', flow.id, 'accept')).out, /Not in the template yet[^]*steps demo-hello-recap set hello wait=on[^]*suggestion \S+ apply/);
  assert.equal((await api('GET', '/api/templates/demo-hello-recap')).body.steps[0].wait, false, 'accept alone changes nothing');
  assert.match((await orchText('suggestions')).out, new RegExp(`Accepted, not in the template yet[^]*${flow.id}`));
  assert.equal((await api('POST', `/api/suggestions/${flow.id}`, { action: 'maybe' })).status, 400);
  // Apply: to a template that is gone, a hint; to the named one (a copy, so other tests keep the demo as is), the change.
  const gone = await orchText('suggestion', flow.id, 'apply', '--template', 'nope');
  assert.notEqual(gone.code, 0);
  assert.match(gone.err + gone.out, /not there any more[^]*template=<id>/);
  assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'lesson-copy')).code, 0);
  assert.match((await orchText('suggestion', flow.id, 'apply', '--template', 'lesson-copy')).out, /accepted and applied[^]*Step hello changed/);
  assert.equal((await api('GET', '/api/templates/lesson-copy')).body.steps[0].wait, true);
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
  fs.writeFileSync(path.join(dataDir, 'templates/broken.json'), '{"steps": 1}');
  const { status, body } = await api('GET', '/api/templates');
  assert.equal(status, 200);
  assert.deepEqual(body.map((t) => t.id), ['demo-hello-recap']);
  fs.rmSync(path.join(dataDir, 'templates/broken.json'));
  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x'.repeat(9000) } })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', steps: [] })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', steps: [{ id: 'a', skill: 'bad skill!' }] })).status, 400);
  assert.equal((await api('PUT', '/api/templates/..%2Fx', { name: 'x', steps: [{ id: 'a', skill: 'orchestra-hello' }] })).status, 400);
  assert.equal((await api('GET', '/api/runs/..%2Fx')).status, 404);
  assert.equal((await api('POST', '/api/runs', { templateId: 'nope' })).status, 400, 'nope is not a template: read as a loose word');
  assert.equal((await api('PUT', '/api/settings', { learn: 'maybe' })).status, 400);
  const unknown = await orchText('fly');
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /unknown command: fly\. All commands: help/);
  assert.match((await orchText('templats')).err, /Did you mean templates\?/);
  assert.match((await orchText('runs', 'colour=red')).err, /runs has no option "colour"\. Its options: all/);
  assert.match((await orchText('settings', 'mx=3')).err, /settings has no option "mx"\. Did you mean max\?/);
  assert.match((await orchText('runs', '--fancy')).err, /runs has no option "fancy"/);
});

test('one grammar: steps of a run and a template with the same verbs; start safety; next from outside', async () => {
  // A template's steps, with no JSON.
  assert.equal((await orchText('template', 'copy', 'demo-hello-recap', 'grammar-demo')).code, 0);
  let out = await orchText('steps', 'grammar-demo', 'add', 'orchestra-recap', 'after=hello', 'label=Check it', 'wait=on', 'model=sonnet');
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /Added orchestra-recap as step 2[^]*2\. Check it \[check-it\] \/orchestra-recap · wait after, sonnet/);
  assert.match((await orchText('steps', 'grammar-demo', 'set', 'check-it', 'effort=hgih')).err, /Did you mean high\?/);
  assert.match((await orchText('steps', 'grammar-demo', 'add', 'orchestra-hello', 'at=abc')).err, /at must be a number from 1 to 4/);
  assert.match((await orchText('steps', 'grammar-demo', 'mvoe', 'x')).err, /steps has no "mvoe"\. Did you mean move\?/);
  assert.equal((await orchText('steps', 'grammar-demo', 'move', 'check-it', 'to=1')).code, 0);
  assert.equal((await orchText('steps', 'grammar-demo', 'remove', '2')).code, 0);
  assert.deepEqual((await orch('template', 'show', 'grammar-demo')).body.steps.map((s) => s.id), ['check-it', 'recap']);
  fs.rmSync(path.join(dataDir, 'templates', 'grammar-demo.json'));

  // Start: loose words are refused; a ticket with a run asks first; a draft starts with start <run>.
  // A quoted job that looks like key=value is the job, not an option.
  const { parse } = await import('../lib/cli/spec.mjs');
  assert.deepEqual(parse(['start', 'x', 'VAT=0 rows break']).pos, ['x', 'VAT=0 rows break']);
  assert.deepEqual(parse(['start', 'x', 'repos=api is broken']), { name: 'start', pos: ['x', 'repos=api is broken'], opt: {} });
  assert.deepEqual(parse(['start', 'x', 'ITP2-1', 'repos=api', 'draft=yes']).opt, { repos: 'api', draft: true });
  assert.match((await orchText('start', 'demo-hello-recap', 'fix', 'the', 'bug')).err, /"fix the bug" is not a ticket key\. Quote a job in words: start demo-hello-recap "fix the bug"/);
  const { body: d } = await orch('start', 'demo-hello-recap', 'ITP2-4242', 'draft=yes');
  assert.equal(d.status, 'draft');
  assert.match((await orchText('start', 'demo-hello-recap', 'ITP2-4242')).err, /ITP2-4242 has a run already \(draft\)[^]*again=yes/);
  // A run's steps, the same verbs (only this run changes).
  out = await orchText('steps', 'ITP2-4242', 'set', 'hello', 'wait=on');
  assert.match(out.out, /Step hello changed\. \(this run only; its template stays\)[^]*1\. Say hello \(\/orchestra-hello\) · pending · wait after/);
  assert.match((await orchText('start', 'ITP2-4242')).out, /ITP2-4242 started/);
  const run = await waitFor(async () => { const r = await getRun(d.id); return r.session?.open ? r : null; }, 'the draft to open its tab');
  await hook(run, 'SessionStart', { session_id: run.sessionId, source: 'startup' });
  assert.match((await orchText('run', 'ITP2-4242')).out, /working[^]*Steps:[^]*More \(what each step did, PR links, activity\): run ITP2-4242 full=yes/);
  assert.match((await orchText('next', 'ITP2-4242')).err, /it is working now/);
  // next from outside, at a gate: like typing it in the tab; its claude restarts to get it.
  await hook(run, 'Stop', done('hello'));
  let now = await getRun(run.id);
  assert.equal(now.status, 'waiting');
  out = await orchText('next', 'ITP2-4242');
  assert.equal(out.code, 0, out.err);
  now = await getRun(run.id);
  assert.ok(now.restart && fs.existsSync(path.join(runsDir, run.id, 'restart.ok')), 'its claude restarts');
  assert.match(now.launchPrompt, /The user typed next \(from outside this tab\)\. [^]*\/orchestra-recap/);
  await close(run);
  assert.equal((await orchText('delete', 'ITP2-4242')).code, 0);
});

test('orch: a template is built step by step, as Claude does it when you talk', async () => {
  const t = (...a) => orch('template', ...a);
  assert.equal((await t('new', 'talk-demo', 'orchestra-hello', '--name', 'Talk demo', '--tracking', 'off')).status, 200);
  assert.equal((await t('new', 'talk-demo', 'orchestra-hello')).status, 409, 'the id is taken');
  assert.equal((await t('add', 'talk-demo', 'no-such-skill')).status, 404);
  await t('add', 'talk-demo', 'orchestra-recap', '--wait', '--label', 'Recap it');
  await t('add', 'talk-demo', 'orchestra-hello', '--at', '1', '--args', 'twice');
  let { body: tpl } = await t('show', 'Talk demo');
  assert.deepEqual(tpl.steps.map((b) => [b.id, b.skill, !!b.wait]), [['orchestra-hello-2', 'orchestra-hello', false], ['orchestra-hello', 'orchestra-hello', false], ['recap-it', 'orchestra-recap', true]]);
  assert.equal(tpl.steps[0].args, 'twice');
  await t('move', 'talk-demo', 'recap-it', '1');
  await t('step', 'talk-demo', 'recap-it', 'wait=off', 'explain=on', 'label=Short recap');
  await t('remove', 'talk-demo', 'orchestra-hello-2');
  await t('set', 'talk-demo', 'name=Talk demo 2', 'tracking=on');
  ({ body: tpl } = await t('show', 'talk-demo'));
  assert.deepEqual(tpl.steps.map((b) => b.id), ['recap-it', 'orchestra-hello']);
  assert.deepEqual([tpl.steps[0].label, tpl.steps[0].wait, tpl.steps[0].explain, tpl.name, tpl.tracking], ['Short recap', false, true, 'Talk demo 2', true]);
  assert.equal((await t('copy', 'talk-demo', 'talk-copy')).body.name, 'Talk demo 2 (copy)');
  assert.equal((await t('step', 'talk-demo', 'recap-it', 'wait=maybe')).status, 400);
  const text = await orchText('template', 'show', 'talk-demo');
  assert.match(text.out, /1\. Short recap \[recap-it\] \/orchestra-recap · explain/);
  for (const id of ['talk-demo', 'talk-copy']) assert.equal((await t('delete', id)).status, 200);
  assert.equal((await t('show', 'talk-demo')).status, 404);
});

test('orch: runs are found by Jira key; status, board and run read plainly', async () => {
  const run = await startRun(null, { input: 'https://orbitax.atlassian.net/browse/ITP2-31337' });
  await hook(run, 'Stop', say('Which repo should I use?'));
  const status = await orchText('status');
  assert.match(status.out, /^Orchestra · \d+ working \(\d+ of 20 heavy slots\) · \d+ need you/);
  assert.match(status.out, /! ITP2-31337: needs you in its tab: Which repo should I use\?/);
  const board = await orchText('runs');
  assert.match(board.out.split('\n')[0], /^Run\s+About\s+Status\s+Step\s+Cost/);
  assert.match(board.out, /ITP2-31337\s+asks you\s+1\/2 Say hello/);
  const detail = await orchText('run', 'itp2-31337');
  assert.match(detail.out, /^ITP2-31337 · Demo/);
  assert.match(detail.out, /1\. Say hello \(\/orchestra-hello\) · running/);
  assert.equal((await orch('run', run.id.slice(-6))).body.id, run.id, 'the end of the id works too');
  await close(run);
  assert.ok(['queued', 'running', 'needs-you'].includes((await orch('reopen', 'ITP2-31337')).body.status), 'reopened (its tab may be opening already)');
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

test('clean-up: a helper claude started that lost its parent is still stopped; a busy folder is retried, then named', async () => {
  const { recordTree, killRecorded } = await import('../lib/app.mjs');
  const { removeFolder } = await import('../lib/workspace.mjs');
  const { stopRunProcesses } = await import('../lib/run/cleanup.mjs');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const ws = fs.mkdtempSync(path.join(tmp, 'orphan-ws-'));
  const procs = path.join(tmp, `procs-${Date.now()}.json`);
  // A parent (like an MCP start script) starts a helper in the run folder, then ends: the helper has no parent left,
  // and its command line does not name the folder (only its working folder is there).
  const parent = spawn(process.execPath, ['-e', "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',cwd:process.cwd()});c.unref();console.log(c.pid);setTimeout(()=>{},4000)"], { cwd: ws, stdio: ['ignore', 'pipe', 'ignore'] });
  const helper = Number(await new Promise((r) => parent.stdout.once('data', (d) => r(String(d).trim()))));
  await waitFor(async () => {
    await recordTree(procs, parent.pid);
    return fs.existsSync(procs) && JSON.parse(fs.readFileSync(procs, 'utf8')).some((p) => p.pid === helper);
  }, 'the launcher records claude\'s tree');
  parent.kill();
  await waitFor(() => !alive(parent.pid), 'the parent ends');
  assert.ok(alive(helper), 'the helper outlives its parent');
  // The folder is held: removing it waits, then says plainly what to do.
  process.env.ORCHESTRA_RM_WAIT_MS = '1500';
  try {
    await assert.rejects(removeFolder(ws), /still in use by another program .*run the same command again/);
    assert.ok(stopRunProcesses(ws, procs) >= 1, 'the recorded helper is stopped');
    await waitFor(() => !alive(helper), 'the helper ends');
    assert.equal(killRecorded(procs), 0, 'nothing of the record runs any more');
    await removeFolder(ws);
    assert.ok(!fs.existsSync(ws), 'the folder goes once nothing holds it');
  } finally {
    delete process.env.ORCHESTRA_RM_WAIT_MS;
    if (alive(helper)) process.kill(helper);
  }
});

test('tabs open one at a time: two openers at once never overlap (a pane cannot land in another run\'s tab)', async () => {
  const log = path.join(tmp, `tab-open-${Date.now()}.log`).replace(/\\/g, '/');
  // A stand-in for wt: writes when it starts and ends, and takes a while.
  const fake = (name) => Buffer.from(JSON.stringify([process.execPath, '-e', `const f=require('fs');f.appendFileSync(${JSON.stringify(log)},'start ${name}\\n');setTimeout(()=>f.appendFileSync(${JSON.stringify(log)},'end ${name}\\n'),400)`])).toString('base64');
  const opener = path.join(ROOT, 'bin/open-tab.mjs');
  const extraEnv = { ORCHESTRA_TAB_GAP_MS: '200' };
  await Promise.all([proc([opener, fake('a')], { extraEnv }), proc([opener, fake('b')], { extraEnv })]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^start/);
  assert.equal(lines[1].replace('end', 'start'), lines[0], `one finishes before the other starts: ${lines.join(' | ')}`);
  assert.ok(!fs.existsSync(path.join(runsDir, '.tab-lock')), 'the lock is let go');
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
  assert.deepEqual(chatOf(now).map((m) => m.text).sort(), ['one', 'two'], 'no save overwrote another');
  assert.equal(now.cost, 0.2);
  assert.ok(!fs.existsSync(path.join(runsDir, '.lock')), 'the lock is let go');
  await close(run);
});

// node test/smoke.mjs [words…]: only the tests whose name has one of the words (any case).
// ORCHESTRA_TEST_TIMEOUT: the time limit per test in seconds (default 180), so a hung test fails with its name.
const words = process.argv.slice(2).map((w) => w.toLowerCase());
const chosen = words.length ? tests.filter(([name]) => words.some((w) => name.toLowerCase().includes(w))) : tests;
if (!chosen.length) console.log(`No test name has: ${words.join(', ')}`);
const LIMIT_S = Number(process.env.ORCHESTRA_TEST_TIMEOUT || 180);
let failed = 0;
try {
  // Many runs stay open in these tests; give them room (also when one test runs alone).
  assert.equal((await api('PUT', '/api/settings', { maxRunning: 20 })).status, 200);
  for (const [name, fn] of chosen) {
    const started = Date.now();
    let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`took more than ${LIMIT_S} s`)), LIMIT_S * 1000); })]);
      console.log(`ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${err.stack}`);
    } finally {
      clearTimeout(timer);
    }
    // Picked tests run without the ones between them, which would have stopped the runs left open: stop them, so
    // they do not hold the run slots.
    if (words.length) for (const r of (await api('GET', '/api/runs')).body) if (r.session?.open || ['running', 'queued'].includes(r.status)) await close(r);
  }
} finally {
  for (const p of sleepers) p.kill();
  await new Promise((r) => setTimeout(r, 1500)); // background jobs (tick, lessons) end
  stopTestApps(path.basename(tmp));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
console.log(failed ? `\n${failed} failed` : `\nall ${chosen.length} passed`);
process.exit(failed ? 1 : 0);
