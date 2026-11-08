// orch commands for templates, skills and repos.
import fs from 'node:fs';
import { listTemplates, getTemplate, deleteTemplate, isSafeId } from '../store.mjs';
import { applyModelOptions } from '../model.mjs';
import { scanSkills } from '../skills-scan.mjs';
import { setMark } from '../tracking.mjs';
import { listRepos } from '../workspace.mjs';
import { fail, onOff } from './args.mjs';
import { didYouMean } from './spec.mjs';
import { table, short, templateText } from '../format.mjs';
import { findTemplate, slug, storeTemplate, stepOptions } from './find.mjs';

export const templateCommands = {
  async templates() {
    const list = await listTemplates();
    return { json: list, text: table(list, [['Id', (t) => t.id], ['Name', (t) => t.name], ['Tracking', (t) => (t.tracking === false ? 'off' : 'on')], ['Steps', (t) => t.steps.map((b) => b.label || b.skill).join(' > ')]]) };
  },

  async template(r, { pos, opt }) {
    const [sub, ref, ...rest] = pos;
    const save = async (t, said) => {
      const saved = await storeTemplate(t);
      return { json: saved, text: `${said}\n${templateText(saved)}` };
    };
    switch (sub) {
      case 'show': {
        const t = await findTemplate(ref);
        return { json: t, text: templateText(t) };
      }
      case 'new': {
        if (!isSafeId(ref)) fail('the id must be letters, digits, - or _ (for example jira-to-pr)');
        if (await getTemplate(ref)) fail(`template ${ref} already exists`, 409);
        // A template needs a step; the first one can come with --skill, else it is added next.
        const t = { id: ref, name: String(opt.name || ref), tracking: opt.tracking === undefined ? true : onOff(opt.tracking, 'tracking'), repos: typeof opt.repos === 'string' ? opt.repos.split(',').filter(Boolean) : [], steps: [] };
        if (typeof opt.skill === 'string' || rest[0]) {
          const skill = opt.skill || rest[0];
          t.steps.push(stepOptions({ id: slug(skill, new Set()), skill, label: skill, args: '' }, opt));
        } else fail('give the first step: template new <id> <skill> --name "…"');
        return save(t, 'Template made.');
      }
      case 'copy': {
        const t = await findTemplate(ref);
        const id = rest[0];
        if (!isSafeId(id)) fail('give the new id: template copy <id> <new-id>');
        if (await getTemplate(id)) fail(`template ${id} already exists`, 409);
        return save({ ...structuredClone(t), id, name: String(opt.name || `${t.name} (copy)`) }, 'Template copied.');
      }
      case 'set': {
        const t = await findTemplate(ref);
        const p = opt;
        if (!['name', 'tracking', 'repos', 'model', 'effort'].some((k) => p[k] !== undefined)) fail('say what to change: name=… tracking=on|off repos=api,webclient model=… effort=…');
        if (p.name !== undefined) t.name = p.name;
        if (p.tracking !== undefined) t.tracking = onOff(p.tracking, 'tracking');
        if (p.repos !== undefined) t.repos = p.repos === 'none' ? [] : p.repos.split(',').filter(Boolean);
        applyModelOptions(t, p);
        return save(t, 'Template changed.');
      }
      case 'add': {
        const t = await findTemplate(ref);
        const skill = rest[0];
        if (!skill) fail('name the skill to add');
        if (!(await scanSkills()).some((s) => s.name === skill)) fail(`no skill named ${skill}. Find one with: skills <words>`, 404);
        const step = stepOptions({ id: slug(opt.label || skill, new Set(t.steps.map((b) => b.id))), skill, label: skill, args: '' }, opt);
        if (opt.at !== undefined && !(Number.isInteger(Number(opt.at)) && Number(opt.at) >= 1)) fail(`at must be a step number from 1 to ${t.steps.length + 1} (got "${opt.at}")`);
        const at = opt.at === undefined ? t.steps.length : Math.max(0, Math.min(t.steps.length, Number(opt.at) - 1));
        t.steps.splice(at, 0, step);
        return save(t, `Added ${skill} at step ${at + 1}.`);
      }
      case 'box': // the old name
      case 'step': {
        const t = await findTemplate(ref);
        const b = t.steps.find((x) => x.id === rest[0] || x.label === rest[0]);
        if (!b) fail(`no step ${rest[0]} in ${t.id}`, 404);
        stepOptions(b, opt);
        return save(t, `Step ${b.id} changed.`);
      }
      case 'move': {
        const t = await findTemplate(ref);
        const from = t.steps.findIndex((x) => x.id === rest[0] || x.label === rest[0]);
        if (from < 0) fail(`no step ${rest[0]} in ${t.id}`, 404);
        const to = Math.max(0, Math.min(t.steps.length - 1, Number(rest[1]) - 1));
        if (!Number.isInteger(to)) fail('give the new position as a number');
        const [b] = t.steps.splice(from, 1);
        t.steps.splice(to, 0, b);
        return save(t, `Moved ${b.id} to step ${to + 1}.`);
      }
      case 'remove': {
        const t = await findTemplate(ref);
        const i = t.steps.findIndex((x) => x.id === rest[0] || x.label === rest[0]);
        if (i < 0) fail(`no step ${rest[0]} in ${t.id}`, 404);
        const [b] = t.steps.splice(i, 1);
        return save(t, `Removed ${b.id}.`);
      }
      case 'save': {
        let t;
        try {
          t = JSON.parse(typeof opt.file === 'string' ? fs.readFileSync(opt.file, 'utf8') : opt['json-in']);
        } catch (err) {
          fail(typeof opt.file === 'string' ? `could not read ${opt.file}: ${err.message}` : 'give the template as a file: template save <id> file=<template.json>');
        }
        return save({ ...t, id: ref }, 'Template saved.');
      }
      case 'delete': {
        const t = await findTemplate(ref);
        await deleteTemplate(t.id);
        return { json: { ok: true }, text: `Template ${t.id} deleted. Runs made from it stay.` };
      }
      default:
        fail(`template has no "${sub}".${didYouMean(sub, ['show', 'new', 'copy', 'set', 'save', 'delete'])} Use: template show|new|copy|set|save|delete <id>; its steps: steps <id> add|set|remove|move`);
    }
  },

  async skills(r, { pos }) {
    const words = pos.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
    const list = (await scanSkills()).filter((s) => words.every((w) => `${s.name} ${s.description || ''}`.toLowerCase().includes(w)));
    return {
      json: list,
      text: table(list, [['Skill', (s) => s.name], ['From', (s) => s.source], ['Writes to Teamspace/vault', (s) => (s.tracks ? `yes${s.mark ? ' (your mark)' : ''}` : s.mark === 'clean' ? 'no (your mark)' : 'no')], ['What it does', (s) => short((s.description || '').replace(/\s+/g, ' '), 90)]]),
    };
  },

  async 'skill-mark'(r, { pos }) {
    await setMark(pos[0], pos[1]);
    const s = (await scanSkills()).find((x) => x.name === pos[0]);
    return { json: s, text: `${pos[0]}: ${s?.tracks ? 'counts as writing to Teamspace or the vault' : 'counts as clean'} (${pos[1]}).` };
  },

  async repos() {
    const list = listRepos({ fresh: true });
    return { json: list, text: table(list, [['Repo', (x) => x.token], ['Folder', (x) => x.dir], ['Cloned', (x) => (x.cloned ? 'yes' : 'no')], ['Starts from', (x) => x.defaultBase || '']]) };
  },
};
