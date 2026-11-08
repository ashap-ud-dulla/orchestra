// Old files on disk, read as today's shape. Version 1 said "box" (boxes, waitAfter, usesApp, walkthrough) and the
// step skills had an "orchestra-" name. An old file is changed in memory when it is read; it is saved in the new
// shape on its next save. Reading a new file changes nothing.
export const VERSION = 2;

// Old skill name -> new one.
export const SKILL_RENAMES = { 'orchestra-app-test': 'app-test', 'orchestra-bug-logs': 'bug-logs', 'orchestra-wrap-up': 'wrap-up' };
export const OLD_SKILL_NAMES = Object.keys(SKILL_RENAMES);
export const newSkillName = (s) => SKILL_RENAMES[s] || s;

function move(o, from, to) {
  if (o && Object.prototype.hasOwnProperty.call(o, from)) {
    if (o[to] === undefined) o[to] = o[from];
    delete o[from];
  }
}

export function upgradeStep(s) {
  if (!s || typeof s !== 'object') return s;
  move(s, 'waitAfter', 'wait');
  move(s, 'usesApp', 'app');
  move(s, 'walkthrough', 'explain');
  if (typeof s.skill === 'string') s.skill = newSkillName(s.skill);
  return s;
}

export function upgradeRun(run) {
  if (!run || typeof run !== 'object' || run.version >= VERSION) return run;
  move(run, 'boxes', 'steps');
  move(run, 'currentBox', 'currentStep');
  move(run, 'walkthroughFor', 'explainFor');
  if (run.restart) move(run.restart, 'boxId', 'stepId');
  for (const s of run.steps || []) upgradeStep(s);
  for (const m of Array.isArray(run.chat) ? run.chat : []) move(m, 'boxId', 'stepId');
  run.version = VERSION;
  return run;
}

export function upgradeTemplate(t) {
  if (!t || typeof t !== 'object' || t.version >= VERSION) return t;
  move(t, 'boxes', 'steps');
  for (const s of t.steps || []) upgradeStep(s);
  t.version = VERSION;
  return t;
}

// A saved lesson's workflow change: {op:"box", box:"plan"} -> {op:"step", step:"plan"}.
export function upgradeChange(c) {
  if (!c || typeof c !== 'object') return c;
  if (c.op === 'box') c.op = 'step';
  move(c, 'box', 'step');
  if (typeof c.skill === 'string') c.skill = newSkillName(c.skill);
  return c;
}

// Skill marks (skill name -> writes|clean|auto): old names become new ones.
export function upgradeMarks(m) {
  if (!m || typeof m !== 'object') return m;
  for (const [old, now] of Object.entries(SKILL_RENAMES)) move(m, old, now);
  return m;
}
