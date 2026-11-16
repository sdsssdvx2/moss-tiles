import { allocate } from '../core/allocator.js';
import { lifecycleAll, getRuns, equityPoints } from '../db/store.js';
import { allStrategies } from '../strategies/index.js';
import { DAY } from '../core/calendar.js';

export function dailyReturns(points) {
  const byDay = new Map();
  for (const p of points) byDay.set(Math.floor(p.t / DAY), p.equity);
  const v = [...byDay.values()];
  const r = [];
  for (let i = 1; i < v.length; i++) if (v[i - 1] > 0) r.push(v[i] / v[i - 1] - 1);
  return r;
}

export async function allocateTask(env, kv, now) {
  const last = await env.DB.prepare('SELECT t, weights FROM allocations ORDER BY t DESC LIMIT 1').first();
  const prev = last ? { t: last.t, weights: JSON.parse(last.weights) } : null;
  const lc = await lifecycleAll(env.DB);
  const stillOk = (id) => ['live_candidate'].includes(lc[id]?.stage) || ['krx_dca_v1', 'crypto_dca_v1'].includes(id);
  if (prev && now - prev.t < 7 * DAY && Object.keys(prev.weights).every(stillOk)) return false; // B19: re-run at once if one lost eligibility
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const cands = [];
  for (const s of allStrategies(kv)) {
    if (s.benchmarkOnly && !['krx_dca_v1', 'crypto_dca_v1'].includes(s.id)) continue;
    const run = runs[`${s.id}:paper`];
    const stage = lc[s.id]?.stage;
    let dr = [];
    if (run && (s.benchmarkOnly || stage === 'live_candidate')) dr = dailyReturns(await equityPoints(env.DB, run.id, now - 100 * DAY));
    cands.push({ id: s.id, stage, benchmarkOnly: !!s.benchmarkOnly, dailyReturns: dr });
  }
  let cfg = {};
  try { cfg = env.ALLOC_JSON ? JSON.parse(env.ALLOC_JSON) : {}; } catch {}
  const a = allocate(cands, prev, now, cfg);
  if (!a.changed) return false;
  await env.DB.prepare('INSERT OR REPLACE INTO allocations (t, weights, notes) VALUES (?, ?, ?)').bind(a.t, JSON.stringify(a.weights), JSON.stringify(a.notes)).run();
  return true;
}
