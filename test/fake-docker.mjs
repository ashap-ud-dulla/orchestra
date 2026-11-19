// A stand-in for docker in tests (ORCHESTRA_DOCKER): keeps volumes and containers in FAKE_DOCKER_STATE (a JSON file)
// and writes every call to it, so tests can check what Orchestra asked for. Answers the few commands slots.mjs uses.
import fs from 'node:fs';

const file = process.env.FAKE_DOCKER_STATE;
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { volumes: {}, containers: {}, calls: [] };
const args = process.argv.slice(2);
s.calls.push(args.join(' '));
const save = () => fs.writeFileSync(file, JSON.stringify(s, null, 1));
const out = (t) => process.stdout.write(t + '\n');
const end = (code = 0) => {
  save();
  process.exit(code);
};
const vols = (list) => list.flatMap((a, i) => (list[i - 1] === '-v' ? [a.split(':')[0]] : []));

const [a, b, c] = args;
if (a === 'info') {
  out('29.0.0');
  end();
}
if (a === 'image' || a === 'pull' || a === 'exec') {
  if (a === 'exec') out('1');
  end();
}
if (a === 'volume' && b === 'inspect') end(s.volumes[c] ? (out(s.volumes[c].created || c), 0) : 1);
if (a === 'volume' && b === 'rm') end(s.volumes[c] && !Object.values(s.containers).some((x) => x.volume === c) ? (delete s.volumes[c], 0) : 1);
if (a === 'ps') {
  out(Object.values(s.containers).map((x) => `127.0.0.1:${x.port}->27017/tcp`).join('\n'));
  end();
}
if (a === 'run') {
  const name = args[args.indexOf('--name') + 1];
  const [from, to] = vols(args);
  if (args.includes('--rm')) {
    // A copy: golden -> slot volume.
    if (to && s.volumes[from]) s.volumes[to] = { created: new Date().toISOString(), from };
    end();
  }
  const port = Number(/:(\d+):27017/.exec(args.find((x) => /:27017$/.test(x)) || '')?.[1]);
  s.volumes[from] = s.volumes[from] || { created: new Date().toISOString() };
  s.containers[name] = { running: true, volume: from, port };
  out('abc123');
  end();
}
if (a === 'inspect') end(s.containers[b] ? (out(String(s.containers[b].running)), 0) : 1);
if (a === 'start' || a === 'stop') end(s.containers[b] ? ((s.containers[b].running = a === 'start'), 0) : 1);
if (a === 'rm') {
  const name = args[args.length - 1];
  delete s.containers[name];
  end();
}
if (a === 'port') end(s.containers[b] ? (out(`127.0.0.1:${s.containers[b].port}`), 0) : 1);
end();
