// Opens one run's tab: node bin/open-tab.mjs <base64 JSON of the wt command>
// Tabs open one at a time. A wt command is "new tab, then split the tab in focus"; two at once mix up (one run's
// steps pane lands in another run's tab). So each opener takes the tab lock (a folder: mkdir is atomic), runs wt,
// gives the window a moment to finish, then lets the next one in. Started detached: nothing waits for it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.mjs';
import { sleep } from '../lib/util.mjs';

const cmd = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8') || '[]');
const lock = path.join(config.runsDir, '.tab-lock');
const GAP_MS = Number(process.env.ORCHESTRA_TAB_GAP_MS ?? 1500);
const STALE_MS = 30000; // an opener that died holding the lock

async function take() {
  const end = Date.now() + 120000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      return;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > end) return; // open it anyway rather than never
      await sleep(200);
    }
  }
}

if (cmd.length) {
  fs.mkdirSync(config.runsDir, { recursive: true });
  await take();
  try {
    await new Promise((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', windowsHide: false });
      child.on('error', resolve);
      child.on('exit', resolve);
    });
    await sleep(GAP_MS);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
