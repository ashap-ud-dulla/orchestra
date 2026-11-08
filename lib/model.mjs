// Model and effort of a step: the words Orchestra knows, one parser and one text, for the CLI, the tab and templates.

// Ultracode is xhigh effort plus many helper agents (costly); it works only from the command line, so a step asks
// for it here.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
// A model a template or step may name: an alias or a full id, like claude-sonnet-5-5 or opus[1m].
export const MODEL_RE = /^[a-z][a-z0-9.\-[\]]{1,63}$/;
// A model word typed by you: a short name or a full model id.
const MODEL_WORD = /^(opus|sonnet|haiku|fable|claude-[a-z0-9.\-[\]]+)$/;
const CLEAR = new Set(['none', 'off']);

// "opus effort high", "sonnet, max", "none" → { model, effort, unknown }. undefined = not named; null = clear it
// ("none": the model when no model came before it, else the effort).
export function parseModelWords(words) {
  let model;
  let effort;
  const unknown = [];
  for (const w of words.map((x) => String(x).trim().toLowerCase()).filter((x) => x && x !== 'effort')) {
    if (EFFORTS.includes(w) && effort === undefined) effort = w;
    else if (CLEAR.has(w)) {
      if (model === undefined) model = null;
      else effort = null;
    } else if (MODEL_WORD.test(w) && model === undefined) model = w;
    else unknown.push(w);
  }
  return { model, effort, unknown };
}

// model=… effort=… options (templates): none, off or empty clears.
export function applyModelOptions(x, o) {
  for (const k of ['model', 'effort']) {
    if (o[k] === undefined) continue;
    const v = String(o[k]).trim().toLowerCase();
    if (CLEAR.has(v) || !v) delete x[k];
    else x[k] = v;
  }
}

// "opus, effort high". long: says what ultracode costs.
export const modelText = (b, { long = false } = {}) =>
  [b.model, b.effort && (b.effort === 'ultracode' ? (long ? 'ultracode (many helpers, costly)' : 'ultracode') : `effort ${b.effort}`)].filter(Boolean).join(', ');

export const MODEL_HELP = 'opus|sonnet|haiku|fable [effort low|medium|high|xhigh|max|ultracode]';
