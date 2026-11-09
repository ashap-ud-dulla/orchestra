// The app, one run at a time: node bin/app.mjs <command> [options]
// The pack knows what the app is and how it starts (pack.app.script, in the pack's folder); this passes the command
// on, so skills and orch app always call the same path. No pack app: it says so.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pack, packDir } from '../lib/pack.mjs';

if (!pack.app?.script) {
  process.stderr.write('Error: this solution has no app Orchestra can start (its pack adds one).\n');
  process.exit(1);
}
const r = spawnSync(process.execPath, [path.join(packDir, pack.app.script), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
