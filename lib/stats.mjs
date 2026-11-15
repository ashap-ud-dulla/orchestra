// Run history and stats: what runs cost, how long they take, and which steps fail.
// Worked out from the saved runs each time; nothing extra is stored.

const DAY = 24 * 60 * 60 * 1000;

const round = (n) => Math.round(n * 1e4) / 1e4;
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// A step's AI time: its time running, less the time it waited for you (youMs; older runs did not count it).
export const aiMs = (b) => Math.max(0, (b.durationMs || 0) - (b.youMs || 0));
// What a step cost in all, its earlier tries too (orch go back keeps them in tries).
export const allCost = (b) => (b.cost || 0) + (b.tries || []).reduce((s, t) => s + (t.cost || 0), 0);

// Time the AI spent working on a run: its steps, not the time it waited for you.
function workMs(run) {
  return (run.steps || []).reduce((sum, b) => sum + aiMs(b) + (b.tries || []).reduce((s, t) => s + aiMs(t), 0), 0);
}
function youMs(run) {
  return (run.steps || []).reduce((sum, b) => sum + (b.youMs || 0) + (b.tries || []).reduce((s, t) => s + (t.youMs || 0), 0), 0);
}

export function computeStats(runs, now = Date.now()) {
  const since = (ms) => runs.filter((r) => now - Date.parse(r.createdAt) < ms);
  const spend = (list) => round(list.reduce((s, r) => s + (r.cost || 0), 0));
  const totals = {
    runs: runs.length,
    done: runs.filter((r) => r.status === 'done').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    cost: spend(runs),
    cost7d: spend(since(7 * DAY)),
    costToday: spend(since(DAY)),
  };

  const templates = new Map();
  for (const r of runs) {
    const t = templates.get(r.templateId) || { id: r.templateId, name: r.templateName, runs: 0, done: 0, failed: 0, cost: 0, doneCosts: [], doneWork: [] };
    t.name = r.templateName || t.name;
    t.runs++;
    t.cost += r.cost || 0;
    if (r.status === 'done') {
      t.done++;
      t.doneCosts.push(r.cost || 0);
      t.doneWork.push(workMs(r));
    }
    if (r.status === 'failed') t.failed++;
    templates.set(r.templateId, t);
  }

  const skills = new Map();
  for (const r of runs) {
    for (const b of r.steps || []) {
      if (!b.attempts) continue; // never ran
      const s = skills.get(b.skill) || { skill: b.skill, steps: 0, tries: 0, failures: 0, done: 0, cost: 0, doneMs: [], doneYouMs: [], doneCosts: [], lastError: null, lastErrorRun: null };
      s.steps++;
      s.tries += b.attempts;
      // Older runs did not count failures; a step failed right now counts as one.
      s.failures += b.failures ?? (b.status === 'failed' ? 1 : 0);
      s.cost += allCost(b);
      if (b.status === 'done') {
        s.done++;
        if (b.durationMs != null) s.doneMs.push(aiMs(b));
        s.doneYouMs.push(b.youMs || 0);
        s.doneCosts.push(b.cost || 0);
      }
      if (b.error && (!s.lastErrorAt || (b.endedAt || '') > s.lastErrorAt)) {
        s.lastError = String(b.error).slice(0, 300);
        s.lastErrorRun = r.id;
        s.lastErrorAt = b.endedAt || '';
      }
      skills.set(b.skill, s);
    }
  }

  return {
    totals,
    templates: [...templates.values()].map(({ doneCosts, doneWork, ...t }) => ({ ...t, cost: round(t.cost), avgCost: round(avg(doneCosts) ?? 0), avgWorkMs: avg(doneWork) })).sort((a, b) => b.runs - a.runs),
    // Most failures first, then the most expensive.
    skills: [...skills.values()].map(({ doneMs, doneYouMs, doneCosts, lastErrorAt, ...s }) => ({ ...s, cost: round(s.cost), avgMs: avg(doneMs), avgYouMs: avg(doneYouMs), avgCost: round(avg(doneCosts) ?? 0) })).sort((a, b) => b.failures - a.failures || b.cost - a.cost),
    history: runs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
      id: r.id, templateName: r.templateName, input: (r.input?.text || '').slice(0, 120), status: r.status, tracking: r.tracking !== false,
      cost: round(r.cost || 0), workMs: workMs(r), youMs: youMs(r), createdAt: r.createdAt, finishedAt: r.finishedAt || null,
      steps: (r.steps || []).map((b) => b.status),
    })),
  };
}
