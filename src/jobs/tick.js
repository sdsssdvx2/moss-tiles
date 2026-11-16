// One cron tick = a few small units of work, in priority order.
import { kvAll } from '../db/store.js';
import { cryptoCandlesTask, cryptoBackfillTask, cryptoUniverseTask, krxDailyTask, krxBackfillTask, krxNavBackfillTask, pruneHourlyTask } from './collect.js';
import { paperTask, workerBacktestTask } from './paper.js';
import { lifecycleTask } from './lifecycle.js';
import { allocateTask } from './allocate.js';
import { notifyPending } from './notify.js';
import { feedsTask } from './feeds.js';
import { aiTask } from './ai.js';
import { marketSignalsTask } from './market-signals.js';
import { researchPullTask } from './research-pull.js';

export async function tick(env, now = Math.floor(Date.now() / 1000), { fetcher = fetch } = {}) {
  const kv = await kvAll(env.DB);
  const log = [];
  const run = async (name, fn) => {
    try { const r = await fn(); if (r) log.push(name); return r; } catch (e) { log.push(`${name}:ERR:${String(e?.message || e).slice(0, 80)}`); return false; }
  };
  let data = 0;
  const maxData = Number(env.DATA_TASKS_PER_TICK || 2);
  if (String(env.COLLECT_ENABLED ?? 'true') !== 'false') {
    const tasks = [
      ['crypto1h', () => cryptoCandlesTask(env, kv, now, '1h', { fetcher })],
      ['crypto1d', () => cryptoCandlesTask(env, kv, now, '1d', { fetcher })],
      ['krx1d', () => krxDailyTask(env, kv, now, { fetcher })],
      ['universe', () => cryptoUniverseTask(env, kv, now, { fetcher })],
      ['market', () => marketSignalsTask(env, kv, now, { fetcher })],
      ['feeds', () => feedsTask(env, kv, now, { fetcher })],
      ['krxBackfill', () => krxBackfillTask(env, kv, now, { fetcher })],
      ['krxNavBackfill', () => krxNavBackfillTask(env, kv, now, { fetcher })],
      ['cryptoBackfill1d', () => cryptoBackfillTask(env, kv, now, '1d', { fetcher })],
      ['cryptoBackfill1h', () => cryptoBackfillTask(env, kv, now, '1h', { fetcher })],
      ['prune', () => pruneHourlyTask(env, kv, now)],
    ];
    for (const [n, f] of tasks) { if (data >= maxData) break; if (await run(n, f)) data++; }
  }
  // AI judgment and the weekly research pull are self-throttled (6h) and mostly I/O, so they get their own slot instead
  // of competing with the data collectors (which fill the data budget almost every tick). At most one per tick.
  if (!(await run('ai', () => aiTask(env, kv, now, { fetcher })))) await run('research', () => researchPullTask(env, kv, now, { fetcher }));
  const changed = (await run('paper', () => paperTask(env, kv, now, { maxSteps: Number(env.PAPER_STEPS_PER_TICK || 2) }))) || [];
  if (!changed.length && data === 0) await run('workerBacktest', () => workerBacktestTask(env, kv, now));
  if ((kv['lc:at'] || 0) < now - 6 * 3600) await run('lifecycle', () => lifecycleTask(env, kv, now));
  else if (changed.length) await run('lifecycle', () => lifecycleTask(env, kv, now, { only: changed }));
  else await run('allocate', () => allocateTask(env, kv, now));
  await run('notify', () => notifyPending(env, { fetcher, kv, now }));
  return log;
}
