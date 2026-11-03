// A stand-in for the interactive claude in a run's tab: notes its arguments, then waits until it is stopped.
import fs from 'node:fs';

fs.appendFileSync(process.env.FAKE_TAB_LOG, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n');
setInterval(() => {}, 1e9);
