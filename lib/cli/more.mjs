// orch commands: stats, settings, help.
import { computeStats } from '../stats.mjs';
import { helpText } from './spec.mjs';
import { fail, onOff } from './args.mjs';
import { table, money, ago, dur, short } from '../format.mjs';
import { ticketKey } from '../terminal.mjs';
import { pack } from '../pack.mjs';

export const moreCommands = {
  // The work you hold, from the pack (read before the lock: bin/orch.mjs passes it in opt.held), numbered, with the
  // run each one has. The /orch skill adds your tracker tickets and asks which to start.
  async mine(r, { opt }) {
    const held = opt.held || { items: [], problem: 'this solution has no tracker list (a pack adds one)' };
    const live = r.list().filter((x) => !x.cleanedAt);
    const items = held.items.map((x, i) => ({ n: i + 1, ...x, run: live.find((run) => ticketKey(run) === x.key)?.id.slice(-6) || null }));
    const text = [
      held.problem ? `Could not read your list: ${held.problem}.` : `You hold${held.who ? ` (${held.who})` : ''}:`,
      ...(held.problem ? [] : [table(items, [['#', (x) => x.n], ['Key', (x) => x.key], ['Title', (x) => x.title], ['State', (x) => x.state], ['Kind', (x) => x.kind], ['Run', (x) => x.run || '']])]),
    ].join('\n');
    return { json: { items, problem: held.problem || null, who: held.who || null }, text };
  },

  async stats(r) {
    const s = computeStats(r.list());
    const t = s.totals;
    const text = [
      `Runs: ${t.runs} (${t.done} done, ${t.failed} failed) · spend ${money(t.cost)} (7 days ${money(t.cost7d)}, today ${money(t.costToday)}). Costs are estimates at API prices.`,
      'Runs before 2026-11-01 may show the cost before a reopen twice; runs before 2026-11-12 may show step costs that do not add up, and AI time with the wait for you in it (fixed since).',
      '',
      'Templates:',
      table(s.templates, [['Template', (x) => x.name], ['Runs', (x) => x.runs], ['Done', (x) => x.done], ['Failed', (x) => x.failed], ['Spend', (x) => money(x.cost)], ['Avg per done run', (x) => money(x.avgCost)], ['Avg AI time', (x) => dur(x.avgWorkMs)]]),
      '',
      'Skills (most failures first):',
      table(s.skills.slice(0, 15), [['Skill', (x) => x.skill], ['Ran', (x) => x.steps], ['Tries', (x) => x.tries], ['Failed', (x) => x.failures], ['Avg cost', (x) => money(x.avgCost)], ['Avg AI time', (x) => dur(x.avgMs)], ['Avg wait for you', (x) => dur(x.avgYouMs)], ['Last error', (x) => short(x.lastError || '', 50)]]),
      '',
      'Recent runs:',
      table(s.history.slice(0, 10), [['When', (x) => ago(x.createdAt)], ['Template', (x) => x.templateName], ['Input', (x) => short(x.input.replace(/\s+/g, ' '), 40)], ['Status', (x) => x.status], ['Cost', (x) => money(x.cost)]]),
    ].join('\n');
    return { json: s, text };
  },

  async settings(r, { pos, opt }) {
    const own = Object.entries(pack.settings || {});
    if (pos.length) fail(`settings takes key=value: max=N learn=on|off pane=on|off panesize=15..70${own.map(([k, s]) => ` ${k}=${s.values.join('|')}`).join('')} (got "${pos[0]}")`);
    const p = opt;
    const patch = {};
    if (p.max !== undefined) patch.maxRunning = Number(p.max);
    if (p.learn !== undefined) patch.learn = onOff(p.learn, 'learn');
    if (p.cleanup !== undefined) fail('clean-up happens only when you say so: clean <run>, clean done, or clean stale');
    if (p.pane !== undefined) patch.pane = onOff(p.pane, 'pane');
    if (p.panesize !== undefined) patch.paneSize = Number(String(p.panesize).replace(/%$/, ''));
    for (const [k] of own) if (p[k] !== undefined) patch[k] = String(p[k]).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const s = Object.keys(patch).length ? await r.setSettings(patch) : r.getSettings();
    return { json: s, text: `Heavy steps (builds, the app) at once: ${s.maxRunning} · lessons after each run: ${s.learn !== false ? 'on' : 'off'} · steps pane in run tabs: ${s.pane !== false ? `on (${s.paneSize || 30}% wide)` : 'off'}${own.map(([k, d]) => ` · ${d.about}: ${d.words?.[s[k]] || s[k]}`).join('')}` };
  },

  async help() {
    return { json: { help: helpText() }, text: helpText() };
  },
};
