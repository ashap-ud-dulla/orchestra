// Orchestra's command line: node bin/orch.mjs <command> [args] [--json]
// The /orchestra skill calls this; you can too. Plain text by default, --json for programs.
// Every command takes the Orchestra lock for a moment and lets go (see lib/lock.mjs).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withRunner } from '../lib/runner.mjs';
import { setup } from '../lib/setup.mjs';
import { config } from '../lib/config.mjs';
import { HELP } from '../lib/cli/help.mjs';
import { parse, fail } from '../lib/cli/args.mjs';
import { watch } from '../lib/pane.mjs';
import { runCommands } from '../lib/cli/runs.mjs';
import { templateCommands } from '../lib/cli/templates.mjs';
import { lessonCommands } from '../lib/cli/lessons.mjs';
import { moreCommands } from '../lib/cli/more.mjs';

// Every command: one object per group (lib/cli/).
const commands = { ...runCommands, ...templateCommands, ...lessonCommands, ...moreCommands };

// ---------- main ----------

const { pos, opt } = parse(process.argv.slice(2));
const name = pos.shift() || 'status';
const json = opt.json === true;
const cmd = commands[name];
try {
  if (name === 'watch') {
    await watch(pos[0] || fail('name a run to watch'), !!opt.once, { rows: Number(opt.rows) || 0, cols: Number(opt.cols) || 0, pin: Number(opt.pin) || 1, scroll: Number(opt.scroll) || 0 });
    process.exit(0);
  }
  if (name === 'setup') {
    const out = await setup({ itp: typeof opt.itp === 'string' ? opt.itp : pos[0], email: typeof opt.email === 'string' ? opt.email : undefined });
    process.stdout.write((json ? JSON.stringify(out.json, null, 1) : out.text) + '\n');
    process.exit(0);
  }
  // The app for you, outside any run: bin/app.mjs does the work (it takes the run lock itself, so not inside one).
  if (name === 'app' && (['start', 'stop', 'restart', 'wait', 'logs'].includes(pos[0]) || (pos[0] === 'release' && !pos[1]))) {
    const env = { ...process.env };
    delete env.ORCHESTRA_RUN_ID; // even typed in a run's tab, orch app is you
    delete env.ORCHESTRA_HOOK_TOKEN;
    const raw = process.argv.slice(process.argv.indexOf('app') + 1);
    const r = spawnSync(process.execPath, [path.join(config.root, 'bin', 'app.mjs'), ...raw], { stdio: 'inherit', env });
    process.exit(r.status ?? 1);
  }
  if (!cmd) fail(`unknown command: ${name}\n\n${HELP}`);
  if (!config.itpRoot && name !== 'help') {
    fail(`Orchestra does not know your ITP folder yet. Run: node ${path.join(config.root, 'bin', 'orch.mjs').replace(/\\/g, '/')} setup --itp <your ITP folder>`);
  }
  const out = await withRunner((r) => cmd(r, { pos, opt }));
  process.stdout.write((json ? JSON.stringify(out.json, null, 1) : out.text) + '\n');
  process.exit(0);
} catch (err) {
  const msg = err.message || String(err);
  if (json) process.stdout.write(JSON.stringify({ error: msg, status: err.status || 500, uncommitted: err.uncommitted }) + '\n');
  else process.stderr.write(`Error: ${msg}\n`);
  process.exit(err.status === 404 ? 4 : err.status === 409 ? 3 : 1);
}
