// A run's steps (steps): make one, find one, describe one.

// Steps that have started stay locked in place when you edit a run.
export const STARTED = new Set(['done', 'running', 'skipped']);
// Steps the run has passed: done, or skipped when you went to a later step (orch go).
export const PASSED = new Set(['done', 'skipped']);

export function newStep(b) {
  return {
    id: b.id,
    skill: b.skill,
    label: String(b.label || b.skill).slice(0, 80),
    args: String(b.args || '').slice(0, 2000),
    wait: !!b.wait,
    app: !!b.app,
    explain: !!b.explain,
    fresh: !!b.fresh, // start this step in a new conversation (a handoff tells it the story so far)
    // A heavy step (it builds, runs the app or big tests): only `max` of them work at once; the rest wait in line.
    heavy: !!b.heavy,
    // Every MCP server of the run in this step (the pack starts its heavy ones only in the skills that use them).
    mcp: !!b.mcp,
    // The model and effort this step runs with. None: it keeps what the step before used.
    model: b.model || null,
    effort: b.effort || null,
    status: 'pending',
    attempts: 0,
    cost: 0,
    summary: '',
    error: null,
  };
}

export const nextStep = (run) => run.steps.find((b) => !PASSED.has(b.status));

// A guided run picks its steps one at a time; its template is only a guide (run.guide = { id, name, steps }).
// The guide's step for a word: its id, else its skill.
export function guideStep(run, word) {
  const g = run.guide?.steps || [];
  return g.find((s) => s.id === word) || g.find((s) => s.skill === word) || null;
}

// The guide's steps still likely to come: the ones after the last guide step the run has, not picked yet.
export function likelyNext(run) {
  const g = run.guide?.steps || [];
  const picked = (s) => run.steps.some((b) => b.skill === s.skill);
  let last = -1;
  g.forEach((s, i) => { if (picked(s)) last = i; });
  return g.slice(last + 1).filter((s) => !picked(s));
}

// A finished step, by its number (as `orch run` shows it), id, skill or label (whole, or words from it).
// The newest match wins, so "build" after a go back means the latest Build.
export function findDone(run, ref) {
  const r = String(ref || '').trim().toLowerCase().replace(/^\//, '').replace(/^step\s+/, '');
  if (!r) return null;
  if (/^\d+$/.test(r)) {
    const b = run.steps[Number(r) - 1];
    return b?.status === 'done' ? b : null;
  }
  const done = run.steps.filter((b) => b.status === 'done');
  const exact = done.filter((b) => [b.id, b.skill, b.label].some((v) => String(v).toLowerCase() === r));
  const near = r.length >= 3 ? done.filter((b) => [b.skill, b.label].some((v) => String(v).toLowerCase().includes(r))) : [];
  return (exact.length ? exact : near).at(-1) || null;
}

export const doneList = (run) => `Finished steps: ${run.steps.map((b, i) => (b.status === 'done' ? `${i + 1}. ${b.label}` : null)).filter(Boolean).join(' · ') || 'none yet'}.`;

// Any step (orch go), by its number, id, skill or label (whole, or words from it). An exact name wins; else the
// newest step whose name holds the words.
export function findStep(run, ref) {
  const r = String(ref || '').trim().toLowerCase().replace(/^\//, '').replace(/^step\s+/, '');
  if (!r) return null;
  if (/^\d+$/.test(r)) return run.steps[Number(r) - 1] || null;
  const exact = run.steps.filter((b) => [b.id, b.skill, b.label].some((v) => String(v).toLowerCase() === r));
  const near = r.length >= 3 ? run.steps.filter((b) => [b.id, b.skill, b.label].some((v) => String(v).toLowerCase().includes(r))) : [];
  return (exact.length ? exact : near).at(-1) || null;
}

export const stepList = (run) => `Steps: ${run.steps.map((b, i) => `${i + 1}. ${b.label}${b.status === 'pending' ? '' : ` (${b.status})`}`).join(' · ')}.`;

// "build fix the review findings" → the step "build" and why. The longest start that names a step wins;
// "test in the app: the export is wrong" splits at the colon.
export function splitStepRef(run, rest) {
  const s = String(rest).trim();
  const colon = /^([^:]+):\s*(.*)$/s.exec(s);
  if (colon && findStep(run, colon[1])) return { ref: colon[1].trim(), why: colon[2] };
  const words = s.split(/\s+/);
  for (let k = words.length; k > 0; k--) {
    const ref = words.slice(0, k).join(' ');
    if (findStep(run, ref)) return { ref, why: words.slice(k).join(' ').replace(/^[-–:,]\s*/, '') };
  }
  return { ref: colon ? colon[1].trim() : words[0], why: '' };
}

// The step `model` changes: the one working (or failed), else the next one to start.
export const stepNow = (run) => run.steps.find((b) => b.status === 'running' || b.status === 'failed') || nextStep(run);

// "opus, effort high" / "opus, ultracode"; '' when the step names neither (it keeps the one before).

export const sessionOpen = (run) => !!run.session?.open;

export function describeTool(c) {
  const i = c.input || {};
  const detail = i.command || i.file_path || i.pattern || i.skill || i.url || i.description || '';
  return `${c.name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`;
}

export function queueTime(run) {
  return run.queuedAt || run.createdAt;
}

// Claude has a turn going (a prompt was sent, its Stop hook has not come yet). An hour old: a lost Stop, not a turn.
export const midTurn = (run) => !!run.turnAt && Date.now() - Date.parse(run.turnAt) < 60 * 60 * 1000;

// The user is back (typed, or answered an Allow prompt): the time the step waited for them counts apart from the
// AI's time (step.youMs; stats show AI time without it).
export function youBack(run) {
  if (!run.youSince) return;
  const step = run.steps.find((b) => b.status === 'running');
  if (step) step.youMs = (step.youMs || 0) + Math.max(0, Date.now() - Date.parse(run.youSince));
  delete run.youSince;
}
