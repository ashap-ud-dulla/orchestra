// Small helpers for orch commands. The command line itself is read by lib/cli/spec.mjs.

export { fail } from './spec.mjs';
import { fail } from './spec.mjs';

// key=value words: name="My flow" wait=on
export function pairs(words) {
  const out = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 1) fail(`expected key=value, got "${w}"`);
    out[w.slice(0, i).toLowerCase()] = w.slice(i + 1);
  }
  return out;
}

export function onOff(v, what) {
  if (v === true || v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 'off' || v === 'false' || v === 'no') return false;
  fail(`${what} must be on or off`);
}
