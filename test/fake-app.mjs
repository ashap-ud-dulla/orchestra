// A stand-in for the ITP app in tests: listens on the ports in ORCHESTRA_APP_PORTS (api=…,web=…),
// answers /health, and runs until it is killed. The workspace path is an argument, so it shows in its command line.
import http from 'node:http';

for (const pair of (process.env.ORCHESTRA_APP_PORTS || '').split(',').filter(Boolean)) {
  const port = Number(pair.split('=')[1]);
  http.createServer((req, res) => res.end(req.url === '/health' ? 'ok' : `fake app from ${process.argv[2] || '?'}`)).listen(port);
}
