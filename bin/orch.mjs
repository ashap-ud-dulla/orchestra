// Orchestra's command line: node bin/orch.mjs <command> [words] [key=value…] [--json]
// The /orch skill calls this; you can too. Plain text by default, --json for programs.
// Every command takes the Orchestra lock for a moment and lets go (see lib/lock.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withRunner } from '../lib/runner.mjs';
import { TICK_MARK } from '../lib/run/session.mjs';
import { setup } from '../lib/setup.mjs';
import { config } from '../lib/config.mjs';
import { parse, fail, helpText, commandNames, didYouMean } from '../lib/cli/spec.mjs';
import { watch } from '../lib/pane.mjs';
import { commands, QUICK } from '../lib/cli/commands.mjs';
import { pack } from '../lib/pack.mjs';

const NO_APP = 'this solution has no app Orchestra can start (a pack adds one; the ITP pack does).';

// The app for you, outside any run: bin/app.mjs does the work (it takes the run lock itself, so not inside one).
// key=value words become the --key value it reads (force=yes: --force).
function appPassthrough(argv) {
  if (!pack.app) fail(NO_APP);
  const raw = argv.slice(argv.indexOf('app') + 1).flatMap((a) => {
    const m = /^(services|with|without|minutes|lines|force)=(.*)$/i.exec(a);
    if (!m) return [a];
    const key = m[1].toLowerCase();
    if (key === 'force') return /^(yes|on|true)$/i.test(m[2]) ? ['--force'] : [];
    return [`--${key}`, m[2]];
  });
  const env = { ...process.env };
  delete env.ORCHESTRA_RUN_ID; // even typed in a run's tab, orch app is you
  delete env.ORCHESTRA_HOOK_TOKEN;
  const r = spawnSync(process.execPath, [path.join(config.root, 'bin', 'app.mjs'), ...raw], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
const json = argv.includes('--json') || argv.includes('json=yes');
try {
  const first = argv.find((a) => !a.startsWith('--'));
  const sub = argv[argv.indexOf(first) + 1];
  if (first === 'app' && (['start', 'stop', 'restart', 'wait', 'logs'].includes(sub) || (sub === 'release' && !argv[argv.indexOf(first) + 2]))) appPassthrough(argv);
  const { name, pos, opt } = parse(argv);
  if (name === 'watch') {
    await watch(pos[0] || fail('name a run to watch'), !!opt.once, { rows: Number(opt.rows) || 0, cols: Number(opt.cols) || 0, pin: Number(opt.pin) || 1, scroll: Number(opt.scroll) || 0 });
    process.exit(0);
  }
  if (name === 'setup') {
    const str = (v) => (typeof v === 'string' ? v : undefined);
    const out = await setup({ solution: str(opt.solution) ?? str(opt.itp) ?? pos[0], email: str(opt.email), worktrees: str(opt.worktrees), uninstall: !!opt.uninstall });
    process.stdout.write((json ? JSON.stringify(out.json, null, 1) : out.text) + '\n');
    process.exit(0);
  }
  const cmd = commands[name];
  if (!cmd) fail(`unknown command: ${name}.${didYouMean(name, commandNames())} All commands: help`);
  if (name === 'help') {
    process.stdout.write((json ? JSON.stringify({ help: helpText() }) : helpText()) + '\n');
    process.exit(0);
  }
  // Set up: a solution folder saved (older setups), or a pack chosen (setup always saves one).
  if (!config.itpRoot && !config.pack) {
    fail(`Orchestra is not set up on this PC yet. Run: node ${path.join(config.root, 'bin', 'orch.mjs').replace(/\\/g, '/')} setup solution=<your solution folder> (or setup alone, for no folder)`);
  }
  if (name === 'tick') fs.rmSync(path.join(config.runsDir, TICK_MARK), { force: true }); // see spawnTick
  // Commands that only show things never do slow work themselves (start runs, clean up): other processes do.
  const out = await withRunner((r) => cmd(r, { pos, opt }), { archived: true, detach: QUICK.has(name) });
  process.stdout.write((json ? JSON.stringify(out.json, null, 1) : out.text) + '\n');
  process.exit(0);
} catch (err) {
  const msg = err.message || String(err);
  if (json) process.stdout.write(JSON.stringify({ error: msg, status: err.status || 500, uncommitted: err.uncommitted }) + '\n');
  else process.stderr.write(`Error: ${msg}\n`);
  process.exit(err.status === 404 ? 4 : err.status === 409 ? 3 : 1);
}
