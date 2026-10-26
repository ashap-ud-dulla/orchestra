// Lists every skill Orchestra can use as a box. Read-only: it never writes to any skill folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { detect, getMarks, applyMark } from './tracking.mjs';

// Where skills come from, in priority order. A name found earlier wins.
export function skillSources() {
  return [
    { source: 'team', dir: path.join(config.itpRoot, '.claude', 'skills') },
    { source: 'mine', dir: path.join(config.itpRoot, '.claude', 'users', config.userEmail, 'skills') },
    { source: 'global', dir: config.homeSkillsDir },
    { source: 'orchestra', dir: path.join(config.root, '.claude', 'skills') },
  ];
}

// Reads `name` and `description` from YAML frontmatter. Handles plain (also multi-line), quoted and `>` / `|` block values.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value = raw.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const folded = value.startsWith('>');
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = block.join(folded ? ' ' : '\n').replace(/\s+$/, '');
      if (folded) value = value.replace(/ {2,}/g, ' ');
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else {
      // A plain value can go on over indented lines.
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += ' ' + lines[++i].trim();
    }
    out[key] = value;
  }
  return out;
}

async function scanDir({ source, dir }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    skills.push({
      name: fm.name || e.name,
      description: fm.description || '',
      source,
      path: file,
      why: detect(text),
    });
  }
  return skills;
}

// Each skill also says whether it writes to Teamspace or the vault (tracks): the guess, or your correction.
export async function scanSkills() {
  const [lists, marks] = await Promise.all([Promise.all(skillSources().map(scanDir)), getMarks()]);
  const byName = new Map();
  for (const s of lists.flat()) if (!byName.has(s.name)) byName.set(s.name, s);
  byName.delete('orchestra'); // the /orchestra launcher is not a workflow step
  return [...byName.values()].map(({ why, ...s }) => applyMark(s, why, marks)).sort((a, b) => a.name.localeCompare(b.name));
}
