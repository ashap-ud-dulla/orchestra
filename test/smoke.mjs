// End-to-end tests with a fake claude. Run: node test/smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/skills-scan.mjs';
import { childEnv, guardEnv, killOrphan } from '../lib/runner.mjs';
import { check, readMark } from '../lib/guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7171;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
const dataDir = path.join(tmp, 'data');
const runsDir = path.join(tmp, 'runs');
fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'test/fixtures/demo-hello-recap.json'), path.join(dataDir, 'templates/demo-hello-recap.json'));

let server = null;
function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ORCHESTRA_PORT: String(PORT), ORCHESTRA_DATA_DIR: dataDir, ORCHESTRA_RUNS_DIR: runsDir, ORCHESTRA_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), ORCHESTRA_TEST: '1', ...extraEnv };
    server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Orchestra is running')) resolve();
    });
    server.stderr.on('data', (d) => process.stderr.write(d));
    server.once('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
  });
}
async function killServer() {
  const s = server;
  server = null;
  if (!s || s.exitCode !== null) return;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill(); // hard kill: no shutdown handler runs, like a crash
  await gone;
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
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
const calls = (run) => fs.readFileSync(path.join(run.cwd, 'fake-calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

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
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_GIT_BASH_PATH: 'keep' });
  try {
    const env = childEnv();
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'keep', 'user settings stay');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('orphan kill never hits Orchestra itself or a process that started at another time', () => {
  assert.equal(killOrphan(process.pid, new Date().toISOString()), false);
  if (process.platform === 'win32') assert.equal(killOrphan(process.ppid, undefined), false, 'no spawn time, no kill');
  // This node process is a "node" image, but it started long before this fake spawn time.
  const parent = process.ppid;
  assert.equal(killOrphan(parent, '2000-01-01T00:00:00Z'), false);
});

test('guard: push and PR need Approve; main and --no-verify are always refused', () => {
  const v = (command, allow = false) => check('Bash', { command }, { ORCHESTRA_ALLOW_PUSH: allow ? '1' : '0' });
  for (const c of ['git push', 'git push -u origin feature/x', 'cd repo && git -C x push origin y', 'gh pr create --fill']) {
    assert.equal(v(c)?.needsApproval, true, c);
    assert.equal(v(c, true), null, `${c} with Approve`);
  }
  for (const c of ['git push origin main', 'git push origin HEAD:main', 'git push origin feature/x --no-verify', 'git checkout main', 'git switch main']) {
    assert.equal(v(c, true)?.needsApproval, false, `${c} refused even with Approve`);
  }
  for (const c of ['git status', 'git log origin/main', 'git merge-base HEAD origin/main', 'git checkout main -- file.txt', 'echo push', 'git commit -m "push later"']) {
    assert.equal(v(c), null, c);
  }
  assert.equal(check('PowerShell', { command: 'git push origin x' }, {})?.needsApproval, true);
  assert.equal(check('Read', { file_path: 'x' }, {}), null);
});

test('guard: reply markers are found on the last line and removed', () => {
  assert.deepEqual(readMark('Which one?\n\n**ORCHESTRA:QUESTION**\n'), { mark: 'ORCHESTRA:QUESTION', text: 'Which one?' });
  assert.equal(readMark('Want to push.\n`ORCHESTRA:APPROVAL`').mark, 'ORCHESTRA:APPROVAL');
  assert.equal(readMark('I wrote ORCHESTRA:QUESTION in a file.\nDone.').mark, null);
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
    const guard = (allow) => ({ ...guardEnv('run-test-git', allow), ORCHESTRA_RUN_DIR: t });
    fs.writeFileSync(path.join(t, 'work', 'b'), 'b');
    git(['add', 'b']);
    assert.equal(git(['commit', '-qm', 'b'], guard(false)).status, 0, 'commit on the work branch is fine');
    const blocked = git(['push', '-q', 'origin', 'feature/x'], guard(false));
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /needs the user's Approve/);
    assert.match(fs.readFileSync(path.join(t, 'approval-requests.jsonl'), 'utf8'), /refs\/heads\/feature\/x/);
    assert.equal(git(['push', '-q', 'origin', 'feature/x'], guard(true)).status, 0, 'Approve lets it through');
    assert.match(git(['push', '-q', 'origin', 'feature/x:main'], guard(true)).stderr, /main branch is refused/);
    git(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(t, 'work', 'c'), 'c');
    git(['add', 'c']);
    assert.match(git(['commit', '-qm', 'c'], guard(false)).stderr, /main branch is refused/);
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

test('skills list includes Orchestra test skills and team skills', async () => {
  const { body } = await api('GET', '/api/skills');
  const names = body.map((s) => s.name);
  assert.ok(names.includes('orchestra-hello') && names.includes('orchestra-recap'));
  if (fs.existsSync('C:\\Workstation\\Workspace\\ITP\\.claude\\skills\\review-changes')) {
    assert.equal(body.find((s) => s.name === 'review-changes')?.source, 'team');
  }
  assert.ok(!names.some((n) => n.startsWith('_')), 'folders starting with _ are skipped');
});

test('a 2-box run finishes, and box 2 resumes the same session', async () => {
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'Bappy' } });
  const done = await waitStatus(run.id, 'done');
  assert.deepEqual(done.boxes.map((b) => b.status), ['done', 'done']);
  assert.equal(done.cost, 0.02);
  assert.equal(done.boxes[0].tokens.input, 100);
  const c = calls(done);
  assert.equal(c.length, 2);
  assert.equal(c[0].prompt, '/orchestra-hello Bappy');
  assert.equal(c[0].resumed, false);
  assert.equal(c[1].prompt, '/orchestra-recap');
  assert.equal(c[1].resumed, true);
  assert.equal(c[1].sessionId, c[0].sessionId);
  assert.equal(done.sessionId, c[0].sessionId);
});

test('the template stays the same after a run', async () => {
  const { body } = await api('GET', '/api/templates/demo-hello-recap');
  assert.equal(body.boxes[0].status, undefined);
});

test('server killed mid-box: restart resumes the run and finishes it', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '4000' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'crash' } });
  await waitFor(async () => (await getRun(run.id)).sessionId, 'box 1 to start its session');
  await killServer();
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'state.json'), 'utf8'));
  assert.equal(saved.status, 'running');
  assert.ok(saved.sessionId, 'session id is saved before the box finishes');
  await startServer();
  const done = await waitStatus(run.id, 'done');
  assert.equal(done.boxes[0].attempts, 2);
  const c = calls(done);
  assert.equal(c.at(-2).resumed, true, 'the interrupted box resumes the saved session');
  assert.equal(c.at(-1).sessionId, saved.sessionId);
});

test('a failing box fails the run; resume after the fix finishes it', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_FAIL_SKILL: 'orchestra-recap' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x' } });
  const failed = await waitStatus(run.id, 'failed');
  assert.deepEqual(failed.boxes.map((b) => b.status), ['done', 'failed']);
  assert.match(failed.boxes[1].error, /problem/);
  await killServer();
  await startServer();
  assert.equal((await getRun(run.id)).status, 'failed', 'a failed run is not auto-resumed');
  await api('POST', `/api/runs/${run.id}/resume`);
  const done = await waitStatus(run.id, 'done');
  assert.equal(done.boxes[0].attempts, 1, 'finished boxes do not run again');
  assert.equal(done.boxes[1].attempts, 2);
});

test('stop pauses the working box; resume runs it again', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '1500' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'y' } });
  await waitFor(async () => (await getRun(run.id)).boxes[0].pid, 'box 1 to start');
  await api('POST', `/api/runs/${run.id}/stop`);
  const stopped = await waitFor(async () => {
    const r = await getRun(run.id);
    return r.status === 'stopped' && r.boxes[0].status === 'pending' ? r : null;
  }, 'box to go back to pending');
  assert.equal(stopped.boxes[0].pid, null);
  await api('POST', `/api/runs/${run.id}/resume`);
  const done = await waitStatus(run.id, 'done');
  assert.equal(done.boxes[0].attempts, 2);
});

test('Stop then an instant Resume continues the run (no false failure)', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '3000' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'race' } });
  await waitFor(async () => (await getRun(run.id)).boxes[0].pid, 'box 1 to start');
  await api('POST', `/api/runs/${run.id}/stop`);
  await api('POST', `/api/runs/${run.id}/resume`);
  const done = await waitStatus(run.id, 'done', 20000);
  assert.deepEqual(done.boxes.map((b) => b.status), ['done', 'done']);
  assert.equal(done.boxes[0].attempts, 2);
});

test('a clean shutdown clears the saved pid', async () => {
  // Ask the server to stop the way a closed window or Ctrl+C would.
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '5000' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'clean' } });
  await waitFor(async () => (await getRun(run.id)).boxes[0].pid, 'box 1 to start');
  const s = server;
  server = null;
  const gone = new Promise((r) => s.once('exit', r));
  if (process.platform === 'win32') {
    // Windows cannot send SIGINT to a child; the test-only endpoint calls the same stop path.
    await api('POST', '/api/test/shutdown').catch(() => {});
  } else {
    s.kill('SIGINT');
  }
  await gone;
  const saved = JSON.parse(fs.readFileSync(path.join(runsDir, run.id, 'state.json'), 'utf8'));
  assert.equal(saved.status, 'running', 'stays running so the next start resumes it');
  assert.equal(saved.boxes[0].pid, null);
  await startServer();
  await waitStatus(run.id, 'done');
});

test('a claude that dies without a result shows its error text', async () => {
  await killServer();
  await startServer({ ORCHESTRA_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude-crash.mjs') });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'z' } });
  const failed = await waitStatus(run.id, 'failed');
  assert.match(failed.boxes[0].error, /without a result: .*No conversation found/);
  await killServer();
  await startServer();
});

test('a chat message sent while a box works is answered before the next box', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '1500' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'chat' } });
  await waitFor(async () => (await getRun(run.id)).boxes[0].pid, 'box 1 to start');
  const sent = await api('POST', `/api/runs/${run.id}/chat`, { text: 'please be brief' });
  assert.equal(sent.body.chat[0].status, 'queued', 'waits while the box works');
  const done = await waitStatus(run.id, 'done', 20000);
  assert.deepEqual(calls(done).map((c) => c.prompt), ['/orchestra-hello chat', 'please be brief', '/orchestra-recap']);
  assert.ok(calls(done).slice(1).every((c) => c.resumed && c.sessionId === done.sessionId), 'chat uses the run session');
  assert.equal(done.chat[0].status, 'answered');
  assert.equal(done.chat[0].reply, 'Ran .');
  assert.equal(done.cost, 0.03, 'chat cost counts in the run');
  await killServer();
  await startServer();
});

test('a chat message to a finished run is answered right away', async () => {
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'later' } });
  await waitStatus(run.id, 'done');
  await api('POST', `/api/runs/${run.id}/chat`, { text: 'what did you do?' });
  const r = await waitFor(async () => ((await getRun(run.id)).chat[0]?.status === 'answered' ? getRun(run.id) : null), 'chat answer');
  assert.equal(r.status, 'done');
  assert.equal(calls(r).at(-1).prompt, 'what did you do?');
  assert.equal((await api('POST', `/api/runs/${run.id}/chat`, { text: '   ' })).status, 400);
});

test('a draft can be edited, then started; "wait after" pauses until Continue', async () => {
  const { body: draft } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'd' }, start: false });
  assert.equal(draft.status, 'draft');
  const boxes = [
    { id: 'hello', skill: 'orchestra-hello', label: 'Hi', waitAfter: true },
    { id: 'again', skill: 'orchestra-hello', label: 'Again', args: 'twice' },
  ];
  const edited = await api('PUT', `/api/runs/${draft.id}/boxes`, { boxes });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.boxes.map((b) => [b.id, b.label, b.status]), [['hello', 'Hi', 'pending'], ['again', 'Again', 'pending']]);
  await api('POST', `/api/runs/${draft.id}/resume`);
  const waiting = await waitStatus(draft.id, 'waiting');
  assert.equal(waiting.waitingAfter, 'hello');
  assert.deepEqual(waiting.boxes.map((b) => b.status), ['done', 'pending']);
  // A finished box must keep its place.
  const bad = await api('PUT', `/api/runs/${draft.id}/boxes`, { boxes: [boxes[1], boxes[0]] });
  assert.equal(bad.status, 409);
  await api('POST', `/api/runs/${draft.id}/resume`);
  const done = await waitStatus(draft.id, 'done');
  assert.deepEqual(calls(done).map((c) => c.prompt), ['/orchestra-hello d', '/orchestra-hello twice']);
  assert.equal((await api('PUT', `/api/runs/${draft.id}/boxes`, { boxes })).status, 400, 'a finished run is locked');
  const { body: tpl } = await api('GET', '/api/templates/demo-hello-recap');
  assert.equal(tpl.boxes[1].skill, 'orchestra-recap', 'the template did not change');
});

test('the timeline has log lines and live activity', async () => {
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 't' } });
  await waitStatus(run.id, 'done');
  const { body: tl } = await api('GET', `/api/runs/${run.id}/timeline`);
  assert.ok(tl.some((e) => e.kind === 'log' && /finished/.test(e.text)));
  assert.ok(tl.some((e) => e.kind === 'tool' && e.boxId === 'recap'));
  assert.ok(tl.every((e, i) => i === 0 || tl[i - 1].at <= e.at), 'oldest first');
});

test('a working run cannot be deleted; a finished one can', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '1500' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'del' } });
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 409);
  await waitStatus(run.id, 'done', 20000);
  assert.equal((await api('DELETE', `/api/runs/${run.id}`)).status, 200);
  assert.equal((await api('GET', `/api/runs/${run.id}`)).status, 404);
  assert.equal(fs.existsSync(path.join(runsDir, run.id)), false);
  await killServer();
  await startServer();
});

test('the queue: only the limit works at once, first in first out', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_SLEEP_MS: '800' });
  assert.equal((await api('PUT', '/api/settings', { maxRunning: 0 })).status, 400);
  assert.equal((await api('PUT', '/api/settings', { maxRunning: 1 })).body.maxRunning, 1);
  const ids = [];
  for (const t of ['q1', 'q2', 'q3']) ids.push((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: t } })).body.id);
  let most = 0;
  const started = [];
  await waitFor(async () => {
    const runs = await Promise.all(ids.map(getRun));
    most = Math.max(most, runs.filter((r) => r.status === 'running').length);
    for (const r of runs) if (r.status !== 'queued' && !started.includes(r.id)) started.push(r.id);
    return runs.every((r) => r.status === 'done');
  }, 'all three runs to finish', 30000);
  assert.equal(most, 1, 'never more than the limit');
  assert.deepEqual(started, ids, 'oldest first');
});

test('the queue: a waiting run frees its slot; a queued run can be taken out', async () => {
  const { body: gate } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'g' }, start: false });
  await api('PUT', `/api/runs/${gate.id}/boxes`, { boxes: [{ id: 'hello', skill: 'orchestra-hello', waitAfter: true }, { id: 'recap', skill: 'orchestra-recap' }] });
  await api('POST', `/api/runs/${gate.id}/resume`);
  await waitStatus(gate.id, 'waiting');
  const { body: a } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'a' } });
  const { body: b } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'b' } });
  assert.equal(a.status, 'running', 'the waiting run does not hold the slot');
  assert.equal(b.status, 'queued');
  await api('POST', `/api/runs/${b.id}/stop`);
  assert.equal((await getRun(b.id)).status, 'stopped');
  await waitStatus(a.id, 'done');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await getRun(b.id)).status, 'stopped', 'a run taken out of the queue stays out');
  // Raising the limit starts queued runs right away.
  await api('POST', `/api/runs/${b.id}/resume`);
  const { body: c } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'c' } });
  assert.equal(c.status, 'queued');
  await api('PUT', '/api/settings', { maxRunning: 2 });
  await waitFor(async () => (await getRun(c.id)).status !== 'queued', 'the queued run to start');
  await waitStatus(c.id, 'done');
  await killServer();
  await startServer();
});

test('a box that asks a question waits; your chat answer continues the same box', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_ASK_SKILL: 'orchestra-hello' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'ask' } });
  const asking = await waitStatus(run.id, 'question');
  assert.equal(asking.boxes[0].status, 'question');
  assert.equal(asking.boxes[0].question, 'Which color do you like? I suggest blue.', 'the marker line is removed');
  assert.equal(asking.boxes[1].status, 'pending');
  const moved = await api('PUT', `/api/runs/${run.id}/boxes`, { boxes: [asking.boxes[1], asking.boxes[0]] });
  assert.equal(moved.status, 409, 'a box that asks is locked in place');
  await api('POST', `/api/runs/${run.id}/chat`, { text: 'blue' });
  const done = await waitStatus(run.id, 'done');
  assert.deepEqual(calls(done).map((c) => c.prompt), ['/orchestra-hello ask', 'blue', '/orchestra-recap']);
  assert.ok(calls(done).every((c) => c.rules), 'every turn gets the run rules');
  assert.equal(done.boxes[0].attempts, 1, 'an answer is not a new try');
  assert.equal(done.boxes[0].turns, 2);
  assert.equal(done.chat[0].kind, 'answer');
  assert.equal((await api('POST', `/api/runs/${run.id}/approve`, { ok: true })).status, 409, 'nothing to approve');
});

test('a blocked push waits for Approve; Approve lets the box push', async () => {
  await killServer();
  await startServer({ FAKE_CLAUDE_PUSH_SKILL: 'orchestra-recap' });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'ship' } });
  const waiting = await waitStatus(run.id, 'approval');
  assert.equal(waiting.boxes[1].status, 'approval');
  assert.match(waiting.boxes[1].approval.requests[0].command, /git push -u origin feature\/x/);
  await api('POST', `/api/runs/${run.id}/approve`, { ok: true });
  const done = await waitStatus(run.id, 'done');
  const c = calls(done);
  assert.equal(c.at(-2).allowPush, '0', 'the first try had no permission');
  assert.match(c.at(-1).prompt, /^The user approved the push \(git push -u origin feature\/x\)/);
  assert.equal(c.at(-1).allowPush, '1');
  assert.equal(done.boxes[1].summary, 'Pushed feature/x.');
  assert.equal(done.boxes[1].approvals[0].ok, true);
});

test('Reject: the box goes on without pushing', async () => {
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'no' } });
  await waitStatus(run.id, 'approval');
  await api('POST', `/api/runs/${run.id}/approve`, { ok: false, note: 'not yet' });
  const done = await waitStatus(run.id, 'done');
  const last = calls(done).at(-1);
  assert.match(last.prompt, /^The user did not approve the push\. Do not push\. The user says: not yet/);
  assert.equal(last.allowPush, '0');
  assert.equal(done.boxes[1].summary, 'OK, I did not push.');
  await killServer();
  await startServer();
});

test('the page and its files are served', async () => {
  for (const p of ['/', '/app.js', '/app.css']) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, p);
  }
});

test('bad URLs and broken files do not crash the server', async () => {
  const raw = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(await raw('/%E0%A4%A'), 400);
  assert.equal(await raw('//'), 400);
  fs.writeFileSync(path.join(dataDir, 'templates/broken.json'), '{"boxes": 1}');
  const { status, body } = await api('GET', '/api/templates');
  assert.equal(status, 200);
  assert.deepEqual(body.map((t) => t.id), ['demo-hello-recap']);
  assert.equal((await api('GET', '/api/health')).status, 200, 'still alive');
});

test('bad input is refused', async () => {
  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'x'.repeat(9000) } })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', boxes: [] })).status, 400);
  assert.equal((await api('PUT', '/api/templates/ok-id', { name: 'x', boxes: [{ id: 'a', skill: 'bad skill!' }] })).status, 400);
  assert.equal((await api('GET', '/api/templates/..%2F..%2Fsecret')).status, 400);
  assert.equal((await api('GET', '/api/runs/..%2Fx')).status, 404);
  assert.equal((await api('POST', '/api/runs', { templateId: 'nope' })).status, 404);
  assert.equal((await api('POST', '/api/runs', { templateId: '../x' })).status, 400);
});

test('requests from other sites are blocked', async () => {
  // fetch() does not let us change Host, so use a raw request.
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/runs', headers: { host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await api('POST', '/api/runs', { templateId: 'demo-hello-recap' }, { origin: 'http://evil.example' })).status, 403);
});

test('a second server on the same port refuses to start', async () => {
  const env = { ...process.env, ORCHESTRA_PORT: String(PORT), ORCHESTRA_DATA_DIR: dataDir, ORCHESTRA_RUNS_DIR: runsDir };
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: 'ignore' });
  const code = await new Promise((r) => p.once('exit', r));
  assert.equal(code, 2);
});

let failed = 0;
try {
  await startServer();
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
  await killServer();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
