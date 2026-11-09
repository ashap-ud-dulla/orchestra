// The tracking switch. A template with tracking OFF must not write to the solution's tracker or notes place (the
// pack says what they are: pack.tracking). Orchestra reads each skill's text to guess which skills write there. You
// can correct each guess; your corrections are saved in data/skill-marks.json.
import path from 'node:path';
import { config } from './config.mjs';
import { pack } from './pack.mjs';
import { readJson, writeJson } from './store.mjs';
import { upgradeMarks } from './upgrade.mjs';

// Returns the reasons a skill looks like it writes to the tracker or the notes place (empty: it does not), from the
// pack's signs (a plain mention is not enough).
export function detect(text, signs = pack.tracking?.signs || []) {
  return signs.filter(([re]) => re.test(String(text || ''))).map(([, why]) => why);
}

// ---- your corrections ----

const MARKS = new Set(['writes', 'clean']);

function marksFile() {
  return path.join(config.dataDir, 'skill-marks.json');
}

export async function getMarks() {
  try {
    const m = upgradeMarks(await readJson(marksFile()));
    return Object.fromEntries(Object.entries(m).filter(([, v]) => MARKS.has(v)));
  } catch {
    return {};
  }
}

// mark: 'writes' | 'clean' | 'auto' (auto removes your correction); 'heavy' | 'light' | 'heavy-auto' for the heavy mark.
export async function setMark(name, mark) {
  if (typeof name !== 'string' || !/^[\w:.-]+$/.test(name)) throw Object.assign(new Error('bad skill name'), { status: 400 });
  if (mark === 'heavy' || mark === 'light' || mark === 'heavy-auto') return setHeavyMark(name, mark === 'heavy-auto' ? 'auto' : mark);
  if (mark !== 'auto' && !MARKS.has(mark)) throw Object.assign(new Error('mark must be writes, clean or auto (tracking), or heavy, light or heavy-auto'), { status: 400 });
  const marks = await getMarks();
  if (mark === 'auto') delete marks[name];
  else marks[name] = mark;
  await writeJson(marksFile(), marks);
  return marks;
}

// Heavy marks: whether a skill's step is heavy (builds, runs the app or big tests). The run's first step decides it by
// reading the skill, and keeps the answer here (data/heavy-marks.json), so it is decided once; you can correct it.
function heavyFile() {
  return path.join(config.dataDir, 'heavy-marks.json');
}
export async function getHeavyMarks() {
  try {
    const m = await readJson(heavyFile());
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v === 'heavy' || v === 'light'));
  } catch {
    return {};
  }
}
export async function setHeavyMark(name, mark) {
  const marks = await getHeavyMarks();
  if (mark === 'auto') delete marks[name];
  else marks[name] = mark;
  await writeJson(heavyFile(), marks);
  return marks;
}

// Adds the tracking fields to a scanned skill: tracksAuto/why (the guess), mark (yours), tracks (the result).
export function applyMark(skill, why, marks) {
  const mark = marks[skill.name] || null;
  return { ...skill, why, tracksAuto: why.length > 0, mark, tracks: mark ? mark === 'writes' : why.length > 0 };
}

// Steps that may not run with tracking OFF. Returns one message per step; empty when all is fine.
export function offProblems(steps, skills) {
  const bySkill = new Map(skills.map((s) => [s.name, s]));
  return (steps || []).filter((b) => bySkill.get(b.skill)?.tracks).map((b) => `step “${b.label || b.skill}” uses /${b.skill}, which writes to ${pack.tracking?.what || 'the tracker'}`);
}

export const OFF_HELP = 'Tracking is OFF for this workflow. Remove those steps, turn tracking on, or correct the skill’s mark on the Skills page.';

// The extra rule a turn gets when tracking is OFF (the pack's).
export const OFF_RULE = pack.tracking?.rule || 'Tracking is OFF for this run.';
