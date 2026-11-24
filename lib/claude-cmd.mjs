// How to start claude on this PC, as { cmd, args }. Node starts only real programs (.exe) without a shell, so:
// - the native install (claude.exe) runs as it is;
// - an npm install has only claude.cmd, a small batch file. Orchestra never runs the batch file (cmd.exe mangles long
//   prompts with quotes and &): it reads what the file starts and starts that itself. npm 2.x of Claude Code starts
//   its own bin\claude.exe (the native program, copied in by its install step); older ones run node on cli.js;
// - a .js/.mjs path (the tests' fake claude) runs with this node.
// A claude.exe anywhere on PATH (or in the native installer's folder) wins over a claude.cmd, so a PC with both
// installs runs the native one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

let found = null;

// What the native installer puts there (it also adds the folder to PATH, but a terminal opened before has the old PATH).
export const nativeDir = () => path.join(process.env.USERPROFILE || os.homedir(), '.local', 'bin');

// The file `claude` means on this PC, or the configured path as it is.
function locate(bin) {
  if (process.platform !== 'win32' || /[\\/]/.test(bin) || path.extname(bin)) return bin;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => d.replace(/^"|"$/g, ''));
  const first = (ext, list) => list.map((d) => path.join(d, bin + ext)).find((f) => fs.existsSync(f));
  return first('.exe', dirs) || first('.exe', [nativeDir()]) || first('.cmd', dirs) || bin; // not found: the usual error
}

// What an npm .cmd shim starts: the last "%dp0%\…" path in it that is a script or a program, relative to its folder.
export function shimTarget(cmdFile) {
  let text;
  try {
    text = fs.readFileSync(cmdFile, 'utf8');
  } catch {
    return null;
  }
  const all = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:m?js|cjs|exe))"/gi)].map((m) => m[1]).filter((f) => !/(^|\\)node\.exe$/i.test(f));
  const rel = all.at(-1);
  if (!rel) return null;
  const file = path.join(path.dirname(cmdFile), rel);
  return fs.existsSync(file) ? { file, exe: /\.exe$/i.test(file) } : null;
}

// The script an npm .cmd shim runs with node (older Claude Code), or null.
export function shimScript(cmdFile) {
  const t = shimTarget(cmdFile);
  return t && !t.exe ? t.file : null;
}

// npm 2.x ships bin\claude.exe as a few-hundred-byte stand-in that its install step replaces with the real program.
// When that step did not run (npm --ignore-scripts, a blocked download), the stand-in stays: say so, not "not found".
const STUB_BYTES = 64 * 1024;
const stub = (file) => {
  try {
    return fs.statSync(file).size < STUB_BYTES;
  } catch {
    return false;
  }
};

const REINSTALL = 'Install the native Claude Code (PowerShell: irm https://claude.ai/install.ps1 | iex), or reinstall it with npm (npm install -g @anthropic-ai/claude-code), then run orch setup again.';

function resolve() {
  if (found && found.bin === config.claudeBin) return found;
  const bin = config.claudeBin;
  let how;
  if (/\.m?js$/i.test(bin)) how = { cmd: process.execPath, pre: [bin], file: bin, kind: 'script' };
  else {
    const file = locate(bin);
    if (/\.(cmd|bat)$/i.test(file)) {
      const t = shimTarget(file);
      if (!t) throw new Error(`found ${file}, but not the program it starts. ${REINSTALL}`);
      if (t.exe && stub(t.file)) throw new Error(`Claude Code from npm (${file}) did not finish installing: its program ${t.file} is only the stand-in its install step replaces. ${REINSTALL}`);
      how = t.exe ? { cmd: t.file, pre: [], file: t.file, kind: 'npm' } : { cmd: process.execPath, pre: [t.file], file: t.file, kind: 'npm (node)' };
    } else {
      if (/\.exe$/i.test(file) && stub(file)) throw new Error(`${file} is only a stand-in, not Claude Code. ${REINSTALL}`);
      how = { cmd: file, pre: [], file, kind: /[\\/]/.test(file) ? (file.startsWith(nativeDir()) ? 'native' : 'program') : 'not found' };
    }
  }
  found = { bin, ...how };
  return found;
}

// { cmd, args } to spawn claude with these arguments (no shell).
export function claudeCommand(args) {
  const { cmd, pre } = resolve();
  return { cmd, args: [...pre, ...args] };
}

// Which claude runs will start, for orch setup: { file, kind } (kind: native, npm, npm (node), program, script, not
// found). Throws with the fix when the install is broken.
export function claudeFound() {
  const { file, kind } = resolve();
  return { file, kind };
}
