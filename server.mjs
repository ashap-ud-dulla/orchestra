// Orchestra server: API + live events (SSE) + the page. Node 22, no npm packages.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './lib/config.mjs';
import { scanSkills } from './lib/skills-scan.mjs';
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from './lib/store.mjs';
import { Runner } from './lib/runner.mjs';

const runner = new Runner();
const clients = new Set(); // open SSE connections

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ALLOWED_HOSTS = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5 * 1024 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { status: 400 });
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

runner.on('run', (run) => broadcast('run', run));
runner.on('log', (e) => broadcast('log', e));
runner.on('activity', (e) => broadcast('activity', e));
runner.on('deleted', (e) => broadcast('deleted', e));

// Only this machine's browser may call the API: blocks DNS-rebinding and cross-site requests.
function allowed(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD'].includes(req.method)) {
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, pid: process.pid })],
  ['GET', /^\/api\/skills$/, () => scanSkills()],
  ['GET', /^\/api\/templates$/, () => listTemplates()],
  ['GET', /^\/api\/templates\/([^/]+)$/, async (_req, [id]) => (await getTemplate(id)) ?? notFound('template')],
  ['PUT', /^\/api\/templates\/([^/]+)$/, async (req, [id]) => saveTemplate({ ...(await readBody(req)), id })],
  ['DELETE', /^\/api\/templates\/([^/]+)$/, async (_req, [id]) => (await deleteTemplate(id), { ok: true })],
  ['GET', /^\/api\/settings$/, () => runner.getSettings()],
  ['PUT', /^\/api\/settings$/, async (req) => {
    const s = await runner.setSettings(await readBody(req));
    broadcast('settings', s);
    return s;
  }],
  ['GET', /^\/api\/runs$/, () => runner.list()],
  ['POST', /^\/api\/runs$/, async (req) => {
    const body = await readBody(req);
    return runner.createRun({ templateId: body.templateId, input: body.input, start: body.start !== false });
  }],
  ['GET', /^\/api\/runs\/([^/]+)$/, (_req, [id]) => runner.get(id) ?? notFound('run')],
  ['DELETE', /^\/api\/runs\/([^/]+)$/, (_req, [id]) => runner.deleteRun(id)],
  ['GET', /^\/api\/runs\/([^/]+)\/timeline$/, (_req, [id]) => runner.timeline(id)],
  ['PUT', /^\/api\/runs\/([^/]+)\/boxes$/, async (req, [id]) => runner.updateBoxes(id, (await readBody(req)).boxes)],
  ['POST', /^\/api\/runs\/([^/]+)\/chat$/, async (req, [id]) => runner.chat(id, (await readBody(req)).text)],
  ['POST', /^\/api\/runs\/([^/]+)\/approve$/, async (req, [id]) => runner.approve(id, await readBody(req))],
  ['POST', /^\/api\/runs\/([^/]+)\/stop$/, (_req, [id]) => runner.stop(id)],
  ['POST', /^\/api\/runs\/([^/]+)\/resume$/, (_req, [id]) => runner.resume(id)],
];

// Windows cannot send SIGINT to a child process, so the tests call the clean-stop path here.
if (process.env.ORCHESTRA_TEST === '1') {
  routes.push(['POST', /^\/api\/test\/shutdown$/, () => (setImmediate(() => stop('test')), { ok: true })]);
}

function notFound(what) {
  throw Object.assign(new Error(`${what} not found`), { status: 404 });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return send(res, 400, { error: 'bad path' });
  }
  const file = path.resolve(config.pageDir, rel);
  if (!file.startsWith(config.pageDir + path.sep)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// No request may ever crash the server: any throw becomes an error reply.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status || 400, { error: err.message });
    else res.end();
  });
});

async function handle(req, res) {
  if (!allowed(req)) return send(res, 403, { error: 'forbidden' });
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ runs: runner.list(), settings: runner.getSettings() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname.startsWith('/api/')) {
    for (const [method, re, handler] of routes) {
      const m = re.exec(pathname);
      if (!m || req.method !== method) continue;
      try {
        return send(res, 200, await handler(req, m.slice(1)));
      } catch (err) {
        return send(res, err.status || 500, { error: err.message });
      }
    }
    return send(res, 404, { error: 'no such API route' });
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  send(res, 405, { error: 'method not allowed' });
}

// Keep SSE connections alive through proxies and sleeping tabs.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000).unref();

let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`Orchestra stopping (${reason}). Unfinished runs resume on next start.`);
  runner.shutdown();
  for (const res of clients) res.end();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(sig));
process.on('exit', () => runner.shutdown());

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error(`Port ${config.port} is busy. Orchestra may already be running (http://localhost:${config.port}), or another app uses it. Set ORCHESTRA_PORT to pick another port.`);
    process.exit(2);
  }
  throw err;
});

server.listen(config.port, config.host, async () => {
  await runner.init();
  console.log(`Orchestra is running: http://localhost:${config.port}`);
});
