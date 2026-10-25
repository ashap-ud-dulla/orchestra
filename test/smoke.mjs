// End-to-end tests with a fake claude. Run: node test/smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/skills-scan.mjs';
import { childEnv, killOrphan } from '../lib/runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7171;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-test-'));
const dataDir = path.join(tmp, 'data');
const runsDir = path.join(tmp, 'runs');
fs.mkdirSync(path.join(dataDir, 'templates'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'data/templates/demo-hello-recap.json'), path.join(dataDir, 'templates/demo-hello-recap.json'));

let server = null;
function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FLOW_PORT: String(PORT), FLOW_DATA_DIR: dataDir, FLOW_RUNS_DIR: runsDir, FLOW_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude.mjs'), FLOW_TEST: '1', ...extraEnv };
    server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    server.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Flow is running')) resolve();
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

test('orphan kill never hits Flow itself or a process that started at another time', () => {
  assert.equal(killOrphan(process.pid, new Date().toISOString()), false);
  if (process.platform === 'win32') assert.equal(killOrphan(process.ppid, undefined), false, 'no spawn time, no kill');
  // This node process is a "node" image, but it started long before this fake spawn time.
  const parent = process.ppid;
  assert.equal(killOrphan(parent, '2000-01-01T00:00:00Z'), false);
});

test('skills list includes Flow test skills and team skills', async () => {
  const { body } = await api('GET', '/api/skills');
  const names = body.map((s) => s.name);
  assert.ok(names.includes('flow-hello') && names.includes('flow-recap'));
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
  assert.equal(c[0].prompt, '/flow-hello Bappy');
  assert.equal(c[0].resumed, false);
  assert.equal(c[1].prompt, '/flow-recap');
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
  await startServer({ FAKE_CLAUDE_FAIL_SKILL: 'flow-recap' });
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
  await startServer({ FLOW_CLAUDE_BIN: path.join(ROOT, 'test/fake-claude-crash.mjs') });
  const { body: run } = await api('POST', '/api/runs', { templateId: 'demo-hello-recap', input: { text: 'z' } });
  const failed = await waitStatus(run.id, 'failed');
  assert.match(failed.boxes[0].error, /without a result: .*No conversation found/);
  await killServer();
  await startServer();
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
  const env = { ...process.env, FLOW_PORT: String(PORT), FLOW_DATA_DIR: dataDir, FLOW_RUNS_DIR: runsDir };
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
