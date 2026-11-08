// Model and effort of a step: the words Orchestra knows, one parser and one text, for the CLI, the tab and templates.

// Ultracode is xhigh effort plus many helper agents (costly); it works only from the command line, so a step asks
// for it here.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
// A model a template or step may name: an alias or a full id, like claude-sonnet-5-5 or opus[1m].
export const MODEL_RE = /^[a-z][a-z0-9.\-[\]]{1,63}$/;
// A model word typed by you: a short name or a full model id.
const MODEL_WORD = /^(opus|sonnet|haiku|fable)(\[1m\])?$|^claude-[a-z0-9.\-[\]]+$/;
const SHORT = ['opus', 'sonnet', 'haiku', 'fable'];
const CLEAR = new Set(['none', 'off']);

// "opus effort high", "sonnet, max", "none" → { model, effort, unknown }. undefined = not named; null = clear it
// ("none": the model when no model came before it, else the effort).
export function parseModelWords(words) {
  let model;
  let effort;
  const unknown = [];
  // effort=high and model=opus read the same as the bare words.
  for (const w of words.map((x) => String(x).trim().toLowerCase().replace(/^(model|effort)=/, '')).filter((x) => x && x !== 'effort')) {
    if (EFFORTS.includes(w) && effort === undefined) effort = w;
    else if (CLEAR.has(w)) {
      if (model === undefined) model = null;
      else effort = null;
    } else if (MODEL_WORD.test(w) && model === undefined) model = w;
    else unknown.push(w);
  }
  return { model, effort, unknown };
}

// A word that is neither a model nor an effort, said plainly with the closest real one.
export function modelTypo(words) {
  const w = [words].flat()[0];
  const near = closestWord(String(w || '').toLowerCase(), [...SHORT, ...EFFORTS, 'none']);
  return `"${w}" is not a model or effort.${near ? ` Did you mean ${near}?` : ''} Use: ${MODEL_HELP} (none clears)`;
}
function closestWord(w, list) {
  let best = null;
  let bestD = 3;
  for (const c of list) {
    const d = lev(w, c);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}
function lev(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length];
}

// model=… effort=… options (templates, steps): none, off or empty clears. A typo is refused with the closest word.
export function applyModelOptions(x, o) {
  for (const k of ['model', 'effort']) {
    if (o[k] === undefined) continue;
    const v = String(o[k]).trim().toLowerCase();
    if (CLEAR.has(v) || !v) delete x[k];
    else if (k === 'model' ? MODEL_WORD.test(v) : EFFORTS.includes(v)) x[k] = v;
    else throw Object.assign(new Error(modelTypo(v)), { status: 400 });
  }
}

// "opus, effort high". long: says what ultracode costs.
export const modelText = (b, { long = false } = {}) =>
  [b.model, b.effort && (b.effort === 'ultracode' ? (long ? 'ultracode (many helpers, costly)' : 'ultracode') : `effort ${b.effort}`)].filter(Boolean).join(', ');

export const MODEL_HELP = 'opus|sonnet|haiku|fable [effort=low|medium|high|xhigh|max|ultracode]';
