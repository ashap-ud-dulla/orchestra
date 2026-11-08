// Reading orch's command line: words, --options, key=value pairs, on/off.

// ---------- parsing ----------

export function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opt[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && VALUE_OPTS.has(k)) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

export const VALUE_OPTS = new Set(['itp', 'email', 'rows', 'cols', 'pin', 'scroll', 'title', 'text', 'repos', 'base', 'set', 'add', 'name', 'tracking', 'at', 'label', 'args', 'json-in', 'limit', 'change', 'template', 'model', 'effort']);

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

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
  if (v === 'off' || v === 'false' || v === 'no') return false;
  fail(`${what} must be on or off`);
}
