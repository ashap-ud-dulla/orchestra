// How to start claude on this PC, as { cmd, args }. Node starts only real programs (.exe) without a shell, so:
// - the native install (claude.exe) runs as it is;
// - an npm install has only claude.cmd, a small batch file that runs node on Claude Code's cli.js: Orchestra runs
//   node on that script itself (a batch file would need cmd.exe, which mangles long prompts with quotes and &);
// - a .js/.mjs path (the tests' fake claude) runs with this node.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

let found = null;

// The file `claude` means on this PC: claude.exe or claude.cmd from PATH, or the configured path as it is.
function locate(bin) {
  if (process.platform !== 'win32' || /[\\/]/.test(bin) || path.extname(bin)) return bin;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of ['.exe', '.cmd']) {
      const file = path.join(dir.replace(/^"|"$/g, ''), bin + ext);
      if (fs.existsSync(file)) return file;
    }
  }
  return bin; // not found: spawning it gives the usual "not found" error
}

// The script an npm .cmd shim runs: the last "…\something.js" path in it, relative to the shim's folder (%dp0%).
export function shimScript(cmdFile) {
  let text;
  try {
    text = fs.readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const all = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.m?js)"/gi)].map((m) => m[1]);
  const rel = all.at(-1);
  if (!rel) return null;
  const file = path.join(path.dirname(cmdFile), rel);
  return fs.existsSync(file) ? file : null;
}

function resolve() {
  if (found && found.bin === config.claudeBin) return found;
  const bin = config.claudeBin;
  let how;
  if (/\.m?js$/i.test(bin)) how = { cmd: process.execPath, pre: [bin] };
  else {
    const file = locate(bin);
    if (/\.(cmd|bat)$/i.test(file)) {
      const script = shimScript(file);
      if (!script) throw new Error(`found ${file}, but not the Claude Code script it runs. Reinstall Claude Code, or install the native version (claude.exe).`);
      how = { cmd: process.execPath, pre: [script] };
    } else how = { cmd: file, pre: [] };
  }
  found = { bin, ...how };
  return found;
}

// { cmd, args } to spawn claude with these arguments (no shell).
export function claudeCommand(args) {
  const { cmd, pre } = resolve();
  return { cmd, args: [...pre, ...args] };
}
