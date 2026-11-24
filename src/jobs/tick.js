// One cron tick = a few small units of work, in priority order.
import { kvAll } from '../db/store.js';
import { cryptoCandlesTask, cryptoBackfillTask, cryptoUniverseTask, krxDailyTask, krxBackfillTask, krxNavBackfillTask, pruneHourlyTask } from './collect.js';
import { paperTask, workerBacktestTask } from './paper.js';
import { lifecycleTask } from './lifecycle.js';
import { allocateTask } from './allocate.js';
import { notifyPending } from './notify.js';
import { feedsTask } from './feeds.js';
import { aiTask, aiDiscTask } from './ai.js';
import { marketSignalsTask } from './market-signals.js';
import { researchPullTask } from './research-pull.js';
import { weeklyDue, weeklyText, newCandidateLines } from '../core/decision.js';
import { candidateById } from '../strategies/candidates.js';
import { kvSetStmt, eventStmt, getRuns, lifecycleAll } from '../db/store.js';
import { allStrategies } from '../strategies/index.js';
import { buildScorecard, appendScorecard, scorecardLines } from '../core/scorecard.js';
import { selfCheckTask } from './selfcheck.js';

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
  // 공시 비교 점수(2026-11-24)는 본 AI가 저장을 끝낸 다음 틱에, 같은 자리(ai → 공시 비교 → 연구 가져오기 중 하나)
  if (!(await run('ai', () => aiTask(env, kv, now, { fetcher }))) && !(await run('aidisc', () => aiDiscTask(env, kv, now, { fetcher })))) await run('research', () => researchPullTask(env, kv, now, { fetcher }));
  const changed = (await run('paper', () => paperTask(env, kv, now, { maxSteps: Number(env.PAPER_STEPS_PER_TICK || 2) }))) || [];
  if (!changed.length && data === 0) await run('workerBacktest', () => workerBacktestTask(env, kv, now));
  const plan = lifecyclePlan(kv, now, changed);
  if (plan === 'full') {
    // mark the attempt first: if a full pass ever dies (CPU limit), it is retried once an hour, not every tick
    kv['lc:fullTry'] = now;
    await run('lcTry', async () => { await kvSetStmt(env.DB, 'lc:fullTry', now).run(); return false; });
    await run('lifecycle', () => lifecycleTask(env, kv, now));
  } else if (plan === 'partial') await run('lifecycle', () => lifecycleTask(env, kv, now, { only: changed }));
  else await run('allocate', () => allocateTask(env, kv, now));
  await run('scorecard', () => weeklyScorecardTask(env, kv, now));
  await run('weekly', () => weeklyDecisionTask(env, kv, now));
  await run('selfcheck', () => selfCheckTask(env, kv, now));
  await run('notify', () => notifyPending(env, { fetcher, kv, now }));
  return log;
}

/**
 * Which lifecycle pass this tick runs. The full pass (automatic decision, criteria, weekly conclusion input) is keyed on
 * its OWN time 'lc:fullAt' — 2026-11-23: keyed on 'lc:at', which partial passes refresh every hour (1h books), the full
 * pass never ran in production. A failed attempt ('lc:fullTry') waits an hour before the next try.
 */
export function lifecyclePlan(kv, now, changed = []) {
  const fullDue = (kv['lc:fullAt'] || 0) < now - 6 * 3600 && (kv['lc:fullTry'] || 0) < now - 3600;
  if (fullDue) return 'full';
  return changed.length ? 'partial' : 'allocate';
}

/** Monday 08:40 KST: one plain-language conclusion (no jargon) as a Telegram event. Cheap: kv only. */
export async function weeklyDecisionTask(env, kv, now) {
  const d = kv['decision:current'];
  if (!d || !weeklyDue(now, kv['decision:weeklyAt'])) return false;
  const lastWeekly = kv['decision:weeklyAt'] || 0;
  kv['decision:weeklyAt'] = now;
  const card = (kv['paper:weekly'] || []).slice(-1)[0];
  const extra = card && now - card.at < 2 * 86400 ? scorecardLines(card) : [];
  const inBody = new Set((d.changes || []).filter((c) => c.firstCandidate).map((c) => c.id)); // weeklyText가 이미 찍는 줄
  const fresh = newCandidateLines(kv['candidates:firstSelected'], lastWeekly, (id) => candidateById[id]?.name || id, inBody);
  const head = fresh.length ? `${weeklyText(d)}\n${fresh.join('\n')}` : weeklyText(d);
  const message = extra.length ? `${head}\n\n${extra.join('\n')}` : head;
  await env.DB.batch([kvSetStmt(env.DB, 'decision:weeklyAt', now), eventStmt(env.DB, { t: now, kind: 'decision_weekly', strategy_id: null, message })]);
  return true;
}

/** Monday 08:40 KST: one snapshot of every paper book (주간 성과표), last 12 weeks kept in kv 'paper:weekly'. Display only. */
export async function weeklyScorecardTask(env, kv, now) {
  if (!weeklyDue(now, kv['paper:weeklyAt'])) return false;
  const runs = Object.fromEntries((await getRuns(env.DB)).map((r) => [r.id, r]));
  const lc = await lifecycleAll(env.DB);
  const hist = kv['paper:weekly'] || [];
  const card = buildScorecard(allStrategies(kv), runs, lc, now, hist.slice(-1)[0] || null);
  const next = appendScorecard(hist, card);
  kv['paper:weekly'] = next; kv['paper:weeklyAt'] = now;
  await env.DB.batch([kvSetStmt(env.DB, 'paper:weekly', next), kvSetStmt(env.DB, 'paper:weeklyAt', now)]);
  return true;
}
