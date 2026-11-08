// orch commands: stats, settings, help.
import { computeStats } from '../stats.mjs';
import { HELP } from './help.mjs';
import { fail, pairs, onOff } from './args.mjs';
import { table, money, ago, dur, short } from '../format.mjs';

export const moreCommands = {
  async stats(r) {
    const s = computeStats(r.list());
    const t = s.totals;
    const text = [
      `Runs: ${t.runs} (${t.done} done, ${t.failed} failed) · spend ${money(t.cost)} (7 days ${money(t.cost7d)}, today ${money(t.costToday)}). Costs are estimates at API prices.`,
      'Runs before 2026-11-01 may show the cost before a reopen twice (fixed since).',
      '',
      'Templates:',
      table(s.templates, [['Template', (x) => x.name], ['Runs', (x) => x.runs], ['Done', (x) => x.done], ['Failed', (x) => x.failed], ['Spend', (x) => money(x.cost)], ['Avg per done run', (x) => money(x.avgCost)], ['Avg AI time', (x) => dur(x.avgWorkMs)]]),
      '',
      'Skills (most failures first):',
      table(s.skills.slice(0, 15), [['Skill', (x) => x.skill], ['Ran', (x) => x.boxes], ['Tries', (x) => x.tries], ['Failed', (x) => x.failures], ['Avg cost', (x) => money(x.avgCost)], ['Avg time', (x) => dur(x.avgMs)], ['Last error', (x) => short(x.lastError || '', 50)]]),
      '',
      'Recent runs:',
      table(s.history.slice(0, 10), [['When', (x) => ago(x.createdAt)], ['Template', (x) => x.templateName], ['Input', (x) => short(x.input.replace(/\s+/g, ' '), 40)], ['Status', (x) => x.status], ['Cost', (x) => money(x.cost)]]),
    ].join('\n');
    return { json: s, text };
  },

  async settings(r, { pos }) {
    const p = pairs(pos);
    const patch = {};
    if (p.max !== undefined) patch.maxRunning = Number(p.max);
    if (p.learn !== undefined) patch.learn = onOff(p.learn, 'learn');
    if (p.cleanup !== undefined) fail('clean-up happens only when you say so now: clean <run>, clean --done, or clean --stale');
    if (p.pane !== undefined) patch.pane = onOff(p.pane, 'pane');
    if (p.panesize !== undefined) patch.paneSize = Number(String(p.panesize).replace(/%$/, ''));
    if (p.launcher !== undefined) patch.launcher = String(p.launcher).toLowerCase().replace(/[^a-z]/g, '');
    const s = Object.keys(patch).length ? await r.setSettings(patch) : r.getSettings();
    return { json: s, text: `Runs working at once: ${s.maxRunning} · lessons after each run: ${s.learn !== false ? 'on' : 'off'} · steps pane in run tabs: ${s.pane !== false ? `on (${s.paneSize || 30}% wide)` : 'off'} · the app starts with: ${s.launcher === 'runstack' ? 'run-stack.ps1 (runstack)' : 'the Aspire AppHost (apphost)'}` };
  },

  async help() {
    return { json: { help: HELP }, text: HELP };
  },
};
