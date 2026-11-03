// Test helper: node test/runner-call.mjs <method> '<json args>'
// Calls the runner the way the in-tab launcher does (launchSpec, onClosed), and prints the result as JSON.
import { withRunner } from '../lib/runner.mjs';

const [method, json] = process.argv.slice(2);
try {
  const out = await withRunner((r) => r[method](...JSON.parse(json || '[]')), { detach: true });
  process.stdout.write(JSON.stringify(out ?? {}));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message, status: err.status || 500 }));
  process.exit(1);
}
